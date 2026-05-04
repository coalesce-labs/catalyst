/**
 * Minimal structural validator for worker signal files.
 *
 * Mirrors the required fields from plugins/dev/templates/worker-signal.json.
 * Kept in its own module (separate from state-reader.ts) so Phase 1 and Phase 2
 * work streams don't collide on the same file.
 */

const VALID_STATUSES = new Set([
  "dispatched",
  "researching",
  "planning",
  "implementing",
  "validating",
  "shipping",
  "pr-created",
  "merging",
  // CTL-211: orchestrator-driven deploy lifecycle states (worker still exits at "merging";
  // these are written by the orchestrator's Phase 4 deploy state machine).
  "merged",
  "deploying",
  "deploy-failed",
  "done",
  "failed",
  "stalled",
  "remediation",
  // Tolerant extras that show up in practice / tests:
  "in_progress",
]);

function isIsoDateTimeString(v: unknown): boolean {
  if (typeof v !== "string" || v.length === 0) return false;
  const t = Date.parse(v);
  return Number.isFinite(t);
}

export function validateSignalFile(obj: unknown): boolean {
  if (obj === null || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;

  if (typeof o.ticket !== "string" || o.ticket.length === 0) return false;
  if (typeof o.orchestrator !== "string" || o.orchestrator.length === 0) return false;
  if (typeof o.workerName !== "string" || o.workerName.length === 0) return false;

  if (typeof o.status !== "string") return false;
  // Accept known statuses; be permissive about case since enum is canonical lowercase.
  if (!VALID_STATUSES.has(o.status)) return false;

  if (typeof o.phase !== "number" || !Number.isInteger(o.phase)) return false;
  if (o.phase < 0 || o.phase > 6) return false;

  if (!isIsoDateTimeString(o.startedAt)) return false;
  if (!isIsoDateTimeString(o.updatedAt)) return false;

  // Optional fields — validate types only if present.
  if ("label" in o && o.label !== null && o.label !== undefined) {
    if (typeof o.label !== "string" || o.label.length === 0) return false;
  }
  if ("pid" in o && o.pid !== null && o.pid !== undefined) {
    if (typeof o.pid !== "number" || !Number.isInteger(o.pid)) return false;
  }
  if ("lastHeartbeat" in o && o.lastHeartbeat !== null && o.lastHeartbeat !== undefined) {
    if (!isIsoDateTimeString(o.lastHeartbeat)) return false;
  }
  if ("fixupCommit" in o && o.fixupCommit !== null && o.fixupCommit !== undefined) {
    if (typeof o.fixupCommit !== "string" || o.fixupCommit.length === 0) return false;
  }
  if ("followUpTo" in o && o.followUpTo !== null && o.followUpTo !== undefined) {
    if (typeof o.followUpTo !== "string" || o.followUpTo.length === 0) return false;
  }

  return true;
}
