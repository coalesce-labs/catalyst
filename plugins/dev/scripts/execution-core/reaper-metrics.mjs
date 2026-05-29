// reaper-metrics.mjs — incremental reap-outcome counter (CTL-695 Phase 2).
//
// Reads the unified event log's flat reap-family lines (event field ending in
// .reap-requested / .reap-complete / .reap-failed) and returns per-tick counters
// that otel-forward ships as a pino gauge. Mirrors event-scan.mjs's per-path
// incremental byte cursor + scanEventsChunked for bounded memory.
//
// Reap echoes use FLAT `ev.event` (not attributes["event.name"]) — a distinct
// shape from OTLP-wrapped session events. Production 2026-05.jsonl: 8936
// reap-requested, 498 reap-complete, 0 reap-failed — the gap is observable but
// uninstrumented without this module.

import { statSync } from "node:fs";
import { scanEventsChunked } from "./event-tail.mjs";
import { getEventLogPath } from "./config.mjs";

const _index = new Map(); // path → { cursor, leftover, events: [{event, ts}] }

function isReapEvent(name) {
  return (
    typeof name === "string" &&
    (name.endsWith(".reap-requested") ||
      name.endsWith(".reap-complete") ||
      name.endsWith(".reap-failed"))
  );
}

function refreshIndex(path) {
  let entry = _index.get(path);
  if (!entry) {
    entry = { cursor: 0, leftover: "", events: [] };
    _index.set(path, entry);
  }
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return entry; // missing log → cold start
  }
  if (size < entry.cursor) {
    // Rotated or truncated — drop stale state.
    entry.cursor = 0;
    entry.leftover = "";
    entry.events = [];
  }
  if (size === entry.cursor) return entry; // no new bytes
  const { endOffset, leftover } = scanEventsChunked({
    path,
    fromOffset: entry.cursor,
    leftover: entry.leftover,
    onEvent: (ev) => {
      const name = ev?.event;
      if (!isReapEvent(name)) return;
      entry.events.push({ event: name, ts: ev?.ts });
    },
  });
  entry.cursor = endOffset;
  entry.leftover = leftover;
  return entry;
}

/**
 * Count reap outcomes from the event log at `path` (defaults to the current
 * month's log). Optional `since` ISO timestamp excludes earlier events.
 * Returns { staleSeen, staleReaped, reapFailures }.
 */
export function countReapOutcomes({ since, path = getEventLogPath() } = {}) {
  let staleSeen = 0;
  let staleReaped = 0;
  let reapFailures = 0;
  for (const ev of refreshIndex(path).events) {
    if (since && ev.ts && ev.ts < since) continue;
    if (ev.event.endsWith(".reap-requested")) staleSeen++;
    else if (ev.event.endsWith(".reap-complete")) staleReaped++;
    else if (ev.event.endsWith(".reap-failed")) reapFailures++;
  }
  return { staleSeen, staleReaped, reapFailures };
}

export function __resetReaperMetricsIndexForTest() {
  _index.clear();
}
