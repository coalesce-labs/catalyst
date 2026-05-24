// event-scan.test.mjs — CTL-587 historical-scan utility for events.jsonl.
//
// Two pure functions:
//   countReviveEvents({ticket, orchId, since, path})  → number
//   countDistinctRevivingTickets({windowMs, now, path}) → number
// Both line-buffer-read the entire events.jsonl, skip malformed lines, and
// return 0 when the file is missing.
//
// Run: cd plugins/dev/scripts/execution-core && bun test event-scan.test.mjs

import { describe, test, expect } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { countReviveEvents, countDistinctRevivingTickets } from "./event-scan.mjs";

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

  test("counts only the matching ticket + phase + action", () => {
    const { path } = tempLog([
      makeEvent({ ticket: "CTL-9", ts: "2026-05-24T00:00:00Z" }), // match
      makeEvent({ ticket: "CTL-9", ts: "2026-05-24T00:01:00Z" }), // match
      makeEvent({ ticket: "CTL-10", ts: "2026-05-24T00:00:00Z" }), // diff ticket
      makeEvent({ ticket: "CTL-9", action: "reclaim", ts: "2026-05-24T00:02:00Z" }), // diff action
      makeEvent({ ticket: "CTL-9", phase: "plan", ts: "2026-05-24T00:03:00Z" }), // diff phase
      "not json", // skipped
      "", // skipped (empty)
    ]);
    expect(countReviveEvents({ ticket: "CTL-9", path })).toBe(2);
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
