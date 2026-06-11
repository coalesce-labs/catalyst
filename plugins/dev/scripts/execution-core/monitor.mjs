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

import { watch, openSync, fstatSync, readSync, closeSync, mkdirSync, existsSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import {
  getEventLogPath,
  RECONCILE_INTERVAL_MS,
  EVENT_DEBOUNCE_MS,
  TAILER_POLL_INTERVAL_MS,
  log,
  getHostName, // CTL-862
  getClusterHosts, // CTL-862
} from "./config.mjs";
import { ownedBy } from "./hrw.mjs"; // CTL-862: HRW ownership filter
import { claimDispatchSync } from "./cluster-claim-sync.mjs"; // CTL-862: cross-host claim soft-CAS
import { listProjects, getProjectConfig, resolveEligibleQuery } from "./registry.mjs";
import { runEligibleQuery, fetchTicketAssignee, isAssigneeClaimable } from "./linear-query.mjs";
import {
  setProjectEligible,
  removeTicket,
  dropProject,
  getEligibleSet,
  upsertTicket,
} from "./eligible-set.mjs";
import { loadCursor, saveCursor, resolveStartOffset } from "./event-cursor.mjs";
import { dispatchTicket } from "./dispatch.mjs";
import { abortWorker as defaultAbortWorker } from "./abort-worker.mjs";
import {
  applyTriageStatus as defaultApplyTriageStatus,
  applyAssignee as defaultApplyAssignee,
} from "./linear-write.mjs";
import { appendTriageTransitionEvent as defaultAppendEvent } from "./triage-transition-event.mjs";
import { countBackgroundAgents, resetLivenessCache } from "./claude-agents.mjs";
import { readMaxParallel, computeFreeSlots, writeClusterGeneration } from "./scheduler.mjs";
import {
  recordReconcileSuccess,
  recordReconcileFailure,
  __resetReconcileHealthForTests,
} from "./reconcile-health.mjs";

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
// poll clears the alert. `appendHealthEvent` is an injectable test seam.
export function reconcileProject(team, { exec, appendHealthEvent } = {}) {
  const entry = getProjectConfig(team);
  if (!entry) {
    log.warn({ team }, "reconcile: no registry entry for team — skipping");
    return;
  }
  const query = resolveEligibleQuery(entry);
  let tickets;
  try {
    tickets = runEligibleQuery(query, { exec });
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
  // CTL-867: the poll succeeded — reset the failure streak, refresh the
  // last-successful-refresh marker, and clear any standing alert. Recorded
  // BEFORE the projection write so a successful poll counts as a recovery even
  // if the (rare) projection write below fails.
  recordReconcileSuccess(team, appendHealthEvent ? { appendEvent: appendHealthEvent } : {});
  try {
    setProjectEligible(team, tickets, { source: "reconcile", query });
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
  }
}

// reconcileAll — full reconcile of every registered team (the missed-webhook
// backstop). Re-reads registry.json each call so a team added to the registry
// is picked up and one removed is dropped within one tick.
export function reconcileAll({ exec, appendHealthEvent } = {}) {
  const projects = listProjects();
  const seen = new Set(projects.map((p) => p.team));
  for (const p of projects) reconcileProject(p.team, { exec, appendHealthEvent });
  for (const stale of knownProjects) {
    if (!seen.has(stale)) {
      dropProject(stale);
      log.info({ team: stale }, "team no longer in the registry — dropped");
    }
  }
  knownProjects.clear();
  for (const t of seen) knownProjects.add(t);
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
    claimDispatch = claimDispatchSync,
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
    computeTriageBudget({ orchDir, concurrency, readMaxParallelFn, liveBackgroundCount });
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
          claimDispatch, // CTL-862
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
          claimDispatch, // CTL-862
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
function computeTriageBudget({
  orchDir,
  concurrency = {},
  readMaxParallelFn = readMaxParallel,
  liveBackgroundCount = () => countBackgroundAgents(),
} = {}) {
  const maxParallel = readMaxParallelFn(orchDir, concurrency);
  const live = liveBackgroundCount();
  return { remaining: computeFreeSlots(maxParallel, live) };
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
    applyAssignee = defaultApplyAssignee,
    // CTL-862: cross-host coordination seams (left undefined → single-host fallback).
    hosts = undefined,
    hostName = undefined,
    claimDispatch = claimDispatchSync,
  }
) {
  if (!orchDir) {
    log.warn({ identifier }, "→Triage seen but monitor has no orchDir — skipping dispatch");
    return false;
  }
  // CTL-862: HRW ownership filter. Resolve roster/self lazily per call so hot
  // roster reloads need no restart. Single-host roster → ownedBy is identity.
  const roster = hosts ?? getClusterHosts();
  const self = hostName ?? getHostName();
  const multiHost = roster.length > 1;
  if (!ownedBy(identifier, roster, self)) {
    log.debug(
      { identifier, self, roster },
      "ctl-862: ticket not owned by this host under HRW — skipping triage dispatch"
    );
    return false;
  }
  if (budget && budget.remaining <= 0) {
    log.info(
      { identifier },
      "monitor: triage dispatch deferred — no free slots (maxParallel); sweepMissingTriage will retry (CTL-716)"
    );
    return false;
  }
  // CTL-781: respect-assignment gate — a →Triage/→Todo ticket assigned to a
  // non-bot is a human's; never claim it. Gateway-first, live read on miss;
  // unknown holds (sweepMissingTriage retries next reconcile). Empty/absent
  // botUserIds disables the gate (CTL-749 fail-open convention).
  if (botUserIds instanceof Set && botUserIds.size > 0) {
    const a = fetchAssignee(identifier, { gateway });
    if (!a.known || !isAssigneeClaimable(a.assignee, botUserIds)) {
      log.info(
        { identifier, known: a.known, assignee: a.known ? (a.assignee ?? null) : undefined },
        "monitor: triage dispatch skipped — respect-assignment (CTL-781)"
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
  const r = dispatchTicket(orchDir, identifier, "triage", { dispatch, clusterGeneration });
  if (r.code !== 0) {
    log.warn({ identifier, code: r.code }, "monitor: triage dispatch failed");
    return false;
  }
  // CTL-1028: persist the won generation so a later flapping-host triage worker
  // is fenced. null (single-host) is a no-op inside writeClusterGeneration.
  writeClusterGeneration(orchDir, identifier, clusterGeneration);
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
  // CTL-781: self-assign the bot on claim — best-effort, never blocks triage.
  if (botWriteId) {
    try {
      applyAssignee({ ticket: identifier, userId: botWriteId });
    } catch (err) {
      log.warn({ identifier, err: err.message }, "monitor: self-assign threw — continuing");
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
  // CTL-781: respect-assignment + self-assign seams.
  botUserIds,
  botWriteId,
  gateway,
  fetchAssignee = fetchTicketAssignee,
  applyAssignee = defaultApplyAssignee,
  // CTL-862: cross-host coordination seams.
  hosts = undefined,
  hostName = undefined,
  claimDispatch = claimDispatchSync,
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
  });
  for (const p of listProjects()) {
    for (const t of getEligibleSet(p.team)) {
      if (budget.remaining <= 0) return; // capacity reached; remainder retries next sweep
      if (hasTriageArtifact(orchDir, t.identifier)) continue;
      dispatchTriage(t.identifier, {
        dispatch,
        orchDir,
        applyTriageStatus,
        appendEvent,
        orchId: t.identifier,
        budget,
        botUserIds,
        botWriteId,
        gateway,
        fetchAssignee,
        applyAssignee,
        hosts,
        hostName,
        claimDispatch, // CTL-862
      });
    }
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
let tailerOpts = {};

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
      handleCommentCreatedEvent(event, foldOnly ? {} : tailerOpts); // CTL-681
    }
  } catch {
    // log file not yet created or a transient read error — best-effort
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
  // CTL-781: respect-assignment + self-assign seams.
  botUserIds,
  botWriteId,
  gateway,
} = {}) {
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
    botUserIds,
    botWriteId,
    gateway,
  };
  reconcileAll({ exec });
  sweepMissingTriage({
    orchDir,
    dispatch,
    concurrency,
    readMaxParallelFn,
    liveBackgroundCount,
    botUserIds,
    botWriteId,
    gateway,
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
  } else {
    seedTailerAtEof();
  }
  startTailing();
  // CTL triage-entry fix (Phase 0): poll-drain the event log. fs.watch
  // (startTailing) is unreliable for cross-process appends, so without this the
  // tailer's fast path (triage dispatch + eligible fold) never fires on live
  // webhooks — new work waits for the 10-min reconcile or a restart. The poll
  // is cheap (readNewEvents reads only bytes past the durable cursor).
  if (tailerPollMs > 0) {
    tailerPollTimer = setInterval(() => readNewEvents(), tailerPollMs);
  }
  reconcileTimer = setInterval(() => {
    reconcileAll({ exec });
    sweepMissingTriage({
      orchDir,
      dispatch,
      concurrency,
      readMaxParallelFn,
      liveBackgroundCount,
      botUserIds,
      botWriteId,
      gateway,
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
}
