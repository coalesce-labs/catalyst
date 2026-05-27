// boot-resume.mjs — execution-core daemon boot-resume (CTL-654).
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
// re-dispatches a fresh worker at the ticket's current phase via
// defaultReviveDispatch — which bypasses the revive budget by construction (the
// budget lives in reclaimDeadWorkIfPossible, not in the dispatch primitive) and
// keeps the CTL-615 worktree-path cross-check. The fan-out is bounded by
// maxParallel so a reboot never spawns a worker storm.
//
// Phase 1 (this section) is pure selection logic, dependency-free beyond the
// scheduler/signal-reader read helpers, and exhaustively unit-tested. The
// reconcileBootResume orchestrator (Phase 2) wires in the side effects.

import { readWorkerSignals, TERMINAL, byActivePhase } from "./signal-reader.mjs";
import { listInFlightTickets, readMaxParallel, computeFreeSlots } from "./scheduler.mjs";
import { log } from "./config.mjs";
import { defaultReviveDispatch, defaultAppendBootResumeEvent } from "./recovery.mjs";
import { defaultDispatch } from "./dispatch.mjs";
// liveAgents() is synchronous (execFileSync `claude agents --json`). A static
// import is safe here: cli/sessions.mjs imports only signal-reader/reap-intent/
// config/claude-ids/session-recency/cli-args — none of which import this module,
// so there is no import cycle. (The plan floated a lazy import to keep the pure
// Phase-1 exports import-light, but a lazy `import()` is async and the boot pass
// must stay synchronous to complete before the monitor/scheduler start.)
import { liveAgents } from "./cli/sessions.mjs";

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
    Array.isArray(agents) &&
    agents.some((s) => s?.kind === "background" && s?.cwd === worktreePath)
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
// list. Returns `{ ticket, phase, worktreePath }[]`, deterministically sorted by
// ticket id and sliced to the free-slot cap so a reboot never over-dispatches.
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
export function selectBootResumeCandidates({
  orchDir,
  agents,
  maxParallel = readMaxParallel(orchDir),
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
    if (!active.worktreePath) {
      logger.warn(
        { ticket, phase: active.phase },
        "boot-resume: in-flight ticket has no worktreePath — cannot revive safely, skipping",
      );
      continue;
    }
    if (hasLiveBgWorker(agents, active.worktreePath)) {
      liveCount++;
    } else {
      needResume.push({ ticket, phase: active.phase, worktreePath: active.worktreePath });
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
  orchId = undefined, // threaded into the audit envelope
} = {}) {
  if (!report || report.coldStart !== true) {
    return { dispatched: 0, failed: 0, skipped: "not-cold-start" };
  }

  const liveAgentList = resolveAgents(agents);
  const candidates = selectBootResumeCandidates({ orchDir, agents: liveAgentList });

  let dispatched = 0;
  let failed = 0;
  for (const { ticket, phase } of candidates) {
    let res;
    try {
      res = reviveDispatch({ orchDir, ticket, phase }, { dispatch });
    } catch (err) {
      res = { code: 1, stderr: err?.message ?? String(err) };
    }
    if (res?.code === 0) {
      dispatched++;
      appendEvent({ phase, ticket, orchId });
    } else {
      failed++;
      log.warn(
        { ticket, phase, code: res?.code, stderr: res?.stderr },
        "boot-resume: dispatch failed (continuing)",
      );
    }
  }

  log.info(
    { dispatched, failed, candidates: candidates.length },
    "boot-resume: cold-start reconciliation complete",
  );
  return { dispatched, failed, candidates: candidates.length };
}
