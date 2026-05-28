// scheduler-rank.mjs — pull-loop scheduler priority ranking (CTL-536, CTL-705).
//
// Pure leaf module: data in → data out, no I/O, no imports. Encodes the
// global ranking rule: priority → stage → createdAt → identifier.

// Linear priority encoding: 1=Urgent, 2=High, 3=Medium, 4=Low, 0=No priority.
// Lower non-zero is more urgent; 0 ("No priority") must rank BELOW Low(4), so
// it maps to 5. A missing / non-numeric priority is treated as No priority.
export function priorityRank(ticket) {
  const p = ticket?.priority;
  return p === 1 || p === 2 || p === 3 || p === 4 ? p : 5;
}

// compareTickets — total order for scheduler selection (CTL-705: 4-key order).
//   1. priority rank ascending (most urgent first)
//   2. stage descending (later pipeline phase first — shortest-remaining-time;
//      absent/undefined stage treated as -1, so queued tickets tie on stage and
//      fall through to createdAt — backward compatible with all queued-vs-queued
//      comparisons. In-flight workers carry an integer stage from STAGE_RANK.)
//   3. createdAt ascending (FIFO fairness; ISO-8601 strings compare lexicographically)
//   4. identifier ascending (deterministic final tie-break)
// A missing createdAt sorts LAST within its band — absent data never jumps the
// queue ahead of a ticket with a known wait time.
export function compareTickets(a, b) {
  const byPriority = priorityRank(a) - priorityRank(b);
  if (byPriority !== 0) return byPriority;

  // stage: higher = later pipeline phase = closer to done. Descending so
  // preemption targets the least-advanced worker. Absent stage → -1.
  const sa = Number.isInteger(a?.stage) ? a.stage : -1;
  const sb = Number.isInteger(b?.stage) ? b.stage : -1;
  if (sa !== sb) return sb - sa; // descending: higher stage sorts first

  const ca = a?.createdAt || "";
  const cb = b?.createdAt || "";
  if (ca !== cb) {
    if (!ca) return 1; // a has no createdAt → a sorts after b
    if (!cb) return -1; // b has no createdAt → a sorts before b
    return ca < cb ? -1 : 1;
  }
  return String(a?.identifier).localeCompare(String(b?.identifier));
}

// rankTickets — a new array sorted by compareTickets. Never mutates the input.
export function rankTickets(tickets) {
  return [...(tickets ?? [])].sort(compareTickets);
}
