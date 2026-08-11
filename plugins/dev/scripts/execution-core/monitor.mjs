// monitor.mjs — execution-core monitor core (CTL-535 Phase 4).
//
// The orchestration layer of the Linear Todo-state monitor: event parsing
// (canonical OTel + legacy flat shapes), per-project and all-project
// reconcile, the event-driven fast path (confident removal + Triage auto-
// dispatch), the byte-offset event-log tailer, the periodic reconcile timer,
// and the startMonitor/stopMonitor lifecycle.
//
// Event-vs-poll division of labour (CTL-681):
// Three event types are handled inline by the tailer, with no Linear poll:
//   linear.issue.state_changed:
//     - DRAG_OUT_STATES (Backlog/Canceled/Duplicate) → confident immediate
//       removal + abortWorker.
//     - →Triage / →Ready-without-triage-artifact → one-shot triage dispatch.
//     - All other states: no-op (pipeline write-backs, unknown states).
//   linear.issue.updated (CTL-681, handleIssueUpdatedEvent):
//     - Evaluates the ticket against each project's eligibleQuery from the
//       event payload (toState/toLabels/toProject/toPriority — no poll).
//     - Upserts the ticket when it matches; removes it when it does not.
//     - Up to one reconcile interval of staleness only for brand-new adds
//       whose relations the event payload omits; removals are instant.
//   linear.comment.created (CTL-681, handleCommentCreatedEvent):
//     - Surfaces parsed comment (ticket, body, author) via log.info and an
//       injectable onComment callback. No eligible-set changes, no poll.
// The 10-min periodic reconcile (RECONCILE_INTERVAL_MS) remains the
// missed-webhook backstop for all three handlers.

import { watch, openSync, fstatSync, readSync, closeSync, mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
// CTL-1744: delegate-lands claim markers. A zero-import leaf so scheduler.mjs can
// read them too without creating a scheduler↔monitor cycle (monitor already
// imports scheduler). See delegate-claims.mjs for the full rationale.
import { recordDelegateClaim, clearDelegateClaim } from "./delegate-claims.mjs";
import { dirname, basename, join } from "node:path";
import {
  getEventLogPath,
  getCoordinationMirrorPath, // CTL-1655: coordination-mirror comment tail
  RECONCILE_INTERVAL_MS,
  EVENT_DEBOUNCE_MS,
  TAILER_POLL_INTERVAL_MS,
  log,
  getHostName, // CTL-862
  getClusterHosts, // CTL-862
  hostMembershipWarning, // CTL-1057
  isDraining as isDrainingDefault, // CTL-1095: drain gate
  isInProcessDispatchMode, // CTL-1457 (T2): sdk|codex-exec occupancy gate predicate
} from "./config.mjs";
// CTL-1397 (Node-loadability): monitor.mjs MUST NOT import replica-read.mjs — that
// module statically imports `bun:sqlite`, which the Node ESM loader rejects at
// module-load (the broker entrypoint is `#!/usr/bin/env node` and loads
// broker/index.mjs → recovery.mjs → monitor.mjs). So the replica reader is
// constructed in daemon.mjs (a bun-only context, mode-gated) and INJECTED into
// startMonitor — exactly the param-injection pattern the per-signal tier uses
// (linear-query.mjs never imports replica-read.mjs either; daemon.mjs:681 builds
// the reader and passes it in). monitor.mjs stays Node-loadable.
import { ownedBy } from "./hrw.mjs"; // CTL-862: HRW ownership filter
import { isLivenessAnchorTicket, resolveAnchorIssueCached } from "./dispatch-exclusions.mjs";
import { claimDispatchSync, readTriageAttemptCountSync, bumpTriageAttemptCountSync } from "./cluster-claim-sync.mjs"; // CTL-862: cross-host claim soft-CAS; CTL-1649: fleet-wide triage attempt count
import { listProjects, getProjectConfig, resolveEligibleQuery } from "./registry.mjs";
import {
  runEligibleQuery,
  runTriageStateQuery as defaultRunTriageStateQuery, // CTL-1589: level-triggered Triage-state read
  fetchTicketState as defaultFetchTicketState, // CTL-1589: last-moment stale-row revalidation
  fetchTicketAssignee,
  isAssigneeClaimable,
  isClaimable,
  fetchTicketsDelegateBatch,
} from "./linear-query.mjs";
import {
  setProjectEligible,
  removeTicket,
  dropProject,
  getEligibleSet,
  upsertTicket,
} from "./eligible-set.mjs";
import { loadCursor, saveCursor, resolveStartOffset } from "./event-cursor.mjs";
import { dispatchTicket, settleDispatchSync, sdkSignalRunnable, backstopOnRejection } from "./dispatch.mjs"; // CTL-1367 P1: settle async (sdk) triage dispatch synchronously + backstop a rejected async dispatch
import { abortWorker as defaultAbortWorker } from "./abort-worker.mjs";
import {
  applyTriageStatus as defaultApplyTriageStatus,
  applyAssignee as defaultApplyAssignee,
  applyLabel, // CTL-1441: needs-human at the triage re-dispatch cap
  removeLabel, // CTL-1481: worker:<host> swap (remove-before-add)
} from "./linear-write.mjs";
import { routeStuckTicketToDelegate } from "./delegate-first.mjs"; // CTL-1609
import { appendTriageTransitionEvent as defaultAppendEvent } from "./triage-transition-event.mjs";
import { countBackgroundAgents, resetLivenessCache } from "./claude-agents.mjs";
import {
  readMaxParallel,
  computeFreeSlots,
  writeClusterGeneration,
  // CTL-1091: route the triage-dispatch HRW gate through the SAME helper the
  // scheduler's new-work gate uses (positive-liveness → restore-deflap → outage
  // fail-safe), so both dispatch sites can never drift out of sync.
  //
  // NOTE (CTL-1091 Codex P1 #2 — correcting an earlier inaccurate comment):
  // a STATIC import from ./scheduler.mjs loads that module's ENTIRE graph, which
  // DOES transitively reach `bun:sqlite` (scheduler.mjs → broker/broker-state.mjs).
  // So this line is NOT bun:sqlite-free, and monitor.mjs is not Node-loadable in
  // isolation. This is a PRE-EXISTING property, not introduced here: monitor.mjs
  // already imported readMaxParallel/computeFreeSlots/writeClusterGeneration from
  // ./scheduler.mjs before this ticket, so the scheduler→broker-state→bun:sqlite
  // edge was already in the graph; adding resolveDispatchRoster changes nothing
  // about reachability. Every runtime that loads this path (exec-core daemon,
  // broker) runs under Bun, where bun:sqlite resolves. Making monitor.mjs truly
  // Node-loadable requires extracting ALL of these shared scheduler helpers into a
  // Node-safe leaf module — an all-or-nothing refactor out of this ticket's scope
  // (a partial extraction of just this symbol would leave the other three imports
  // pulling the same edge, so it would buy nothing). Tracked separately.
  resolveDispatchRoster,
} from "./scheduler.mjs";
// CTL-863: Linear-free fence event emitter (durable fence → event-log migration).
import { emitFenceClaimed } from "./fence-event.mjs";
// CTL-1481: best-effort worker:<host> label visibility-projection stamp on a
// won cluster claim. Never the claim arbiter — see worker-label.mjs header.
import { stampWorkerLabel as defaultStampWorkerLabel } from "./worker-label.mjs";
import { countSdkInflight as defaultCountSdkInflight } from "./signal-reader.mjs"; // CTL-1367 P1: executor=sdk occupancy reader for the triage budget
import {
  recordReconcileSuccess,
  recordReconcileFailure,
  getReconcileHealth,
  __resetReconcileHealthForTests,
} from "./reconcile-health.mjs";
import { recordTriageSweep } from "./triage-sweep-health.mjs";
// CTL-1628: direct import (not routed through reconcile-health.mjs) — the
// eligible-set persist-failure event has no consecutive-failure/alert-latch
// state to track, so it skips recordReconcileFailure and appends straight
// through the same appendHealthEvent seam used above.
import {
  appendReconcileHealthEvent,
  ELIGIBLE_PERSIST_FAILURE_ACTION,
} from "./reconcile-health-event.mjs";
import { checkFleetFreeze } from "./fleet-freeze-alert.mjs"; // CTL-1420: fleet-frozen-for-admission alert
import { recordReplicaRead } from "./replica-health.mjs"; // CAT-35

const MONITOR_BOOT_TS = Date.now();

// DRAG_OUT_STATES — the Linear workflow states that signal "stop work on this
// ticket". The monitor classifies these as a kill: remove the ticket from the
// eligible projection and abort any in-flight worker. CTL-584: any other
// non-Triage/non-Ready state — including the daemon's own CTL-558 write-backs
// (Research/Plan/Implement/Validate/PR/Done) — is a NO-OP, not a kill. The
// design (2026-05-21-linear-state-machine-trigger-model.md, "Human Override /
// Kill") names Backlog/Canceled; Duplicate is included because Linear ships it
// by default and users sometimes pick it instead of Canceled. Conservative
// enumeration: a missed kill is recoverable (the next reconcile drops the
// ticket from the eligible set anyway), a wrong kill destroys live work.
const DRAG_OUT_STATES = new Set(["Backlog", "Canceled", "Duplicate"]);

// --- Event parsing -------------------------------------------------------

// parseStateChangedEvent — accept both the canonical OTel envelope
// (attributes['event.name'] + body.payload) and the legacy flat shape
// (event.event + event.detail). Returns null for anything that is not a
// linear.issue.state_changed event with an extractable ticket identifier.
export function parseStateChangedEvent(event) {
  const name = event?.attributes?.["event.name"] ?? event?.event;
  if (name !== "linear.issue.state_changed") return null;
  const payload = event?.body?.payload ?? event?.detail ?? {};
  const identifier =
    event?.attributes?.["linear.issue.identifier"] ?? payload.ticket ?? payload.identifier ?? null;
  if (!identifier) return null;
  return {
    identifier,
    teamKey: payload.teamKey ?? null,
    toState: payload.toState ?? null,
    // CTL triage-entry fix (Phase 0): carry the projection-fold fields so a
    // →status transition can be folded into the eligible set from the event
    // payload (no Linear poll), the same way handleIssueUpdatedEvent does.
    toLabels: payload.toLabels ?? null,
    toProject: payload.toProject ?? null,
    toPriority: typeof payload.toPriority === "number" ? payload.toPriority : null,
  };
}

// parseIssueUpdatedEvent — accept both canonical OTel and legacy flat shapes.
// Returns null for anything that is not a linear.issue.updated event or that
// lacks an extractable ticket identifier. CTL-681.
export function parseIssueUpdatedEvent(event) {
  const name = event?.attributes?.["event.name"] ?? event?.event;
  if (name !== "linear.issue.updated") return null;
  const payload = event?.body?.payload ?? event?.detail ?? {};
  const identifier =
    event?.attributes?.["linear.issue.identifier"] ?? payload.ticket ?? payload.identifier ?? null;
  if (!identifier) return null;
  return {
    identifier,
    teamKey: payload.teamKey ?? null,
    toState: payload.toState ?? null,
    toLabels: payload.toLabels ?? null,
    toProject: payload.toProject ?? null,
    toPriority: typeof payload.toPriority === "number" ? payload.toPriority : null,
    // CTL-957: estimate from the event payload (may be undefined when absent).
    toEstimate:
      typeof payload.toEstimate === "number"
        ? payload.toEstimate
        : "toEstimate" in payload
          ? null
          : undefined,
    description: typeof payload.description === "string" ? payload.description : null, // CTL-749
    descriptionChanged: payload.descriptionChanged === true, // CTL-749
    actorId: payload.actorId ?? null, // CTL-749
    actorName: payload.actorName ?? null, // CTL-749
    // CTL-1174: delegate tri-state (KEY-PRESENCE mirrors toEstimate).
    // string → bot UUID set; null → explicitly cleared; undefined → absent (keep).
    toDelegate:
      typeof payload.toDelegateId === "string"
        ? payload.toDelegateId
        : "toDelegateId" in payload
          ? null
          : undefined,
  };
}

// parseCommentCreatedEvent — accept canonical OTel and legacy flat shapes.
// Returns null for anything that is not a linear.comment.created event. CTL-681.
export function parseCommentCreatedEvent(event) {
  const name = event?.attributes?.["event.name"] ?? event?.event;
  if (name !== "linear.comment.created") return null;
  const payload = event?.body?.payload ?? event?.detail ?? {};
  const ticket = event?.attributes?.["linear.issue.identifier"] ?? payload.ticket ?? null;
  return {
    ticket,
    commentId: payload.commentId ?? null,
    issueId: payload.issueId ?? null,
    body: payload.body ?? null,
    authorId: payload.authorId ?? null,
    authorName: payload.authorName ?? null,
  };
}

// ticketMatchesQuery — eligibility predicate for a linear.issue.updated fold.
// All conditions must hold: state matches, label matches (or no label filter),
// project matches (or no project filter), priority within floor (or no filter).
// Mirrors linear-query.mjs:144-148 priority semantics. CTL-681.
function ticketMatchesQuery(query, { toState, toLabels, toProject, toPriority }) {
  if (toState !== query.status) return false;
  if (query.label !== null) {
    if (!Array.isArray(toLabels) || !toLabels.includes(query.label)) return false;
  }
  if (query.project !== null && toProject !== query.project) return false;
  if (query.priority !== null) {
    if (typeof toPriority !== "number" || toPriority < 1 || toPriority > query.priority) {
      return false;
    }
  }
  return true;
}

// handleIssueUpdatedEvent — fold a linear.issue.updated event into the eligible
// projection by evaluating the ticket against each matching project's query.
// Upserts (newly eligible) or removes (no longer eligible) without a Linear poll.
// Never aborts a worker — this is a projection edit only. CTL-681.
export function handleIssueUpdatedEvent(
  event,
  {
    cache,
    abortWorker: _abortWorker, // accepted for signature symmetry, never invoked
    onUpdate, // CTL-749: optional issue-update subscriber
  } = {}
) {
  const parsed = parseIssueUpdatedEvent(event);
  if (!parsed) return;
  if (cache) cache.set(parsed.identifier, parsed.toState);
  for (const p of listProjects()) {
    const query = resolveEligibleQuery(p);
    if (query.team !== parsed.teamKey) continue;
    if (ticketMatchesQuery(query, parsed)) {
      const upd = {
        identifier: parsed.identifier,
        state: parsed.toState,
        priority: parsed.toPriority,
        project: parsed.toProject ?? null,
      };
      // CTL-957: forward estimate into the eligible projection when present
      // (undefined = absent from payload = keep stored value).
      if (parsed.toEstimate !== undefined) upd.estimate = parsed.toEstimate;
      // CTL-1174: forward delegate into the eligible projection when present
      // (undefined = absent from payload = keep stored value).
      if (parsed.toDelegate !== undefined) upd.delegate = parsed.toDelegate;
      upsertTicket(query.team, upd);
    } else {
      removeTicket(query.team, parsed.identifier);
    }
  }
  if (typeof onUpdate === "function") {
    try {
      onUpdate(parsed);
    } catch (err) {
      log.warn({ err: err.message }, "onUpdate subscriber threw — ignored");
    }
  }
}

// handleCommentCreatedEvent — parse a linear.comment.created event and surface
// it via a log.info line and an injectable onComment callback. No eligibility
// changes — this is a pure hook seam. CTL-681.
export function handleCommentCreatedEvent(event, { onComment } = {}) {
  const parsed = parseCommentCreatedEvent(event);
  if (!parsed) return;
  log.info(
    { ticket: parsed.ticket, commentId: parsed.commentId, authorId: parsed.authorId },
    "monitor: comment.created observed (CTL-681 hook seam)"
  );
  if (typeof onComment === "function") {
    try {
      onComment(parsed);
    } catch (err) {
      log.warn({ err: err.message }, "onComment subscriber threw — ignored");
    }
  }
}

// --- Reconcile -----------------------------------------------------------

// CTL-1397: the replica-backed board-list discovery reader, INJECTED by the
// daemon (daemon.mjs constructs `readLinearReplica().mode === "on" ?
// createReplicaReader() : undefined` in its bun-only context and passes it into
// startMonitor — see the Node-loadability note at the import block). `null` =
// no reader (mode off, or the Node broker which never injects one) → the reconcile
// path falls to the linearis exec, byte-identical to pre-CTL-1397.
let _injectedEligibleReplica = null;

// Teams that have been reconciled at least once — used by reconcileAll to
// detect teams dropped from the registry that must be dropProject'd.
const knownProjects = new Set();

// reconcileProject — the authoritative per-project rebuild, keyed by Linear
// team (CTL-582: the eligible projection and reconcile both key on `team`).
// Re-resolves the team's registry entry each call so an operator's registry
// edit is picked up without a daemon restart. A failed poll THROWS inside
// runEligibleQuery; we log and return, preserving the prior eligible set
// rather than flattening it to empty.
//
// CTL-867: a PERSISTENT per-team poll failure (e.g. the team's status references
// a removed Linear state, so `linearis issues list --team X --status Ready`
// exits 1 every tick) is no longer ONLY a buried log.error. Each call records
// the per-team reconcile outcome (recordReconcileSuccess / recordReconcileFailure);
// after N consecutive failures the health tracker escalates a canonical
// `monitor.reconcile.failing.<TEAM>` event onto the unified event log so the
// orch-monitor dashboard surfaces the silently-starving team, and a recovering
// poll clears the alert. `appendHealthEvent` is an injectable test seam — it
// also gates the CTL-1628 `monitor.reconcile.eligible_persist_failure.<TEAM>`
// event fired below when the eligible-set disk projection write fails.
export function reconcileProject(team, { exec, delegateExec, appendHealthEvent, replica, onSource } = {}) {
  const entry = getProjectConfig(team);
  if (!entry) {
    log.warn({ team }, "reconcile: no registry entry for team — skipping");
    return;
  }
  const query = resolveEligibleQuery(entry);
  let tickets;
  try {
    // CTL-1397: pass the replica-backed board-list reader (injectable for tests,
    // else the mode-gated module singleton) so discovery reads the local replica
    // instead of `linearis issues list` — immune to the shared Linear quota + the
    // CTL-679 circuit breaker. onSource logs a structured eligible_source marker
    // (value "replica"|"linearis") so OTEL/Loki can verify which source served.
    const eligibleSource =
      onSource ??
      ((source, count) =>
        log.info({ team, eligible_source: source, eligible_count: count }, "eligible: source"));
    tickets = runEligibleQuery(query, {
      exec,
      delegateExec,
      replica: replica ?? _injectedEligibleReplica,
      onSource: eligibleSource,
    });
  } catch (err) {
    log.error({ team, err: err.message }, "reconcile poll failed — preserving prior eligible set");
    // CTL-867: escalate persistent failures beyond the buried log line.
    recordReconcileFailure(
      team,
      err.message,
      appendHealthEvent ? { appendEvent: appendHealthEvent } : {}
    );
    return;
  }
  try {
    setProjectEligible(team, tickets, { source: "reconcile", query });
    // CTL-867/CTL-1628: reset the failure streak, refresh the
    // last-successful-refresh marker, and clear any standing alert only once
    // the projection has actually landed on disk. This used to run BEFORE the
    // persist try/catch (recorded as soon as the poll succeeded), which meant
    // a *persistent* persist fault (e.g. EACCES on the eligible dir) kept
    // reconcile-health — and by extension checkFleetFreeze, which reads
    // getReconcileHealth(team)?.alerting — permanently green while the
    // scheduler read a stale-forever projection (the CTL-1628 design gap:
    // "persist failures invisible to reconcile health state"). Moved here so
    // a persist failure now falls into the catch below instead of being
    // masked as success.
    recordReconcileSuccess(team, appendHealthEvent ? { appendEvent: appendHealthEvent } : {});
  } catch (err) {
    // A projection write/rename failure (disk full, permissions) must NOT
    // crash the daemon: reconcileProject runs inside reconcileAll, itself
    // driven by the setInterval reconcile timer, so an uncaught throw here
    // would kill the process. The in-memory eligible set is already current
    // (setProjectEligible updates the Map before persisting), so the next
    // reconcile tick retries the disk write.
    log.error(
      { team, err: err.message },
      "eligible-set projection write failed — daemon continues, retry next reconcile"
    );
    // CTL-1628: the log line above was invisible to the dashboard —
    // "monitoring green, scheduler stale". Escalate onto the unified event
    // log too, via the same appendHealthEvent test seam used for the CTL-867
    // reconcile-poll escalation above. Unlike that escalation this fires on
    // every failed persist (no threshold/latch — a stale-on-disk projection
    // is worth surfacing immediately, not after N consecutive misses).
    (appendHealthEvent ?? appendReconcileHealthEvent)({
      team,
      action: ELIGIBLE_PERSIST_FAILURE_ACTION,
      reason: err.message,
    });
    // CTL-1628: ALSO feed this into the same N-consecutive escalation/
    // alert-latch tracker recordReconcileFailure already drives for poll
    // failures, so a *persistent* persist fault escalates monitor.reconcile.
    // failing and holds checkFleetFreeze's alerting flag true — exactly like
    // a persistent poll fault does — instead of the marker staying frozen
    // "healthy" forever. The `eligible-persist-failed:` prefix distinguishes
    // a persist-origin streak from a poll-origin streak in the health marker
    // / dashboard without adding a second tracked dimension. `origin: "persist"`
    // (CTL-1628 r2) additionally lets recordReconcileSuccess's eventual
    // recovery event name the stage that actually recovered, rather than
    // hard-coding "reconcile-poll-succeeded" for a streak the poll never failed.
    recordReconcileFailure(
      team,
      `eligible-persist-failed: ${err.message}`,
      { origin: "persist", ...(appendHealthEvent ? { appendEvent: appendHealthEvent } : {}) }
    );
  }
}

// reconcileAll — full reconcile of every registered team (the missed-webhook
// backstop). Re-reads registry.json each call so a team added to the registry
// is picked up and one removed is dropped within one tick.
export function reconcileAll({ exec, delegateExec, appendHealthEvent, fleetFreezeAppend } = {}) {
  const projects = listProjects();
  const seen = new Set(projects.map((p) => p.team));
  for (const p of projects) reconcileProject(p.team, { exec, delegateExec, appendHealthEvent });
  for (const stale of knownProjects) {
    if (!seen.has(stale)) {
      dropProject(stale);
      log.info({ team: stale }, "team no longer in the registry — dropped");
    }
  }
  knownProjects.clear();
  for (const t of seen) knownProjects.add(t);
  // CTL-1420: after every team reconciled this pass, roll the per-team reconcile
  // health up into a fleet-frozen-for-admission alert. When EVERY registered team
  // is in a persistent-failure state, the eligible projection can refresh from
  // neither the replica nor linearis — new work is frozen fleet-wide, which used
  // to be silent (reconcileProject just preserves the empty prior set). Latched +
  // best-effort inside checkFleetFreeze; a team's recovery clears it.
  //
  // CTL-1628 r3: getTeamOrigin threads each team's failure origin ("poll" |
  // "persist", from reconcile-health.mjs's lastFailureOrigin) so checkFleetFreeze
  // can tell the documented replica+linearis double outage (all-poll) apart
  // from an all-teams local disk fault (all-persist) — same alert name, an
  // accurate cause instead of an operator chasing the wrong subsystem.
  checkFleetFreeze({
    teams: [...seen],
    isTeamFrozen: (t) => getReconcileHealth(t)?.alerting === true,
    isTeamFailing: (t) => (getReconcileHealth(t)?.consecutiveFailures ?? 0) > 0,
    getTeamOrigin: (t) => getReconcileHealth(t)?.lastFailureOrigin ?? "poll",
    getTeamLastSuccess: (t) => getReconcileHealth(t)?.lastSuccessTs ?? null,
    getTeamLastFailureMessage: (t) => getReconcileHealth(t)?.lastFailureMessage ?? null,
    bootTs: MONITOR_BOOT_TS,
    ...(fleetFreezeAppend ? { append: fleetFreezeAppend } : {}),
  });
}

// --- Event-driven fast path ---------------------------------------------

// handleStateChangedEvent — fold one state_changed event into the eligible
// sets of every project whose query team matches the event's team.
//
// CTL-565 + CTL-584 + CTL-681 — the toState branch is a four-way split:
//   →triageStatus              one-shot-dispatches the triage phase agent
//                              (NOT the eligible set — a Triage ticket is
//                              never scheduler-pulled).
//   →status (Ready)            no-op (CTL-681 removed the per-event scoping
//                              poll). If the ticket has no triage.json the
//                              one-shot triage auto-dispatch still fires
//                              (CTL-625); otherwise the periodic reconcile
//                              picks it up on the next 10-min tick.
//   →DRAG_OUT_STATES           the leave-path — confident immediate removal
//                              + abortWorker on the in-flight worker.
//   anything else (pipeline)   no-op. Research/Plan/Implement/Validate/PR/
//                              Done are the daemon's own CTL-558 write-backs
//                              echoed back; an unknown state is conservatively
//                              treated as a hand-edit we don't recognize.
//
// `exec` and `debounceMs` are kept in the signature for backwards-compat with
// the previous reconcile-on-event contract; they are now unused inside the
// function. Removing them would break call sites that still pass them.
export function handleStateChangedEvent(
  event,
  {
    exec: _exec, // CTL-681: retained for signature compat; no longer triggers a poll
    debounceMs: _debounceMs = EVENT_DEBOUNCE_MS, // CTL-681: retained for signature compat; unused
    dispatch,
    orchDir,
    abortWorker = defaultAbortWorker,
    cache, // CTL-634: write-through target shared with the scheduler read path
    applyTriageStatus = defaultApplyTriageStatus, // CTL-704: injectable for tests
    appendEvent = defaultAppendEvent, // CTL-704: injectable for tests
    // CTL-731 Phase 00: fold-only mode for the boot/large-gap catch-up. When true,
    // apply only the idempotent projection folds (cache.set + upsert/removeTicket)
    // and SKIP every dispatch side-effect (dispatchTriage, abortWorker). The boot
    // gap-drain re-reads events already acted on before the restart; re-running
    // their spawns both blocks startMonitor (synchronous `claude --bg` / linearis
    // bursts) and double-dispatches triage. Live side-effects fire only on the
    // steady-state poll/watch path (foldOnly defaults to false).
    foldOnly = false,
    // CTL-716: slot-gate seams. concurrency/readMaxParallelFn/liveBackgroundCount
    // resolve the ceiling; triageBudget is a shared per-drain budget from
    // readNewEvents (undefined → compute one for this single call).
    concurrency = {},
    readMaxParallelFn = readMaxParallel,
    liveBackgroundCount = () => countBackgroundAgents(),
    // CTL-1367 P1: dispatch mode + SDK-occupancy reader for the triage budget when
    // this call computes its own (no shared triageBudget). Default "phase-agents" →
    // byte-identical bg budget. Threaded from startMonitor via tailerOpts.
    dispatchMode = "phase-agents",
    countSdkInflight = defaultCountSdkInflight,
    // CTL-1457 (N1): per-phase in-process route flag → the computed budget (below)
    // arms the SDK-occupancy term on a bg node. Default false → unchanged.
    hasInProcessRoute = false,
    triageBudget,
    // CTL-781: respect-assignment + self-assign seams.
    botUserIds,
    botWriteId,
    gateway,
    fetchAssignee = fetchTicketAssignee,
    applyAssignee = defaultApplyAssignee,
    // CTL-862: cross-host coordination seams.
    hosts = undefined,
    hostName = undefined,
    // CTL-1091: surviving-roster override → threaded through to dispatchTriage's
    // live-roster ownership gate (undefined → real heartbeat feed; tests inject).
    survivingRosterOverride = undefined,
    claimDispatch = claimDispatchSync,
    // CTL-1095: drain gate seam — thread through to dispatchTriage.
    isDraining = (dir) => isDrainingDefault(dir),
    anchorIssue = undefined,
    // CTL-1367 P1: failed-terminal backstop for a rejected async (sdk) triage
    // dispatch — threaded through to dispatchTriage (undefined → real default).
    emitBackstop,
    // CTL-1481: worker:<host> label-stamp seam — threaded through to
    // dispatchTriage (undefined → real default; tests inject a fake).
    stampWorkerLabel,
    readFenceTriageAttempt = readTriageAttemptCountSync,
    bumpFenceTriageAttempt = bumpTriageAttemptCountSync,
  } = {}
) {
  const parsed = parseStateChangedEvent(event);
  if (!parsed) return;
  // CTL-634: write-through — refresh the cached state so the next scheduler
  // tick's out-of-set blocker hydration is a hit instead of a re-read. set()
  // ignores a null toState, so an event without an extractable state is a safe
  // no-op. Runs before the project loop because the cache is keyed by ticket
  // identifier, independent of which project's eligible set the event touches.
  if (cache) cache.set(parsed.identifier, parsed.toState);
  // CTL-716: compute budget once per call (not per project-loop iteration) so
  // multiple matching projects share the same slot budget. When a shared per-drain
  // triageBudget is provided by readNewEvents, use it; otherwise build one for this
  // single call. Either way, the budget gates all dispatchTriage calls below.
  const budget =
    triageBudget ??
    computeTriageBudget({ orchDir, concurrency, readMaxParallelFn, liveBackgroundCount, dispatchMode, countSdkInflight, hasInProcessRoute });
  for (const p of listProjects()) {
    const query = resolveEligibleQuery(p);
    if (query.team !== parsed.teamKey) continue;

    if (parsed.toState === query.triageStatus) {
      // →Triage — one-shot dispatch the triage phase agent. NOT the eligible
      // set: a Triage ticket is never scheduler-pulled. Idempotent downstream
      // (phase-agent-dispatch no-ops an existing signal file).
      // CTL-731: skipped during the fold-only boot drain (no eligible fold here,
      // so the entire branch is a no-op when foldOnly).
      if (!foldOnly) {
        dispatchTriage(parsed.identifier, {
          dispatch,
          orchDir,
          applyTriageStatus,
          appendEvent,
          orchId: parsed.identifier,
          budget, // CTL-716
          botUserIds,
          botWriteId,
          gateway,
          fetchAssignee,
          applyAssignee,
          hosts,
          hostName,
          anchorIssue,
          readFenceTriageAttempt,
          bumpFenceTriageAttempt,
          survivingRosterOverride, // CTL-1091
          claimDispatch, // CTL-862
          isDraining, // CTL-1095
          emitBackstop, // CTL-1367 P1
          stampWorkerLabel, // CTL-1481
        });
      }
    } else if (!parsed.toState || parsed.toState === query.status) {
      // →Ready (or an unknown new state). CTL-625: a confirmed →Ready
      // (toState === query.status) for a ticket with no prior triage.json means
      // the user moved Backlog→Ready directly, skipping →Triage. Auto-dispatch
      // triage (same seam as →Triage) so "Ready" transparently triages-then-
      // proceeds instead of dead-locking the research prior-artifact gate. The
      // triage agent's phase.triage.complete advances the ticket to research
      // via the scheduler's advancement sweep, so we do NOT also reconcile
      // here.
      //
      // CTL-681: anything that does NOT trigger the triage auto-dispatch
      // (an already-triaged Ready, an unknown new state, or a standalone
      // monitor with no orchDir) is a NO-OP here. The handleIssueUpdatedEvent
      // fold (wired below readNewEvents) handles label/project/priority changes
      // incrementally without a poll. The 10-min reconcile remains the
      // missed-webhook backstop.
      //
      // CTL triage-entry fix (Phase 0): a →status (Todo) transition arrives as a
      // `state_changed` event, which handleIssueUpdatedEvent ignores (it only
      // folds `linear.issue.updated`). Without this fold a ticket entering Todo
      // is invisible to the scheduler until the 10-min reconcile. Fold it into
      // the eligible projection here, straight from the event payload (no Linear
      // poll), mirroring handleIssueUpdatedEvent's upsert.
      if (parsed.toState === query.status && ticketMatchesQuery(query, parsed)) {
        upsertTicket(query.team, {
          identifier: parsed.identifier,
          state: parsed.toState,
          priority: parsed.toPriority,
          project: parsed.toProject ?? null,
        });
      }
      if (
        !foldOnly && // CTL-731: boot drain folds eligibility only, no dispatch
        parsed.toState === query.status &&
        orchDir &&
        !hasTriageArtifact(orchDir, parsed.identifier)
      ) {
        dispatchTriage(parsed.identifier, {
          dispatch,
          orchDir,
          applyTriageStatus,
          appendEvent,
          orchId: parsed.identifier,
          budget, // CTL-716
          botUserIds,
          botWriteId,
          gateway,
          fetchAssignee,
          applyAssignee,
          hosts,
          hostName,
          anchorIssue,
          readFenceTriageAttempt,
          bumpFenceTriageAttempt,
          survivingRosterOverride, // CTL-1091
          claimDispatch, // CTL-862
          isDraining, // CTL-1095
          emitBackstop, // CTL-1367 P1
          stampWorkerLabel, // CTL-1481
        });
      } else {
        log.debug(
          {
            ticket: parsed.identifier,
            team: p.team,
            toState: parsed.toState,
          },
          "monitor: →Ready event (no triage dispatch); handleIssueUpdatedEvent folds projection, 10-min reconcile backstop (CTL-681)"
        );
      }
    } else if (DRAG_OUT_STATES.has(parsed.toState)) {
      // Drag-out to Backlog/Canceled/Duplicate — kill signal. Confident
      // immediate removal, then abort any in-flight worker and tear down its
      // worktree. removeTicket persists the projection itself; removing a
      // non-member is a safe no-op. abortWorker no-ops when the ticket was
      // never dispatched.
      removeTicket(p.team, parsed.identifier);
      // CTL-731: removeTicket is an idempotent fold (kept on the boot drain);
      // abortWorker is a side-effect (kill + worktree teardown) — skip it during
      // the fold-only catch-up so a restart does not re-abort a worker for a
      // drag-out already handled before the downtime.
      if (!foldOnly && orchDir) {
        abortWorker(orchDir, parsed.identifier, { repoRoot: p.repoRoot });
      }
    } else {
      // Pipeline state (the daemon's own CTL-558 write-back —
      // Research/Plan/Implement/Validate/PR/Done) or an unknown state. No-op:
      // the daemon must never kill its own worker on hearing its own write-
      // back echoed through the broker, and an unknown state is conservatively
      // treated as a hand-edit we don't recognize (let the next reconcile sort
      // it out — a missed kill is safe, a wrong kill destroys live work).
      // CTL-584.
      log.debug(
        { ticket: parsed.identifier, toState: parsed.toState },
        "monitor: non-trigger toState — no-op"
      );
    }
  }
}

// computeTriageBudget — read the slot ceiling + live bg count ONCE and return
// a mutable budget the caller spends across a single event-drain or sweep.
// Mirrors schedulerTick's per-tick single read (CTL-716). Defaults source the
// same primitives the scheduler uses; tests inject both to stay deterministic.
// CTL-1367 P1: exported so the SDK-occupancy gating is unit-testable in CI.
export function computeTriageBudget({
  orchDir,
  concurrency = {},
  readMaxParallelFn = readMaxParallel,
  liveBackgroundCount = () => countBackgroundAgents(),
  // CTL-1367 P1: catalyst.dispatch.mode for this node ("sdk" under executor=sdk).
  // Gates the SDK-occupancy term so the bg/oneshot-legacy budget is byte-identical.
  dispatchMode = "phase-agents",
  // CTL-1367 P1: executor=sdk occupancy reader (in-process SDK workers have no
  // `claude --bg` job → invisible to liveBackgroundCount). Injectable for tests.
  countSdkInflight = defaultCountSdkInflight,
  // CTL-1457 (N1): true when executorByPhase routes ANY phase to an in-process
  // executor (sdk|codex-exec) while the node boot dispatchMode is still bg — the
  // per-phase rollout. ORed into the gate so the routed no-bg triage worker is
  // counted on a bg node. Default false → byte-identical when nothing routes.
  hasInProcessRoute = false,
} = {}) {
  const maxParallel = readMaxParallelFn(orchDir, concurrency);
  const live = liveBackgroundCount();
  // CTL-1367 P1: under executor=sdk add the in-process SDK workers' occupancy so the
  // →Triage budget counts them like bg jobs and a webhook drain / sweepMissingTriage
  // can't dispatch past maxParallel while prior SDK triage queries run/queue behind
  // the semaphore. CTL-1457 (T2): codex-exec prelaunches write the SAME no-bg_job_id
  // signals and queue behind their own semaphore, so gate on isInProcessDispatchMode
  // (sdk OR codex-exec) → still 0 under bg/oneshot-legacy (byte-identical). CTL-1457
  // (N1): also arm when a per-phase in-process route is present on a bg node — the
  // triage phase routed to codex-exec/sdk writes the same no-bg signal.
  let sdkInflight = 0;
  if (isInProcessDispatchMode(dispatchMode) || hasInProcessRoute) {
    try {
      sdkInflight = countSdkInflight(orchDir);
    } catch {
      /* best-effort — never block triage admission on a signal-scan failure */
    }
  }
  return { remaining: computeFreeSlots(maxParallel, live + sdkInflight) };
}

// CAT-82: per-sweep hold accumulator. Optional so one-off webhook dispatches
// retain their existing per-ticket INFO visibility.
export function createHoldTally() {
  const held = Object.create(null);
  let considered = 0;
  return {
    consider() { considered += 1; },
    record(reason) { held[reason] = (held[reason] ?? 0) + 1; },
    snapshot() { return { considered, held: { ...held } }; },
  };
}

// dispatchTriage — fire the triage phase agent for a →Triage transition. Guards
// a missing orchDir (a standalone monitor with no daemon wiring) and logs —
// never throws — a non-zero dispatch. CTL-704: after a successful dispatch,
// writes Linear Todo→Triage (verified) and emits a canonical observability event.
// CTL-716: budget param — a mutable { remaining } object; when provided and
// remaining <= 0, the dispatch is deferred (dropped; sweepMissingTriage retries).
// Only decrements on a successful (code === 0) dispatch. Returns true on success.
function dispatchTriage(
  identifier,
  {
    dispatch,
    orchDir,
    applyTriageStatus = defaultApplyTriageStatus,
    appendEvent = defaultAppendEvent,
    orchId,
    budget,
    // CTL-781: respect-assignment + self-assign seams.
    botUserIds,
    botWriteId,
    gateway,
    fetchAssignee = fetchTicketAssignee,
    // Stage 0 / A1: the daemon-injected replica reader (createReplicaReader, with an
    // ownership() method), so the CTL-1174 gate consults local ownership FIRST and
    // only falls through to the live confirm on a replica miss. Defaults to the
    // module singleton the daemon set (mirrors reconcileProject's replica default);
    // undefined on the Node broker / mode-off → the live path, byte-identical to today.
    replica = _injectedEligibleReplica,
    applyAssignee = defaultApplyAssignee,
    // CTL-862: cross-host coordination seams (left undefined → single-host fallback).
    hosts = undefined,
    hostName = undefined,
    // CTL-1091: injectable surviving-roster override for the ownership gate below,
    // mirroring the scheduler's dispatchSurvivingRoster. Default undefined →
    // resolveDispatchRoster (positive-liveness → restore-deflap → outage fail-safe),
    // called read-only (persist:false) — the SAME gate the scheduler's new-work
    // path uses, so the two dispatch sites can never drift. (computeDispatchSurvivingRoster
    // is the positive-liveness-only sub-step, exported/unit-tested but NOT the live
    // composition — the live path adds the deflap.) Tests inject a fixed survivor
    // set to drive the offline-owner failover deterministically.
    survivingRosterOverride = undefined,
    claimDispatch = claimDispatchSync,
    // CTL-1481: best-effort worker:<host> label stamp, fired right after a won
    // multi-host triage claim (same gate as emitFenceClaimed). Injectable so
    // tests drive/assert the stamp without touching Linear.
    stampWorkerLabel = defaultStampWorkerLabel,
    // CAT-159: normally threaded down from startMonitor (resolved once per
    // scan). Defaulted to the real cached accessor rather than `undefined` so a
    // caller that forgets to thread it still gets the exclusion — losing the
    // guard is the failure mode this ticket exists to prevent. Tests pass an
    // explicit value (including null) and the suite clears the env anchor, so
    // the default never makes a verdict host-dependent.
    anchorIssue = resolveAnchorIssueCached(),
    // CTL-1095: drain gate — node-level refusal of new-triage admission.
    isDraining = (dir) => isDrainingDefault(dir),
    // CTL-1367 P1: failed-terminal backstop for a REJECTED async (sdk) triage
    // dispatch. undefined → backstopOnRejection applies the real defaultEmitBackstop;
    // tests inject a spy. The bg path is synchronous → the detached handler never
    // fires, so this is a no-op on bg.
    emitBackstop,
    // CTL-1441: needs-human application at the re-dispatch cap. Injectable so
    // tests never spawn a real linearis write; default = the label-guard path.
    labelNeedsHuman = (dir, t) =>
      routeStuckTicketToDelegate(dir, t, {
        site: "triage-redispatch-cap",
        reason: "triage-redispatch-cap",
        boardContext: { cap: TRIAGE_DISPATCH_CAP },
        applyLabel: { applyLabel },
        explanation: {
          problem: `${t} hit the triage re-dispatch cap (${TRIAGE_DISPATCH_CAP})`,
          call_to_action: `triage ${t} manually or re-scope it`,
        },
        // CTL-1609 (Codex P1): supply the configured ceiling so
        // enqueueDelegateIntent can reach `queue-full` → human instead of
        // defaulting to Infinity. Lazy: the state.json read is paid only on the
        // enforce path that actually enqueues.
        deps: { orchDir: dir, maxParallel: () => readMaxParallel(dir) },
      }),
    // CTL-1589 (Codex R3): when set (the sweep's Triage-BOARD candidates), the
    // ticket's LIVE state must still equal this workflow-state name at launch.
    // null/undefined (the webhook path, eligible-half candidates) skips the check.
    requireTriageState = null,
    fetchLiveState = defaultFetchTicketState,
    // CTL-1589 (Codex R7): the candidate row's replica updatedAt (ISO). A row
    // updated AFTER a cached negative verdict invalidates the marker — the
    // ticket may have legitimately re-entered Triage.
    candidateUpdatedAt = null,
    // CTL-1649: fleet-wide triage attempt count seams (multiHost-gated).
    // Defaults to the sync implementations (TTL-cached in cluster-claim-sync.mjs).
    // Single-host paths never call these.
    readFenceTriageAttempt = readTriageAttemptCountSync,
    bumpFenceTriageAttempt = bumpTriageAttemptCountSync,
    holdTally = null,
  }
) {
  // CAT-159: the durable cross-host liveness-anchor ticket (config
  // catalyst.cluster.livenessAnchorIssue) has no completion criteria — it
  // exists permanently as an attachment point for heartbeat records. It has
  // nothing to research/implement, so dispatching it here always fails,
  // escalates to recovery-pass, self-heal-exhausts, and needs a human to
  // manually clear it back into the identical loop. Checked FIRST — before
  // orchDir/drain/HRW — so this never costs a Linear call, not even a read,
  // and before every budget/counter side effect. Sibling correctness gate to
  // dispatch-readiness.mjs's new-work admission check and board-health.mjs's
  // recovery suppression: all three route through the one shared predicate so
  // they can never disagree.
  if (isLivenessAnchorTicket(identifier, { anchorIssue })) {
    log.debug(
      { identifier },
      "cat-159: skipping triage dispatch for catalyst.cluster.livenessAnchorIssue"
    );
    return false;
  }
  if (!orchDir) {
    log.warn({ identifier }, "→Triage seen but monitor has no orchDir — skipping dispatch");
    return false;
  }
  holdTally?.consider();
  // CTL-1095: drain gate — refuse new triage dispatch before HRW filter.
  if (isDraining(orchDir)) {
    log.debug({ identifier }, "drain: skipping triage dispatch — node draining (CTL-1095)");
    return false;
  }
  // CTL-862/CTL-1057: HRW ownership filter. Resolve roster/self lazily per call
  // so hot roster reloads need no restart. Single-host (multiHost===false) is a
  // TRUE no-op regardless of whether the lone roster entry string-matches the
  // resolved hostName (stale/aliased hosts.json). HRW filtering engages only
  // when roster.length > 1, matching the multiHost gate on the claim below.
  const roster = hosts ?? getClusterHosts();
  const self = hostName ?? getHostName();
  const multiHost = roster.length > 1;
  // CTL-1057: loud one-time warning when this host is absent from a multi-host roster.
  const _mw = hostMembershipWarning(roster, self);
  if (_mw && !globalThis.__ctl1057_monitor_warned) {
    globalThis.__ctl1057_monitor_warned = true;
    log.warn({ roster, self }, _mw);
  }
  // CTL-1091: ownership over the LIVE roster (positive-liveness + restore-deflap +
  // outage fail-safe), so a →Triage ticket whose HRW owner is offline is triaged by
  // a live host instead of stranding. Computed via the SAME resolveDispatchRoster
  // the scheduler's new-work gate uses, so the two dispatch sites can never drift
  // out of sync. READ-ONLY here (persist:false) — the scheduler tick is the sole
  // writer of .liveness-deflap.json. The heartbeat sync wrappers cache (Loki 20s /
  // Linear 45s) so per-call reads coalesce. Only computed multi-host.
  let dispatchRoster;
  if (!multiHost) {
    dispatchRoster = roster;
  } else if (Array.isArray(survivingRosterOverride)) {
    // Test override bypasses both the heartbeat read and the deflap.
    dispatchRoster = survivingRosterOverride;
  } else {
    dispatchRoster = resolveDispatchRoster({
      roster,
      orchDir,
      self,
      nowMs: Date.now(),
      persist: false,
    });
  }
  if (multiHost && !ownedBy(identifier, dispatchRoster, self)) {
    log.debug(
      { identifier, self, roster, dispatchRoster },
      "ctl-1091: ticket not owned by this host under HRW over the live roster — skipping triage dispatch"
    );
    return false;
  }
  // CTL-1441 guard (b) — placed BEFORE the capacity gate (Codex R4: parking is
  // capacity-independent; at a saturated fleet the budget return would keep a
  // capped ticket invisible forever) and AFTER the drain/HRW gates (only the
  // owner parks). The needs-human apply retries every capped sweep — labelOnce's
  // markers are the idempotence guard (a transient Linear failure leaves none);
  // cappedAt in the counter record gates only the duplicate WARN. Re-arm by
  // deleting orchDir/.triage-dispatch-counts/<ticket>.json.
  // CTL-1649: use fleet-wide count (max of host-local and fence) so an ownership
  // churn cannot restart the counter at 0 on the new owner.
  if (fleetTriageDispatchCount(orchDir, identifier, { multiHost, readFenceCount: readFenceTriageAttempt }) >= TRIAGE_DISPATCH_CAP) {
    // Codex R2: the final allowed attempt may still be RUNNING — triage.json is
    // naturally absent until it finishes. Defer the park while in flight.
    if (isTriageInFlight(readTriageSignalStatus(orchDir, identifier))) return false;
    try {
      labelNeedsHuman(orchDir, identifier);
    } catch (err) {
      log.warn({ identifier, err: err.message }, "ctl-1441: needs-human label at triage cap threw — continuing");
    }
    if (markTriageCapped(orchDir, identifier)) {
      log.warn(
        { identifier, cap: TRIAGE_DISPATCH_CAP },
        "ctl-1441: triage re-dispatch cap reached — parked needs-human; delete .triage-dispatch-counts/<ticket>.json to re-arm",
      );
    }
    return false;
  }
  if (budget && budget.remaining <= 0) {
    log.info(
      { identifier },
      "monitor: triage dispatch deferred — no free slots (maxParallel); sweepMissingTriage will retry (CTL-716)"
    );
    return false;
  }
  // CTL-781/CTL-1174: respect-assignment + delegate gate. A →Triage/→Todo
  // ticket assigned to a human, or delegated to a non-bot, is not ours.
  // Gateway-first, live read on miss; unknown holds (sweepMissingTriage
  // retries next reconcile). Empty/absent botUserIds disables the gate
  // (CTL-749 fail-open convention).
  if (botUserIds instanceof Set && botUserIds.size > 0) {
    const a = fetchAssignee(identifier, { gateway, replica });
    if (!a.known) {
      // Unreadable delegate → HOLD (sweepMissingTriage retries next reconcile).
      holdTally?.record("delegate-unreadable");
      const fields = { identifier, known: false };
      if (holdTally) log.debug(fields, "monitor: triage dispatch held — delegate unreadable (CTL-1174)");
      else log.info(fields, "monitor: triage dispatch held — delegate unreadable (CTL-1174)");
      return false;
    }
    if (a.delegate == null) {
      // CTL-1174 DELEGATE-ON-TODO: an undelegated Todo ticket is claimed by
      // DELEGATING it to the orchestrator now (the assignee is irrelevant), then
      // HELD this tick — it dispatches once the delegate lands in the cache
      // (webhook-projected). This is what gets queued-but-untriaged items moving.
      const d = applyAssignee({ ticket: identifier, userId: botWriteId });
      // CTL-1744: stamp WHEN the claim was made, so board-health's
      // dispatchLiveness can tell this legitimate two-pass wait from a wedge.
      // Only on a confirmed apply — an unapplied claim is not a wait we should
      // excuse, and stamping it anyway would suppress a real stall.
      if (d.applied === true) recordDelegateClaim(orchDir, identifier);
      log.info(
        { identifier, applied: d.applied, reason: d.reason },
        "monitor: delegated to orchestrator — will dispatch once delegate lands (CTL-1174)"
      );
      return false;
    }
    if (!isClaimable(a.assignee, a.delegate, botUserIds)) {
      // Delegated to a different actor (another bot/human) → not ours.
      log.info(
        { identifier, delegate: a.delegate ?? null },
        "monitor: triage dispatch skipped — delegated to another actor (CTL-1174)"
      );
      return false;
    }
  }
  // CTL-862: cross-host claim soft-CAS immediately before the spawn. Skipped on
  // single-host (no Linear write). A lost claim is NOT a failure — defer cleanly.
  // CTL-1028: lift claim.generation out of the block so it can be forwarded to
  // the triage worker as CATALYST_CLUSTER_GENERATION (mirrors CTL-864 scheduler
  // path). null on single-host → writeClusterGeneration and dispatchTicket both
  // treat null as a no-op (fence token is omitted from the env).
  // CTL-1589 (Codex R3+R4): live revalidation for a Triage-BOARD candidate.
  // Placement is deliberate on BOTH sides: AFTER the drain/HRW/delegate/cap
  // gates (R3 P1 — the bare live read fires only for a dispatch this host would
  // genuinely make, so the rate is bounded by launch attempts, never a
  // per-sweep/per-candidate probe) and BEFORE the cross-host claim (R4 P1 — a
  // skip must not bump the fence generation out from under a live later-phase
  // worker holding the current one). A replica row can have MISSED the ticket's
  // exit from Triage (delivery hole), and the CTL-758 guard refuses only
  // TERMINAL backward writes — without this check the later status write could
  // drag an advanced ticket back to Triage. FAIL-CLOSED (R4 P1): an unreadable
  // live state skips this sweep — a stranded ticket loses one cycle (the next
  // sweep retries), while proceeding blind could double-launch AND regress the
  // ticket's state. No verdict caching: a cached positive could go stale after
  // a failed dispatch and redispatch an advanced ticket on the next sweep.
  if (requireTriageState) {
    // NEGATIVE-verdict cache (Codex R6): a failed validation is not a launch,
    // so a persistently-stale row (unhealed delivery hole) would otherwise pay
    // one bare read per sweep forever. Caching ONLY negatives keeps R4's
    // no-stale-positive property — a fresh negative marker just extends the
    // skip of an already-skipped ticket, and expiry re-reads (2 reads/hour cap
    // per stuck ticket).
    const revalDir = join(orchDir, ".triage-revalidate");
    const revalPath = join(revalDir, `${identifier}.json`);
    try {
      const m = JSON.parse(readFileSync(revalPath, "utf8"));
      const rowMs = candidateUpdatedAt ? Date.parse(candidateUpdatedAt) : NaN;
      // A replica row updated AFTER the verdict invalidates it (Codex R7): the
      // ticket may have legitimately re-entered Triage since the negative.
      const invalidated = Number.isFinite(rowMs) && typeof m?.ts === "number" && rowMs > m.ts;
      if (!invalidated && typeof m?.ts === "number" && Date.now() - m.ts < TRIAGE_REVALIDATE_NEGATIVE_MS) {
        log.debug(
          { identifier, cachedLive: m.live ?? null },
          "dispatchTriage: Triage-board revalidation negative still cached — skipping without a read (CTL-1589)"
        );
        return false;
      }
    } catch {
      /* absent/corrupt marker → read */
    }
    let live = null;
    try {
      // AUTHORITATIVE read only (Codex R7): no gateway/replica tier — a ≤60s
      // cached "Triage" from the webhook-fed descriptor store could approve a
      // duplicate launch on a just-advanced ticket, and the replica is the very
      // source being audited. The negative cache above owns the read-rate
      // bound, so the bare read stays ≤2/hour per stuck candidate.
      live = fetchLiveState(identifier);
    } catch {
      live = null;
    }
    if (live !== requireTriageState) {
      try {
        mkdirSync(revalDir, { recursive: true });
        writeFileSync(revalPath, JSON.stringify({ ts: Date.now(), live }));
      } catch {
        /* marker is best-effort; worst case is a re-read next sweep */
      }
      log.info(
        { identifier, live, expected: requireTriageState },
        live == null
          ? "dispatchTriage: Triage-board candidate's live state unreadable — holding this sweep (CTL-1589)"
          : "dispatchTriage: replica Triage row is stale — ticket already advanced; skipping (CTL-1589)"
      );
      return false;
    }
    // Positive: clear any expired negative so a healed ticket never waits on
    // stale forensics. Best-effort.
    try {
      renameSync(revalPath, `${revalPath}.cleared`);
    } catch {
      /* no marker to clear */
    }
  }
  let clusterGeneration = null;
  if (multiHost) {
    const claim = claimDispatch({ ticket: identifier, hostName: self, phase: "triage" });
    if (!claim.won) {
      log.debug(
        { identifier, self },
        "ctl-862: lost cross-host claim — another host owns this triage dispatch, deferring"
      );
      return false;
    }
    clusterGeneration = claim.generation; // CTL-1028: forward to worker (mirrors CTL-864)
  }
  // CTL-1441 guard (a), placed HERE (post-gates, post-claim, launch imminent —
  // Codex R3): a done phase-triage.json with triage.json missing is the
  // artifact-mismatch class; the launcher short-circuits done signals as
  // idempotent no-ops, so the stale completion signal is RETIRED (rename,
  // forensics kept) immediately before a REAL launch. Doing this in the sweep
  // (pre-gates) could strip the signal on a node that then never launches
  // (HRW/drain/delegate/claim skip) — leaving the ticket with NEITHER artifact.
  const preLaunchStatus = readTriageSignalStatus(orchDir, identifier);
  if (preLaunchStatus === "done" && !hasTriageArtifact(orchDir, identifier)) {
    const sigPath = join(orchDir, "workers", identifier, "phase-triage.json");
    try {
      renameSync(sigPath, `${sigPath}.stale-ctl1441`);
      const warned = join(orchDir, "workers", identifier, ".triage-artifact-mismatch-warned");
      if (!existsSync(warned)) {
        try {
          writeFileSync(warned, new Date().toISOString());
        } catch { /* best-effort */ }
        log.warn(
          { identifier },
          "ctl-1441: phase-triage.json was done but triage.json is missing — retired the stale signal for a real re-triage (bounded by the dispatch cap)",
        );
      }
    } catch (err) {
      log.warn(
        { identifier, err: err.message },
        "ctl-1441: could not retire the stale done triage signal — skipping this dispatch (a counted no-op would burn the cap)",
      );
      return false;
    }
  }
  // CTL-1441: count the REAL spawn attempt — post-gates, post-claim, and BEFORE
  // the launch so a spawn that dies without ever writing a signal (the
  // no-artifacts class) still counts toward the cap. Unbounded silent failure
  // is exactly the loop this bounds.
  // Codex P1 + R3: do NOT count idempotent no-ops — an in-flight signal
  // (dispatched/running/pending; the CTL-615 yield) OR a surviving done signal
  // (only possible when triage.json exists, since the mismatch case was just
  // retired above; the launcher short-circuits it). A dead-frozen "running"
  // signal is reset to stalled by the reclaim/revive path, after which counting
  // resumes; "failed"/"stalled" re-dispatches launch real workers and count.
  // CTL-1744: the two-pass wait is over — this ticket is launching, so drop its
  // delegate-claim marker. Pure housekeeping: a surviving marker would expire on
  // its own once `now - claimedAt` passes graceMs, so this can never be
  // load-bearing for correctness, only for keeping .delegate-claims/ bounded.
  clearDelegateClaim(orchDir, identifier);
  const statusAtLaunch = readTriageSignalStatus(orchDir, identifier);
  // CTL-1367 P1: settle an async (executor=sdk) dispatch synchronously. bg returns a
  // plain object (passthrough → byte-identical). sdk returns a Promise whose
  // synchronous prelaunch already wrote the triage `dispatched` signal;
  // settleDispatchSync detaches the in-process query and confirms success from that
  // signal (SDK-aware: no bg_job_id required) so the triage dispatch isn't recorded
  // as a failure while the query runs detached.
  const r = settleDispatchSync(
    dispatchTicket(orchDir, identifier, "triage", { dispatch, clusterGeneration }),
    {
      verifySync: () => sdkSignalRunnable(orchDir, identifier, "triage"),
      // CTL-1367 P1: on a REJECTED async (sdk) triage dispatch, flip the triage
      // signal to stalled + emit phase.triage.failed.<ticket> so the ticket can't
      // strand at "dispatched"; sweepMissingTriage re-attempts on the next reconcile.
      onSettled: backstopOnRejection(
        { orchDir, ticket: identifier, phase: "triage", log },
        { emitBackstop },
      ),
    },
  );
  if (r.deferred) {
    log.info(
      { identifier, code: r.code, reason: r.reason },
      "monitor: triage dispatch deferred — executor lane parked"
    );
    return false;
  }
  // Count only a real spawn attempt. A lane-parked dispatch returns before any
  // worker launch and must not consume the ticket or fleet-wide triage budget.
  if (!isTriageInFlight(statusAtLaunch) && statusAtLaunch !== "done") {
    bumpTriageDispatchCount(orchDir, identifier);
    if (multiHost) {
      try {
        bumpFenceTriageAttempt({ ticket: identifier });
      } catch {
        /* fail-open */
      }
    }
  }
  if (r.code !== 0) {
    log.warn({ identifier, code: r.code }, "monitor: triage dispatch failed");
    return false;
  }
  // CTL-1028: persist the won generation so a later flapping-host triage worker
  // is fenced. null (single-host) is a no-op inside writeClusterGeneration.
  writeClusterGeneration(orchDir, identifier, clusterGeneration);
  // CTL-863: emit the authoritative fence.claimed event (Linear-free local append)
  // so the broker projects this triage claim into ticket_state's fence columns.
  // Multi-host only (clusterGeneration non-null); single-host never fences.
  if (clusterGeneration != null) {
    emitFenceClaimed({
      ticket: identifier,
      owner_host: self,
      generation: clusterGeneration,
      phase: "triage",
    });
  }
  if (budget) budget.remaining -= 1;
  // CTL-704: write Linear Todo→Triage (verified) + emit observability event.
  let res = { applied: false, verified: false, from_state: null, to_state: null, reason: null };
  try {
    res = applyTriageStatus({ ticket: identifier });
  } catch (err) {
    log.warn({ identifier, err: err.message }, "monitor: triage status write threw");
  }
  appendEvent({
    ticket: identifier,
    orchId: orchId ?? identifier,
    from_state: res.from_state,
    to_state: res.to_state,
    verified: res.verified,
    applied: res.applied,
    reason: res.reason,
  });
  // CTL-781 + CTL-1011: self-assign the bot on claim — always invoked so a
  // missing botUserId surfaces the deduped config-missing warn (invalid-user)
  // instead of silently skipping. Best-effort, never blocks triage.
  try {
    applyAssignee({ ticket: identifier, userId: botWriteId });
  } catch (err) {
    log.warn({ identifier, err: err.message }, "monitor: self-assign threw — continuing");
  }
  // CTL-1481: best-effort worker:<host> label stamp — a visibility projection
  // of the triage claim we just won, NEVER the claim arbiter itself. Multi-host
  // only (same gate as emitFenceClaimed). Placed AFTER the triage-status +
  // self-assign writes so a stamp-tripped breaker can never starve them. Own
  // try/catch (mirrors the self-assign precedent above) so a throw only logs
  // and never blocks the triage dispatch.
  if (clusterGeneration != null) {
    try {
      stampWorkerLabel({ ticket: identifier, hostName: self, knownHosts: roster, replica, applyLabel, removeLabel, log });
    } catch (err) {
      log.warn({ identifier, err: err.message }, "monitor: stampWorkerLabel threw — continuing");
    }
  }
  return true;
}

// hasTriageArtifact — does a triage.json exist for this ticket's worker dir?
// CTL-625: the marker that distinguishes an already-triaged Ready ticket from
// a Backlog→Ready-direct entry that skipped the triage phase agent.
function hasTriageArtifact(orchDir, ticket) {
  return existsSync(join(orchDir, "workers", ticket, "triage.json"));
}

// ── CTL-1441: triage re-dispatch guard ───────────────────────────────────────
// CTL-1403 was re-triaged 12× in ~30h: this sweep keys ONLY on triage.json,
// while advancement keys phase-triage.json — a triage run whose content
// artifact goes astray (the skill's WORKER_DIR falling back to $(pwd)) posts
// its comment and completes "done", yet stays re-dispatchable forever. Nothing
// bounds per-ticket triage dispatches (the scheduler's dispatch circuit breaker
// has no reach into monitor's dispatch path). Two additions:
//   (a) when phase-triage.json is done but triage.json is missing, the
//       re-dispatch is the legitimate REMEDY (research's prior-artifact gate
//       needs triage.json) — but the mismatch is surfaced loudly once;
//   (b) a hard per-ticket dispatch cap (CATALYST_TRIAGE_DISPATCH_CAP, default
//       3): at the cap the ticket parks LOUDLY (needs-human via the
//       label-guard) instead of silently burning a dispatch every reconcile —
//       this also bounds the class where NO artifacts ever appear (a spawn
//       dying on a bad repoRoot). Re-arm by deleting
//       workers/<t>/.triage-redispatch-capped + .triage-dispatch-count.json.
export const TRIAGE_DISPATCH_CAP = Number(process.env.CATALYST_TRIAGE_DISPATCH_CAP) || 3;

export function readTriageSignalStatus(orchDir, ticket) {
  try {
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", ticket, "phase-triage.json"), "utf8"),
    );
    return typeof sig?.status === "string" ? sig.status : null;
  } catch {
    return null; // absent/malformed → fail-open
  }
}

// isTriageInFlight — CTL-1441: a signal the launcher would treat as a live,
// idempotent no-op (phase-agent-dispatch:513 short-circuits dispatched|running|
// done; pending is a re-arm in progress). Used to (a) skip cap COUNTING (a
// no-op dispatch is not a retry) and (b) defer cap PARKING (an allowed attempt
// may still complete — only park after the signal settles without an artifact).
function isTriageInFlight(status) {
  return status === "dispatched" || status === "running" || status === "pending";
}

// Codex R4: the cap state lives at orchDir level — NOT under workers/<t>/ —
// because the worker-dir GC deletes terminal dirs after retention, and losing
// the counter would re-arm the very re-dispatch cycle the cap terminates
// (mirrors the .recovery-intents / .escalation-cooldowns placement rationale).
// One file per ticket: { count, lastDispatchAt, cappedAt? }. Re-arm by
// deleting orchDir/.triage-dispatch-counts/<ticket>.json.
function triageDispatchCountPath(orchDir, ticket) {
  return join(orchDir, ".triage-dispatch-counts", `${ticket}.json`);
}

export function readTriageDispatchRecord(orchDir, ticket) {
  try {
    const data = JSON.parse(readFileSync(triageDispatchCountPath(orchDir, ticket), "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null; // absent/malformed → fail-open (the cap only ever under-counts)
  }
}

export function readTriageDispatchCount(orchDir, ticket) {
  const rec = readTriageDispatchRecord(orchDir, ticket);
  return typeof rec?.count === "number" ? rec.count : 0;
}

function writeTriageDispatchRecord(orchDir, ticket, rec) {
  // Codex R3: never manufacture the orch dir itself — several legacy tests use a
  // shared literal orchDir (e.g. "/orch") with mocked dispatchers, and a counter
  // write there would persist across runs and machines (cap suppression bleeding
  // between suites). A real daemon's orchDir always exists; a missing one means
  // a hermetic/mocked context → in-memory only (fail-open, under-counts).
  if (!existsSync(orchDir)) return false;
  const p = triageDispatchCountPath(orchDir, ticket);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(rec));
    return true;
  } catch (err) {
    log.warn({ ticket, err: err.message }, "ctl-1441: triage dispatch-count write failed");
    return false;
  }
}

export function bumpTriageDispatchCount(orchDir, ticket, { now = () => new Date().toISOString() } = {}) {
  const prior = readTriageDispatchRecord(orchDir, ticket) ?? {};
  const count = (typeof prior.count === "number" ? prior.count : 0) + 1;
  writeTriageDispatchRecord(orchDir, ticket, { ...prior, count, lastDispatchAt: now() });
  return count;
}

export function markTriageCapped(orchDir, ticket, { now = () => new Date().toISOString() } = {}) {
  const prior = readTriageDispatchRecord(orchDir, ticket) ?? {};
  if (prior.cappedAt) return false; // already parked once
  writeTriageDispatchRecord(orchDir, ticket, { ...prior, cappedAt: now(), cap: TRIAGE_DISPATCH_CAP });
  return true;
}

// fleetTriageDispatchCount — the CTL-1649 fleet-wide dispatch count for a ticket.
//
// On single-host (multiHost:false), returns the host-local count unchanged —
// no fence read, no new subprocess, byte-identical to the pre-CTL-1649 path.
//
// On multi-host, reads the fence's triage_attempt_count via the injected
// readFenceCount seam and returns max(host-local, fence). A null from the fence
// read (fence-absent or spawn failure) is the fail-open signal — fall back to
// host-local so a temporary Linear outage never falsely parks a ticket.
//
// The seam default (readTriageAttemptCountSync) is TTL-cached in
// cluster-claim-sync.mjs (CATALYST_TRIAGE_ATTEMPT_CACHE_MS, 30s default) to
// bound the Linear read rate — mirrors fenceCheckSyncCached's design.
//
// Exported for unit coverage.
export function fleetTriageDispatchCount(
  orchDir,
  identifier,
  { multiHost = false, readFenceCount = readTriageAttemptCountSync } = {},
) {
  const hostLocal = readTriageDispatchCount(orchDir, identifier);
  if (!multiHost) return hostLocal;
  try {
    const { count } = readFenceCount({ ticket: identifier });
    if (count === null) return hostLocal; // fence-absent or failure — fail-open
    return Math.max(hostLocal, count);
  } catch {
    return hostLocal; // fail-open on any unexpected throw
  }
}

// triageStateTickets — the CTL-1589 half of the sweep's ticket source: the
// tickets currently SITTING IN this team's Triage state, read from the local
// replica. Fail-open — an unavailable board yields [] and the sweep degrades to
// its pre-CTL-1589 eligible-only behavior rather than aborting the pass. The
// unavailable cases are logged at WARN and never silent: with the replica tier
// off (or its writer dead) this half of the fix is INERT, and a stranded Triage
// ticket would otherwise look like a mysterious no-op.
// TRIAGE_REVALIDATE_NEGATIVE_MS — how long a NEGATIVE launch-revalidation
// verdict (stale/unreadable) suppresses re-reading a Triage-board candidate.
// See the negative-verdict cache inside dispatchTriage (Codex R6).
const TRIAGE_REVALIDATE_NEGATIVE_MS = 30 * 60 * 1000;

function triageStateTickets(entry, { replica, runTriageState }) {
  const query = resolveEligibleQuery(entry);
  const onSource = (source, count) => {
    const line = { team: query.team, triage_source: source, triage_count: count };
    if (source === "replica") log.info(line, "triage sweep: Triage-state source");
    else if (source === "no-triage-status") log.debug(line, "triage sweep: team configures no Triage state");
    else
      log.warn(
        line,
        "triage sweep: Triage-state board unavailable — sweeping the eligible set only (CTL-1589)"
      );
    recordReplicaRead(query.team, source);
  };
  try {
    const rows = runTriageState(query, { replica, onSource });
    // No dwell filter (Codex R3): issues.updated_at is generic last-modified, so
    // a frequently-touched stranded ticket would never pass an age gate. A young
    // row racing the →Triage webhook is harmless — dispatchTriage is idempotent
    // (in-flight signals no-op, artifacts skip) and the launch-imminent live
    // revalidation (dispatchTriage requireTriageState) is the stale-row guard.
    // Tag the source so ONLY this half pays that live revalidation.
    return rows.map((t) => ({ ...t, fromTriageBoard: true }));
  } catch (err) {
    log.warn(
      { team: query.team, err: err.message },
      "sweepMissingTriage: Triage-state read threw — sweeping the eligible set only (CTL-1589)"
    );
    return [];
  }
}

// sweepMissingTriage — the reconcile-path analogue of the CTL-625 webhook guard
// (handleStateChangedEvent →Ready branch). After reconcileAll has (re)populated
// the eligible sets, dispatch triage for every eligible ticket that lacks a
// triage.json. Tickets already in the Ready state when the daemon boots — or
// that appear in Linear between webhooks — never generate a →Ready event
// (CTL-681 removed the per-event scoping poll), so without this sweep their
// research dispatch dead-locks on phase-agent-dispatch's prior_artifact_missing
// gate, looping prior_artifact_missing → 60s cooldown → retry forever (CTL-711:
// CTL-704/705/706/710 each needed a manual triage dispatch after a restart).
//
// CTL-1589: the eligible set alone is NOT a sufficient source. It is fed by a
// Todo-only query, so a ticket sitting in the TRIAGE state appears in neither
// half of the retry loop — and the only path that ever noticed it, the →Triage
// webhook, is edge-triggered and one-shot. A delegated ticket whose dispatch was
// consumed and whose worker dir later vanished therefore stranded in Triage
// forever (live: ADV-1374, ADV-1376, CTL-1381, OTL-5). The sweep now iterates the
// UNION of the eligible set and the team's Triage-state board, deduped by ticket
// id — making triage admission level-triggered. Only the sweep's ticket SOURCE
// widens: Triage-state tickets are NOT added to the eligible projection (the
// scheduler's new-work pull, the phantom sweep, and the dependency graph all
// consume that, and a Triage ticket is never scheduler-pulled).
//
// Idempotent by construction: hasTriageArtifact skips already-triaged tickets
// (no duplicate dispatch on normal webhook-driven tickets), and an in-flight
// triage's signal file is no-op'd downstream by phase-agent-dispatch. A missing
// orchDir (standalone monitor) is a no-op. A non-zero dispatch for one ticket is
// logged by dispatchTriage and never aborts the sweep for the rest.
export function sweepMissingTriage({
  orchDir,
  dispatch,
  applyTriageStatus = defaultApplyTriageStatus,
  appendEvent = defaultAppendEvent,
  // CTL-716: slot-gate seams — same primitives as handleStateChangedEvent.
  concurrency = {},
  readMaxParallelFn = readMaxParallel,
  liveBackgroundCount = () => countBackgroundAgents(),
  // CTL-1367 P1: dispatch mode + SDK-occupancy reader for the budget (default
  // "phase-agents" → byte-identical bg budget). Threaded from startMonitor.
  dispatchMode = "phase-agents",
  countSdkInflight = defaultCountSdkInflight,
  // CTL-1457 (N1): per-phase in-process route flag (arms the SDK-occupancy term on
  // a bg node). Threaded from startMonitor. Default false → unchanged.
  hasInProcessRoute = false,
  // CTL-781: respect-assignment + self-assign seams.
  botUserIds,
  botWriteId,
  gateway,
  fetchAssignee = fetchTicketAssignee,
  applyAssignee = defaultApplyAssignee,
  // CTL-862: cross-host coordination seams.
  hosts = undefined,
  hostName = undefined,
  // CTL-1091: surviving-roster override → threaded through to dispatchTriage's
  // live-roster ownership gate (undefined → real heartbeat feed; tests inject).
  survivingRosterOverride = undefined,
  claimDispatch = claimDispatchSync,
  // CTL-1367 P1: failed-terminal backstop for a rejected async (sdk) triage
  // dispatch — threaded through to dispatchTriage (undefined → real default).
  emitBackstop,
  // CTL-1441: needs-human at the re-dispatch cap — threaded through to
  // dispatchTriage (undefined → real label-guard default; tests inject a spy).
  labelNeedsHuman,
  // CTL-1481: worker:<host> label-stamp seam — threaded through to
  // dispatchTriage (undefined → real default; tests inject a fake).
  stampWorkerLabel,
  // CTL-1589: the Triage-state read seams. `replica` defaults to the same
  // daemon-injected board reader reconcileProject uses, so the sweep is served
  // from the local replica with no Linear call at all.
  replica = _injectedEligibleReplica,
  runTriageState = defaultRunTriageStateQuery,
  // CTL-1589 (Codex R2): live-state read for stale-row revalidation; injectable.
  fetchLiveState = defaultFetchTicketState,
  anchorIssue = undefined,
  recordSweepHealth = recordTriageSweep,
} = {}) {
  if (!orchDir) {
    log.debug("sweepMissingTriage: no orchDir wired — skipping triage sweep");
    return;
  }
  // CTL-716: read liveness once per sweep (mirrors schedulerTick's once-per-tick read).
  const budget = computeTriageBudget({
    orchDir,
    concurrency,
    readMaxParallelFn,
    liveBackgroundCount,
    dispatchMode, // CTL-1367 P1
    countSdkInflight, // CTL-1367 P1
    hasInProcessRoute, // CTL-1457 (N1)
  });
  for (const p of listProjects()) {
    const holdTally = createHoldTally();
    const triageStatusName = resolveEligibleQuery(p)?.triageStatus ?? null;
    // CTL-1589: Triage-state board ∪ eligible set, deduped by ticket id. The
    // STRANDED half walks first (Codex R1): under sustained admission load an
    // eligible-first walk let fresh Todo tickets drain the per-sweep budget
    // every sweep, starving the level-triggered recovery exactly when the fleet
    // is busy. The stranded set is small and self-draining (one successful
    // triage removes the ticket permanently), while the eligible half retries
    // on the next 60s sweep — so stranded-first costs the Todo path at most one
    // sweep of latency. DUAL-PRESENCE (Codex R5): a feed hole can leave a stale
    // Triage row for a ticket the live-confirmed eligible query reports as
    // Todo — the Triage copy would walk first, fail launch revalidation, and
    // its `seen` entry would then skip the genuinely dispatchable eligible
    // copy every sweep. The eligible copy is the authoritative one (it came
    // from a live-confirmed source and pays no revalidation), so a
    // dual-present ticket keeps ONLY that copy.
    const eligibleSet = getEligibleSet(p.team);
    const eligibleIds = new Set(eligibleSet.map((t) => t.identifier));
    const seen = new Set();
    const candidates = [
      ...triageStateTickets(p, { replica, runTriageState }).filter(
        (t) => !eligibleIds.has(t.identifier)
      ),
      ...eligibleSet,
    ];
    for (const t of candidates) {
      if (seen.has(t.identifier)) continue;
      seen.add(t.identifier);
      // Redundant with dispatchTriage by design: the gate is correctness; this
      // filter avoids reconsidering the permanent anchor on every sweep.
      if (isLivenessAnchorTicket(t.identifier, { anchorIssue })) continue;
      // Codex R4: at a saturated fleet, still ROUTE capped tickets (their park is
      // capacity-independent and dispatchTriage's cap gate runs before its
      // budget gate); everything else waits for the next sweep.
      if (budget.remaining <= 0 && readTriageDispatchCount(orchDir, t.identifier) < TRIAGE_DISPATCH_CAP) continue;
      if (hasTriageArtifact(orchDir, t.identifier)) continue;
      // CTL-1589 (Codex R4): a Triage-STATE ticket whose triage worker is
      // in-flight right now has no artifact yet and would route to an
      // idempotent no-op launch — which still decrements the sweep budget
      // (code 0) and would pay a pointless live revalidation read. Skip it
      // here; the eligible half keeps its pre-existing behavior.
      if (t.fromTriageBoard && isTriageInFlight(readTriageSignalStatus(orchDir, t.identifier))) continue;
      // CTL-1441 guard (a) note: the done-signal/missing-triage.json mismatch is
      // handled INSIDE dispatchTriage (post-gates, launch-imminent — Codex R3),
      // where the stale completion signal is retired immediately before a real
      // launch. The sweep just routes the ticket there like any other.
      dispatchTriage(t.identifier, {
        dispatch,
        orchDir,
        applyTriageStatus,
        appendEvent,
        orchId: t.identifier,
        budget,
        // CTL-1589 (Codex R3): Triage-BOARD candidates must still be in the
        // Triage state at launch; eligible-half candidates skip the check.
        requireTriageState: t.fromTriageBoard ? triageStatusName : null,
        candidateUpdatedAt: t.fromTriageBoard ? (t.updatedAt ?? null) : null,
        fetchLiveState,
        botUserIds,
        botWriteId,
        gateway,
        fetchAssignee,
        applyAssignee,
        hosts,
        hostName,
        survivingRosterOverride, // CTL-1091
        claimDispatch, // CTL-862
        emitBackstop, // CTL-1367 P1
        ...(labelNeedsHuman ? { labelNeedsHuman } : {}), // CTL-1441
        stampWorkerLabel, // CTL-1481
        anchorIssue,
        holdTally,
      });
    }
    const { considered, held } = holdTally.snapshot();
    const heldDelegateUnreadable = held["delegate-unreadable"] ?? 0;
    if (considered > 0) {
      const fields = { team: p.team, considered, heldDelegateUnreadable };
      if (heldDelegateUnreadable === considered) {
        log.warn(fields, "monitor: triage sweep held EVERY candidate — delegate unreadable (CAT-82)");
      } else {
        log.info(fields, "monitor: triage sweep summary (CAT-82)");
      }
    }
    recordSweepHealth(p.team, { considered, heldDelegateUnreadable });
  }
}

// CTL-681 removed scheduleDirtyReconcile + its dirtyTimers Map. The
// per-event scoping reconcile it implemented is the load that exhausted the
// Linear 2500/hr quota: the parser dropped project/labels/priority, so every
// relevant event triggered a full poll to recover them. CTL-681 captures those
// fields in the event payload; the per-event reconcile is gone. The eligible
// set is now refreshed by exactly two paths: the startup reconcile + the
// 10-min periodic reconcile (RECONCILE_INTERVAL_MS).

// --- Byte-offset event-log tailer ---------------------------------------
// Mirrors broker/tailer.mjs: follow ~/catalyst/events/YYYY-MM.jsonl via
// fs.watch, reading only the bytes appended since the last call.

let lastByteOffset = 0;
let lastLogPath = "";
let leftoverBuf = "";
let watcher = null;
let reconcileTimer = null;
// CTL triage-entry fix (Phase 0): the poll timer that drains the event log when
// fs.watch fails to fire (the common case for cross-process appends on macOS).
let tailerPollTimer = null;
// CTL-1655: sibling poll timer draining the coordination mirror. The mirror is a
// cross-process append (written by coordination-publish), so fs.watch alone is
// unreliable — the same rationale that requires tailerPollTimer above. There is no
// reconcile backstop for the coordination tail, so without this poll a missed
// fs.watch event silently drops a cross-host comment wake until restart.
let coordinationPollTimer = null;
let tailerOpts = {};

// CTL-1655: bounded commentId-keyed dedup (Phase 1).
// Shared between the local event-log tail (readNewEvents) and the
// coordination-mirror tail (readNewCoordinationComments) so whichever sees
// a given comment first wins and the other skips — preventing duplicate
// dispatch regardless of which tail ingests the comment on a given host.
const COMMENT_DEDUP_CAP = 2000; // named constant for documentation + tests
const commentDedupMap = new Map(); // insertion-ordered → evict oldest on overflow

// commentKeyOf — derive the dedup key for a raw event. Prefers
// body.payload.commentId (stable across local/echo duplicates), falls back
// to the envelope id. Returns undefined for a row that has neither (caller
// skips insertion but does NOT treat as "already seen").
export function commentKeyOf(event) {
  const payloadKey = event?.body?.payload?.commentId ?? event?.detail?.commentId;
  if (payloadKey != null && payloadKey !== "") return String(payloadKey);
  const envelopeKey = event?.id;
  if (envelopeKey != null && envelopeKey !== "") return String(envelopeKey);
  return undefined;
}

// markAndCheckCommentSeen — returns true if key is already in the dedup set;
// otherwise inserts it (evicting the oldest entry when at cap) and returns false.
// A null/undefined key is treated as never-seen and is NOT inserted.
export function markAndCheckCommentSeen(key) {
  if (key == null) return false;
  if (commentDedupMap.has(key)) return true;
  if (commentDedupMap.size >= COMMENT_DEDUP_CAP) {
    // Map preserves insertion order — first key is the oldest.
    commentDedupMap.delete(commentDedupMap.keys().next().value);
  }
  commentDedupMap.set(key, true);
  return false;
}

// CTL-1655: coordination-mirror cursor (Phase 2).
let coordinationCursor = 0;
let coordinationLogPath = "";
let coordinationLeftoverBuf = "";
let coordinationWatcher = null; // Phase 3 — fs.watch handle for the mirror file

// fileSizeOrZero — current byte size of a file, or 0 when it does not exist
// (the poll-only state). Shared by both tailer seeders.
function fileSizeOrZero(path) {
  try {
    const fd = openSync(path, "r");
    const { size } = fstatSync(fd);
    closeSync(fd);
    return size;
  } catch {
    return 0; // log file does not exist yet — poll-only mode
  }
}

// seedTailerAtEof — pin the tailer to the current end of the event log so the
// startup reconcile poll (not a log replay) is the authoritative rebuild.
export function seedTailerAtEof() {
  lastLogPath = getEventLogPath();
  leftoverBuf = "";
  lastByteOffset = fileSizeOrZero(lastLogPath);
}

// seedTailerFromCursor — pin the tailer to the durable cursor's saved offset so
// a daemon restart resumes the fast path mid-stream. resolveStartOffset falls
// back to EOF for a missing/stale/rotated cursor; the periodic reconcile is the
// correctness backstop either way. CTL-539.
export function seedTailerFromCursor() {
  lastLogPath = getEventLogPath();
  leftoverBuf = "";
  lastByteOffset = resolveStartOffset({
    cursor: loadCursor(),
    logPath: lastLogPath,
    fileSize: fileSizeOrZero(lastLogPath),
  });
}

// readNewEvents — drain bytes appended since the last call, parse each
// complete line, and feed it to handleStateChangedEvent. A leftover buffer
// carries partial lines; on month rollover the new file is re-seeded at its
// current size (its tail is not replayed).
//
// Exported for deterministic test drives + the CTL-539 startup gap-drain; the
// index.mjs barrel deliberately does not re-export it.
//
// CTL-731 Phase 00: `foldOnly` (default false) is threaded to the per-event
// handlers for the boot/large-gap catch-up — it applies projection folds only
// (no dispatchTriage / abortWorker / onComment side-effects). The steady-state
// poll/watch path calls readNewEvents() with no args (foldOnly false), so live
// events still fire their full side-effects.
export function readNewEvents({ foldOnly = false } = {}) {
  const logPath = getEventLogPath();
  if (logPath !== lastLogPath) {
    lastLogPath = logPath;
    leftoverBuf = "";
    try {
      const fd = openSync(logPath, "r");
      lastByteOffset = fstatSync(fd).size;
      closeSync(fd);
    } catch {
      lastByteOffset = 0;
    }
    return;
  }
  try {
    const fd = openSync(logPath, "r");
    const { size } = fstatSync(fd);
    if (size <= lastByteOffset) {
      closeSync(fd);
      return;
    }
    const newByteCount = size - lastByteOffset;
    const buf = Buffer.alloc(newByteCount);
    readSync(fd, buf, 0, newByteCount, lastByteOffset);
    closeSync(fd);
    lastByteOffset = size;
    // CTL-539: persist the durable cursor so a restart resumes here. saveCursor
    // is best-effort — it swallows and logs its own write failures.
    saveCursor({ logPath: lastLogPath, byteOffset: lastByteOffset });

    const text = leftoverBuf + buf.toString("utf8");
    const lines = text.split("\n");
    leftoverBuf = lines.pop() ?? "";
    // CTL-716: compute one triage budget per non-fold drain — a single liveness
    // read shared across all events in this pass (mirrors schedulerTick's once-
    // per-tick read). foldOnly drains have no dispatch side-effects, so no budget.
    const triageBudget = foldOnly
      ? undefined
      : computeTriageBudget({
          orchDir: tailerOpts.orchDir,
          concurrency: tailerOpts.concurrency,
          readMaxParallelFn: tailerOpts.readMaxParallelFn,
          liveBackgroundCount: tailerOpts.liveBackgroundCount,
          dispatchMode: tailerOpts.dispatchMode, // CTL-1367 P1
          countSdkInflight: tailerOpts.countSdkInflight, // CTL-1367 P1
          hasInProcessRoute: tailerOpts.hasInProcessRoute, // CTL-1457 (N1)
        });
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // skip a malformed line, keep tailing
      }
      // CTL-731: handleStateChangedEvent gates its dispatch side-effects on
      // foldOnly; handleIssueUpdatedEvent is a pure projection fold (always safe);
      // handleCommentCreatedEvent's onComment is a side-effect — withhold it on
      // the fold-only boot drain so replayed comments don't re-fire subscribers.
      handleStateChangedEvent(event, { ...tailerOpts, foldOnly, triageBudget });
      handleIssueUpdatedEvent(
        event,
        foldOnly ? { ...tailerOpts, onUpdate: undefined } : tailerOpts
      ); // CTL-681 + CTL-749
      // CTL-1655: consult the shared cross-source dedup before routing so the
      // two tails don't double-dispatch the same comment. Per plan §Phase 2
      // ("whichever tail sees a given comment first wins and the other skips"),
      // HONOR the result here: if the coordination-mirror tail already processed
      // this comment (it won the race on the originating host, where the comment
      // lands in BOTH the local event log and the hub-echoed coordination.jsonl),
      // skip the redundant handleCommentCreatedEvent — otherwise Phase B
      // dispatch fires twice for one Linear comment (the CTL-1653 pathology).
      // foldOnly drains do NOT insert — replayed events must not permanently
      // poison the dedup set and block their own future live delivery.
      const eventName681 = event?.attributes?.["event.name"] ?? event?.event;
      if (eventName681 === "linear.comment.created" && !foldOnly) {
        if (markAndCheckCommentSeen(commentKeyOf(event))) continue;
      }
      handleCommentCreatedEvent(event, foldOnly ? {} : tailerOpts); // CTL-681
    }
  } catch {
    // log file not yet created or a transient read error — best-effort
  }
}

// readNewCoordinationComments — CTL-1655 Phase 2. Drain bytes appended to
// the coordination mirror (coordination.jsonl) since the last call, parse
// each JSONL line, and route ONLY linear.comment.created rows through the
// shared dedup → handleCommentCreatedEvent path.
//
// Design constraints (each guarded by a test):
//   1. Comment-only filter: only linear.comment.created rows reach onComment.
//   2. Cross-source dedup: the shared markAndCheckCommentSeen gate prevents a
//      comment seen by both the local tail and this tail from dispatching twice.
//   3. Safe degradation: absent/empty mirror file → no-op, no throw.
//   4. foldOnly boot drain: withholds onComment (no dispatch of replayed comments).
//   5. Single-host no-op: skips entirely when the cluster has only one host.
//
// Exported so tests can drive it deterministically without wiring startTailing.
export function readNewCoordinationComments({ foldOnly = false } = {}) {
  // Constraint 5: single-host no-op.
  if (getClusterHosts().length <= 1) return;

  const mirrorPath = getCoordinationMirrorPath();
  // Reset cursor on path change (analogous to readNewEvents month-rollover guard).
  if (mirrorPath !== coordinationLogPath) {
    coordinationLogPath = mirrorPath;
    coordinationLeftoverBuf = "";
    coordinationCursor = fileSizeOrZero(mirrorPath);
    return;
  }

  try {
    const fd = openSync(mirrorPath, "r");
    const { size } = fstatSync(fd);
    if (size <= coordinationCursor) {
      closeSync(fd);
      return;
    }
    const newByteCount = size - coordinationCursor;
    const buf = Buffer.alloc(newByteCount);
    readSync(fd, buf, 0, newByteCount, coordinationCursor);
    closeSync(fd);
    coordinationCursor = size;

    const text = coordinationLeftoverBuf + buf.toString("utf8");
    const lines = text.split("\n");
    coordinationLeftoverBuf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // skip malformed line, keep tailing (constraint 3)
      }
      // Constraint 1: comment-only filter.
      const evName = event?.attributes?.["event.name"] ?? event?.event;
      if (evName !== "linear.comment.created") continue;

      // Constraint 2: cross-source dedup. foldOnly drains do NOT insert (boot
      // drain must not permanently poison the dedup set for future live delivery).
      if (!foldOnly) {
        const key = commentKeyOf(event);
        if (markAndCheckCommentSeen(key)) continue; // already processed locally
      }

      // Constraint 4: foldOnly → withhold onComment.
      if (foldOnly) continue;

      // Emit observability breadcrumb so operators can confirm the mirror tail fired.
      // Name satisfies CTL-1142 namespace contract (not filter.* / broker.daemon.* /
      // phase.<KNOWN_PHASE>.*). The dedup above ensures at-most-once per comment.
      const ticket = event?.attributes?.["linear.issue.identifier"] ??
        event?.body?.payload?.ticket ?? event?.detail?.ticket;
      if (ticket) {
        log.info({ ticket }, `comment.wake.cross-host.${ticket}`);
      }

      handleCommentCreatedEvent(event, tailerOpts);
    }
  } catch {
    // mirror file absent or transient read error — safe degradation (constraint 3)
  }
}

// startTailing — fs.watch the events dir; on change, drain new bytes. The
// tailer is best-effort: if the event log never appears the watcher simply
// never fires and the reconcile poll alone maintains the eligible set.
export function startTailing() {
  const eventsDir = dirname(getEventLogPath());
  mkdirSync(eventsDir, { recursive: true });
  watcher = watch(eventsDir, (eventType, filename) => {
    if (eventType !== "change") return;
    if (filename !== null && filename !== basename(getEventLogPath())) return;
    readNewEvents();
  });
  // CTL-1655 Phase 3: watch the coordination mirror dir too (multi-host only).
  if (getClusterHosts().length > 1) {
    const mirrorPath = getCoordinationMirrorPath();
    const mirrorDir = dirname(mirrorPath);
    const mirrorFile = basename(mirrorPath);
    mkdirSync(mirrorDir, { recursive: true });
    coordinationWatcher = watch(mirrorDir, (eventType, filename) => {
      if (eventType !== "change") return;
      if (filename !== null && filename !== mirrorFile) return;
      readNewCoordinationComments();
    });
  }
  return watcher;
}

// --- Lifecycle -----------------------------------------------------------

// startMonitor — immediate reconcileAll (authoritative initial rebuild), seed
// the tailer, start tailing, then arm the periodic reconcile timer. With
// resumeFromCursor (default, CTL-539) the tailer resumes from the durable
// cursor and the cursor→EOF downtime gap is drained immediately; otherwise it
// seeds at EOF (the legacy poll-only-on-startup behavior).
export function startMonitor({
  exec,
  debounceMs = EVENT_DEBOUNCE_MS,
  reconcileIntervalMs = RECONCILE_INTERVAL_MS,
  tailerPollMs = TAILER_POLL_INTERVAL_MS, // CTL triage-entry fix (Phase 0)
  resumeFromCursor = true,
  orchDir,
  dispatch,
  abortWorker,
  cache, // CTL-634: shared state cache for event-driven write-through
  onComment, // CTL-681: optional comment subscriber
  onUpdate, // CTL-749: optional issue-update subscriber
  // CTL-716: slot-gate seams — threaded into tailerOpts so readNewEvents and
  // sweepMissingTriage use the same ceiling as the scheduler (CTL-665).
  concurrency = {},
  readMaxParallelFn,
  liveBackgroundCount,
  // CTL-1367 P1: dispatch mode ("sdk" under executor=sdk) + the SDK-occupancy
  // reader, threaded into tailerOpts + sweepMissingTriage so the triage budget
  // counts in-process SDK workers. Default "phase-agents" → byte-identical bg.
  dispatchMode = "phase-agents",
  countSdkInflight = defaultCountSdkInflight,
  // CTL-1457 (N1): true when executorByPhase routes ANY phase to an in-process
  // executor (sdk|codex-exec) while the node boot dispatchMode is still bg. Threaded
  // into tailerOpts + both sweepMissingTriage calls so the →Triage budget counts a
  // routed no-bg triage worker on a bg node. Default false → byte-identical bg.
  hasInProcessRoute = false,
  // CTL-781: respect-assignment + self-assign seams.
  botUserIds,
  botWriteId,
  gateway,
  // CTL-1397: the daemon-injected replica-backed board-list reader (constructed
  // in daemon.mjs's bun context, mode-gated). undefined/absent → the reconcile
  // path uses linearis (the Node broker never injects one, so monitor.mjs needs
  // no bun:sqlite import). Stored module-level so reconcileAll/reconcileProject
  // (which the reconcile timer drives) read it without re-threading.
  eligibleReplica,
  anchorIssue = resolveAnchorIssueCached(),
} = {}) {
  _injectedEligibleReplica = eligibleReplica ?? null;
  // CTL-565: orchDir + dispatch + abortWorker are stored in tailerOpts so the
  // tailer-driven readNewEvents → handleStateChangedEvent path can one-shot-
  // dispatch triage and abort a dragged-out worker. When abortWorker is left
  // undefined, handleStateChangedEvent falls back to its real default.
  // CTL-634: cache rides in tailerOpts too so the tailer's write-through path
  // populates the same instance the scheduler reads.
  tailerOpts = {
    exec,
    debounceMs,
    orchDir,
    dispatch,
    abortWorker,
    cache,
    onComment,
    onUpdate,
    concurrency,
    readMaxParallelFn,
    liveBackgroundCount,
    dispatchMode, // CTL-1367 P1
    countSdkInflight, // CTL-1367 P1
    hasInProcessRoute, // CTL-1457 (N1)
    botUserIds,
    botWriteId,
    gateway,
    anchorIssue,
  };
  reconcileAll({ exec });
  sweepMissingTriage({
    orchDir,
    dispatch,
    concurrency,
    readMaxParallelFn,
    liveBackgroundCount,
    dispatchMode, // CTL-1367 P1
    countSdkInflight, // CTL-1367 P1
    hasInProcessRoute, // CTL-1457 (N1)
    botUserIds,
    botWriteId,
    gateway,
    anchorIssue,
  }); // CTL-711: triage pre-existing eligible tickets
  if (resumeFromCursor) {
    seedTailerFromCursor();
    // CTL-731 Phase 00: drain the cursor→EOF downtime gap FOLD-ONLY. Pre-CTL-731
    // this synchronous drain re-ran dispatchTriage/applyTriageStatus
    // (spawnSync claude --bg + linearis) for every gap event, blocking
    // startMonitor for ~20-30s AND double-dispatching triage for events already
    // acted on before the restart. Fold-only advances the cursor + applies the
    // idempotent projection folds; live side-effects resume on the poll/watch
    // path below. reconcileAll (above) is the authoritative eligible rebuild and
    // sweepMissingTriage (above) the intended boot triage backstop.
    readNewEvents({ foldOnly: true });
    // CTL-1655 Phase 3: seed the coordination cursor and boot-drain foldOnly so
    // historical mirror comments don't dispatch on restart (constraint 4).
    coordinationLogPath = getCoordinationMirrorPath();
    coordinationLeftoverBuf = "";
    coordinationCursor = fileSizeOrZero(coordinationLogPath);
    readNewCoordinationComments({ foldOnly: true });
  } else {
    seedTailerAtEof();
    // Seed the coordination cursor at EOF so we don't replay old mirror events.
    coordinationLogPath = getCoordinationMirrorPath();
    coordinationLeftoverBuf = "";
    coordinationCursor = fileSizeOrZero(coordinationLogPath);
  }
  startTailing();
  // CTL triage-entry fix (Phase 0): poll-drain the event log. fs.watch
  // (startTailing) is unreliable for cross-process appends, so without this the
  // tailer's fast path (triage dispatch + eligible fold) never fires on live
  // webhooks — new work waits for the 10-min reconcile or a restart. The poll
  // is cheap (readNewEvents reads only bytes past the durable cursor).
  if (tailerPollMs > 0) {
    tailerPollTimer = setInterval(() => readNewEvents(), tailerPollMs);
    // CTL-1655: poll the coordination mirror on the same cadence so a missed
    // fs.watch (the common case for cross-process appends on macOS) does not
    // silently drop cross-host comment wakes. The poll is cheap (reads only
    // bytes past coordinationCursor) and readNewCoordinationComments re-reads
    // the roster per call, self-no-op'ing while single-host. Arm it
    // UNCONDITIONALLY (not gated on the boot-time host count): a daemon that
    // boots single-host and later has a peer added must still start draining the
    // mirror without a restart — the startTailing watcher gate is startup-only,
    // so this poll is the sole path that re-arms on a live roster expansion.
    coordinationPollTimer = setInterval(
      () => readNewCoordinationComments(),
      tailerPollMs
    );
  }
  reconcileTimer = setInterval(() => {
    reconcileAll({ exec });
    sweepMissingTriage({
      orchDir,
      dispatch,
      concurrency,
      readMaxParallelFn,
      liveBackgroundCount,
      dispatchMode, // CTL-1367 P1
      countSdkInflight, // CTL-1367 P1
      hasInProcessRoute, // CTL-1457 (N1)
      botUserIds,
      botWriteId,
      gateway,
      anchorIssue,
    }); // CTL-711 + CTL-716: catch tickets that appeared between webhooks
  }, reconcileIntervalMs);
}

// stopMonitor — clear the reconcile interval and the file watcher. Idempotent
// and safe to call when nothing is running. CTL-681 removed the dirtyTimers
// cleanup (the per-event debounce timers it tracked are gone).
export function stopMonitor() {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  if (tailerPollTimer) {
    clearInterval(tailerPollTimer);
    tailerPollTimer = null;
  }
  watcher?.close();
  watcher = null;
  // CTL-1655: clear the coordination mirror poll timer and close its watcher.
  if (coordinationPollTimer) {
    clearInterval(coordinationPollTimer);
    coordinationPollTimer = null;
  }
  coordinationWatcher?.close();
  coordinationWatcher = null;
}

// __tailerOffset — the tailer's current byte offset. Test-only, for
// deterministic cursor-seeding assertions; kept out of the index.mjs barrel.
export function __tailerOffset() {
  return lastByteOffset;
}

// __resetForTests — clear all module-level state between unit tests. Not part
// of the public monitor contract; index.mjs does not re-export it.
// CTL-716: also resets the liveness cache so tests that use the real default
// countBackgroundAgents() start from a cold (agents=[]) state, not from a
// warm snapshot that may reflect the current bg-job environment.
export function __resetForTests() {
  stopMonitor();
  knownProjects.clear();
  lastByteOffset = 0;
  lastLogPath = "";
  leftoverBuf = "";
  tailerOpts = {};
  resetLivenessCache();
  __resetReconcileHealthForTests(); // CTL-867: clear per-team reconcile-health map
  _injectedEligibleReplica = null; // CTL-1397: drop the daemon-injected board-list replica reader
  // CTL-1655: reset coordination and dedup state.
  coordinationCursor = 0;
  coordinationLogPath = "";
  coordinationLeftoverBuf = "";
  commentDedupMap.clear();
}

// __resetCommentDedupForTests — clear the comment dedup set. Exported so
// tests that drive readNewCoordinationComments directly can isolate dedup state.
export function __resetCommentDedupForTests() {
  commentDedupMap.clear();
}
