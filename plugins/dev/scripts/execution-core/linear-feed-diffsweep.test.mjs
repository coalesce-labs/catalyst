// linear-feed-diffsweep.test.mjs — CTL-1847, the issues-diff sweep + baseline store.
//
// Run: cd plugins/dev/scripts/execution-core && bun test linear-feed-diffsweep.test.mjs
//
// Real files in a temp dir: the baseline is a SQLite store and the cursor is a file,
// and both claims under test ("a cold start does not burst", "an interrupted seed is
// not a baseline") are about what survives on disk.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLastSeenStore } from "./linear-feed-lastseen.mjs";
import { runDiffSweep, seedBaseline } from "./linear-feed-sweep.mjs";
import { CURSOR_ABSENT, CURSOR_OK, defaultCursorPath, readCursor } from "./linear-feed-cursor.mjs";
// CTL-1909: the readiness predicate is IMPORTED, not restated here. A hand-built
// copy of it in this file could agree with a fixture while disagreeing with the
// gate the daemon actually runs.
import { countsClean, sweepUnreadyReason } from "./cloud-feed-timer.mjs";

let dir;
let store;
let storeSeq = 0;
const makeStore = () => createLastSeenStore({ path: join(dir, `fresh-${storeSeq++}.db`) });
let cursorPath;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfds-"));
  store = createLastSeenStore({ path: join(dir, "lastseen.db") });
  cursorPath = defaultCursorPath(dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const TEAMS = new Set(["CTL"]);

const issue = (id, over = {}) => ({
  issue: {
    id, identifier: `CTL-${id}`, team_key: "CTL", state: "Backlog", assignee_id: null,
    priority: null, estimate: null, project_id: null, cycle_id: null, parent_id: null,
    team_id: "t1", title: "t", due_date: null, delegate_id: null, description: "d",
    updated_at: 1000, ...over,
  },
  project: null,
  labels: [],
});

/** In-memory source honouring the composite-cursor contract over issues rows. */
const fakeSource = (rows) => ({
  issuesSince(pos, limit = 100) {
    return rows
      .filter((r) => r.issue.updated_at > pos.lastCreatedAt || (r.issue.updated_at === pos.lastCreatedAt && r.issue.id > (pos.lastId ?? "")))
      .sort((a, b) => a.issue.updated_at - b.issue.updated_at || a.issue.id.localeCompare(b.issue.id))
      .slice(0, limit);
  },
  positionAfter(items) {
    if (!items?.length) return null;
    const last = items[items.length - 1];
    return { lastCreatedAt: last.issue.updated_at, lastId: last.issue.id };
  },
});

describe("⛔ a cold start SEEDS — it does not emit ~4,000 edges", () => {
  test("the first sweep emits NOTHING and records the baseline", () => {
    const rows = Array.from({ length: 25 }, (_, i) => issue(`i${String(i).padStart(3, "0")}`));
    const emitted = [];
    const r = runDiffSweep({
      source: fakeSource(rows), store, cursorPath, teams: TEAMS,
      emit: (_e, i) => emitted.push(i.issue.id),
    });
    expect(r.mode).toBe("seeded");
    expect(emitted).toEqual([]); // ← the whole point
    expect(r.seeded).toBe(25);
    expect(store.size()).toBe(25);
    expect(store.isSeeded()).toBe(true);
  });

  test("⭐ the SECOND sweep emits only what actually changed", () => {
    const rows = [issue("a"), issue("b")];
    const emitted = [];
    const emit = (_e, i) => emitted.push(i.issue.id);
    runDiffSweep({ source: fakeSource(rows), store, cursorPath, teams: TEAMS, emit });
    expect(emitted).toEqual([]);

    rows[0] = issue("a", { state: "Todo", updated_at: 2000 }); // one real change
    runDiffSweep({ source: fakeSource(rows), store, cursorPath, teams: TEAMS, emit });
    expect(emitted).toEqual(["a"]);
  });

  test("an interrupted seed is NOT a baseline — count>0 cannot tell them apart", () => {
    const rows = Array.from({ length: 10 }, (_, i) => issue(`i${i}`));
    const partial = seedBaseline({ source: fakeSource(rows), store, batchLimit: 2, maxBatches: 2 });
    expect(partial.complete).toBe(false);
    expect(store.size()).toBeGreaterThan(0); // non-empty...
    expect(store.isSeeded()).toBe(false); // ...but NOT a baseline
  });

  test("a completed seed marks itself, only at the end", () => {
    const r = seedBaseline({ source: fakeSource([issue("a")]), store });
    expect(r.complete).toBe(true);
    expect(store.isSeeded()).toBe(true);
  });
});

describe("the diff sweep emits real edges", () => {
  const prime = (rows, emit) => runDiffSweep({ source: fakeSource(rows), store, cursorPath, teams: TEAMS, emit });

  test("a state change is emitted as the dispatch trigger", () => {
    const rows = [issue("a")];
    const events = [];
    prime(rows, (e) => events.push(e));
    rows[0] = issue("a", { state: "Todo", updated_at: 2000 });
    prime(rows, (e) => events.push(e));
    expect(events).toHaveLength(1);
    expect(events[0].attributes["event.name"]).toBe("linear.issue.state_changed");
    expect(events[0].body.payload.toState).toBe("Todo");
  });

  test("a non-state change is emitted as issue.updated", () => {
    const rows = [issue("a")];
    const events = [];
    prime(rows, (e) => events.push(e));
    rows[0] = issue("a", { priority: 2, updated_at: 2000 });
    prime(rows, (e) => events.push(e));
    expect(events[0].attributes["event.name"]).toBe("linear.issue.updated");
    expect(events[0].body.payload.updatedFromKeys).toEqual(["priority"]);
  });

  test("a rewrite that changes nothing tracked is declined, and still advances", () => {
    // The mirror moves updated_at without touching a field we care about. Emitting
    // for that is noise; NOT advancing would re-examine it forever.
    const rows = [issue("a")];
    prime(rows, () => {});
    rows[0] = issue("a", { updated_at: 2000 }); // same fields, newer timestamp
    const r = prime(rows, () => {
      throw new Error("should not emit");
    });
    expect(r.edges.emitted).toBe(0);
    expect(r.edges.byReason["no-tracked-change"]).toBe(1);
    expect(readCursor(cursorPath).position.lastCreatedAt).toBe(2000);
  });

  test("a foreign team is declined but still advances the baseline", () => {
    const rows = [issue("a", { team_key: "ADV", identifier: "ADV-1" })];
    prime(rows, () => {});
    rows[0] = issue("a", { team_key: "ADV", identifier: "ADV-1", state: "Todo", updated_at: 2000 });
    const r = prime(rows, () => {
      throw new Error("should not emit");
    });
    expect(r.edges.byReason["foreign-team"]).toBe(1);
    expect(store.get("a").state).toBe("Todo"); // baseline moved
  });
});

describe("⭐ an emit failure must NOT advance the baseline", () => {
  test("the `before` survives, so the edge can be re-derived next tick", () => {
    // Advancing the baseline on a failed emit destroys the very `before` needed to
    // re-derive that edge — the change would be lost permanently, which is strictly
    // worse than the duplicate a retry risks.
    const rows = [issue("a")];
    runDiffSweep({ source: fakeSource(rows), store, cursorPath, teams: TEAMS, emit: () => {} });
    expect(store.get("a").state).toBe("Backlog");

    rows[0] = issue("a", { state: "Todo", updated_at: 2000 });
    runDiffSweep({
      source: fakeSource(rows), store, cursorPath, teams: TEAMS,
      emit: () => {
        throw new Error("sink down");
      },
    });
    expect(store.get("a").state).toBe("Backlog"); // NOT Todo — baseline held

    const emitted = [];
    runDiffSweep({ source: fakeSource(rows), store, cursorPath, teams: TEAMS, emit: (_e, i) => emitted.push(i.issue.id) });
    expect(emitted).toEqual(["a"]); // the edge was not lost
    expect(store.get("a").state).toBe("Todo");
  });
});

describe("the baseline store", () => {
  test("get returns null for an unknown issue, not a fabricated snapshot", () => {
    expect(store.get("nope")).toBeNull();
    expect(store.get("")).toBeNull();
    expect(store.get(null)).toBeNull();
  });

  test("put/get round-trips and upserts", () => {
    store.put("a", { state: "Todo" }, 1);
    expect(store.get("a")).toEqual({ state: "Todo" });
    store.put("a", { state: "Done" }, 2);
    expect(store.get("a")).toEqual({ state: "Done" });
    expect(store.size()).toBe(1);
  });

  test("isSeeded is independent of size", () => {
    expect(store.isSeeded()).toBe(false);
    store.put("a", { state: "Todo" });
    expect(store.size()).toBe(1);
    expect(store.isSeeded()).toBe(false); // non-empty is NOT seeded
    store.markSeeded();
    expect(store.isSeeded()).toBe(true);
  });

  test("a corrupt snapshot reads as null rather than as garbage", () => {
    store.put("a", { state: "Todo" });
    const raw = createLastSeenStore({ path: join(dir, "lastseen.db") });
    raw.put("a", undefined); // stores "null"
    expect(raw.get("a")).toBeNull();
    raw.close();
  });
});

describe("⭐ comments are swept in diff mode too — the harness caught their absence", () => {
  // The first cut of runDiffSweep omitted comments entirely. The parity harness
  // found it on its first live run: smee reported 14 comment.created in the window
  // and the feed could never match one.
  const withComments = (rows, comments) => ({
    ...fakeSource(rows),
    commentsSince(pos, limit = 100) {
      return comments
        .filter((c) => c.comment.created_at > pos.lastCreatedAt)
        .slice(0, limit);
    },
    positionAfter(items) {
      if (!items?.length) return null;
      const last = items[items.length - 1];
      const row = last.issue ?? last.comment;
      return { lastCreatedAt: row.updated_at ?? row.created_at, lastId: row.id };
    },
  });
  const comment = (id, createdAt) => ({
    comment: { id, issue_id: "a", body: "hi", created_at: createdAt, author_id: "u1" },
    issue: { id: "a", identifier: "CTL-1", team_key: "CTL" },
    author: { name: "Ryan Rozich" },
  });

  test("a comment is emitted", () => {
    const src = withComments([issue("a")], [comment("c1", 5_000_000_000_000)]);
    runDiffSweep({ source: src, store, cursorPath, teams: TEAMS, emit: () => {} }); // seed
    const events = [];
    const r = runDiffSweep({ source: src, store, cursorPath, teams: TEAMS, emit: (e) => events.push(e), now: () => 1000 });
    expect(r.comments.emitted).toBe(1);
    expect(events[0].attributes["event.name"]).toBe("linear.comment.created");
  });

  test("a foreign team's comment is declined", () => {
    const c = comment("c1", 5_000_000_000_000);
    c.issue.team_key = "ADV";
    const src = withComments([issue("a")], [c]);
    runDiffSweep({ source: src, store, cursorPath, teams: TEAMS, emit: () => {} });
    const r = runDiffSweep({ source: src, store, cursorPath, teams: TEAMS, emit: () => {}, now: () => 1000 });
    expect(r.comments.emitted).toBe(0);
    expect(r.comments.byReason["foreign-team"]).toBe(1);
  });
});

// ── CTL-1847 (Codex P1 round 5): a lost baseline with a live cursor ──────────
describe("⛔ refuses to reseed when a durable cursor says we had a baseline", () => {
  test("missing baseline + intact cursor ⇒ baseline-lost, NOT a fresh seed", () => {
    // Deleting linear-feed-lastseen-*.db after the producer has been emitting,
    // while the cursor survives, previously reseeded: snapshot the CURRENT
    // replica, advance the cursor, emit nothing — absorbing every change since
    // the former baseline, permanently. Under enforce those events' webhook
    // copies are suppressed, so nothing can retry them.
    const rows = [issue("a"), issue("b")];
    const emitted = [];
    const freshStore = makeStore(); // never seeded
    const r = runDiffSweep({
      source: fakeSource(rows),
      store: freshStore,
      cursorPath,
      teams: TEAMS,
      emit: (e, i) => emitted.push(i.issue.id),
      // the durable evidence that a baseline once existed
      readCursorFn: () => ({ state: CURSOR_OK, position: { lastCreatedAt: 500, lastId: "z" } }),
    });
    expect(r.mode).toBe("baseline-lost");
    expect(r.stoppedEarly).toBe(true);
    expect(emitted).toEqual([]);
    expect(freshStore.isSeeded()).toBe(false); // did NOT silently reseed
    expect(r.alarm?.severity).toBe("error");
    expect(r.alarm?.reason).toBe("baseline-lost-with-live-cursor");
    // CTL-1909: a lost baseline is a FAILURE census entry, never a decline —
    // it is the producer that cannot do its job, not a row it declined.
    expect(Object.keys(r.edges.byFailure)).toContain("baseline-lost-with-live-cursor");
    expect(r.edges.failed).toBe(1);
    expect(r.edges.byReason).toEqual({});
  });

  test("NEGATIVE CONTROL: missing baseline + NO cursor is a legitimate first seed", () => {
    // Without this, the guard could refuse every first run and nothing would
    // ever seed.
    const rows = [issue("a"), issue("b")];
    const freshStore = makeStore();
    const r = runDiffSweep({
      source: fakeSource(rows),
      store: freshStore,
      cursorPath,
      teams: TEAMS,
      emit: () => {},
      readCursorFn: () => ({ state: CURSOR_ABSENT, position: null }),
    });
    expect(r.mode).toBe("seeded");
    expect(freshStore.isSeeded()).toBe(true);
  });

  test("a baseline-lost sweep can never arm enforce (it is not a clean sweep)", () => {
    // Belt and braces, asserted through the REAL predicate rather than by
    // restating it: the hand-built shape this used to assert against could drift
    // from what runDiffSweep actually returns and still pass.
    const r = runDiffSweep({
      source: fakeSource([]),
      store: makeStore(),
      cursorPath,
      teams: TEAMS,
      emit: () => {},
      readCursorFn: () => ({ state: CURSOR_OK, position: { lastCreatedAt: 1, lastId: "x" } }),
    });
    expect(r.mode).not.toBe("resume");
    expect(r.stoppedEarly).toBe(true);
    expect(countsClean(r.edges)).toBe(false);
    expect(sweepUnreadyReason({ account: "t0", skipped: null, sweep: r }, { healthy: true })).toBe("stopped-early");
  });

  // ── CTL-1909 ──────────────────────────────────────────────────────────────
  // The whole point of the decline/failure split: a sweep that declines every
  // row must ARM. These run the REAL sweep against the REAL readiness predicate
  // (imported, not restated), so neither side can be satisfied by a fixture
  // that only agrees with itself.
  describe("⭐ CTL-1909 — the sweep's own output, judged by the real readiness gate", () => {
    const ready = (sweep) => sweepUnreadyReason({ account: "t0", skipped: null, sweep }, { healthy: true });
    const foreign = (id, over = {}) => issue(id, { identifier: `ZZZ-${id}`, team_key: "ZZZ", ...over });

    test("a sweep of nothing but FOREIGN-TEAM rows arms enforce", () => {
      const st = makeStore();
      runDiffSweep({ source: fakeSource([foreign("f1"), foreign("f2")]), store: st, cursorPath, teams: TEAMS, emit: () => {} }); // seed
      const emitted = [];
      const r = runDiffSweep({
        // same two issues, each with a real state change the sweep will diff
        source: fakeSource([foreign("f1", { state: "Todo", updated_at: 2000 }), foreign("f2", { state: "Done", updated_at: 2001 })]),
        store: st,
        cursorPath,
        teams: TEAMS,
        emit: (e) => emitted.push(e),
      });
      expect(emitted).toEqual([]); // it emitted nothing...
      expect(r.edges.declined).toBe(2);
      expect(r.edges.byReason["foreign-team"]).toBe(2);
      expect(r.edges.failed).toBe(0);
      expect(r.edges.byFailure).toEqual({}); // ...and nothing went wrong
      expect(countsClean(r.edges)).toBe(true);
      expect(ready(r)).toBe(null); // ⭐ ARMED — this is the CTL-1909 fix
    });

    test("POSITIVE CONTROL on the same path: an emit failure does NOT arm", () => {
      // Same sweep shape, only the emit throws. Without this, the assertion
      // above could be satisfied by a gate that always says ready.
      const st = makeStore();
      runDiffSweep({ source: fakeSource([issue("m1")]), store: st, cursorPath, teams: TEAMS, emit: () => {} }); // seed
      const r = runDiffSweep({
        source: fakeSource([issue("m1", { state: "Done", updated_at: 2000 })]),
        store: st,
        cursorPath,
        teams: TEAMS,
        emit: () => {
          throw new Error("boom");
        },
      });
      expect(r.edges.failed).toBeGreaterThan(0);
      expect(Object.keys(r.edges.byFailure)[0]).toContain("emit-failed");
      expect(countsClean(r.edges)).toBe(false);
      expect(ready(r)).not.toBe(null); // UN-ARMED
    });

    test("⛔ a producer with NO team scope refuses to sweep, and cannot arm", () => {
      // The hole the split would otherwise open: with `teams` EMPTY, classifyEdge
      // declines every row as `foreign-team` — a healthy decline under the new
      // rule — so enforce would arm while the feed emitted nothing for anybody.
      for (const teams of [undefined, new Set()]) {
        const st = makeStore();
        let wroteCursor = false;
        const r = runDiffSweep({
          source: fakeSource([issue("s1")]),
          store: st,
          cursorPath,
          teams,
          emit: () => {},
          writeCursorFn: () => {
            wroteCursor = true;
          },
        });
        expect(r.edges.failed, String(teams)).toBe(1);
        expect(countsClean(r.edges), String(teams)).toBe(false);
        expect(ready(r), String(teams)).not.toBe(null);
        // ...and it must not have consumed anything on the way out: no baseline,
        // no cursor movement past rows it will never emit.
        expect(st.isSeeded()).toBe(false);
        expect(wroteCursor).toBe(false);
      }
    });

    // ── the FATAL branch, at the altitude where it is WIRED ──────────────────
    // `runDiffSweep` carries a `classifyFn` seam for exactly this: the fatal
    // branch is unreachable through the real `classifyEdge` (teamScopeFailure
    // pre-empts the only fatal verdict it can return), and an unreachable guard
    // is one nothing can prove still works. These do not re-test the predicate —
    // `linear-feed-sweep.test.mjs` owns that — they test that the sweep ACTS on
    // it: no baseline absorbed, no cursor advanced, enforce un-armed.
    const fatalVerdict = { emit: false, reason: "some-future-producer-fault", fatal: true };

    test("⛔ a FATAL verdict mid-sweep does not advance the baseline, the cursor, or readiness", () => {
      const st = makeStore();
      runDiffSweep({ source: fakeSource([issue("k1")]), store: st, cursorPath, teams: TEAMS, emit: () => {} }); // seed
      const seeded = st.get("k1");
      expect(seeded.state).toBe("Backlog"); // the `before` the retry will need

      let wroteCursor = false;
      const emitted = [];
      const r = runDiffSweep({
        source: fakeSource([issue("k1", { state: "Done", updated_at: 2000 })]),
        store: st,
        cursorPath,
        teams: TEAMS,
        emit: (e) => emitted.push(e),
        classifyFn: () => fatalVerdict,
        writeCursorFn: () => {
          wroteCursor = true;
        },
      });

      expect(emitted).toEqual([]);
      expect(r.edges.failed).toBe(1);
      expect(r.edges.byFailure).toEqual({ "some-future-producer-fault": 1 });
      expect(r.edges.byReason).toEqual({}); // NOT laundered into the decline census
      expect(r.stoppedEarly).toBe(true);
      // ⭐ the part a reason-string assertion cannot see: the edge is still
      // re-derivable, because the baseline was not absorbed.
      expect(st.get("k1").state).toBe("Backlog");
      expect(wroteCursor).toBe(false);
      expect(countsClean(r.edges)).toBe(false);
      expect(ready(r)).not.toBe(null); // UN-ARMED — smee stays authoritative
    });

    test("NEGATIVE CONTROL: the same seam returning a NAMED decline arms, and settles the row", () => {
      // Identical wiring, `fatal` removed. Proves the test above is driven by the
      // fatal flag rather than by the injected seam declining at all.
      const st = makeStore();
      runDiffSweep({ source: fakeSource([issue("k2")]), store: st, cursorPath, teams: TEAMS, emit: () => {} }); // seed
      const r = runDiffSweep({
        source: fakeSource([issue("k2", { state: "Done", updated_at: 2000 })]),
        store: st,
        cursorPath,
        teams: TEAMS,
        emit: () => {},
        classifyFn: () => ({ emit: false, reason: "some-future-producer-fault" }),
      });
      expect(r.edges.failed).toBe(0);
      expect(r.edges.byReason).toEqual({ "some-future-producer-fault": 1 });
      expect(r.edges.byFailure).toEqual({});
      expect(r.stoppedEarly).toBe(false);
      expect(st.get("k2").state).toBe("Done"); // examined and SETTLED
      expect(countsClean(r.edges)).toBe(true);
      expect(ready(r)).toBe(null); // ARMED
    });
  });
});

// ── CTL-1904: labels that land AFTER the cursor passed the issue ─────────────
// `rows` are the file's SHAPED items ({issue, project, labels}); the label map
// is consulted separately so it can move INDEPENDENTLY of the issue rows —
// which is the entire race being reproduced.
const raceSource = (rows, labelMap) => {
  const withLabels = (r) => ({ ...r, labels: labelMap.get(r.issue.id) ?? [] });
  return {
    issuesSince(pos, lim = 100) {
      const since = pos?.lastCreatedAt ?? 0;
      return rows
        .filter((r) => r.issue.updated_at > since || (r.issue.updated_at === since && r.issue.id > (pos?.lastId ?? "")))
        .sort((a, b) => a.issue.updated_at - b.issue.updated_at || a.issue.id.localeCompare(b.issue.id))
        .slice(0, lim)
        .map(withLabels);
    },
    positionAfter(items) {
      if (!items?.length) return null;
      const last = items[items.length - 1];
      return { lastCreatedAt: last.issue.updated_at, lastId: last.issue.id };
    },
    labelSets() {
      const m = new Map();
      for (const [k, v] of labelMap) if (v.length) m.set(k, [...v].sort());
      return m;
    },
    issuesByIds(ids) {
      return rows.filter((r) => ids.includes(r.issue.id)).map(withLabels);
    },
  };
};

describe("⛔ the label sweep catches what the updated_at cursor cannot", () => {
  // The live race, 2026-08-16: smee reported `linear.issue.updated
  // ['updatedAt','labelIds']` for CTL-1894 at 23:23:28Z; the feed emitted no
  // `labels` key for that ticket EVER, because the replica synced the issue row
  // and its issue_labels rows at different times and `updated_at` (23:24:51Z)
  // never advanced again.
  //
  // A source with labelSets()/issuesByIds(), where the label map can be changed
  // INDEPENDENTLY of the issue rows — which is the whole point.
  test("⭐ THE RACE: labels arrive after the cursor passed the issue — still emitted", () => {
    const rows = [issue("a", { updated_at: 1000 })];
    const labels = new Map([["a", []]]);
    const emitted = [];
    const emit = (e) => emitted.push(e?.body?.payload?.updatedFromKeys ?? []);
    const st = makeStore();
    const src = raceSource(rows, labels);

    runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit }); // seed
    runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit }); // steady, nothing
    expect(emitted).toEqual([]);

    // The label lands LATER, and the issue row's updated_at does NOT move — so the
    // keyset cursor will never return this issue again.
    labels.set("a", ["refactor"]);
    runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain("labels");
  });

  test("⛔ CONTROL: without the label sweep this edge is lost forever", () => {
    // Same fixture against a source with NO labelSets/issuesByIds — i.e. the
    // pre-CTL-1904 capability set. Proves the fixture is not trivially passing.
    const rows = [issue("a", { updated_at: 1000 })];
    const labels = new Map([["a", []]]);
    const emitted = [];
    const emit = (e) => emitted.push(e);
    const st = makeStore();
    const full = raceSource(rows, labels);
    const legacy = { issuesSince: (...a) => full.issuesSince(...a), positionAfter: (...a) => full.positionAfter(...a) };

    runDiffSweep({ source: legacy, store: st, cursorPath, teams: TEAMS, emit });
    runDiffSweep({ source: legacy, store: st, cursorPath, teams: TEAMS, emit });
    labels.set("a", ["refactor"]);
    runDiffSweep({ source: legacy, store: st, cursorPath, teams: TEAMS, emit });
    runDiffSweep({ source: legacy, store: st, cursorPath, teams: TEAMS, emit });

    expect(emitted).toEqual([]); // permanently invisible — the defect
  });

  test("a REMOVAL of the last label is detected (absence ≠ unknown)", () => {
    const rows = [issue("a", { updated_at: 1000 })];
    const labels = new Map([["a", ["refactor"]]]);
    const emitted = [];
    const emit = (e) => emitted.push(e?.body?.payload?.updatedFromKeys ?? []);
    const st = makeStore();
    const src = raceSource(rows, labels);

    runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit }); // seed w/ label
    runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit });
    expect(emitted).toEqual([]);

    labels.set("a", []); // last label removed — the issue vanishes from the map
    runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain("labels");
  });

  test("NEGATIVE CONTROL: an unchanged label set emits nothing, repeatedly", () => {
    const rows = [issue("a", { updated_at: 1000 })];
    const labels = new Map([["a", ["refactor"]]]);
    const emitted = [];
    const st = makeStore();
    const src = raceSource(rows, labels);
    for (let i = 0; i < 4; i++) {
      runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit: (e) => emitted.push(e) });
    }
    expect(emitted).toEqual([]);
  });

  test("no DOUBLE emit when the issue sweep already caught the label change", () => {
    // updated_at moves AND labels change in the same tick: the issue sweep emits
    // once and the label sweep must find no difference.
    const rows = [issue("a", { updated_at: 1000 })];
    const labels = new Map([["a", []]]);
    const emitted = [];
    const st = makeStore();
    const src = raceSource(rows, labels);
    runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit: () => {} });

    rows[0] = issue("a", { updated_at: 2000, state: "Todo" });
    labels.set("a", ["refactor"]);
    runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit: (e) => emitted.push(e) });
    expect(emitted).toHaveLength(1);
  });

  test("the label sweep reports its own counts, so a failure can un-arm enforce", () => {
    const rows = [issue("a", { updated_at: 1000 })];
    const src = raceSource(rows, new Map([["a", []]]));
    const st = makeStore();
    runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit: () => {} });
    const r = runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit: () => {} });
    expect(r.labels).toBeDefined();
    expect(r.labels.failed).toBe(0);
    expect(Object.keys(r.labels.byReason)).toHaveLength(0);
  });

  // ── CTL-1909, third call site ────────────────────────────────────────────
  // The label pass has its OWN `verdictIsFailure` branch and its own counts
  // block, and `sweepUnreadyReason` gates on that block separately
  // (`labels:` prefix). A split applied to two of three call sites would leave
  // this one able to arm enforce on a producer-level fault.
  test("⛔ CTL-1909: a FATAL verdict in the LABEL pass un-arms, and keeps the row re-derivable", () => {
    const rows = [issue("a", { updated_at: 1000 })];
    const labels = new Map([["a", []]]);
    const src = raceSource(rows, labels);
    const st = makeStore();
    runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit: () => {} }); // seed
    labels.set("a", ["refactor"]); // a label-only change: only the label pass sees it

    const emitted = [];
    const r = runDiffSweep({
      source: src,
      store: st,
      cursorPath,
      teams: TEAMS,
      emit: (e) => emitted.push(e),
      classifyFn: () => ({ emit: false, reason: "some-future-producer-fault", fatal: true }),
    });

    expect(emitted).toEqual([]);
    expect(r.labels.failed).toBe(1);
    expect(r.labels.byFailure).toEqual({ "some-future-producer-fault": 1 });
    expect(r.labels.byReason).toEqual({}); // not a decline
    // the label change must survive in re-derivable form for the retry
    expect(st.get("a").labels ?? []).toEqual([]);
    expect(countsClean(r.labels)).toBe(false);
    // `labels:` prefix ⇒ the LABEL block is what disqualified it, and the reason
    // string names the fault so the un-arm is actionable.
    expect(sweepUnreadyReason({ account: "t0", skipped: null, sweep: r }, { healthy: true })).toBe(
      "labels:failed=1,some-future-producer-fault",
    );
  });

  test("NEGATIVE CONTROL: a NAMED decline in the label pass arms, and settles the row", () => {
    const rows = [issue("a", { updated_at: 1000 })];
    const labels = new Map([["a", []]]);
    const src = raceSource(rows, labels);
    const st = makeStore();
    runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit: () => {} }); // seed
    labels.set("a", ["refactor"]);

    const r = runDiffSweep({
      source: src,
      store: st,
      cursorPath,
      teams: TEAMS,
      emit: () => {},
      classifyFn: () => ({ emit: false, reason: "foreign-team" }),
    });

    expect(r.labels.failed).toBe(0);
    expect(r.labels.byReason).toEqual({ "foreign-team": 1 });
    expect(r.labels.byFailure).toEqual({});
    expect(st.get("a").labels ?? []).toEqual(["refactor"]); // examined and SETTLED
    expect(countsClean(r.labels)).toBe(true);
    expect(sweepUnreadyReason({ account: "t0", skipped: null, sweep: r }, { healthy: true })).toBe(null);
  });
});

// ── Codex P2 (#3446): the label sweep is bounded per tick ────────────────────
describe("⛔ a bulk label change cannot stall the daemon event loop", () => {
  const mkRows = (n) => Array.from({ length: n }, (_, i) => issue(`i${String(i).padStart(4, "0")}`));

  test("a mass label change is processed in BUDGETED slices, not all at once", () => {
    // A label rename or bulk edit changes many issues at once, and this pass sits
    // outside the issue sweep's maxBatches bound. Measured at ~2.4 s for 2,843
    // changed issues on the daemon event loop.
    const rows = mkRows(50);
    const labels = new Map(rows.map((r) => [r.issue.id, []]));
    const st = makeStore();
    const src = raceSource(rows, labels);
    runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit: () => {} }); // seed

    for (const id of labels.keys()) labels.set(id, ["refactor"]); // all 50 at once

    const emitted = [];
    const r1 = runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit: (e) => emitted.push(e), labelBudget: 10 });
    expect(r1.labels.examined).toBe(50);
    expect(emitted).toHaveLength(10); // budget respected
    expect(r1.labels.deferred).toBe(40);
  });

  test("the deferred remainder is picked up on later ticks — bounded, not lost", () => {
    const rows = mkRows(25);
    const labels = new Map(rows.map((r) => [r.issue.id, []]));
    const st = makeStore();
    const src = raceSource(rows, labels);
    runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit: () => {} });
    for (const id of labels.keys()) labels.set(id, ["refactor"]);

    const emitted = [];
    for (let i = 0; i < 5; i++) {
      runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit: (e) => emitted.push(e), labelBudget: 10 });
    }
    expect(emitted).toHaveLength(25); // every one eventually emitted
    const last = runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit: () => {}, labelBudget: 10 });
    expect(last.labels.deferred).toBe(0); // and it drains
  });

  test("⚠️ deferral does NOT land in byReason — a paced sweep must not un-arm enforce", () => {
    // readiness treats any byReason entry as disqualifying. Deferral is healthy
    // operation; only a failure should un-arm.
    const rows = mkRows(30);
    const labels = new Map(rows.map((r) => [r.issue.id, []]));
    const st = makeStore();
    const src = raceSource(rows, labels);
    runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit: () => {} });
    for (const id of labels.keys()) labels.set(id, ["refactor"]);
    const r = runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit: () => {}, labelBudget: 5 });
    expect(r.labels.deferred).toBeGreaterThan(0);
    expect(Object.keys(r.labels.byReason)).toHaveLength(0);
    expect(r.labels.failed).toBe(0);
  });

  test("NEGATIVE CONTROL: a small change set is not deferred at all", () => {
    const rows = mkRows(3);
    const labels = new Map(rows.map((r) => [r.issue.id, []]));
    const st = makeStore();
    const src = raceSource(rows, labels);
    runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit: () => {} });
    labels.set(rows[0].issue.id, ["refactor"]);
    const r = runDiffSweep({ source: src, store: st, cursorPath, teams: TEAMS, emit: () => {}, labelBudget: 200 });
    expect(r.labels.deferred).toBe(0);
    expect(r.labels.emitted).toBe(1);
  });
});
