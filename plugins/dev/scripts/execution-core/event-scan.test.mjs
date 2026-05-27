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
  __resetEventScanIndexForTest,
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
