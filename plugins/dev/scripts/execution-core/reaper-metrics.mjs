// reaper-metrics.mjs — incremental reap-outcome counter (CTL-695 Phase 2; CTL-793 counters-not-rows).
//
// Reads the unified event log's flat reap-family lines (event field ending in
// .reap-requested / .reap-complete / .reap-failed) and returns per-tick counters
// that otel-forward ships as a pino gauge. Mirrors event-scan.mjs's per-path
// incremental byte cursor + scanEventsChunked for bounded memory.
//
// CTL-793: the index folds each reap event into three running counters as it is
// scanned, instead of retaining every event in an unbounded `events[]` array that
// countReapOutcomes re-iterated every tick (the ~170k-entry leak that blocked the
// scheduler event loop ~20s/tick). Memory is now O(1) per active month and
// countReapOutcomes is O(1). The first call still seeds the counters with a single
// cursor-0 scan of the month's log, so the absolute totals are continuous with the
// pre-CTL-793 array-based gauge (no per-boot discontinuity). The cross-month evict
// (redesign §3 finding #4) drops the prior month's entry on rotation so the Map
// can never accumulate across months.
//
// Reap echoes use FLAT `ev.event` (not attributes["event.name"]) — a distinct
// shape from OTLP-wrapped session events.

import { statSync } from "node:fs";
import { scanEventsChunked } from "./event-tail.mjs";
import { getEventLogPath } from "./config.mjs";

const _index = new Map(); // path → { cursor, leftover, staleSeen, staleReaped, reapFailures }

function isReapEvent(name) {
  return (
    typeof name === "string" &&
    (name.endsWith(".reap-requested") ||
      name.endsWith(".reap-complete") ||
      name.endsWith(".reap-failed"))
  );
}

function newEntry() {
  return { cursor: 0, leftover: "", staleSeen: 0, staleReaped: 0, reapFailures: 0 };
}

function refreshIndex(path) {
  // Cross-month evict (redesign §3 finding #4): keep only the active path's entry
  // so the Map can never accumulate prior months across log rotation.
  for (const key of _index.keys()) {
    if (key !== path) _index.delete(key);
  }
  let entry = _index.get(path);
  if (!entry) {
    entry = newEntry();
    _index.set(path, entry);
  }
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return entry; // missing log → cold start
  }
  if (size < entry.cursor) {
    // Rotated or truncated — drop stale state, counters included.
    entry.cursor = 0;
    entry.leftover = "";
    entry.staleSeen = 0;
    entry.staleReaped = 0;
    entry.reapFailures = 0;
  }
  if (size === entry.cursor) return entry; // no new bytes
  const { endOffset, leftover } = scanEventsChunked({
    path,
    fromOffset: entry.cursor,
    leftover: entry.leftover,
    onEvent: (ev) => {
      const name = ev?.event;
      if (!isReapEvent(name)) return;
      // Fold into running counters — no per-event retention (CTL-793).
      if (name.endsWith(".reap-requested")) entry.staleSeen++;
      else if (name.endsWith(".reap-complete")) entry.staleReaped++;
      else if (name.endsWith(".reap-failed")) entry.reapFailures++;
    },
  });
  entry.cursor = endOffset;
  entry.leftover = leftover;
  return entry;
}

/**
 * Count reap outcomes from the event log at `path` (defaults to the current
 * month's log). Returns { staleSeen, staleReaped, reapFailures } in O(1): the
 * counters are folded incrementally as the log is scanned (CTL-793), so this is
 * a constant-time read after the first cursor-0 seed scan. The pre-CTL-793 `since`
 * window param is dropped — the sole production caller (scheduler reap-stats log)
 * never passed it, and folded counters can't be retroactively windowed.
 */
export function countReapOutcomes({ path = getEventLogPath() } = {}) {
  const { staleSeen, staleReaped, reapFailures } = refreshIndex(path);
  return { staleSeen, staleReaped, reapFailures };
}

export function __resetReaperMetricsIndexForTest() {
  _index.clear();
}

// Test-only: the live index size. Guards the cross-month evict (finding #4) —
// the Map must stay bounded (≤1 active month) across log rotation.
export function __reaperMetricsIndexSizeForTest() {
  return _index.size;
}
