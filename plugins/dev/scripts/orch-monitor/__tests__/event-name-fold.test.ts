// event-name-fold.test.ts — CTL-1834 per-call-site coverage for the ORCH-MONITOR half.
//
// Run: cd plugins/dev/scripts/orch-monitor && bun test __tests__/event-name-fold.test.ts
// (this package's CI step is a globbed `bun test`, so a new file here runs without
// a workflow edit — orch-monitor-quality.yml is path-filtered to orch-monitor/**,
// and this PR touches orch-monitor/lib/*.ts so the workflow fires.)
//
// Two folded sites:
//   • lib/event-log-reader.ts  accumulateGithubStat — read the v2 key ONLY, so a
//     v1- or v3-shaped `github.*` event was not counted in eventCount24h at all.
//   • lib/event-analysis.ts    normalize — branched on `attributes` being PRESENT
//     to choose the key, so a canonical-shaped line whose name sat at the v1/v3 key
//     resolved to null and the WHOLE line was dropped.
//
// Reverting either fold turns its first test below RED. Fixtures are hand-built;
// nothing here reads ~/catalyst/events/*.jsonl.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTunnelEventStats } from "../lib/event-log-reader.ts";
import { normalize } from "../lib/event-analysis.ts";

// readTunnelEventStats reads `<catalystDir>/events/<YYYY-MM>.jsonl` for `now`.
function withEventLog(lines: unknown[], run: (dir: string, now: () => Date) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ctl1834-om-"));
  try {
    const now = new Date("2026-08-12T12:00:00.000Z");
    mkdirSync(join(dir, "events"), { recursive: true });
    writeFileSync(
      join(dir, "events", "2026-08.jsonl"),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    run(dir, () => now);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TS = "2026-08-12T11:00:00.000Z";

describe("event-log-reader.ts counts every envelope shape (CTL-1834)", () => {
  test("v1- and v3-shaped github.* events are COUNTED", () => {
    withEventLog(
      [
        { ts: TS, event: "github.push", attributes: undefined },
        { ts: TS, name: "github.check_suite.completed" },
      ],
      (dir, now) => {
        const stats = readTunnelEventStats(dir, null, now);
        // Pre-fix: 0. Not an error, not a warning — a silent undercount.
        expect(stats.eventCount24h).toBe(2);
      },
    );
  });

  test("positive control: a v2-shaped github.* event still counts, with its repo", () => {
    withEventLog(
      [
        {
          ts: TS,
          attributes: { "event.name": "github.pr.merged", "vcs.repository.name": "catalyst" },
        },
      ],
      (dir, now) => {
        const stats = readTunnelEventStats(dir, null, now);
        expect(stats.eventCount24h).toBe(1);
        expect(stats.eventCount24hByRepo["catalyst"]).toBe(1);
      },
    );
  });

  test("the biased-slice failure: mixed shapes of one family all count", () => {
    withEventLog(
      [
        { ts: TS, event: "github.pr.merged" },
        { ts: TS, attributes: { "event.name": "github.pr.merged" } },
        { ts: TS, name: "github.pr.merged" },
      ],
      (dir, now) => {
        expect(readTunnelEventStats(dir, null, now).eventCount24h).toBe(3);
      },
    );
  });

  test("non-github and nameless lines are still excluded", () => {
    withEventLog(
      [
        { ts: TS, event: "linear.issue.updated" },
        { ts: TS, level: 30, msg: "a pino line" },
        { ts: TS },
      ],
      (dir, now) => {
        expect(readTunnelEventStats(dir, null, now).eventCount24h).toBe(0);
      },
    );
  });
});

describe("event-analysis.ts normalize() drops the shape branch (CTL-1834)", () => {
  test("a canonical-shaped line whose name sits at the v1 key is NOT dropped", () => {
    // The precise pre-fix bug: `attributes` present -> read ONLY attributes; the
    // name lives at `event`; `asString(undefined)` is null; the whole line returns
    // null and disappears from every phaseTime/stalls/ciFunnel projection.
    const line = JSON.stringify({
      ts: TS,
      event: "github.pr.merged",
      attributes: { "vcs.repository.name": "catalyst" },
    });
    const out = normalize(line);
    expect(out).not.toBeNull();
    expect(out!.eventName).toBe("github.pr.merged");
  });

  test("a v3-shaped line normalizes", () => {
    const out = normalize(JSON.stringify({ ts: TS, name: "phase.rescue.escalated.CTC-310" }));
    expect(out).not.toBeNull();
    expect(out!.eventName).toBe("phase.rescue.escalated.CTC-310");
  });

  test("positive control: plain v1 and plain v2 still normalize", () => {
    expect(normalize(JSON.stringify({ ts: TS, event: "github.push" }))!.eventName).toBe(
      "github.push",
    );
    expect(
      normalize(JSON.stringify({ ts: TS, attributes: { "event.name": "github.push" } }))!.eventName,
    ).toBe("github.push");
  });

  test("a nameless line, a tsless line and a torn line still return null", () => {
    expect(normalize(JSON.stringify({ ts: TS, level: 30, msg: "pino" }))).toBeNull();
    expect(normalize(JSON.stringify({ event: "github.push" }))).toBeNull();
    expect(normalize("{not json")).toBeNull();
  });
});
