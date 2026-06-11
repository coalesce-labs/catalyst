// janitor-event-types.mjs — SINGLE SOURCE OF TRUTH for the stall-janitor's
// reap-intent event vocabulary (CTL-1004 / CTL-1005 / CTL-1056).
//
// WHY a dedicated leaf module: stall-janitor.mjs EMITS these types and
// reap-intent.mjs must REGISTER them in REAP_INTENT_TYPES (its closed
// vocabulary throws on any unknown type). stall-janitor.mjs already imports
// reap-intent.mjs transitively (stall-janitor → worktree-safety →
// reap-intent), so importing the list the other way (reap-intent →
// stall-janitor) would close an import cycle and a top-level frozen-array
// export evaluated mid-cycle is exactly the shape that resolves to `undefined`
// under cyclic module init. This dependency-free leaf — imported by BOTH —
// breaks the cycle and guarantees the producer and the vocabulary can never
// drift again: the bug CTL-1005 introduced (it added the J3 shadow type
// janitor.would.clear and the J3 enforce type janitor.stall.cleared to the
// emitter but never to the vocabulary, so every J3 verdict threw
// "unknown reap-intent event type" at the emitter and was silently lost).
//
// EVERY string the stall-janitor passes to its `fire()`/`emit()` seam MUST be
// listed here. The reap-intent test enumerates this constant and asserts each
// member is registered, so a future janitor emit type that is forgotten here
// fails the suite instead of dying live on the daemon.

export const JANITOR_EVENT_TYPES = Object.freeze([
  // ---- J1 (orphan worktrees) -------------------------------------------------
  "janitor.worktree.deferred", // enforce: dirty-tree deferral flag
  "janitor.would.defer", // shadow twin of janitor.worktree.deferred
  "janitor.would.reap-request", // shadow twin of orphans.reap-requested
  // (enforce J1 emits the pre-existing orphans.reap-requested, registered
  //  directly in reap-intent.mjs as a non-janitor type.)
  // ---- J2 (ghost sessions) ---------------------------------------------------
  "janitor.would.kill-intent", // shadow twin of the recordKillIntent seam
  // ---- J3 (prior-artifact-retry-exhausted stalls, CTL-1005) ------------------
  "janitor.stall.cleared", // enforce: a stall was auto-cleared once
  "janitor.would.clear", // shadow twin of janitor.stall.cleared
]);
