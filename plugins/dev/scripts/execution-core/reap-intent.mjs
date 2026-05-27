// reap-intent.mjs — mjs producer for reap-intent events (CTL-649 Phase 4).
// Appends one JSONL line per intent to ~/catalyst/events/YYYY-MM.jsonl, the
// canonical event log getEventLogPath() resolves to.
//
// The vocabulary is closed — unknown event types throw — so the schema
// stays disciplined and the reconciler can rely on a fixed switch.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getEventLogPath, log } from "./config.mjs";

export const REAP_INTENT_TYPES = Object.freeze([
  "phase.yield.reap-requested",
  "phase.predecessor.reap-requested",
  "phase.supersede.reap-requested",
  "phase.revive.reap-requested",
  "phase.abort.reap-requested",
  "worktree.presweep.reap-requested",
  "pr.merged.cleanup-requested",
  "orphans.reap-requested",
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
