// sparse-warn.ts — CTL-1817's "count every occurrence, log sparsely" gate, extracted
// (CTL-1818) so the drop surface reuses the SAME mechanism instead of growing a second one
// beside it.
//
// The counters a caller keeps must be exact — they are the measurement. The log line is the
// alarm, and an alarm that fires per-record is a liability: the observed v3 rate was ~17/day,
// but an unknown future shape could be a `recovery.tick`-class emitter (326,940/month), which
// would flood otel-forward.log and, through Alloy, Loki itself. Degrading the log surface
// while reporting a log-surface defect would be its own bug.
//
// So: warn once per distinct key (the diagnostic that actually tells an operator what to
// fix), then only on exponentially-spaced totals so a sustained flood still shows a live
// heartbeat with an accurate running count. The distinct-key set is capped — an attacker-ish
// pathological case (a unique name per record, e.g. a ticket id in the name) must not grow
// unboundedly in a long-lived daemon.
//
// Each caller builds its OWN gate rather than sharing one module-level set: a flood of
// unknown envelope shapes must not exhaust the budget that the drop-reason alarm depends on.

export interface SparseWarnGateOpts {
  /** Cap on distinct keys that get a first-sighting warning. Default 50. */
  maxTracked?: number;
}

/**
 * Returns `shouldWarn(key, total)` — true on the first sighting of `key` (while under the
 * cap), and thereafter only at 10, 100, 1000, … occurrences of the caller's running `total`.
 */
export function createSparseWarnGate({ maxTracked = 50 }: SparseWarnGateOpts = {}) {
  const warned = new Set<string>();
  return function shouldWarn(key: string, total: number): boolean {
    if (!warned.has(key) && warned.size < maxTracked) {
      warned.add(key);
      return true;
    }
    // 10, 100, 1000, … — a bounded heartbeat under sustained loss.
    return total >= 10 && Math.log10(total) % 1 === 0;
  };
}
