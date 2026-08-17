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
// CTL-1909: the readiness predicate is IMPORTED, not restated. A hand-written copy
// of the gate could agree with these fixtures while disagreeing with the daemon.
import { countsClean } from "./cloud-feed-timer.mjs";

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
    // The cursor sits at the START position, NOT past the failed row — so h1 and h2
    // are both still pending. (This used to assert the cursor was absent, which was a
    // PROXY for "didn't advance"; a cold start now persists its position up front, so
    // the proxy broke while the property it stood for held. Assert the property.)
    const c = readCursor(cursorPath);
    expect(c.state).toBe("ok");
    expect(c.position.lastCreatedAt).toBe(0); // the cold-start instant, before h1@10
    expect(c.position.lastId).toBeNull();
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
    expect(Object.keys(r.edges.byFailure).some((k) => k.startsWith("cursor-write-failed"))).toBe(true);
    // CTL-1909: a cursor failure is a FAILURE, so it must also be counted as one
    // — the readiness gate no longer infers that from the map alone.
    expect(r.edges.failed).toBeGreaterThan(0);
    expect(r.edges.byReason).toEqual({}); // ...and never as a decline
  });

  test("an empty replica is a clean no-op", () => {
    const r = runSweep({ source: fakeSource([]), cursorPath, teams: TEAMS, emit: () => {}, maxBatches: 3 });
    expect(r.edges).toMatchObject({ emitted: 0, declined: 0, failed: 0, examined: 0 });
    expect(r.stoppedEarly).toBe(false);
  });

  // CTL-1909: `runSweep` carries the same team-scope guard as `runDiffSweep`, and
  // it needs its own test — the diffsweep test cannot reach this function, so the
  // guard here was live and unkillable. This path is the superseded history sweep,
  // which is exactly why it would rot unnoticed.
  test("⛔ CTL-1909: runSweep refuses to sweep with no team scope, and cannot arm", () => {
    for (const teams of [undefined, new Set()]) {
      let wroteCursor = false;
      const r = runSweep({
        source: fakeSource([edge("h1", 1)]),
        cursorPath,
        teams,
        emit: () => {},
        writeCursorFn: () => {
          wroteCursor = true;
        },
      });
      expect(r.mode, String(teams)).toBe("no-team-scope");
      expect(r.edges.failed, String(teams)).toBe(1);
      expect(r.edges.byReason, String(teams)).toEqual({}); // never a decline
      expect(countsClean(r.edges), String(teams)).toBe(false);
      expect(r.stoppedEarly, String(teams)).toBe(true);
      expect(wroteCursor, String(teams)).toBe(false); // no cursor past rows it will never emit
    }
  });

  test("NEGATIVE CONTROL: runSweep with a real team scope does sweep and can arm", () => {
    const r = runSweep({ source: fakeSource([edge("h1", 1)]), cursorPath, teams: TEAMS, emit: () => {} });
    expect(r.mode).not.toBe("no-team-scope");
    expect(r.edges.failed).toBe(0);
    expect(countsClean(r.edges)).toBe(true);
  });
});

describe("processPage — the unit the loop is built on", () => {
  test("handled includes declines but stops before a failed emit", () => {
    const counts = { emitted: 0, declined: 0, failed: 0, examined: 0, byReason: {}, byFailure: {} };
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
    const counts = { emitted: 0, declined: 0, failed: 0, examined: 0, byReason: {}, byFailure: {} };
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
    expect(Object.keys(counts.byFailure)[0]).toContain("build-failed");
    expect(counts.byReason).toEqual({});
  });

  // ── CTL-1909 ──────────────────────────────────────────────────────────────
  // `verdictIsFailure` is the whole decline/failure split in one predicate, and
  // each of its three clauses is the sole thing preventing a distinct way for a
  // NON-decline to be scored as a healthy decline — i.e. to ARM enforce. Every
  // clause therefore gets a case that fails if the clause is deleted, and a
  // negative control on the same path so none of them can pass by the predicate
  // simply always saying "failure".
  describe("⭐ CTL-1909 — a non-decline must never be scored as a healthy decline", () => {
    const freshCounts = () => ({ emitted: 0, declined: 0, failed: 0, examined: 0, byReason: {}, byFailure: {} });
    const run = (verdict) => {
      const counts = freshCounts();
      const res = processPage([{ id: "a" }, { id: "b" }], {
        classify: () => verdict,
        build: (i) => i,
        emit: () => {},
        counts,
      });
      return { counts, res };
    };

    // Clause 1 — `verdict?.fatal === true`. A named reason, so clauses 2 and 3
    // both pass; only the `fatal` clause can catch this. This is the verdict
    // `classifyEdge` returns for `no-team-scope-configured`.
    test("a FATAL verdict fails the sweep even though its reason is well-formed", () => {
      const { counts, res } = run({ emit: false, reason: "no-team-scope-configured", fatal: true });
      expect(counts.failed).toBe(1);
      expect(counts.byFailure).toEqual({ "no-team-scope-configured": 1 });
      expect(counts.byReason).toEqual({}); // NOT a decline
      expect(counts.declined).toBe(0);
      // ...and it stops the page: the cursor must not move past a row the
      // producer was structurally unable to emit.
      expect(res.stopped).toBe(true);
      expect(res.handled).toEqual([]);
      expect(counts.examined).toBe(1); // stopped at the first, did not grind on
    });

    // Clause 2 — `typeof verdict?.reason !== "string"`. A decline is only
    // demonstrated when the producer SAYS why; an unexplained refusal is not
    // evidence of health.
    test.each([
      ["reasonless object", { emit: false }],
      ["null reason", { emit: false, reason: null }],
      ["non-string reason", { emit: false, reason: 42 }],
      ["undefined verdict", undefined],
      ["null verdict", null],
    ])("an unexplained refusal (%s) is a failure, named `unclassified`", (_label, verdict) => {
      const { counts, res } = run(verdict);
      expect(counts.failed).toBe(1);
      expect(counts.byFailure).toEqual({ unclassified: 1 });
      expect(counts.byReason).toEqual({});
      expect(res.stopped).toBe(true);
      expect(res.handled).toEqual([]);
    });

    // Clause 3 — `verdict.reason.length === 0`. `typeof "" === "string"`, so
    // clause 2 passes an empty reason straight through; without this clause an
    // empty string would be a perfectly healthy decline whose census entry is
    // the empty key.
    test('an EMPTY-string reason is a failure, not a decline keyed ""', () => {
      const { counts, res } = run({ emit: false, reason: "" });
      expect(counts.failed).toBe(1);
      expect(counts.byFailure).toEqual({ unclassified: 1 });
      expect(counts.byReason).toEqual({});
      expect(res.stopped).toBe(true);
    });

    // The NAMING half, which is the same function on purpose. A fatal verdict is
    // a failure on the strength of the flag alone, so its reason is untrusted for
    // the census KEY — `verdict.reason || "unclassified"` would key this census on
    // the number 42. (That was a real defect in this ticket's first cut: the
    // predicate ruled the reason unusable and the call site used it anyway.)
    test.each([
      ["non-string", 42],
      ["empty string", ""],
      ["absent", undefined],
    ])("a FATAL verdict with a %s reason is named `unclassified`, not keyed on the junk", (_label, reason) => {
      const { counts } = run({ emit: false, reason, fatal: true });
      expect(counts.failed).toBe(1);
      expect(counts.byFailure).toEqual({ unclassified: 1 });
      expect(counts.byReason).toEqual({});
    });

    test("NEGATIVE CONTROL: a fatal verdict that DID name itself keeps its own name", () => {
      // Otherwise the assertions above would pass on a function that threw every
      // fatal reason away, which would make the un-arm unactionable.
      const { counts } = run({ emit: false, reason: "no-team-scope-configured", fatal: true });
      expect(counts.byFailure).toEqual({ "no-team-scope-configured": 1 });
    });

    // NEGATIVE CONTROL on the identical path. Without this, every assertion
    // above would still pass if `verdictIsFailure` were hard-wired to `true` —
    // which would restore the CTL-1909 bug in its worst form (every decline
    // un-arms enforce AND stops the sweep).
    test("NEGATIVE CONTROL: an ordinary named decline is healthy, settled, and does not stop the page", () => {
      const { counts, res } = run({ emit: false, reason: "foreign-team" });
      expect(counts.failed).toBe(0);
      expect(counts.byFailure).toEqual({});
      expect(counts.declined).toBe(2);
      expect(counts.byReason).toEqual({ "foreign-team": 2 });
      expect(res.stopped).toBe(false);
      expect(res.handled.map((i) => i.id)).toEqual(["a", "b"]); // cursor MUST advance
    });
  });
});

describe("⭐ a cold start PERSISTS its position, or every sweep restarts from a new now", () => {
  // Found by running the producer on a real host: every sweep logged `cold-start`
  // because an empty page writes no cursor, so the next sweep began from a FRESH
  // `now` — making the interval between ticks a permanent blind spot.
  test("an empty cold-start still writes the cursor", () => {
    const r = runSweep({ source: fakeSource([]), cursorPath, teams: TEAMS, emit: () => {}, now: () => 5000, maxBatches: 2 });
    expect(r.mode).toBe("cold-start");
    expect(readCursor(cursorPath)).toMatchObject({ state: "ok", position: { lastCreatedAt: 5000 } });
  });

  test("the NEXT sweep resumes instead of cold-starting again", () => {
    const src = fakeSource([]);
    runSweep({ source: src, cursorPath, teams: TEAMS, emit: () => {}, now: () => 5000, maxBatches: 2 });
    const second = runSweep({ source: src, cursorPath, teams: TEAMS, emit: () => {}, now: () => 9999, maxBatches: 2 });
    expect(second.mode).toBe("resume"); // NOT cold-start
  });

  test("⭐ an edge arriving between two ticks is NOT skipped", () => {
    // The defect in its consequential form: with per-sweep `now`, an edge landing in
    // the gap between ticks was never queried by either.
    const edges = [];
    const src = fakeSource(edges);
    runSweep({ source: src, cursorPath, teams: TEAMS, emit: () => {}, now: () => 1000, maxBatches: 2 });
    edges.push(edge("gap", 1500)); // lands between tick 1 (t=1000) and tick 2 (t=2000)
    const emitted = [];
    runSweep({ source: src, cursorPath, teams: TEAMS, emit: (_e, i) => emitted.push(i.history.id), now: () => 2000, maxBatches: 2 });
    expect(emitted).toEqual(["gap"]);
  });

  test("a reset also persists its stated bound", () => {
    writeCursor(cursorPath, { lastCreatedAt: 10, lastId: "x" });
    require("node:fs").writeFileSync(cursorPath, "corrupt", "utf8");
    const r = runSweep({ source: fakeSource([]), cursorPath, teams: TEAMS, emit: () => {}, now: () => 9000, resetLookbackMs: 1000, maxBatches: 2 });
    expect(r.mode).toBe("reset");
    expect(readCursor(cursorPath).position.lastCreatedAt).toBe(8000);
  });
});
