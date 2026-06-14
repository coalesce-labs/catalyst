// unstuck-sweep-event-types.mjs — CTL-1064 unstuck sweep event vocabulary.
//
// Dependency-free leaf, mirroring janitor-event-types.mjs:23. Every string the
// unstuck sweep passes to its fire()/emit() seam MUST be listed here (10 strings:
// 4 category pairs + 1 escalate pair). The sweep owns this vocabulary and emits
// via the unified-log fire-and-forget path; JANITOR_EVENT_TYPES is NOT extended
// (reap-intent.mjs's closed vocabulary is kept untouched, CTL-1064 §"What We're
// NOT Doing"). Shadow twins follow the convention unstuck.would.* to mirror the
// enforce event name minus the enforce-specific verb prefix.

export const UNSTUCK_SWEEP_EVENT_TYPES = Object.freeze([
  // ---- Category A: rebase_refused_dirty_tree ---------------------------------
  "unstuck.cleared.noise",        // enforce: machine-noise cleared, worktree retried
  "unstuck.would.clear-noise",    // shadow twin
  // ---- Category B: source_conflict_ctl708_unavailable -----------------------
  "unstuck.pushed.force-with-lease", // enforce: clean rebase pushed --force-with-lease
  "unstuck.would.push",           // shadow twin
  // ---- Category C: orphan-sweep-stale (normalized from failureReason) -------
  "unstuck.emitted.phase-complete", // enforce: synthetic phase-complete emitted
  "unstuck.would.emit-complete",  // shadow twin
  // ---- Category D: stale attention labels on terminal tickets ---------------
  "unstuck.cleared.stale-label",  // enforce: stale attention label cleared
  "unstuck.would.clear-label",    // shadow twin
  // ---- Escalate: genuine decision required from human -----------------------
  "unstuck.escalated",            // enforce: genuine decision escalated
  "unstuck.would.escalate",       // shadow twin
]);
