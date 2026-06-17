// event-scan.test.mjs — CTL-587 historical-scan utility for events.jsonl.
//
// Two pure functions:
//   countReviveEvents({ticket, orchId, since, path})  → number
//   countDistinctRevivingTickets({windowMs, now, path}) → number
// Both line-buffer-read the entire events.jsonl, skip malformed lines, and
// return 0 when the file is missing.
//
// Run: cd plugins/dev/scripts/execution-core && bun test event-scan.test.mjs

import { describe, test, expect, beforeEach } from "bun:test";
import { writeFileSync, appendFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  countReviveEvents,
  countDistinctRevivingTickets,
  countRemediateCycles,
  countRecoveryPassCycles,
  hasCompleteEvent,
  __resetEventScanIndexForTest,
  __phaseEventsLengthForTest,
  countTicketEventsInWindow,
} from "./event-scan.mjs";

// makeEvent — minimal envelope mirroring buildEventEnvelope in recovery.mjs.
function makeEvent({ phase = "implement", action = "revive", ticket, orchId, ts }) {
  return JSON.stringify({
    ts,
    attributes: {
      "event.name": `phase.${phase}.${action}.${ticket}`,
      "event.entity": "phase",
      "event.action": action,
      "event.label": ticket,
      "catalyst.orchestration": orchId ?? ticket,
      "linear.issue.identifier": ticket,
    },
    body: { payload: { phase, ticket, status: action } },
  });
}

function tempLog(lines) {
  const dir = mkdtempSync(join(tmpdir(), "evtscan-"));
  const path = join(dir, "events.jsonl");
  if (lines !== undefined) writeFileSync(path, lines.join("\n") + "\n");
  return { dir, path };
}

describe("countReviveEvents", () => {
  test("missing event log returns 0 (cold start)", () => {
    const dir = mkdtempSync(join(tmpdir(), "evtscan-"));
    expect(countReviveEvents({ ticket: "CTL-9", path: join(dir, "events.jsonl") })).toBe(0);
  });

  test("counts the matching ticket + revive action across ALL phases (CTL-735)", () => {
    // CTL-604 made revive phase-agnostic (triage/research/plan/verify, not just
    // implement). The per-ticket budget MUST count every phase's revive, else a
    // non-implement phase never exhausts MAX_REVIVES and slow-loops forever (the
    // triage/verify storm seen at the CTL-731 re-enable).
    const { path } = tempLog([
      makeEvent({ ticket: "CTL-9", phase: "implement", ts: "2026-05-24T00:00:00Z" }), // match
      makeEvent({ ticket: "CTL-9", phase: "implement", ts: "2026-05-24T00:01:00Z" }), // match
      makeEvent({ ticket: "CTL-10", ts: "2026-05-24T00:00:00Z" }), // diff ticket — excluded
      makeEvent({ ticket: "CTL-9", action: "reclaim", ts: "2026-05-24T00:02:00Z" }), // diff action — excluded
      makeEvent({ ticket: "CTL-9", phase: "plan", ts: "2026-05-24T00:03:00Z" }), // plan revive — NOW counts
      "not json", // skipped
      "", // skipped (empty)
    ]);
    expect(countReviveEvents({ ticket: "CTL-9", path })).toBe(3);
  });

  test("counts triage and verify revives (phase-agnostic budget) (CTL-735)", () => {
    const { path } = tempLog([
      makeEvent({ ticket: "CTL-728", phase: "triage", ts: "2026-05-24T00:00:00Z" }),
      makeEvent({ ticket: "CTL-728", phase: "triage", ts: "2026-05-24T00:01:00Z" }),
      makeEvent({ ticket: "CTL-726", phase: "verify", ts: "2026-05-24T00:00:00Z" }),
    ]);
    expect(countReviveEvents({ ticket: "CTL-728", path })).toBe(2);
    expect(countReviveEvents({ ticket: "CTL-726", path })).toBe(1);
  });

  test("does not let a similar ticket id bleed across (suffix-safe)", () => {
    const { path } = tempLog([
      makeEvent({ ticket: "CTL-728", phase: "triage", ts: "2026-05-24T00:00:00Z" }),
      makeEvent({ ticket: "CTL-7281", phase: "triage", ts: "2026-05-24T00:01:00Z" }),
      makeEvent({ ticket: "CTL-1728", phase: "triage", ts: "2026-05-24T00:02:00Z" }),
    ]);
    expect(countReviveEvents({ ticket: "CTL-728", path })).toBe(1);
  });

  test("respects orchId filter when set", () => {
    const { path } = tempLog([
      makeEvent({ ticket: "CTL-9", orchId: "orchA", ts: "2026-05-24T00:00:00Z" }),
      makeEvent({ ticket: "CTL-9", orchId: "orchB", ts: "2026-05-24T00:01:00Z" }),
      makeEvent({ ticket: "CTL-9", orchId: "orchA", ts: "2026-05-24T00:02:00Z" }),
    ]);
    expect(countReviveEvents({ ticket: "CTL-9", orchId: "orchA", path })).toBe(2);
    expect(countReviveEvents({ ticket: "CTL-9", orchId: "orchB", path })).toBe(1);
  });

  test("respects since filter — only events at or after `since`", () => {
    const { path } = tempLog([
      makeEvent({ ticket: "CTL-9", ts: "2026-05-24T00:00:00Z" }),
      makeEvent({ ticket: "CTL-9", ts: "2026-05-24T00:05:00Z" }),
      makeEvent({ ticket: "CTL-9", ts: "2026-05-24T00:10:00Z" }),
    ]);
    expect(countReviveEvents({ ticket: "CTL-9", path, since: "2026-05-24T00:04:00Z" })).toBe(2);
  });

  test("throws when ticket is missing (programmer error)", () => {
    const { path } = tempLog([]);
    expect(() => countReviveEvents({ path })).toThrow();
  });

  test("tolerates parse errors and partial envelopes", () => {
    const { path } = tempLog([
      "{",
      JSON.stringify({ ts: "x", body: {} }), // no attributes
      JSON.stringify({ ts: "x", attributes: {} }), // no event.name
      makeEvent({ ticket: "CTL-9", ts: "2026-05-24T00:00:00Z" }), // ok
    ]);
    expect(countReviveEvents({ ticket: "CTL-9", path })).toBe(1);
  });
});

describe("countDistinctRevivingTickets", () => {
  test("counts unique tickets in the time window", () => {
    const nowMs = Date.parse("2026-05-24T00:10:00Z");
    const { path } = tempLog([
      makeEvent({ ticket: "CTL-1", ts: "2026-05-24T00:00:00Z" }), // 10min ago — IN
      makeEvent({ ticket: "CTL-2", ts: "2026-05-24T00:05:00Z" }), // 5min ago — IN
      makeEvent({ ticket: "CTL-1", ts: "2026-05-24T00:06:00Z" }), // dup ticket
      makeEvent({ ticket: "CTL-3", ts: "2026-05-23T23:55:00Z" }), // 15min ago — OUT
    ]);
    expect(
      countDistinctRevivingTickets({
        windowMs: 10 * 60 * 1000,
        now: () => nowMs,
        path,
      })
    ).toBe(2);
  });

  test("returns 0 for missing log (cold start, no events.jsonl yet)", () => {
    const dir = mkdtempSync(join(tmpdir(), "evtscan-"));
    expect(
      countDistinctRevivingTickets({
        windowMs: 600_000,
        now: () => 0,
        path: join(dir, "no-such-file.jsonl"),
      })
    ).toBe(0);
  });

  test("ignores non-revive events even when in-window", () => {
    const nowMs = Date.parse("2026-05-24T00:10:00Z");
    const { path } = tempLog([
      makeEvent({ ticket: "CTL-1", ts: "2026-05-24T00:05:00Z" }), // revive — IN
      makeEvent({
        ticket: "CTL-2",
        action: "reclaim",
        ts: "2026-05-24T00:05:00Z",
      }), // not a revive — skip
      makeEvent({
        ticket: "CTL-3",
        action: "escalated",
        ts: "2026-05-24T00:05:00Z",
      }), // not a revive — skip
    ]);
    expect(
      countDistinctRevivingTickets({
        windowMs: 10 * 60 * 1000,
        now: () => nowMs,
        path,
      })
    ).toBe(1);
  });

  test("throws when windowMs is missing", () => {
    const { path } = tempLog([]);
    expect(() => countDistinctRevivingTickets({ now: () => 0, path })).toThrow();
  });

  test("ignores events with unparseable ts", () => {
    const nowMs = Date.parse("2026-05-24T00:10:00Z");
    const { path } = tempLog([
      makeEvent({ ticket: "CTL-1", ts: "not-a-date" }),
      makeEvent({ ticket: "CTL-2", ts: "2026-05-24T00:05:00Z" }), // 5min ago — IN
    ]);
    expect(
      countDistinctRevivingTickets({
        windowMs: 10 * 60 * 1000,
        now: () => nowMs,
        path,
      })
    ).toBe(1);
  });
});

// ─── CTL-653: countRemediateCycles — the event-counted verify⇄remediate budget ───
// Distinct from countReviveEvents (crash-revive budget) so a crash never spends
// verdict-cycle budget. One completed cycle == one phase.remediate.complete.<T>.

describe("CTL-653: countRemediateCycles", () => {
  test("missing event log returns 0 (cold start)", () => {
    const dir = mkdtempSync(join(tmpdir(), "evtscan-"));
    expect(countRemediateCycles({ ticket: "CTL-653", path: join(dir, "events.jsonl") })).toBe(0);
  });

  test("counts only phase.remediate.complete.<ticket> envelopes", () => {
    const { path } = tempLog([
      makeEvent({ phase: "remediate", action: "complete", ticket: "CTL-653", ts: "2026-05-27T00:00:00Z" }), // match
      makeEvent({ phase: "remediate", action: "complete", ticket: "CTL-653", ts: "2026-05-27T00:01:00Z" }), // match
      makeEvent({ phase: "remediate", action: "failed", ticket: "CTL-653", ts: "2026-05-27T00:02:00Z" }), // diff action
      makeEvent({ phase: "implement", action: "revive", ticket: "CTL-653", ts: "2026-05-27T00:03:00Z" }), // diff phase
      makeEvent({ phase: "remediate", action: "complete", ticket: "CTL-999", ts: "2026-05-27T00:04:00Z" }), // diff ticket
      "not json", // skipped
    ]);
    expect(countRemediateCycles({ ticket: "CTL-653", path })).toBe(2);
  });

  test("respects orchId filter (mirrors countReviveEvents)", () => {
    const { path } = tempLog([
      makeEvent({ phase: "remediate", action: "complete", ticket: "CTL-653", orchId: "orch-A", ts: "2026-05-27T00:00:00Z" }),
      makeEvent({ phase: "remediate", action: "complete", ticket: "CTL-653", orchId: "orch-B", ts: "2026-05-27T00:01:00Z" }),
    ]);
    expect(countRemediateCycles({ ticket: "CTL-653", orchId: "orch-A", path })).toBe(1);
  });

  test("respects since filter (mirrors countReviveEvents)", () => {
    const { path } = tempLog([
      makeEvent({ phase: "remediate", action: "complete", ticket: "CTL-653", ts: "2026-05-27T00:00:00Z" }),
      makeEvent({ phase: "remediate", action: "complete", ticket: "CTL-653", ts: "2026-05-27T05:00:00Z" }),
    ]);
    expect(countRemediateCycles({ ticket: "CTL-653", since: "2026-05-27T01:00:00Z", path })).toBe(1);
  });

  test("throws without ticket", () => {
    expect(() => countRemediateCycles({})).toThrow();
  });
});

// ─── CTL-1176 rung 3: countRecoveryPassCycles — the recovery-pass dispatch budget ─
// Mirrors countRemediateCycles; one completed sweep == one
// phase.recovery-pass.complete.<ticket>. The hyphen in "recovery-pass" is matched
// by COMPLETE_NAME_RE's [^.]+ phase segment, so the complete event is indexed.

describe("CTL-1176: countRecoveryPassCycles", () => {
  test("missing event log returns 0 (cold start)", () => {
    const dir = mkdtempSync(join(tmpdir(), "evtscan-"));
    expect(countRecoveryPassCycles({ ticket: "CTL-1176", path: join(dir, "events.jsonl") })).toBe(0);
  });

  test("counts only phase.recovery-pass.complete.<ticket> envelopes", () => {
    const { path } = tempLog([
      makeEvent({ phase: "recovery-pass", action: "complete", ticket: "CTL-1176", ts: "2026-06-16T00:00:00Z" }), // match
      makeEvent({ phase: "recovery-pass", action: "complete", ticket: "CTL-1176", ts: "2026-06-16T00:01:00Z" }), // match
      makeEvent({ phase: "remediate", action: "complete", ticket: "CTL-1176", ts: "2026-06-16T00:02:00Z" }), // diff phase
      makeEvent({ phase: "recovery-pass", action: "complete", ticket: "CTL-999", ts: "2026-06-16T00:03:00Z" }), // diff ticket
      "not json", // skipped
    ]);
    expect(countRecoveryPassCycles({ ticket: "CTL-1176", path })).toBe(2);
  });

  test("throws without ticket", () => {
    expect(() => countRecoveryPassCycles({})).toThrow();
  });
});

// ── CTL-673: incremental per-path index. The counters must read only
// newly-appended bytes on repeated calls against the same path, while
// returning byte-identical results to the old whole-file scan.
describe("incremental index (CTL-673)", () => {
  beforeEach(() => __resetEventScanIndexForTest());

  test("second call after append returns the updated count (same path)", () => {
    const { path } = tempLog([makeEvent({ ticket: "CTL-1", ts: "2026-05-27T00:00:00Z" })]);
    expect(countReviveEvents({ ticket: "CTL-1", path })).toBe(1);
    appendFileSync(path, makeEvent({ ticket: "CTL-1", ts: "2026-05-27T00:01:00Z" }) + "\n");
    expect(countReviveEvents({ ticket: "CTL-1", path })).toBe(2); // saw appended event
  });

  test("does NOT re-scan bytes already read (overwrite already-counted bytes, count unchanged)", () => {
    const { path } = tempLog([makeEvent({ ticket: "CTL-1", ts: "2026-05-27T00:00:00Z" })]);
    expect(countReviveEvents({ ticket: "CTL-1", path })).toBe(1); // seeds index, cursor=EOF
    // Overwrite the already-scanned line with a DIFFERENT ticket of the SAME
    // byte length. Because size === cursor, refreshIndex must short-circuit and
    // never re-read — so the cached CTL-1 record still answers the query.
    writeFileSync(path, makeEvent({ ticket: "CTL-2", ts: "2026-05-27T00:00:00Z" }) + "\n");
    expect(countReviveEvents({ ticket: "CTL-1", path })).toBe(1); // cached; no re-read of CTL-2
  });

  test("rotation/truncation (size < cursor) resets the index", () => {
    const { path } = tempLog([
      makeEvent({ ticket: "CTL-1", ts: "t1" }),
      makeEvent({ ticket: "CTL-1", ts: "t2" }),
    ]);
    expect(countReviveEvents({ ticket: "CTL-1", path })).toBe(2);
    writeFileSync(path, makeEvent({ ticket: "CTL-1", ts: "t3" }) + "\n"); // smaller file
    expect(countReviveEvents({ ticket: "CTL-1", path })).toBe(1); // counts new file only
  });

  test("distinct paths keep independent cursors", () => {
    const a = tempLog([makeEvent({ ticket: "CTL-A", ts: "t1" })]);
    const b = tempLog([
      makeEvent({ ticket: "CTL-B", ts: "t1" }),
      makeEvent({ ticket: "CTL-B", ts: "t2" }),
    ]);
    expect(countReviveEvents({ ticket: "CTL-A", path: a.path })).toBe(1);
    expect(countReviveEvents({ ticket: "CTL-B", path: b.path })).toBe(2);
  });

  test("partial trailing line completed by a later append is counted once", () => {
    const { path } = tempLog([makeEvent({ ticket: "CTL-1", ts: "t1" })]);
    expect(countReviveEvents({ ticket: "CTL-1", path })).toBe(1);
    const half = makeEvent({ ticket: "CTL-1", ts: "t2" });
    appendFileSync(path, half.slice(0, 10)); // half a line, no newline
    expect(countReviveEvents({ ticket: "CTL-1", path })).toBe(1); // partial not yet counted
    appendFileSync(path, half.slice(10) + "\n");
    expect(countReviveEvents({ ticket: "CTL-1", path })).toBe(2); // completed → counted once
  });

  test("remediate cycles count incrementally on the same path", () => {
    const { path } = tempLog([
      makeEvent({ phase: "remediate", action: "complete", ticket: "CTL-1", ts: "t1" }),
    ]);
    expect(countRemediateCycles({ ticket: "CTL-1", path })).toBe(1);
    appendFileSync(
      path,
      makeEvent({ phase: "remediate", action: "complete", ticket: "CTL-1", ts: "t2" }) + "\n",
    );
    expect(countRemediateCycles({ ticket: "CTL-1", path })).toBe(2);
  });

  test("distinct-window honors a sliding now across calls without re-reading", () => {
    const { path } = tempLog([
      makeEvent({ ticket: "CTL-A", ts: "2026-05-27T00:00:00Z" }),
      makeEvent({ ticket: "CTL-B", ts: "2026-05-27T00:09:00Z" }),
    ]);
    const at = (iso) => () => Date.parse(iso);
    expect(
      countDistinctRevivingTickets({ windowMs: 10 * 60 * 1000, now: at("2026-05-27T00:09:30Z"), path }),
    ).toBe(2);
    expect(
      countDistinctRevivingTickets({ windowMs: 10 * 60 * 1000, now: at("2026-05-27T00:15:00Z"), path }),
    ).toBe(1); // A aged out of the window
  });
});

// ─── CTL-671 Phase 4: countTicketEventsInWindow — per-ticket event-rate ───
// Total phase.*.<ticket> envelopes in a rolling window. Counts ALL actions
// (the CTL-9 storm was 92% non-failed work-done probes), unlike a
// dispatch-failure-only counter — the runaway-loop domination signal.

describe("countTicketEventsInWindow (CTL-671)", () => {
  test("counts all phase.*.<ticket> events in window regardless of action", () => {
    const now = 10_000_000;
    const recent = new Date(now - 1000).toISOString();
    const { path } = tempLog([
      makeEvent({ phase: "pr", action: "work-done-probe", ticket: "CTL-9", ts: recent }),
      makeEvent({ phase: "implement", action: "failed", ticket: "CTL-9", ts: recent }),
      makeEvent({ phase: "research", action: "complete", ticket: "CTL-100", ts: recent }), // other ticket
    ]);
    expect(
      countTicketEventsInWindow({ ticket: "CTL-9", windowMs: 60_000, now: () => now, path })
    ).toBe(2);
  });

  test("excludes events older than the window", () => {
    const now = 10_000_000;
    const old = new Date(now - 10 * 60_000).toISOString();
    const { path } = tempLog([
      makeEvent({ phase: "pr", action: "work-done-probe", ticket: "CTL-9", ts: old }),
    ]);
    expect(
      countTicketEventsInWindow({ ticket: "CTL-9", windowMs: 60_000, now: () => now, path })
    ).toBe(0);
  });

  test("does NOT match a ticket that is a prefix of another (suffix boundary)", () => {
    const now = 10_000_000;
    const recent = new Date(now - 1000).toISOString();
    const { path } = tempLog([
      makeEvent({ phase: "pr", action: "probe", ticket: "CTL-90", ts: recent }), // CTL-90 ≠ CTL-9
      makeEvent({ phase: "pr", action: "probe", ticket: "CTL-9", ts: recent }), // match
    ]);
    expect(
      countTicketEventsInWindow({ ticket: "CTL-9", windowMs: 60_000, now: () => now, path })
    ).toBe(1);
  });

  test("ignores events with unparseable ts", () => {
    const now = 10_000_000;
    const recent = new Date(now - 1000).toISOString();
    const { path } = tempLog([
      makeEvent({ phase: "pr", action: "probe", ticket: "CTL-9", ts: "not-a-date" }),
      makeEvent({ phase: "pr", action: "probe", ticket: "CTL-9", ts: recent }),
    ]);
    expect(
      countTicketEventsInWindow({ ticket: "CTL-9", windowMs: 60_000, now: () => now, path })
    ).toBe(1);
  });

  test("missing log → 0", () => {
    expect(
      countTicketEventsInWindow({ ticket: "CTL-9", windowMs: 60_000, now: () => 1, path: "/nope" })
    ).toBe(0);
  });

  test("throws when ticket or windowMs is missing", () => {
    expect(() => countTicketEventsInWindow({ windowMs: 60_000 })).toThrow();
    expect(() => countTicketEventsInWindow({ ticket: "CTL-9" })).toThrow();
  });

  // CTL-802 — the counter now rides the incremental cursor (no more offset-0 rescan).
  test("incremental: a later append is counted without re-reading the whole file", () => {
    __resetEventScanIndexForTest();
    const now = 10_000_000;
    const recent = new Date(now - 1000).toISOString();
    const { path } = tempLog([
      makeEvent({ phase: "pr", action: "probe", ticket: "CTL-9", ts: recent }),
    ]);
    expect(
      countTicketEventsInWindow({ ticket: "CTL-9", windowMs: 60_000, now: () => now, path })
    ).toBe(1);
    appendFileSync(
      path,
      makeEvent({ phase: "implement", action: "failed", ticket: "CTL-9", ts: recent }) + "\n",
    );
    expect(
      countTicketEventsInWindow({ ticket: "CTL-9", windowMs: 60_000, now: () => now, path })
    ).toBe(2);
  });

  test("does NOT re-scan already-read bytes (overwrite a counted line; count stays cached)", () => {
    __resetEventScanIndexForTest();
    const now = 10_000_000;
    const recent = new Date(now - 1000).toISOString();
    const { path } = tempLog([
      makeEvent({ phase: "pr", action: "probe", ticket: "CTL-9", ts: recent }),
    ]);
    // Seed: cursor advances to EOF.
    expect(
      countTicketEventsInWindow({ ticket: "CTL-9", windowMs: 60_000, now: () => now, path })
    ).toBe(1);
    // Overwrite the already-scanned line with a DIFFERENT ticket of the SAME byte
    // length (CTL-8 ≡ CTL-9 in width). size === cursor → refreshIndex short-circuits
    // and never re-reads — proof the offset-0 full rescan is gone.
    writeFileSync(path, makeEvent({ phase: "pr", action: "probe", ticket: "CTL-8", ts: recent }) + "\n");
    expect(
      countTicketEventsInWindow({ ticket: "CTL-9", windowMs: 60_000, now: () => now, path })
    ).toBe(1); // cached CTL-9 record, no re-read
    expect(
      countTicketEventsInWindow({ ticket: "CTL-8", windowMs: 60_000, now: () => now, path })
    ).toBe(0); // CTL-8 bytes were never scanned
  });

  test("window-prune shrinks the retained list (aged-out leading prefix is spliced)", () => {
    __resetEventScanIndexForTest();
    const now = 10_000_000;
    const old = new Date(now - 20 * 60_000).toISOString(); // aged out (>10min)
    const recent = new Date(now - 60_000).toISOString(); // in window
    const { path } = tempLog([
      makeEvent({ phase: "pr", action: "probe", ticket: "CTL-9", ts: old }),
      makeEvent({ phase: "pr", action: "probe", ticket: "CTL-9", ts: recent }),
    ]);
    expect(
      countTicketEventsInWindow({ ticket: "CTL-9", windowMs: 10 * 60_000, now: () => now, path })
    ).toBe(1);
    // the aged-out entry was spliced — only the in-window record is retained
    expect(__phaseEventsLengthForTest(path)).toBe(1);
  });

  test("PHASE_EVENT_CAP bounds the retained list even when the count is never read", async () => {
    const prev = process.env.EXECUTION_CORE_PHASE_EVENT_CAP;
    process.env.EXECUTION_CORE_PHASE_EVENT_CAP = "3";
    try {
      const mod = await import(`./event-scan.mjs?cap=${Date.now()}-${Math.random()}`);
      mod.__resetEventScanIndexForTest();
      const ts = new Date().toISOString();
      const lines = [];
      for (let i = 0; i < 8; i++) {
        lines.push(makeEvent({ phase: "implement", action: "probe", ticket: `CTL-${i}`, ts }));
      }
      const { path } = tempLog(lines);
      // refreshIndex (via the revive counter, which does NOT prune phaseEvents) must
      // still cap the list at 3, not retain all 8.
      mod.countReviveEvents({ ticket: "CTL-0", path });
      expect(mod.__phaseEventsLengthForTest(path)).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.EXECUTION_CORE_PHASE_EVENT_CAP;
      else process.env.EXECUTION_CORE_PHASE_EVENT_CAP = prev;
    }
  });

  test("ignores a non-phase event whose trailing segment collides with the ticket id", () => {
    __resetEventScanIndexForTest();
    const now = 10_000_000;
    const recent = new Date(now - 1000).toISOString();
    const { path } = tempLog([
      // a non-phase event family that happens to end in ".CTL-9" — must NOT be counted
      JSON.stringify({ ts: recent, attributes: { "event.name": "session.ended.CTL-9" } }),
      makeEvent({ phase: "pr", action: "probe", ticket: "CTL-9", ts: recent }), // the real one
    ]);
    expect(
      countTicketEventsInWindow({ ticket: "CTL-9", windowMs: 60_000, now: () => now, path })
    ).toBe(1);
  });
});

// CTL-778: hasCompleteEvent — has a phase.<phase>.complete.<ticket> event been observed?
describe("hasCompleteEvent", () => {
  beforeEach(() => __resetEventScanIndexForTest());

  test("true after a phase.<phase>.complete.<ticket> envelope", () => {
    const { path } = tempLog([
      makeEvent({ phase: "plan", action: "complete", ticket: "CTL-1", ts: "2026-06-08T00:00:00Z" }),
    ]);
    expect(hasCompleteEvent({ ticket: "CTL-1", phase: "plan", path })).toBe(true);
  });

  test("false when only a different phase completed", () => {
    const { path } = tempLog([
      makeEvent({ phase: "research", action: "complete", ticket: "CTL-1", ts: "2026-06-08T00:00:00Z" }),
    ]);
    expect(hasCompleteEvent({ ticket: "CTL-1", phase: "plan", path })).toBe(false);
  });

  test("suffix is exact (CTL-9 never matches CTL-90)", () => {
    const { path } = tempLog([
      makeEvent({ phase: "plan", action: "complete", ticket: "CTL-90", ts: "2026-06-08T00:00:00Z" }),
    ]);
    expect(hasCompleteEvent({ ticket: "CTL-9", phase: "plan", path })).toBe(false);
  });

  test("missing log → false (cold start)", () => {
    const dir = mkdtempSync(join(tmpdir(), "evtscan-"));
    expect(hasCompleteEvent({ ticket: "CTL-1", phase: "plan", path: join(dir, "events.jsonl") })).toBe(false);
  });

  test("false when only a revive event exists (not a complete)", () => {
    const { path } = tempLog([
      makeEvent({ phase: "plan", action: "revive", ticket: "CTL-1", ts: "2026-06-08T00:00:00Z" }),
    ]);
    expect(hasCompleteEvent({ ticket: "CTL-1", phase: "plan", path })).toBe(false);
  });

  test("true for any phase segment (implement, verify, etc.)", () => {
    const { path } = tempLog([
      makeEvent({ phase: "implement", action: "complete", ticket: "CTL-5", ts: "2026-06-08T00:00:00Z" }),
    ]);
    expect(hasCompleteEvent({ ticket: "CTL-5", phase: "implement", path })).toBe(true);
  });

  test("returns false when ticket or phase is missing", () => {
    const { path } = tempLog([]);
    expect(hasCompleteEvent({ ticket: "", phase: "plan", path })).toBe(false);
    expect(hasCompleteEvent({ ticket: "CTL-1", phase: "", path })).toBe(false);
    expect(hasCompleteEvent({ path })).toBe(false);
  });
});
