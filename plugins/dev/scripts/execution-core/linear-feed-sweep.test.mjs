// linear-feed-sweep.test.mjs — CTL-1847.
//
// Run: cd plugins/dev/scripts/execution-core && bun test linear-feed-sweep.test.mjs
//
// The source layer is already tested against real SQLite; this drives the loop with
// an in-memory source so the failure/decline/advance interactions can be forced
// exactly. Cursor reads/writes go through real files, because "a restart is not a
// gap" is a claim about persistence.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BATCHES, processPage, runSweep } from "./linear-feed-sweep.mjs";
import { defaultCursorPath, readCursor, writeCursor } from "./linear-feed-cursor.mjs";

let dir;
let cursorPath;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfsw-"));
  cursorPath = defaultCursorPath(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const TEAMS = new Set(["CTL"]);

const edge = (id, createdAt, over = {}) => ({
  history: { id, issue_id: "i1", actor_id: "u1", created_at: createdAt, from_state: "Todo", to_state: "Triage" },
  issue: { id: "i1", identifier: "CTL-1", team_key: "CTL", ...over },
  actor: null,
  assignee: null,
  project: null,
  labels: [],
});

/** In-memory source honouring the composite-cursor contract. */
const fakeSource = (edges, comments = []) => ({
  edgesSince(pos, limit = 100) {
    return edges
      .filter(
        (e) =>
          e.history.created_at > pos.lastCreatedAt ||
          (e.history.created_at === pos.lastCreatedAt && e.history.id > (pos.lastId ?? "")),
      )
      .sort((a, b) => a.history.created_at - b.history.created_at || a.history.id.localeCompare(b.history.id))
      .slice(0, limit);
  },
  commentsSince(pos, limit = 100) {
    return comments
      .filter((c) => c.comment.created_at > pos.lastCreatedAt)
      .slice(0, limit);
  },
  positionAfter(items) {
    if (!items?.length) return null;
    const last = items[items.length - 1];
    const row = last.history ?? last.comment;
    return { lastCreatedAt: row.created_at, lastId: row.id };
  },
});

describe("⭐ cursor advances to the LAST CONTIGUOUS SUCCESS", () => {
  test("a mid-page emit failure keeps the failed row and everything after it", () => {
    const edges = [edge("h1", 10), edge("h2", 20), edge("h3", 30), edge("h4", 40)];
    const emitted = [];
    const emit = (_ev, item) => {
      if (item.history.id === "h3") throw new Error("sink down");
      emitted.push(item.history.id);
    };

    const r = runSweep({ source: fakeSource(edges), cursorPath, teams: TEAMS, emit, now: () => 0,
      maxBatches: 5 });

    expect(emitted).toEqual(["h1", "h2"]);
    expect(r.stoppedEarly).toBe(true);
    // cursor sits on h2 — NOT h4 (which would lose h3+h4) and NOT before h1
    expect(readCursor(cursorPath).position).toMatchObject({ lastId: "h2", lastCreatedAt: 20 });
  });

  test("the next sweep resumes at the failed row, re-emitting nothing already sent", () => {
    const edges = [edge("h1", 10), edge("h2", 20), edge("h3", 30), edge("h4", 40)];
    let failOn = "h3";
    const emitted = [];
    const emit = (_ev, item) => {
      if (item.history.id === failOn) throw new Error("sink down");
      emitted.push(item.history.id);
    };
    const src = fakeSource(edges);

    runSweep({ source: src, cursorPath, teams: TEAMS, emit, now: () => 0,
      maxBatches: 5 });
    expect(emitted).toEqual(["h1", "h2"]);

    failOn = null; // sink recovers
    runSweep({ source: src, cursorPath, teams: TEAMS, emit, now: () => 0,
      maxBatches: 5 });

    // h1/h2 are NOT re-sent; h3/h4 are picked up
    expect(emitted).toEqual(["h1", "h2", "h3", "h4"]);
    expect(new Set(emitted).size).toBe(4);
  });

  test("a failure on the FIRST row advances nothing and loses nothing", () => {
    const edges = [edge("h1", 10), edge("h2", 20)];
    const emit = () => {
      throw new Error("sink down");
    };
    runSweep({ source: fakeSource(edges), cursorPath, teams: TEAMS, emit, now: () => 0,
      maxBatches: 3 });
    // no cursor written at all — nothing was handled
    expect(readCursor(cursorPath).state).toBe("absent");
  });
});

describe("⭐ a DECLINE is not a failure — it must advance, or the sweep wedges", () => {
  test("a foreign-team row advances the cursor past itself", () => {
    // On a multi-tenant replica most rows are declines. Treating a decline as a
    // failure would wedge the sweep on the first one, forever.
    const edges = [edge("h1", 10, { identifier: "ADV-9", team_key: "ADV" }), edge("h2", 20)];
    const emitted = [];
    runSweep({
      source: fakeSource(edges),
      cursorPath,
      teams: TEAMS,
      emit: (_e, i) => emitted.push(i.history.id),
      now: () => 0,
      maxBatches: 3,
    });
    expect(emitted).toEqual(["h2"]); // only ours emitted
    expect(readCursor(cursorPath).position.lastId).toBe("h2"); // but BOTH passed
  });

  test("an all-declined page still advances, so the sweep terminates", () => {
    const edges = [
      edge("h1", 10, { identifier: "ADV-1", team_key: "ADV" }),
      edge("h2", 20, { identifier: "CTC-1", team_key: "CTC" }),
    ];
    const r = runSweep({
      source: fakeSource(edges),
      cursorPath,
      teams: TEAMS,
      emit: () => {},
      now: () => 0,
      maxBatches: 3,
    });
    expect(r.edges.emitted).toBe(0);
    expect(r.edges.declined).toBe(2);
    expect(r.stoppedEarly).toBe(false);
    expect(readCursor(cursorPath).position.lastId).toBe("h2");
  });

  test("decline reasons are counted by name, so 'nothing emitted' is diagnosable", () => {
    const edges = [
      edge("h1", 10, { identifier: "ADV-1", team_key: "ADV" }),
      edge("h2", 20, { team_key: null }),
    ];
    const r = runSweep({ source: fakeSource(edges), cursorPath, teams: TEAMS, emit: () => {}, now: () => 0, maxBatches: 3 });
    expect(r.edges.byReason["foreign-team"]).toBe(1);
    expect(r.edges.byReason["issue-has-no-team-key"]).toBe(1);
  });
});

describe("modes: resume, cold-start, reset", () => {
  test("a fresh host cold-starts and emits no history", () => {
    const edges = [edge("h1", 10)]; // older than now
    const r = runSweep({
      source: fakeSource(edges),
      cursorPath,
      teams: TEAMS,
      emit: () => {},
      now: () => 1000,
      maxBatches: 3,
    });
    expect(r.mode).toBe("cold-start");
    expect(r.alarm).toBeNull();
    expect(r.edges.emitted).toBe(0); // the old edge is before the cold-start instant
  });

  test("a healthy cursor resumes, clock-independent", () => {
    writeCursor(cursorPath, { lastCreatedAt: 15, lastId: "h1" });
    const edges = [edge("h1", 10), edge("h2", 20)];
    const emitted = [];
    const r = runSweep({
      source: fakeSource(edges),
      cursorPath,
      teams: TEAMS,
      emit: (_e, i) => emitted.push(i.history.id),
      // far-future clock ON PURPOSE: a resume must ignore it entirely. If the
      // sweep ever consulted the clock on the resume path this would emit nothing.
      now: () => 999999,
      maxBatches: 3,
    });
    expect(r.mode).toBe("resume");
    expect(emitted).toEqual(["h2"]);
  });

  test("an unreadable cursor resets from a STATED bound and says so", () => {
    writeCursor(cursorPath, { lastCreatedAt: 15, lastId: "h1" });
    require("node:fs").writeFileSync(cursorPath, "corrupt", "utf8");
    const r = runSweep({
      source: fakeSource([edge("h1", 900)]),
      cursorPath,
      teams: TEAMS,
      emit: () => {},
      now: () => 1000,
      resetLookbackMs: 200,
      maxBatches: 3,
    });
    expect(r.mode).toBe("reset");
    expect(r.alarm).not.toBeNull();
    expect(r.alarm.lookbackMs).toBe(200);
    // the bound is now-200 = 800, so the edge at 900 IS inside the replay window
    expect(r.edges.emitted).toBe(1);
  });
});

describe("bounds and failure posture", () => {
  test("maxBatches bounds one sweep", () => {
    const edges = Array.from({ length: 50 }, (_, i) => edge(`h${String(i).padStart(3, "0")}`, i + 1));
    const src = fakeSource(edges);
    const orig = src.edgesSince.bind(src);
    src.edgesSince = (pos) => orig(pos, 2); // 2 per page
    const r = runSweep({ source: src, cursorPath, teams: TEAMS, emit: () => {}, now: () => 0, maxBatches: 3 });
    expect(r.batches).toBe(3);
    expect(r.edges.examined).toBe(6);
  });

  test("DEFAULT_MAX_BATCHES is a real bound, not Infinity", () => {
    expect(Number.isInteger(DEFAULT_MAX_BATCHES)).toBe(true);
    expect(DEFAULT_MAX_BATCHES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_BATCHES).toBeLessThan(1000);
  });

  test("a cursor that cannot be persisted is NOTED, and the sweep continues", () => {
    const r = runSweep({
      source: fakeSource([edge("h1", 10), edge("h2", 20)]),
      cursorPath,
      teams: TEAMS,
      emit: () => {},
      now: () => 0,
      maxBatches: 2,
      writeCursorFn: () => {
        throw Object.assign(new Error("readonly fs"), { code: "EROFS" });
      },
    });
    expect(r.edges.emitted).toBe(2); // work still happened
    expect(Object.keys(r.edges.byReason).some((k) => k.startsWith("cursor-write-failed"))).toBe(true);
  });

  test("an empty replica is a clean no-op", () => {
    const r = runSweep({ source: fakeSource([]), cursorPath, teams: TEAMS, emit: () => {}, maxBatches: 3 });
    expect(r.edges).toMatchObject({ emitted: 0, declined: 0, failed: 0, examined: 0 });
    expect(r.stoppedEarly).toBe(false);
  });
});

describe("processPage — the unit the loop is built on", () => {
  test("handled includes declines but stops before a failed emit", () => {
    const counts = { emitted: 0, declined: 0, failed: 0, examined: 0, byReason: {} };
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const res = processPage(items, {
      classify: (i) => (i.id === "a" ? { emit: false, reason: "foreign-team" } : { emit: true, reason: "ok" }),
      build: (i) => i,
      emit: (i) => {
        if (i.id === "c") throw new Error("boom");
      },
      counts,
    });
    expect(res.stopped).toBe(true);
    expect(res.handled.map((i) => i.id)).toEqual(["a", "b"]); // decline + success, not "c"
    expect(counts).toMatchObject({ emitted: 1, declined: 1, failed: 1, examined: 3 });
  });

  test("a build failure stops the page too, and is named", () => {
    const counts = { emitted: 0, declined: 0, failed: 0, examined: 0, byReason: {} };
    const res = processPage([{ id: "a" }], {
      classify: () => ({ emit: true, reason: "ok" }),
      build: () => {
        throw new Error("bad row");
      },
      emit: () => {},
      counts,
    });
    expect(res.stopped).toBe(true);
    expect(res.handled).toEqual([]);
    expect(Object.keys(counts.byReason)[0]).toContain("build-failed");
  });
});
