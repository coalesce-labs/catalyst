// reap-intent.mjs — mjs producer for reap-intent events (CTL-649 Phase 4).
// Appends one JSONL line per intent to ~/catalyst/events/YYYY-MM.jsonl, the
// canonical event log getEventLogPath() resolves to.
//
// The vocabulary is closed — unknown event types throw — so the schema
// stays disciplined and the reconciler can rely on a fixed switch.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getEventLogPath, log } from "./config.mjs";
// CTL-1004 / CTL-1005 / CTL-1056: the stall-janitor's emit vocabulary lives in a
// dependency-free leaf both modules import, so the producer (stall-janitor.mjs)
// and this closed vocabulary can never drift again. CTL-1005 added the J3 types
// janitor.stall.cleared / janitor.would.clear to the emitter but forgot to
// register them here, so every J3 verdict threw "unknown reap-intent event type"
// at this emitter and was silently lost. Importing the list (instead of
// re-typing it) makes that class of bug structurally impossible.
import { JANITOR_EVENT_TYPES } from "./janitor-event-types.mjs";

export const REAP_INTENT_TYPES = Object.freeze([
  "phase.yield.reap-requested",
  "phase.predecessor.reap-requested",
  "phase.supersede.reap-requested",
  "phase.revive.reap-requested",
  "phase.abort.reap-requested",
  // CTL-661 hole #3: the reclaim happy path (recovery.mjs branch (B)) nominates
  // the (possibly genuinely-hung) worker it is reclaiming for a stop.
  "phase.reclaim.reap-requested",
  // CTL-661 hole #4: the per-ticket reconciliation sweep (reaper.mjs
  // reconcileTicketWorkers) reaps every non-canonical live bg session.
  "phase.reconcile.reap-requested",
  "worktree.presweep.reap-requested",
  "pr.merged.cleanup-requested",
  "orphans.reap-requested",
  // CTL-1165 D3: the ~/.claude/jobs/<id> dir GC (job-dir-gc.mjs) emits this FLAG
  // after a sweep so the reclaim is auditable in the event log. A FLAG class —
  // the reaper has no handle() case for it (it is not a reap REQUEST, the work
  // is already done); it is registered here ONLY so the emitter does not throw
  // "unknown reap-intent event type" and silently drop the count.
  "jobs.gc.swept",
  // CTL-1165 D2: the orphan child-process reaper (proc-reaper.mjs). The periodic
  // orphan-reaper timer emits the TRIGGER `procOrphans.reap-requested` (routed by
  // reaper.mjs _handleProcOrphansSweep → procReaper.sweep); the ProcReaper itself
  // emits the per-process FLAGs `procOrphans.reaped` (enforce kill),
  // `procOrphans.would-reap` (shadow — the DEFAULT, kills nothing), and
  // `procOrphans.spared` (corroboration-failed / catastrophe-guard skip). Only
  // the `.reap-requested` trigger has a handle() case; the FLAGs are registered
  // here ONLY so the emitter does not throw "unknown reap-intent event type".
  "procOrphans.reap-requested",
  "procOrphans.reaped",
  "procOrphans.would-reap",
  "procOrphans.spared",
  // CTL-695: terminal-worker reap — a phase signal reached failed/stalled, or the
  // final monitor-deploy phase completed, with no successor dispatch to trigger the
  // happy-path predecessor reap. Routed to the single-target (busy-OK) reap path.
  "phase.terminal.reap-requested",
  // CTL-791: a worktree removal was REFUSED by the evidence gate (not merged /
  // dirty / live session / unknown provenance / archive-failed). A FLAG, not a
  // request — the reaper does not act on it; it surfaces the deferred worktree in
  // the out-of-tree cleanup queue + orch-monitor for an operator / later tick.
  "worktree.cleanup-deferred",
  // CTL-1004 / CTL-1005 stall-janitor (shadow-first). In "enforce" the janitor
  // emits the real targeted orphans.reap-requested (already above) and the
  // enforce flags; in "shadow" it emits these would.* twins instead of acting. A
  // FLAG class — the reaper does not act on any of these; they surface in the
  // operator event log. Spread from janitor-event-types.mjs (the single source of
  // truth the producer ALSO imports) so this vocabulary can never drift behind a
  // new janitor emit type (CTL-1056): J1 deferred/would.defer/would.reap-request,
  // J2 would.kill-intent, J3 stall.cleared/would.clear.
  ...JANITOR_EVENT_TYPES,
]);

// camelCase → snake_case key mapping. The on-disk schema uses snake_case so
// bash producers and mjs producers write the same shape.
const FIELD_MAP = {
  ticket: "ticket",
  phase: "phase",
  bgJobId: "bg_job_id",
  worktreePath: "worktree_path",
  sessionId: "session_id",
  branch: "branch",
  reason: "reason",
  canonicalBgJobId: "canonical_bg_job_id",
  dominantPhase: "dominant_phase",
  quietMs: "quiet_ms",
  orchId: "orch_id",
  // CTL-1165 D2: proc-reaper process-level fields (already snake_case identity).
  pid: "pid",
  command: "command",
};

/**
 * Emit one reap-intent event. Throws on unknown type. Best-effort on write
 * failure — returns false so callers can fall back to inline reap; never
 * throws on EACCES / disk full.
 *
 * @param {string} eventType — one of REAP_INTENT_TYPES
 * @param {object} fields — fields (camelCase keys); empty/null are dropped
 * @returns {Promise<boolean>} true on append success, false on failure
 */
export async function emitReapIntent(eventType, fields = {}) {
  if (!REAP_INTENT_TYPES.includes(eventType)) {
    throw new Error(`unknown reap-intent event type: ${eventType}`);
  }
  const payload = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    event: eventType,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    const target = FIELD_MAP[k] ?? k;
    payload[target] = v;
  }
  const line = JSON.stringify(payload) + "\n";
  const logPath = getEventLogPath();
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.error({ err: err.message, eventType }, "emitReapIntent: append failed");
    return false;
  }
}
