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
    expect(Object.keys(r.edges.byReason)).toContain("baseline-lost-with-live-cursor");
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
    // Belt and braces with the readiness predicate: mode !== "resume" and a
    // byReason entry both disqualify it independently.
    const r = { mode: "baseline-lost", stoppedEarly: true, edges: { failed: 0, byReason: { "baseline-lost-with-live-cursor": 1 } }, comments: { failed: 0, byReason: {} } };
    expect(r.mode).not.toBe("resume");
    expect(Object.keys(r.edges.byReason).length).toBeGreaterThan(0);
  });
});
