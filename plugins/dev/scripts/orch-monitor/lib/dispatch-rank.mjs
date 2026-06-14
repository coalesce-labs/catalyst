// dispatch-rank.mjs — the ONE canonical dispatch-order comparator (CTL-1015).
//
// Pure leaf module: data in → data out, no I/O, no imports. This is the single
// source of truth for the "order work will be dispatched" rank used everywhere
// in the monitor — the /queue control-tower deck + dispatch list, and (in a
// follow-up ticket) the board's Display > Ordering > Priority option.
//
// It mirrors execution-core/scheduler-rank.mjs `compareTickets` EXACTLY so the
// monitor's displayed order is identical to the order the scheduler actually
// dispatches in. A parity test (dispatch-rank.test.mjs) imports BOTH modules and
// asserts identical sort order over a shared fixture, locking the two together.
//
// Rank rule (total order):
//   1. priority rank ascending  (1=Urgent…4=Low, 0/absent → 5, so "No priority"
//      sorts below Low)
//   2. stage descending         (later pipeline phase first; absent/non-integer
//      stage → -1, so queued tickets — which carry no stage — tie here and fall
//      through to createdAt, behavior-identical to the queue's prior comparator)
//   3. createdAt ascending      (FIFO fairness; ISO-8601 compares lexically; a
//      missing createdAt sorts LAST within its band — absent data never jumps
//      the queue)
//   4. identifier ascending     (deterministic final tie-break, localeCompare)

/** Linear priority → rank. 1=Urgent…4=Low; 0/absent/non-numeric → 5 (below Low). */
export const PRIORITY_RANK = (p) => (p && p >= 1 && p <= 4 ? p : 5);

/**
 * Total-order comparator for dispatch selection. Accepts either a queue item
 * (id + priority + createdAt) or an in-flight-style ticket (which may also carry
 * an integer `stage`). The four axes degrade gracefully on absent fields.
 */
export function compareDispatchOrder(a, b) {
  const byPriority = PRIORITY_RANK(a?.priority) - PRIORITY_RANK(b?.priority);
  if (byPriority !== 0) return byPriority;

  // stage: higher = later pipeline phase = closer to done. Descending so the
  // least-advanced sorts last. Absent/non-integer stage → -1 (queue items tie).
  const sa = Number.isInteger(a?.stage) ? a.stage : -1;
  const sb = Number.isInteger(b?.stage) ? b.stage : -1;
  if (sa !== sb) return sb - sa; // descending

  const ca = a?.createdAt || "";
  const cb = b?.createdAt || "";
  if (ca !== cb) {
    if (!ca) return 1; // a has no createdAt → a sorts after b
    if (!cb) return -1; // b has no createdAt → a sorts before b
    return ca < cb ? -1 : 1;
  }

  // identifier tie-break: queue items use `id`, scheduler tickets use
  // `identifier`. Prefer whichever is present so both shapes sort deterministically.
  const ia = a?.identifier ?? a?.id;
  const ib = b?.identifier ?? b?.id;
  return String(ia).localeCompare(String(ib));
}

/** A new array sorted by compareDispatchOrder. Never mutates the input. */
export function rankDispatchOrder(items) {
  return [...(items ?? [])].sort(compareDispatchOrder);
}
