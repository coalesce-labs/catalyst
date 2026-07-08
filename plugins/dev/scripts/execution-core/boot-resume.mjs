// boot-resume.mjs — execution-core daemon boot-resume (CTL-654, CTL-690).
//
// On a real reboot every prior `claude --bg` phase worker is provably dead at
// once. The per-tick reclaim sweep (recovery.mjs::reclaimDeadWorkIfPossible) is
// revive-budget-gated (MAX_REVIVES) and escalates to `needs-human` on
// exhaustion — so it treats a clean restart like a chronic-failure storm and
// the in-flight tickets do NOT reliably auto-resume.
//
// This module is a dedicated, synchronous boot-reconciliation pass that runs
// once at daemon boot (between recover() and the monitor). For each in-flight
// ticket whose persisted worktreePath has no live background session it
// re-dispatches a worker at the ticket's current phase via
// defaultReviveDispatch — which bypasses the revive budget by construction (the
// budget lives in reclaimDeadWorkIfPossible, not in the dispatch primitive) and
// keeps the CTL-615 worktree-path cross-check. The fan-out is bounded by
// maxParallel so a reboot never spawns a worker storm.
//
// CTL-690 — session continuation. Each candidate's bg_job_id is mapped (via
// the same resolvePhaseSessionId helper recovery.mjs:1265 uses on the per-tick
// reclaim path) to a `claude --resume`-compatible UUID. When that resolves, the
// dispatcher relaunches `claude --bg --resume <uuid>` so the worker continues
// where it left off. When it does NOT resolve (legacy signal, transcript
// missing, etc.) the candidate falls through to today's fresh-dispatch path —
// preserving the unchanged-from-CTL-654 fallback. Resume-launch failures are
// reclassified by phase-agent-dispatch (CTL-658 launched/alive/failed) which
// itself falls back to a fresh start inside the same dispatcher invocation, so
// boot-resume never has to retry.
//
// Phase 1 (this section) is pure selection logic, dependency-free beyond the
// scheduler/signal-reader read helpers, and exhaustively unit-tested. The
// reconcileBootResume orchestrator (Phase 2) wires in the side effects.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { emitBootResumePending as defaultEmitBootResumePending } from "./dispatch-alert.mjs"; // CTL-1443
import {
  readWorkerSignals,
  readAllPhaseSignals,
  TERMINAL,
  byActivePhase,
} from "./signal-reader.mjs";
import { listInFlightTickets, readMaxParallel, computeFreeSlots } from "./scheduler.mjs";
import { log } from "./config.mjs";
// CTL-1006: phaseIndex/isKnownPhase are the canonical phase-order comparators —
// the same ones recovery's CTL-606 supersede guard uses (recovery.mjs:2219).
import { phaseIndex, isKnownPhase } from "../lib/phase-fsm.mjs";
import {
  defaultReviveDispatch,
  defaultAppendBootResumeEvent,
  defaultAppendBootResumeGatedEvent,
  defaultAppendBootResumePhaseRegressionEvent,
  resolvePhaseSessionId,
} from "./recovery.mjs";
import { defaultDispatch } from "./dispatch.mjs";
// liveAgents() is synchronous (execFileSync `claude agents --json`). A static
// import is safe here: cli/sessions.mjs imports only signal-reader/reap-intent/
// config/claude-ids/session-recency/cli-args — none of which import this module,
// so there is no import cycle. (The plan floated a lazy import to keep the pure
// Phase-1 exports import-light, but a lazy `import()` is async and the boot pass
// must stay synchronous to complete before the monitor/scheduler start.)
import { liveAgents } from "./cli/sessions.mjs";

// ─── CTL-644: cheap/expensive classification ───────────────────────────────
//
// cheap = early phases whose work is cheap to re-run; auto-resume on cold start.
// expensive = phases that edit application code or open PRs; require operator approval.
// remediate is treated as expensive (edits app code, same cost class as implement).
export const CHEAP_RESUME_PHASES = new Set(["triage", "research", "plan"]);
export function isCheapPhase(phase) {
  return CHEAP_RESUME_PHASES.has(phase);
}

// bootResumePendingPath — JSON marker written when a gated ticket is awaiting approval.
// Schema: { ticket, phase, worktreePath, requestedAt }
export function bootResumePendingPath(orchDir, ticket) {
  return join(orchDir, "workers", ticket, ".boot-resume-pending-approval");
}

// bootResumeApprovedPath — empty sentinel written by the operator (or a HUD button)
// to approve re-dispatch of a gated ticket.
export function bootResumeApprovedPath(orchDir, ticket) {
  return join(orchDir, "workers", ticket, ".boot-resume-approved");
}

// ─── internal helpers ──────────────────────────────────────────────────────

function writePendingMarker(orchDir, ticket, phase, worktreePath) {
  const p = bootResumePendingPath(orchDir, ticket);
  if (existsSync(p)) return false; // idempotent — do not re-emit
  try {
    writeFileSync(
      p,
      JSON.stringify({ ticket, phase, worktreePath, requestedAt: new Date().toISOString() })
    );
    return true;
  } catch (err) {
    log.warn({ ticket, phase, err: err?.message }, "boot-resume: pending marker write failed — continuing");
    return false;
  }
}

function readPendingMarker(orchDir, ticket) {
  try {
    return JSON.parse(readFileSync(bootResumePendingPath(orchDir, ticket), "utf8"));
  } catch {
    return null;
  }
}

// ─── CTL-1443 (P1-loop-3): the approval gate becomes OPERABLE ───────────────
//
// The pending marker was written with a companion "operator (or a HUD button)"
// approval sentinel that NOTHING ever wrote, no surface displayed, and no TTL
// expired — a gated ticket sat invisible forever (OTL-41: 4+ days). Three
// additions: a list/approve API (fronted by boot-resume-approve.mjs), and a
// per-tick expiry sweep that surfaces a stale gate ONCE into the existing
// Needs-You pipeline (explanation on the gated phase's signal) + a
// catalyst.alert.boot_resume_pending event.

export const BOOT_RESUME_PENDING_TTL_MS =
  Number(process.env.CATALYST_BOOT_RESUME_PENDING_TTL_H) * 3600e3 || 48 * 3600e3;

// listPendingApprovals — every gated ticket with its age + approval state.
export function listPendingApprovals(orchDir, { now = () => Date.now() } = {}) {
  const workersDir = join(orchDir, "workers");
  let tickets;
  try {
    tickets = readdirSync(workersDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out = [];
  for (const ticket of tickets) {
    if (!existsSync(bootResumePendingPath(orchDir, ticket))) continue;
    const pending = readPendingMarker(orchDir, ticket) ?? {};
    const requestedMs = Date.parse(pending.requestedAt ?? "") || null;
    out.push({
      ticket,
      phase: pending.phase ?? null,
      requestedAt: pending.requestedAt ?? null,
      ageMs: requestedMs != null ? Math.max(0, now() - requestedMs) : null,
      approved: existsSync(bootResumeApprovedPath(orchDir, ticket)),
      surfacedAt: pending.surfacedAt ?? null,
    });
  }
  return out;
}

// approveBootResume — write the approval sentinel; the every-tick
// processApprovedResumes picks it up (no restart). Refuses when no gate exists.
export function approveBootResume(orchDir, ticket) {
  if (!existsSync(bootResumePendingPath(orchDir, ticket))) {
    return { approved: false, reason: "no-pending-gate" };
  }
  try {
    writeFileSync(bootResumeApprovedPath(orchDir, ticket), "");
    return { approved: true };
  } catch (err) {
    return { approved: false, reason: err?.message ?? String(err) };
  }
}

// surfaceStalePendingApprovals — a pending gate older than the TTL surfaces
// ONCE: the gated phase's signal gains status:"needs-human" + a curated
// explanation (the monitor's existing Needs-You inbox renders it via
// deriveExplanation) and a catalyst.alert.boot_resume_pending event fires. The
// marker itself stays (approval still works); surfacedAt on the marker is the
// per-ticket dedupe. Never throws; returns the tickets surfaced.
export function surfaceStalePendingApprovals({
  orchDir,
  now = () => Date.now(),
  ttlMs = BOOT_RESUME_PENDING_TTL_MS,
  emitAlert = null, // ({identifier, phase, ageHours}) => void — daemon wires emitBootResumePending
} = {}) {
  const surfaced = [];
  for (const gate of listPendingApprovals(orchDir, { now })) {
    if (gate.approved || gate.surfacedAt) continue;
    if (gate.ageMs == null || gate.ageMs < ttlMs) continue;
    const { ticket, phase } = gate;
    const ageHours = Math.round(gate.ageMs / 3600e3);
    // (1) explanation onto the GATED phase's signal → the Needs-You inbox.
    const sigPath = join(orchDir, "workers", ticket, `phase-${phase}.json`);
    try {
      let sig = {};
      try {
        sig = JSON.parse(readFileSync(sigPath, "utf8")) ?? {};
      } catch {
        sig = {};
      }
      if (!sig.ticket) sig.ticket = ticket;
      if (!sig.phase) sig.phase = phase;
      sig.status = "needs-human";
      if (!sig.needsHumanSince) sig.needsHumanSince = new Date(now()).toISOString();
      sig.updatedAt = new Date(now()).toISOString();
      sig.explanation = {
        escalation_type: "authorization",
        problem: `${ticket}'s ${phase} resume has been gated behind boot-resume approval for ${ageHours}h with no operator response — expensive phases require explicit approval after a cold start, and nothing was surfacing the ask.`,
        call_to_action: `approve the ${phase} resume for ${ticket} (boot-resume-approve.mjs ${ticket}), or take the ticket over?`,
        recommendation: `approve the resume — the gate exists to prevent silent expensive re-runs, not to park the ticket`,
        risk: `left unapproved the ticket stays frozen invisibly (the OTL-41 failure mode)`,
        why_asking: "the CTL-644 cold-start gate requires operator approval for expensive phases",
        observed: { gate_age_hours: ageHours, phase },
        attempts: [],
      };
      const tmp = `${sigPath}.tmp.${process.pid}`;
      writeFileSync(tmp, JSON.stringify(sig, null, 2));
      renameSync(tmp, sigPath);
    } catch (err) {
      log.warn({ ticket, phase, err: err?.message }, "ctl-1443: stale-gate signal surfacing failed — will retry next tick");
      continue; // no surfacedAt stamp → retried next tick
    }
    // (2) the durable alert event (throttled per-kind inside the emitter).
    try {
      emitAlert?.({ identifier: ticket, phase, ageHours });
    } catch {
      /* alert is best-effort; the signal is the operator surface */
    }
    // (3) dedupe stamp on the marker (approval still works; marker retained).
    try {
      const pending = readPendingMarker(orchDir, ticket) ?? { ticket, phase };
      pending.surfacedAt = new Date(now()).toISOString();
      writeFileSync(bootResumePendingPath(orchDir, ticket), JSON.stringify(pending));
    } catch (err) {
      log.warn({ ticket, err: err?.message }, "ctl-1443: surfacedAt stamp failed — the gate may re-surface next tick");
    }
    log.warn(
      { ticket, phase, ageHours },
      "ctl-1443: boot-resume approval gate exceeded its TTL — surfaced to Needs-You (approve with boot-resume-approve.mjs)"
    );
    surfaced.push(ticket);
  }
  return surfaced;
}

// hasLiveBgWorker — does `agents` contain a live BACKGROUND session whose cwd is
// exactly `worktreePath`? This is the synchronous reduction of research §6's
// buildLiveSessionsByWorktree predicate, sharing CTL-649's kind+cwd semantics:
//   - kind === "background" (an interactive human session never counts as the
//     ticket's worker), and
//   - cwd === worktreePath by exact string equality (worktreePath is the
//     canonical persisted value; no trailing-slash normalization).
// The deliberate synchronous shape (vs. the async buildRows join) keeps the boot
// pass inside startDaemon's synchronous boot ordering.
export function hasLiveBgWorker(agents, worktreePath) {
  return (
    Array.isArray(agents) && agents.some((s) => s?.kind === "background" && s?.cwd === worktreePath)
  );
}

// activePhaseForTicket — given a ticket's phase-signal list, return the single
// non-terminal signal to resume (or null when every phase is terminal). When
// more than one is non-terminal the most-recently-updated wins, reusing the
// shared byActivePhase comparator (after the non-terminal filter that comparator
// reduces to updatedAt-desc, so the result is the freshest in-flight phase).
export function activePhaseForTicket(signals) {
  const nonTerminal = (signals ?? []).filter((s) => s && !TERMINAL.has(s.status));
  if (nonTerminal.length === 0) return null;
  return nonTerminal.sort(byActivePhase)[0];
}

// isBootResumeEligible — boot-resume runs on a cold start OR a daemon bounce.
// CTL-1006: report.coldStart is the detectColdStart OBJECT in production
// (recovery.mjs:2576/2583) — { coldStart, epoch, epochSource, ... } — not a bare
// boolean. The legacy `report.coldStart !== true` gate is therefore a permanent
// no-op in production (an object is never === true), so boot-resume never ran on
// a real start and the budget-gated per-tick reclaim sweep false-escalated
// in-flight tickets to needs-human after a daemon bounce (the Scenario-1 bug).
//
// This predicate admits boot-resume when:
//   • report.coldStart === true            — legacy synthetic boolean (back-compat;
//                                             daemon.test.mjs + older boot-resume tests)
//   • report.coldStart.coldStart === true  — the real object, genuine cold start
//   • report.coldStart.epochSource ===
//       "exec-core"                         — a DAEMON BOUNCE: the exec-core boot
//                                             epoch won the cold-start verdict
//                                             (CTL-701), i.e. a daemon restart
//                                             without OS/socket reboot. Resuming
//                                             here is exactly Scenario 1.
//   • report.daemonBounce === true          — explicit override seam.
// PRODUCTION REALITY (review finding, CTL-1006): on current detectColdStart
// behavior the exec-core epoch wins on effectively every daemon start, so in
// practice every production start — cold or bounce — is ELIGIBLE. That is the
// intended Scenario-1 posture: boot-resume reconciles in-flight tickets on
// every start. Scenario 4's "chronic failures stay escalated" is therefore
// carried NOT by this predicate but by the explicit guards downstream: the
// needs-human marker skip in selectBootResumeCandidates and the
// expensive-phase .boot-resume-pending-approval gate. A non-eligible object
// shape (e.g. { coldStart: false, epochSource: "os-boot" }) remains a no-op
// for synthetic/test inputs and any future detectColdStart change.
export function isBootResumeEligible(report) {
  if (!report) return false;
  const cs = report.coldStart;
  if (cs === true) return true; // legacy synthetic boolean
  if (cs && typeof cs === "object") {
    if (cs.coldStart === true) return true; // real object cold start
    if (cs.epochSource === "exec-core") return true; // CTL-701 daemon bounce
  }
  return report.daemonBounce === true; // explicit override seam
}

// supersededByTerminalPhase — CTL-1006 Scenario 2. Returns the dominant terminal
// phase NAME iff some signal for the ticket is TERMINAL at a phase strictly LATER
// than `phase` (the resume candidate), else null. Mirrors recovery's CTL-606
// supersede guard (recovery.mjs:2219) but keyed on the resume candidate: a later
// terminal phase (e.g. research=stalled) means re-dispatching an EARLIER phase
// (triage left at `running`) is a phase regression — the CTL-997/998 bug — not a
// resume. Unknown phase names are skipped via isKnownPhase so a tombstone / manual
// operator file never throws (the CTL-702 defensive posture). `phaseIndex` ranks
// remediate at verify's index, so equal-index terminals are NOT supersedes
// (strictly-greater only).
export function supersededByTerminalPhase(signals, phase) {
  if (!isKnownPhase(phase)) return null;
  const here = phaseIndex(phase);
  let dominant = null;
  let dominantIdx = here;
  for (const s of signals ?? []) {
    if (!s || !TERMINAL.has(s.status) || !isKnownPhase(s.phase)) continue;
    const i = phaseIndex(s.phase);
    if (i > dominantIdx) {
      dominantIdx = i;
      dominant = s.phase;
    }
  }
  return dominant;
}

// selectBootResumeCandidates — the set of in-flight tickets that need a fresh
// worker, bounded by free slots. Pure over the filesystem + the supplied agents
// list. Returns `{ ticket, phase, worktreePath, bgJobId }[]`, deterministically
// sorted by ticket id and sliced to the free-slot cap so a reboot never
// over-dispatches.
//
//   1. inFlight  = the tickets currently occupying a worker slot.
//   2. signals   = one active signal per ticket (readWorkerSignals already
//                  collapses each worker dir to its active phase).
//   3. per ticket: resolve the active phase; skip (with a warn) when it is null
//      or carries no worktreePath (cannot revive safely). Partition by whether a
//      live bg worker already owns the worktree.
//   4. free      = maxParallel − (# in-flight tickets that DO have a live worker)
//                  so the boot pass and the surviving workers together stay under
//                  the cap.
//   5. return the no-live-worker candidates sorted by ticket id, sliced to free.
//
// CTL-690: bgJobId is captured from the active signal so reconcileBootResume
// can resolve a `claude --resume`-compatible UUID and continue the dead
// worker's session instead of starting fresh. May be null on legacy signals or
// when the worker died before any bg job was recorded — the reconcile pass
// treats null as "fresh dispatch", preserving today's behavior for those rows.
export function selectBootResumeCandidates({
  orchDir,
  agents,
  // CTL-665: committed executionCore concurrency knobs, threaded from the
  // daemon. The boot-resume ceiling honors config-first precedence + bounds the
  // same way the new-work pull does; an empty {} keeps the legacy state.json path.
  concurrency = {},
  maxParallel = readMaxParallel(orchDir, concurrency),
  logger = log,
  // CTL-1006 Scenario 2: invoked (no-op by default, so the pure selection tests
  // are unaffected) when a candidate is dropped because a LATER terminal phase
  // supersedes its resume phase. reconcileBootResume threads a real callback that
  // routes the regression to the audit log.
  onPhaseRegression = () => {},
  // CTL-1422 review fix (B): warm-harvested tickets are exempt from the
  // free-slot slice — dropping one silently discards its session UUID (the
  // in-memory harvest is the boot pass's only copy in use). Safe: they were
  // occupying slots before the restart, and the runner's semaphore still caps
  // real concurrency.
  sdkSessionHarvest = new Map(),
} = {}) {
  const inFlight = listInFlightTickets(orchDir);
  if (inFlight.size === 0) return [];

  const byTicket = new Map();
  for (const sig of readWorkerSignals(orchDir)) {
    if (!sig?.ticket) continue;
    const list = byTicket.get(sig.ticket) ?? [];
    list.push(sig);
    byTicket.set(sig.ticket, list);
  }

  // CTL-1006 Scenario 2: readWorkerSignals collapses each ticket to ONE active
  // phase row, so it cannot reveal a sibling LATER-terminal phase. The
  // phase-regression guard needs the FULL per-file signal set — read it once and
  // index by ticket. (The collapsed `byTicket` above is kept verbatim so
  // activePhaseForTicket's recency-ranked selection — and its 12 existing pure
  // tests — are unchanged.)
  const allByTicket = new Map();
  for (const sig of readAllPhaseSignals(orchDir)) {
    if (!sig?.ticket) continue;
    const list = allByTicket.get(sig.ticket) ?? [];
    list.push(sig);
    allByTicket.set(sig.ticket, list);
  }

  let liveCount = 0;
  const needResume = [];
  for (const ticket of inFlight) {
    const active = activePhaseForTicket(byTicket.get(ticket) ?? []);
    if (!active) continue; // mid-advance: terminal active signal, nothing to resume
    // CTL-549: needs-input is intentionally parked — never auto-resume on reboot.
    // The comment-wake path in daemon.mjs handles re-dispatch when the human replies.
    if (active.status === "needs-input") {
      logger.debug(
        { ticket, phase: active.phase },
        "boot-resume: skipping needs-input (awaiting human comment)"
      );
      continue;
    }
    if (!active.worktreePath) {
      logger.warn(
        { ticket, phase: active.phase },
        "boot-resume: in-flight ticket has no worktreePath — cannot revive safely, skipping"
      );
      continue;
    }
    // CTL-1006 Scenario 4 (chronic-failure invariant): a ticket the escalation
    // path already flagged needs-human must NOT be silently auto-resumed by a
    // bounce — with boot-resume now actually running in production, eligibility
    // alone no longer carries this invariant. The marker is the same one
    // label-guard writes (workers/<T>/.linear-label-needs-human.applied); the
    // operator clears it (with the label) when re-arming a ticket.
    if (existsSync(join(orchDir, "workers", ticket, ".linear-label-needs-human.applied"))) {
      logger.warn(
        { ticket, phase: active.phase },
        "boot-resume: ticket is escalated to needs-human — not auto-resuming, operator owns re-arm"
      );
      continue;
    }
    // CTL-1006 Scenario 2: phase-regression guard. activePhaseForTicket is
    // recency-ranked, so a stale earlier phase left non-terminal can shadow a
    // later TERMINAL phase. Re-dispatching the earlier phase would be the
    // CTL-997/998 regression class — drop the candidate and surface a
    // phase_regression observation instead. (NOTE: the literal CTL-997/998
    // fixture — research=stalled + triage=running — is already excluded
    // upstream by isTicketInFlight, which drops tickets with stalled/failed
    // phases; this guard is defense-in-depth for the in-flight variant: a
    // later phase terminal-done shadowed by a stale earlier non-terminal one.)
    const dominant = supersededByTerminalPhase(allByTicket.get(ticket) ?? [], active.phase);
    if (dominant) {
      onPhaseRegression({ ticket, phase: active.phase, dominantPhase: dominant });
      logger.warn(
        { ticket, phase: active.phase, dominantPhase: dominant },
        "boot-resume: phase regression — later terminal phase supersedes resume candidate, skipping"
      );
      continue;
    }
    if (hasLiveBgWorker(agents, active.worktreePath)) {
      liveCount++;
    } else {
      // CTL-690: capture bg_job_id (signal-reader exposes it as liveness.value
      // when liveness.kind === 'bg'). The reconcile pass resolves it to a
      // resume-compatible UUID; legacy/missing values stay null and the
      // candidate falls back to fresh dispatch downstream.
      const bgJobId = active.liveness?.kind === "bg" ? active.liveness.value : null;
      needResume.push({
        ticket,
        phase: active.phase,
        worktreePath: active.worktreePath,
        bgJobId,
      });
    }
  }

  const free = computeFreeSlots(maxParallel, liveCount);
  needResume.sort((a, b) => a.ticket.localeCompare(b.ticket));
  // CTL-1422 (B): warm candidates always survive selection; the slice caps
  // only cold candidates, against the slots warm did not consume.
  const warm = needResume.filter((c) => sdkSessionHarvest.has?.(c.ticket));
  const cold = needResume.filter((c) => !sdkSessionHarvest.has?.(c.ticket));
  return [...warm, ...cold.slice(0, Math.max(0, free - warm.length))];
}

// resolveAgents — normalize the injectable `agents` seam to a concrete array.
// An array is used as-is; a function is invoked; undefined falls back to the
// synchronous production liveAgents() shell-out. Keeps reconcileBootResume's
// agent resolution test-injectable while the production default needs no wiring.
function resolveAgents(agents) {
  if (Array.isArray(agents)) return agents;
  if (typeof agents === "function") return agents();
  return liveAgents();
}

// reconcileBootResume — the side-effecting boot driver (Phase 2). Gated on a
// cold start, it dispatches each selected candidate via defaultReviveDispatch
// (which resets the signal to `stalled` and applies the CTL-615 worktree-path
// cross-check, and bypasses the revive budget because the budget lives in
// reclaimDeadWorkIfPossible, not in the dispatch primitive), and emits one
// audit event per successful dispatch. A non-cold-start restart is a no-op so
// the existing budget-gated per-tick reclaim sweep keeps chronic-failure
// protection. No single failure throws out of the loop — a boot pass must never
// crash daemon boot.
//
// CTL-1084: per-boot cheap-dispatch cap. Default BOOT_REWALK_MAX_PER_TICK (2)
// limits the burst: deferred items drain via the scheduler's Sweep 1.5 on
// subsequent ticks (they are NOT lost). The cap is independent of the per-tick
// dispatch-cooldown markers — it never resets them.
const BOOT_REWALK_MAX_PER_TICK =
  Number(process.env.CATALYST_BOOT_REWALK_MAX_PER_TICK) || 2;

// CTL-1422 review fix (A): the warm-resume loop budget. A crash-looping daemon
// would otherwise re-resume the SAME session on every boot forever — bypassing
// the CTL-644 operator gate it is allowed to skip only because a continuation
// is cheap ONCE. The budget is keyed by session UUID (a NEW session is a new
// run, not a loop) and persisted per ticket so it survives the crash loop it
// exists to stop. At the cap, the candidate falls back to the normal gated path.
export const WARM_RESUME_MAX_PER_SESSION =
  Number(process.env.CATALYST_WARM_RESUME_MAX_PER_SESSION) || 3;

function warmBudgetPath(orchDir, ticket) {
  return join(orchDir, "workers", ticket, ".warm-resume-budget");
}

// Returns true when the warm path may proceed (and records the attempt);
// false when the session has exhausted its budget.
function consumeWarmBudget(orchDir, ticket, sessionId) {
  const p = warmBudgetPath(orchDir, ticket);
  let rec = null;
  try {
    rec = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    /* absent/corrupt → fresh budget */
  }
  const count = rec?.sessionId === sessionId ? Number(rec.count) || 0 : 0;
  if (count >= WARM_RESUME_MAX_PER_SESSION) return false;
  try {
    writeFileSync(p, JSON.stringify({ sessionId, count: count + 1 }));
  } catch (err) {
    log.warn(
      { ticket, err: err?.message },
      "boot-resume: warm-budget write failed — allowing this resume, budget not durable"
    );
  }
  return true;
}

export function reconcileBootResume({
  orchDir,
  report,
  agents = undefined, // array | fn | undefined→liveAgents()
  dispatch = defaultDispatch, // inner seam handed to reviveDispatch
  reviveDispatch = defaultReviveDispatch,
  appendEvent = defaultAppendBootResumeEvent,
  // CTL-644: gated-event appender — emitted once per expensive ticket gated.
  appendGatedEvent = defaultAppendBootResumeGatedEvent,
  // CTL-1006 Scenario 2: phase-regression appender — emitted once per candidate
  // dropped because a later terminal phase supersedes its resume phase. Audit-only
  // (broker-ignored, uncounted by countReviveEvents), injectable for tests.
  appendRegressionEvent = defaultAppendBootResumePhaseRegressionEvent,
  // CTL-690: session resolver — same helper recovery.mjs:1265 uses on the
  // per-tick reclaim path so boot-resume and reclaim share resume semantics.
  // Injectable so tests can drive both the resumable + unresumable branches
  // without touching real ~/.claude/jobs state. Returns a UUID string when the
  // dead worker's transcript is on disk, or null when not resumable.
  resolveSession = resolvePhaseSessionId,
  orchId = undefined, // threaded into the audit envelope
  concurrency = {}, // CTL-665: committed executionCore concurrency knobs (from startDaemon)
  // CTL-1084: per-boot dispatch cap for cheap phases. Deferred items drain via
  // Sweep 1.5 on subsequent ticks. Default from BOOT_REWALK_MAX_PER_TICK const.
  maxRewalkPerTick = BOOT_REWALK_MAX_PER_TICK,
  // CTL-1422: Map<ticket, sessionId> harvested from dead-pid SDK registry
  // projections (reconcileSdkRegistryOnBoot) — interrupted in-process runs whose
  // SDK session can be CONTINUED via options.resume. A warm candidate bypasses
  // the CTL-644 expensive-phase gate AND the rewalk cap: continuation is cheap,
  // and a deferred warm candidate would lose its UUID (the harvest lives only in
  // this boot pass — Sweep 1.5 has no access to it).
  sdkSessionHarvest = new Map(),
} = {}) {
  // CTL-1006 Scenario 1: eligible on a cold start OR a daemon bounce. The old
  // `report.coldStart !== true` gate was a permanent production no-op because
  // recoverStartup hands us the detectColdStart OBJECT, never a bare boolean —
  // see isBootResumeEligible. A daemon bounce now resumes in-flight tickets
  // instead of letting the budget-gated reclaim sweep false-escalate them.
  if (!isBootResumeEligible(report)) {
    return { dispatched: 0, failed: 0, gated: 0, skipped: "not-eligible" };
  }

  const liveAgentList = resolveAgents(agents);
  const candidates = selectBootResumeCandidates({
    orchDir,
    agents: liveAgentList,
    concurrency,
    // CTL-1006 Scenario 2: route a dropped earlier-phase candidate to the
    // audit log instead of re-dispatching it behind a later terminal phase.
    onPhaseRegression: ({ ticket, phase, dominantPhase }) =>
      appendRegressionEvent({ phase, ticket, dominantPhase, orchId }),
    sdkSessionHarvest, // CTL-1422 (B): warm candidates are slice-exempt
  });

  // CTL-1084: planned = total candidates found (before any cap or cooldown filter).
  const planned = candidates.length;
  let dispatched = 0;
  let resumed = 0;
  let warmResumed = 0; // CTL-1422: dispatches that continued a harvested SDK session
  let failed = 0;
  let gated = 0;
  let deferred = 0; // CTL-1084: cheap candidates held back by the per-boot cap
  for (const { ticket, phase, worktreePath, bgJobId } of candidates) {
    // CTL-1422: a harvested SDK session makes this a warm CONTINUATION, not a
    // cold re-run — skip the expensive gate and the rewalk cap (rationale in
    // the option doc above). Review fix (A): the skip is BUDGETED per session
    // UUID — an exhausted budget demotes the candidate to the normal cold path
    // (gate + cap apply), so a crash-looping daemon cannot re-resume forever.
    let warmSession = sdkSessionHarvest.get?.(ticket) ?? null;
    if (warmSession && !consumeWarmBudget(orchDir, ticket, warmSession)) {
      log.warn(
        { ticket, phase, sessionId: warmSession, max: WARM_RESUME_MAX_PER_SESSION },
        "boot-resume: warm-resume budget exhausted for this session — demoting to the gated cold path"
      );
      warmSession = null;
    }
    // CTL-644: gate expensive phases behind operator approval; auto-dispatch cheap ones.
    if (!isCheapPhase(phase) && !warmSession) {
      const written = writePendingMarker(orchDir, ticket, phase, worktreePath);
      if (written) {
        gated++;
        appendGatedEvent({ phase, ticket, orchId });
        log.info(
          { ticket, phase },
          "boot-resume: expensive phase gated — awaiting operator approval"
        );
      }
      continue;
    }

    // CTL-1084: per-boot cheap-dispatch cap — defer to Sweep 1.5 once reached.
    // Cooldown markers are never reset here; the cap is purely additive.
    // CTL-1422: warm candidates are exempt (see option doc).
    if (!warmSession && dispatched >= maxRewalkPerTick) {
      deferred++;
      continue;
    }

    // Cheap path — existing resume/dispatch logic unchanged.
    // CTL-1422: the harvested SDK session wins over bg-job-dir resolution (an
    // sdk-run ticket has no bg job dir; a bg-run ticket has no projection —
    // the two sources are disjoint in practice, precedence is belt-and-braces).
    // CTL-690: try to map the dead worker's bg_job_id → resume UUID. Null
    // result (no bg id, no state.json, no/!.jsonl transcript) falls through
    // to the today-default fresh-dispatch path. The downstream stderr
    // classifier in phase-agent-dispatch (CTL-658 launched/alive/failed)
    // handles a resume that's recorded on disk but fails to launch.
    // CTL-1422 review fix (C): a warm dispatch supersedes any pending-approval
    // marker a PRIOR boot's cold gating left behind — otherwise a later operator
    // approval (processApprovedResumes) double-dispatches the same ticket.
    if (warmSession) {
      try {
        rmSync(bootResumePendingPath(orchDir, ticket), { force: true });
      } catch {
        /* best-effort */
      }
    }
    let resumeSession = warmSession;
    if (!resumeSession && bgJobId) {
      try {
        resumeSession = resolveSession(bgJobId);
      } catch (err) {
        log.warn(
          { ticket, phase, bgJobId, err: err?.message ?? String(err) },
          "boot-resume: resolveSession threw — falling back to fresh dispatch"
        );
        resumeSession = null;
      }
    }

    let res;
    try {
      res = reviveDispatch({ orchDir, ticket, phase, resumeSession }, { dispatch });
    } catch (err) {
      res = { code: 1, stderr: err?.message ?? String(err) };
    }
    if (res?.code === 0) {
      dispatched++;
      if (resumeSession) resumed++;
      if (warmSession) warmResumed++;
      appendEvent({ phase, ticket, orchId });
    } else {
      failed++;
      log.warn(
        { ticket, phase, code: res?.code, stderr: res?.stderr, resumeSession },
        "boot-resume: dispatch failed (continuing)"
      );
    }
  }

  log.info(
    { dispatched, resumed, warmResumed, gated, failed, deferred, planned, candidates: candidates.length },
    "boot-resume: cold-start reconciliation complete"
  );
  return { dispatched, resumed, warmResumed, gated, failed, deferred, planned, candidates: candidates.length };
}

// processApprovedResumes — CTL-644. Dispatch gated tickets whose operator
// approval sentinel exists. Called once at boot (after reconcileBootResume)
// and each scheduler tick so a mid-run approval is honored without a restart.
// Routes through reviveDispatch → same MAX_REVIVES / storm-breaker guards as
// the cheap auto path. Clears both sentinels on a successful dispatch.
export function processApprovedResumes({
  orchDir,
  reviveDispatch = defaultReviveDispatch,
  dispatch = defaultDispatch,
  appendEvent = defaultAppendBootResumeEvent,
  orchId = undefined,
  // CTL-1443: the stale-gate expiry sweep rides the same every-tick call so no
  // scheduler wiring is needed. Injectable for tests; emitAlert defaults to the
  // real dispatch-alert emitter (lazy import avoided — passed by the caller or
  // defaulted here at call time).
  surfaceStaleGates = (o) => surfaceStalePendingApprovals(o),
  emitStaleGateAlert = defaultEmitBootResumePending,
} = {}) {
  try {
    surfaceStaleGates({ orchDir, emitAlert: emitStaleGateAlert });
  } catch (err) {
    log.warn({ err: err?.message }, "ctl-1443: stale-gate sweep threw — continuing");
  }
  const workersDir = join(orchDir, "workers");
  let tickets;
  try {
    // withFileTypes: filter to directories only — guards against non-directory
    // entries at the workers/ level and prevents path-component confusion from
    // any stray file whose name could produce an unexpected path join.
    tickets = readdirSync(workersDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return { dispatched: 0, failed: 0 };
  }

  let dispatched = 0;
  let failed = 0;
  for (const ticket of tickets) {
    const pendingPath = bootResumePendingPath(orchDir, ticket);
    const approvedPath = bootResumeApprovedPath(orchDir, ticket);
    if (!existsSync(pendingPath) || !existsSync(approvedPath)) continue;

    const pending = readPendingMarker(orchDir, ticket);
    if (!pending) {
      log.warn({ ticket }, "processApprovedResumes: pending marker unreadable — skipping");
      continue;
    }

    const { phase, worktreePath } = pending;
    let res;
    try {
      res = reviveDispatch({ orchDir, ticket, phase, resumeSession: null }, { dispatch });
    } catch (err) {
      res = { code: 1, stderr: err?.message ?? String(err) };
    }

    if (res?.code === 0) {
      dispatched++;
      appendEvent({ phase, ticket, orchId });
      try { unlinkSync(pendingPath); } catch { /* best-effort */ }
      try { unlinkSync(approvedPath); } catch { /* best-effort */ }
    } else {
      failed++;
      log.warn(
        { ticket, phase, code: res?.code, stderr: res?.stderr },
        "processApprovedResumes: dispatch failed — sentinels retained for retry"
      );
    }
  }

  return { dispatched, failed };
}
