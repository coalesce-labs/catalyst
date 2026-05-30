// event-scan.mjs — CTL-587 historical scan of execution-core's events.jsonl,
// reworked for bounded memory in CTL-673.
//
// Three count queries no existing consumer provides:
//   - countReviveEvents({ticket, orchId, since, path}) — the per-ticket revive
//     budget for recovery.mjs.
//   - countRemediateCycles({ticket, orchId, since, path}) — the event-counted
//     verify⇄remediate budget (CTL-653).
//   - countDistinctRevivingTickets({windowMs, now, path}) — the storm-breaker
//     that prevents a chain reaction when many tickets revive at once.
//
// CTL-673: the daemon calls these on its hot path — once per in-flight ticket
// and once per reclaim-eligible signal, on every event-log write. The old
// implementation `readFileSync`'d the WHOLE monthly log (~183 MB / ~297K lines)
// per call, allocating a fresh giant string + array each time; observed daemon
// RSS hit 1.8 GB after ~5h (JavaScriptCore never returns the freed pages).
//
// We now keep a per-path incremental index: a byte cursor advanced with the
// shared `scanEventsChunked` primitive (event-tail.mjs), retaining ONLY the two
// event families these counters query (`phase.implement.revive.*` and
// `phase.remediate.complete.*`) as compact records. Repeated calls against the
// same path read only newly-appended bytes; each query filters the small
// retained list. Per-wake work becomes O(appended bytes); steady-state RSS is
// bounded by the chunk size + the retained relevant-event list. The returned
// numbers stay byte-identical to the old whole-file scan (existing tests guard
// this). The only behavioral change is *when* bytes are read.
//
// Parse failures on a line are skipped silently (via parseEventTailChunk). A
// missing log yields 0 from all three functions — the cold-start path the
// daemon hits before the first event lands. The index is process-lifetime
// in-memory state: a daemon restart re-seeds from offset 0 on the first call
// (one bounded streaming pass), which is correct because the counters need full
// history. Monthly rotation changes getEventLogPath() → a fresh index entry.

import { statSync } from "node:fs";
import { scanEventsChunked } from "./event-tail.mjs";
import { getEventLogPath } from "./config.mjs";

// CTL-735: revive events are phase-agnostic — `phase.<phase>.revive.<ticket>`.
// CTL-604 extended revive to triage/research/plan/verify, but this scan still
// matched only `phase.implement.revive.` — so the per-ticket budget (MAX_REVIVES)
// and the storm-breaker never counted non-implement revives, and those phases
// slow-looped forever (the triage/verify storm at the CTL-731 re-enable). Match
// ANY single phase segment. (`[^.]+` is one segment, so this does NOT match
// `phase.remediate.complete.` or `phase.revive.reap-requested`.)
const REVIVE_NAME_RE = /^phase\.[^.]+\.revive\./;
const REMEDIATE_NAME_PREFIX = "phase.remediate.complete.";

// Per-path incremental index. We retain ONLY the two event families the counters
// query — a tiny fraction of the log — so memory stays bounded as the file grows.
const _index = new Map(); // path -> { cursor, leftover, events: [{ name, orchId, ts, label }] }

function isRelevant(name) {
  return (
    typeof name === "string" &&
    (REVIVE_NAME_RE.test(name) || name.startsWith(REMEDIATE_NAME_PREFIX))
  );
}

// refreshIndex — advance the path's cursor over newly-appended bytes, appending
// any relevant events to the retained list. Resets on rotation/truncation
// (size < cursor → a new/rolled file). A missing log is a no-op cold start
// (events stays []). Returns the (mutated) entry so callers can filter it.
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
    return entry; // missing log → cold start; retained events unchanged
  }
  if (size < entry.cursor) {
    // File rotated or truncated — drop the stale cursor, leftover, and records.
    entry.cursor = 0;
    entry.leftover = "";
    entry.events = [];
  }
  if (size === entry.cursor) return entry; // no new bytes — never re-reads
  const { endOffset, leftover } = scanEventsChunked({
    path,
    fromOffset: entry.cursor,
    leftover: entry.leftover,
    onEvent: (ev) => {
      const name = ev?.attributes?.["event.name"];
      if (!isRelevant(name)) return;
      entry.events.push({
        name,
        orchId: ev?.attributes?.["catalyst.orchestration"],
        ts: ev?.ts,
        label: ev?.attributes?.["event.label"],
      });
    },
  });
  entry.cursor = endOffset;
  entry.leftover = leftover;
  return entry;
}

// countByExactName — shared body for the two exact-name counters. Matches by
// full `event.name`, with the optional orchId / since filters applied exactly
// as the pre-CTL-673 whole-file scan did.
function countByExactName(target, { orchId, since, path }) {
  return countByMatch((name) => name === target, { orchId, since, path });
}

// countByMatch — like countByExactName but matches names via a predicate, so the
// phase-agnostic revive counter (CTL-735) can match `phase.<any>.revive.<ticket>`.
function countByMatch(nameMatches, { orchId, since, path }) {
  let n = 0;
  for (const ev of refreshIndex(path).events) {
    if (typeof ev.name !== "string" || !nameMatches(ev.name)) continue;
    if (orchId && ev.orchId !== orchId) continue;
    if (since && ev.ts && ev.ts < since) continue;
    n++;
  }
  return n;
}

// countReviveEvents — number of phase.implement.revive.<ticket> envelopes that
// match the optional filters. Used by recovery.mjs to enforce MAX_REVIVES on a
// per-ticket basis. orchId is currently always set in the envelope but the
// match is tolerant of a missing attribute on either side (defensive default).
export function countReviveEvents({ ticket, orchId, since, path = getEventLogPath() } = {}) {
  if (!ticket) throw new Error("countReviveEvents: ticket required");
  // CTL-735: match `phase.<any-phase>.revive.<ticket>` (the suffix uniquely
  // identifies a revive for this exact ticket — `.revive.CTL-728` cannot match
  // `.revive.CTL-7281`/`.revive.CTL-1728`). Phase-agnostic so every phase's
  // revive consumes the per-ticket MAX_REVIVES budget, not just implement.
  const suffix = `.revive.${ticket}`;
  return countByMatch((name) => name.startsWith("phase.") && name.endsWith(suffix), {
    orchId,
    since,
    path,
  });
}

// countRemediateCycles — number of phase.remediate.complete.<ticket> envelopes
// (CTL-653). The event-counted verify⇄remediate budget, mirroring
// countReviveEvents but deliberately DISTINCT from it: a crash-revive
// (phase.implement.revive.<T>) never consumes verdict-cycle budget, and the
// cycle survives the per-cycle signal reset (signals are deleted each cycle;
// events are durable). One completed cycle == one remediate-complete event.
export function countRemediateCycles({ ticket, orchId, since, path = getEventLogPath() } = {}) {
  if (!ticket) throw new Error("countRemediateCycles: ticket required");
  return countByExactName(`${REMEDIATE_NAME_PREFIX}${ticket}`, { orchId, since, path });
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
  for (const ev of refreshIndex(path).events) {
    if (typeof ev.name !== "string" || !REVIVE_NAME_RE.test(ev.name)) continue; // CTL-735: any phase
    const tsMs = Date.parse(ev.ts || "");
    if (!Number.isFinite(tsMs) || tsMs < cutoff) continue;
    if (ev.label) seen.add(ev.label);
  }
  return seen.size;
}

// __resetEventScanIndexForTest — clear the per-path index so a suite starts from
// a known state. Test-only; not used by production code.
export function __resetEventScanIndexForTest() {
  _index.clear();
}
