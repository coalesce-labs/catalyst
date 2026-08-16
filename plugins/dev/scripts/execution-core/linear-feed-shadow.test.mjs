// linear-feed-shadow.test.mjs — CTL-1847.
//
// Run: cd plugins/dev/scripts/execution-core && bun test linear-feed-shadow.test.mjs

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNotEventLog, coverageClassesOf, createShadowSink } from "./linear-feed-shadow.mjs";
import { buildIssueEvent } from "./linear-feed-event.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfsh-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SEAMS = { now: () => new Date("2026-08-15T20:00:00.000Z"), newId: () => "i", newTrace: () => "t", newSpan: () => "s" };

const ev = (over = {}, issueOver = {}) =>
  buildIssueEvent(
    {
      history: {
        id: "h1", issue_id: "i1", actor_id: "u1", created_at: 1000,
        from_state: "Todo", to_state: "Triage", updated_description: 0, ...over,
      },
      issue: { id: "i1", identifier: "CTL-1", team_key: "CTL", ...issueOver },
      labels: [],
    },
    SEAMS,
  );

describe("⛔ the sink structurally cannot become the event log", () => {
  test("a path inside ~/catalyst/events is refused AT CONSTRUCTION", () => {
    // At construction, not at write time: a guard that fires on the first write has
    // already been handed a live config.
    const eventsDir = join(dir, "catalyst", "events");
    mkdirSync(eventsDir, { recursive: true });
    expect(() => createShadowSink({ path: join(eventsDir, "shadow.jsonl"), eventsDir })).toThrow(/event log directory/);
  });

  test("an event-log-SHAPED filename is refused wherever it sits", () => {
    // The second, independent test: a month-named log placed somewhere unexpected.
    for (const name of ["2026-08.jsonl", "2027-01.jsonl"]) {
      expect(() => createShadowSink({ path: join(dir, name) })).toThrow(/event-log-shaped/);
    }
  });

  test("the real events path is refused even without an explicit eventsDir", () => {
    expect(() => createShadowSink({ path: "/Users/someone/catalyst/events/shadow.jsonl" })).toThrow(
      /event log directory/,
    );
  });

  test("an ordinary shadow path is accepted", () => {
    const s = createShadowSink({ path: join(dir, "shadow", "feed-shadow.jsonl") });
    expect(s.path).toContain("feed-shadow.jsonl");
  });

  test("assertNotEventLog is exported so the runner can pre-check the same rule", () => {
    expect(() => assertNotEventLog(join(dir, "2026-08.jsonl"))).toThrow();
    expect(assertNotEventLog(join(dir, "ok.jsonl"))).toContain("ok.jsonl");
  });
});

describe("writes are one JSON line per event", () => {
  test("events land as parseable lines, in order", () => {
    const p = join(dir, "shadow.jsonl");
    const s = createShadowSink({ path: p });
    s.emit(ev({ id: "h1" }));
    s.emit(ev({ id: "h2" }));
    const lines = readFileSync(p, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).body.payload.historyId).toBe("h1");
    expect(JSON.parse(lines[1]).body.payload.historyId).toBe("h2");
  });

  test("the parent directory is created", () => {
    const p = join(dir, "deep", "nested", "shadow.jsonl");
    createShadowSink({ path: p }).emit(ev());
    expect(existsSync(p)).toBe(true);
  });

  test("a failed write throws — the sweep's contiguity rule depends on it", () => {
    // If the sink swallowed a failure, runSweep would advance its cursor past an
    // event that never reached the harness.
    const s = createShadowSink({
      path: join(dir, "shadow.jsonl"),
      appendFn: () => {
        throw new Error("disk full");
      },
    });
    expect(() => s.emit(ev())).toThrow(/disk full/);
    expect(s.stats()).toMatchObject({ written: 0, failed: 1 });
  });

  test("a failed write is NOT counted as coverage", () => {
    // Coverage feeds the exit criterion; counting an event the harness will never
    // see would let the window exit on evidence that does not exist.
    const s = createShadowSink({
      path: join(dir, "shadow.jsonl"),
      appendFn: () => {
        throw new Error("nope");
      },
    });
    try {
      s.emit(ev());
    } catch {
      /* expected */
    }
    expect(s.stats().classes).toEqual({});
  });
});

describe("⭐ coverage classes — the shadow window's exit criterion", () => {
  test("state_changed is its own class", () => {
    expect(coverageClassesOf(ev({ from_state: "Todo", to_state: "Triage" }))).toEqual([
      "linear.issue.state_changed",
    ]);
  });

  test("issue.updated fans out PER CHANGED FIELD, not one bucket", () => {
    // Field-mapping bugs live in the variants, so a single `updated` bucket would
    // let the window exit having exercised one mapping and claimed them all.
    const classes = coverageClassesOf(
      ev({ from_state: "Todo", to_state: "Todo", from_estimate: 1, to_estimate: 5, from_priority: 1, to_priority: 2 }),
    );
    expect(classes).toContain("linear.issue.updated:estimate");
    expect(classes).toContain("linear.issue.updated:priority");
    expect(classes).not.toContain("linear.issue.updated:state");
  });

  test("one event touching two fields counts toward BOTH", () => {
    const p = join(dir, "shadow.jsonl");
    const s = createShadowSink({ path: p });
    s.emit(ev({ from_state: "Todo", to_state: "Todo", from_estimate: 1, to_estimate: 5, from_priority: 1, to_priority: 2 }));
    const { classes } = s.stats();
    expect(classes["linear.issue.updated:estimate"]).toBe(1);
    expect(classes["linear.issue.updated:priority"]).toBe(1);
  });

  test("an update that changed nothing is its own named class, not silently dropped", () => {
    expect(coverageClassesOf(ev({ from_state: "Todo", to_state: "Todo" }))).toEqual([
      "linear.issue.updated:none",
    ]);
  });

  test("missing() names the cells still to manufacture", () => {
    const s = createShadowSink({ path: join(dir, "shadow.jsonl") });
    s.emit(ev()); // one state_changed
    const required = ["linear.issue.state_changed", "linear.comment.created", "linear.issue.updated:estimate"];
    const gaps = s.missing(required, 2);
    expect(gaps).toContainEqual({ cls: "linear.issue.state_changed", seen: 1, need: 2 });
    expect(gaps).toContainEqual({ cls: "linear.comment.created", seen: 0, need: 2 });
    expect(gaps).toHaveLength(3);
  });

  test("missing() is empty once every required class meets the floor", () => {
    const s = createShadowSink({ path: join(dir, "shadow.jsonl") });
    s.emit(ev({ id: "a" }));
    s.emit(ev({ id: "b" }));
    expect(s.missing(["linear.issue.state_changed"], 2)).toEqual([]);
  });

  test("an unrecognised event yields no class rather than a bogus one", () => {
    expect(coverageClassesOf({})).toEqual([]);
    expect(coverageClassesOf(null)).toEqual([]);
  });
});
