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
// CTL-1176 rung 3: the recovery-pass dispatch budget, analogous to the
// remediate verdict-cycle budget. One completed recovery-pass sweep ==
// one phase.recovery-pass.complete.<ticket> event. Durable (survives signal
// resets), so the cap holds across ticks/restarts.
const RECOVERY_PASS_NAME_PREFIX = "phase.recovery-pass.complete.";

// CTL-802 — countTicketEventsInWindow (the CTL-671 runaway detector) used to scan
// the WHOLE log from offset 0 on every call — and it is called once per in-flight
// signal per scheduler tick. On a large monthly log that single function dominated
// tick latency (~20s/tick observed; blocked the event loop, starved the liveness
// warmer → held new-work dispatch). It now rides the SAME incremental cursor as the
// revive/remediate counters: refreshIndex records a compact {t, k} for every
// `phase.*.<ticket>` event, and countTicketEventsInWindow filters that time-windowed
// list instead of re-reading the file. PHASE_EVENT_CAP bounds the retained list for
// the pathological case where the count is never read (so the per-call window prune
// never runs) — keep only the most-recent slice. Env-overridable so tests can
// drive the cap with a small fixture instead of 20k events.
const PHASE_EVENT_CAP = Number(process.env.EXECUTION_CORE_PHASE_EVENT_CAP) || 20_000;

// ticketOfPhaseEvent — the trailing dot-segment of a `phase.<phase>.<action>.<ticket>`
// name (e.g. "phase.implement.revive.CTL-728" → "CTL-728"). Mirrors the old
// `.endsWith(".<ticket>")` suffix match exactly (so "CTL-9" still never matches
// "CTL-90") while letting one forward pass bucket every phase event by ticket.
// Returns "" for a non-phase / non-string name.
function ticketOfPhaseEvent(name) {
  if (typeof name !== "string" || !name.startsWith("phase.")) return "";
  return name.slice(name.lastIndexOf(".") + 1);
}

// CTL-778: complete event name prefix — `phase.<phase>.complete.` (any phase).
const COMPLETE_NAME_RE = /^phase\.[^.]+\.complete\./;

// Per-path incremental index. We retain ONLY the two event families the counters
// query plus the compact per-ticket {t,k} phase-event records (CTL-802) and the
// CTL-778 complete-event set — a small fraction of the log — so memory stays
// bounded as the file grows.
const _index = new Map(); // path -> { cursor, leftover, events: [...], phaseEvents: [{ t, k }], completes: Set }

function isRelevant(name) {
  return (
    typeof name === "string" &&
    (REVIVE_NAME_RE.test(name) || name.startsWith(REMEDIATE_NAME_PREFIX) || COMPLETE_NAME_RE.test(name))
  );
}

// refreshIndex — advance the path's cursor over newly-appended bytes, appending
// any relevant events to the retained list. Resets on rotation/truncation
// (size < cursor → a new/rolled file). A missing log is a no-op cold start
// (events stays []). Returns the (mutated) entry so callers can filter it.
function refreshIndex(path) {
  let entry = _index.get(path);
  if (!entry) {
    entry = { cursor: 0, leftover: "", events: [], phaseEvents: [], completes: new Set() };
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
    entry.phaseEvents = [];
    entry.completes = new Set();
  }
  if (size === entry.cursor) return entry; // no new bytes — never re-reads
  const { endOffset, leftover } = scanEventsChunked({
    path,
    fromOffset: entry.cursor,
    leftover: entry.leftover,
    onEvent: (ev) => {
      const name = ev?.attributes?.["event.name"];
      if (isRelevant(name)) {
        entry.events.push({
          name,
          orchId: ev?.attributes?.["catalyst.orchestration"],
          ts: ev?.ts,
          label: ev?.attributes?.["event.label"],
        });
        // CTL-778: index complete events by their full name for hasCompleteEvent.
        if (COMPLETE_NAME_RE.test(name)) {
          entry.completes.add(name);
        }
      }
      // CTL-802 — bucket every phase.*.<ticket> event for countTicketEventsInWindow,
      // so it no longer re-scans the whole file. Skip unparseable ts (matches the
      // old detector, which ignored them). Cap the list as a memory backstop.
      const k = ticketOfPhaseEvent(name);
      if (k) {
        const t = Date.parse(ev?.ts || "");
        if (Number.isFinite(t)) {
          entry.phaseEvents.push({ t, k });
          if (entry.phaseEvents.length > PHASE_EVENT_CAP) {
            entry.phaseEvents.splice(0, entry.phaseEvents.length - PHASE_EVENT_CAP);
          }
        }
      }
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

// countRecoveryPassCycles — number of phase.recovery-pass.complete.<ticket>
// envelopes (CTL-1176 rung 3). The event-counted recovery-pass dispatch budget,
// mirroring countRemediateCycles. Used by defaultInvokeRecoveryPass to refuse a
// re-dispatch once the per-target cap is spent (the cap holds even after the
// per-cycle signal reset, because events are durable).
export function countRecoveryPassCycles({ ticket, orchId, since, path = getEventLogPath() } = {}) {
  if (!ticket) throw new Error("countRecoveryPassCycles: ticket required");
  return countByExactName(`${RECOVERY_PASS_NAME_PREFIX}${ticket}`, { orchId, since, path });
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

// CTL-778: has a phase.<phase>.complete.<ticket> envelope been observed?
// Rides the same incremental cursor as the revive/remediate counters. Exact
// suffix match on the ticket (so CTL-9 never matches CTL-90).
export function hasCompleteEvent({ ticket, phase, path = getEventLogPath() } = {}) {
  if (!ticket || !phase) return false;
  const entry = refreshIndex(path);
  const name = `phase.${phase}.complete.${ticket}`;
  return entry.completes?.has(name) ?? false;
}

// __resetEventScanIndexForTest — clear the per-path index so a suite starts from
// a known state. Test-only; not used by production code.
export function __resetEventScanIndexForTest() {
  _index.clear();
}

// Test-only: the retained phaseEvents length for a path. Guards the CTL-802
// window-prune + PHASE_EVENT_CAP memory bounds (both are count-invisible — only
// the retained-list size observes them).
export function __phaseEventsLengthForTest(path = getEventLogPath()) {
  return _index.get(path)?.phaseEvents?.length ?? 0;
}

// countTicketEventsInWindow — CTL-671. Total phase.*.<ticket> envelopes within
// `windowMs` of now(). The runaway-loop signal: a healthy ticket emits a
// handful of events per phase; a phantom probe-storm emits hundreds. Counts ALL
// actions (the CTL-9 storm was 92% non-failed work-done probes), unlike a
// dispatch-failure-only counter which would have missed it. Matches on the
// canonical event name `phase.<phase>.<action>.<ticket>` via a leading-dot
// suffix so "CTL-9" never matches "CTL-90". now: () => number matches the
// recovery.mjs clock-injection convention.
export function countTicketEventsInWindow({
  ticket,
  windowMs,
  now = Date.now,
  path = getEventLogPath(),
} = {}) {
  if (!ticket) throw new Error("countTicketEventsInWindow: ticket required");
  if (!windowMs) throw new Error("countTicketEventsInWindow: windowMs required");
  // CTL-802: ride the incremental cursor instead of re-scanning from offset 0.
  // refreshIndex has already bucketed every phase.*.<ticket> event as {t,k}.
  const entry = refreshIndex(path);
  const cutoff = now() - windowMs;
  // Prune entries that have aged out of the window. The list is append-ordered by
  // the forward scan (≈ chronological), so the stale entries are a leading prefix;
  // splicing them bounds the retained list to ≈ one window of phase events. (The
  // one production caller always passes the same RUNAWAY_WINDOW_MS, so this prune
  // and the count below use a consistent cutoff.)
  const arr = entry.phaseEvents;
  let firstIn = 0;
  while (firstIn < arr.length && arr[firstIn].t < cutoff) firstIn++;
  if (firstIn > 0) arr.splice(0, firstIn);
  let n = 0;
  for (const e of arr) if (e.k === ticket && e.t >= cutoff) n++;
  return n;
}
