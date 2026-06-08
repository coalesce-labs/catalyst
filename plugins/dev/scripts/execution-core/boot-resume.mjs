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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readWorkerSignals, TERMINAL, byActivePhase } from "./signal-reader.mjs";
import { listInFlightTickets, readMaxParallel, computeFreeSlots } from "./scheduler.mjs";
import { log } from "./config.mjs";
import {
  defaultReviveDispatch,
  defaultAppendBootResumeEvent,
  defaultAppendBootResumeGatedEvent,
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
  return needResume.slice(0, free);
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
export function reconcileBootResume({
  orchDir,
  report,
  agents = undefined, // array | fn | undefined→liveAgents()
  dispatch = defaultDispatch, // inner seam handed to reviveDispatch
  reviveDispatch = defaultReviveDispatch,
  appendEvent = defaultAppendBootResumeEvent,
  // CTL-644: gated-event appender — emitted once per expensive ticket gated.
  appendGatedEvent = defaultAppendBootResumeGatedEvent,
  // CTL-690: session resolver — same helper recovery.mjs:1265 uses on the
  // per-tick reclaim path so boot-resume and reclaim share resume semantics.
  // Injectable so tests can drive both the resumable + unresumable branches
  // without touching real ~/.claude/jobs state. Returns a UUID string when the
  // dead worker's transcript is on disk, or null when not resumable.
  resolveSession = resolvePhaseSessionId,
  orchId = undefined, // threaded into the audit envelope
  concurrency = {}, // CTL-665: committed executionCore concurrency knobs (from startDaemon)
} = {}) {
  if (!report || report.coldStart !== true) {
    return { dispatched: 0, failed: 0, gated: 0, skipped: "not-cold-start" };
  }

  const liveAgentList = resolveAgents(agents);
  const candidates = selectBootResumeCandidates({ orchDir, agents: liveAgentList, concurrency });

  let dispatched = 0;
  let resumed = 0;
  let failed = 0;
  let gated = 0;
  for (const { ticket, phase, worktreePath, bgJobId } of candidates) {
    // CTL-644: gate expensive phases behind operator approval; auto-dispatch cheap ones.
    if (!isCheapPhase(phase)) {
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

    // Cheap path — existing resume/dispatch logic unchanged.
    // CTL-690: try to map the dead worker's bg_job_id → resume UUID. Null
    // result (no bg id, no state.json, no/!.jsonl transcript) falls through
    // to the today-default fresh-dispatch path. The downstream stderr
    // classifier in phase-agent-dispatch (CTL-658 launched/alive/failed)
    // handles a resume that's recorded on disk but fails to launch.
    let resumeSession = null;
    if (bgJobId) {
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
    { dispatched, resumed, gated, failed, candidates: candidates.length },
    "boot-resume: cold-start reconciliation complete"
  );
  return { dispatched, resumed, gated, failed, candidates: candidates.length };
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
} = {}) {
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
