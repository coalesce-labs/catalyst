// event-scan.mjs — CTL-587 historical scan of execution-core's events.jsonl.
//
// Two count queries no existing consumer provides:
//   - countReviveEvents({ticket, orchId, since, path}) — the per-ticket revive
//     budget for recovery.mjs.
//   - countDistinctRevivingTickets({windowMs, now, path}) — the storm-breaker
//     that prevents a chain reaction when many tickets revive at once.
//
// Both are read-only synchronous scans of the entire events.jsonl. Pure: no
// caching, no cursor. The file is not yet hot enough to justify either. A
// follow-up (sized as "What We're NOT Doing" in the plan) adds a tailed cache
// keyed on `(file size, last line ts)` if the file grows beyond ~50 MB.
//
// Parse failures on a line are skipped silently (best-effort). A missing log
// returns 0 from both functions — the cold-start path the daemon hits before
// the first event lands.

import { existsSync, readFileSync } from "node:fs";
import { getEventLogPath } from "./config.mjs";

const REVIVE_NAME_PREFIX = "phase.implement.revive.";

function* readLinesSync(path) {
  if (!existsSync(path)) return;
  // events.jsonl is at MB-scale today; the whole-file read is simpler than a
  // stream and the OS page cache makes repeat scans cheap.
  const buf = readFileSync(path, "utf8");
  for (const line of buf.split(/\r?\n/)) {
    if (line) yield line;
  }
}

function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// countReviveEvents — number of phase.implement.revive.<ticket> envelopes that
// match the optional filters. Used by recovery.mjs to enforce MAX_REVIVES on a
// per-ticket basis. orchId is currently always set in the envelope but the
// match is tolerant of a missing attribute on either side (defensive default).
export function countReviveEvents({
  ticket,
  orchId,
  since,
  path = getEventLogPath(),
} = {}) {
  if (!ticket) throw new Error("countReviveEvents: ticket required");
  const target = `phase.implement.revive.${ticket}`;
  let n = 0;
  for (const line of readLinesSync(path)) {
    const ev = safeParse(line);
    if (!ev) continue;
    const name = ev?.attributes?.["event.name"];
    if (name !== target) continue;
    if (orchId && ev?.attributes?.["catalyst.orchestration"] !== orchId) continue;
    if (since && ev?.ts && ev.ts < since) continue;
    n++;
  }
  return n;
}

// countDistinctRevivingTickets — unique tickets that have any revive event
// inside `windowMs` of `now()`. Used by recovery.mjs to suppress revives when
// the storm-breaker is open (default >3 distinct tickets in the last 10min).
// The shape `now: () => number` matches the recovery.mjs convention so tests
// can pin the clock.
export function countDistinctRevivingTickets({
  windowMs,
  now = Date.now,
  path = getEventLogPath(),
} = {}) {
  if (!windowMs) throw new Error("countDistinctRevivingTickets: windowMs required");
  const cutoff = now() - windowMs;
  const seen = new Set();
  for (const line of readLinesSync(path)) {
    const ev = safeParse(line);
    if (!ev) continue;
    const name = ev?.attributes?.["event.name"];
    if (typeof name !== "string" || !name.startsWith(REVIVE_NAME_PREFIX)) continue;
    const tsMs = Date.parse(ev?.ts || "");
    if (!Number.isFinite(tsMs) || tsMs < cutoff) continue;
    const ticket = ev?.attributes?.["event.label"];
    if (ticket) seen.add(ticket);
  }
  return seen.size;
}
