// resolve-conflict-sweep-event-types.mjs — #1461 resolve-conflict-sweep event
// vocabulary. Dependency-free leaf, mirroring unstuck-sweep-event-types.mjs and
// janitor-event-types.mjs. Every string the sweep passes to its emit() seam MUST
// be listed here. This is its OWN closed vocabulary — not routed through
// reap-intent.mjs or unstuck-sweep's UNSTUCK_SWEEP_EVENT_TYPES (same "closed
// list per sweep" discipline those two modules already establish).

export const RESOLVE_CONFLICT_SWEEP_EVENT_TYPES = Object.freeze([
  // A resolvable candidate found — marked and about to dispatch.
  "resolve-conflict.marked.resolvable",
  "resolve-conflict.would.mark", // shadow twin
  // phase-resolve-conflict dispatched via the standard envelope.
  "resolve-conflict.dispatched",
  "resolve-conflict.would.dispatch", // shadow twin
  // The original stall cleared after a resolve-conflict completion.
  "resolve-conflict.cleared",
  "resolve-conflict.would.clear", // shadow twin
  // Cycle cap exhausted without a clean resolution — escalated to the operator.
  "resolve-conflict.escalated",
  "resolve-conflict.would.escalate", // shadow twin
  // #1461 escalation-gap fix: a FAILED (not done) resolve-conflict run, still
  // under the cycle cap — the original stall reason reverted + the stale cycle
  // reset so the ticket becomes a genuine candidate again on a later tick.
  "resolve-conflict.retry-armed",
  "resolve-conflict.would.retry", // shadow twin
]);
