// linear-feed-torn-read.test.mjs — CTL-1920, telling a torn replica read from a
// real change set.
//
// Run: cd plugins/dev/scripts/execution-core && bun test linear-feed-torn-read.test.mjs
//
// Real SQLite baseline + real cursor file, same as the CTL-1847 sweep suite: the
// central claim ("the baseline keeps its pre-tear truth") is a claim about what
// survives on disk, so an in-memory double would not test it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLastSeenStore } from "./linear-feed-lastseen.mjs";
import { runDiffSweep } from "./linear-feed-sweep.mjs";
import { defaultCursorPath } from "./linear-feed-cursor.mjs";
import {
  DEFAULT_TORN_SUSTAINED_TICKS,
  classifyLabelMapTear,
  createTearTracker,
} from "./linear-feed-torn-read.mjs";
// ⚠️ IMPORTED, never restated (CTL-1909 discipline): a hand-built copy of the
// readiness predicate could agree with this fixture while disagreeing with the gate
// the daemon actually runs.
import { countsClean, sweepUnreadyReason } from "./cloud-feed-timer.mjs";

let dir;
let cursorPath;
let storeSeq = 0;
const makeStore = () => createLastSeenStore({ path: join(dir, `s-${storeSeq++}.db`) });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lftr-"));
  cursorPath = defaultCursorPath(dir);
});
afterEach(() => {
  // ⚠️ NEVER let cleanup fail the suite. A transient macOS `rm: Directory not empty`
  // under `set -e` once aborted a whole mutation run, and an aborted suite exits
  // non-zero — byte-identical to a mutant being caught. `force` + swallow.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
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

/** Source whose label map can be mutated INDEPENDENTLY of the issue rows — which is
 *  precisely the torn state a re-seed produces (issues back, labels not yet). */
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

/** N labelled issues — comfortably over DEFAULT_TORN_VANISH_FLOOR (25). */
const corpus = (n) => {
  const rows = [];
  const labels = new Map();
  for (let i = 0; i < n; i++) {
    const id = `i${String(i).padStart(3, "0")}`;
    rows.push(issue(id));
    labels.set(id, ["refactor"]);
  }
  return { rows, labels };
};

describe("classifyLabelMapTear — the pure decision", () => {
  test("nothing vanished ⇒ never torn, whatever the corpus", () => {
    const r = classifyLabelMapTear({ vanished: 0, baselinedWithLabels: 5000 });
    expect(r).toEqual({ torn: false, accept: true, reason: null, nextConsecutive: 0 });
  });

  test("⛔ under the ABSOLUTE FLOOR is never torn — a 3-issue tenant clearing 2 is not a re-seed", () => {
    // 2/3 is 67% — way over the ratio — but 2 < floor(25).
    const r = classifyLabelMapTear({ vanished: 2, baselinedWithLabels: 3 });
    expect(r.torn).toBe(false);
    expect(r.accept).toBe(true);
  });

  test("⛔ over the floor but under the RATIO is not torn — a big bulk edit is real work", () => {
    // 100 vanished of 1000 baselined = 10%: over floor, well under 50%.
    const r = classifyLabelMapTear({ vanished: 100, baselinedWithLabels: 1000 });
    expect(r.torn).toBe(false);
    expect(r.accept).toBe(true);
  });

  test("⭐ over BOTH ⇒ torn, and held (not accepted) on the first tick", () => {
    const r = classifyLabelMapTear({ vanished: 2843, baselinedWithLabels: 2843, consecutiveTorn: 0 });
    expect(r.torn).toBe(true);
    expect(r.accept).toBe(false);
    expect(r.nextConsecutive).toBe(1);
    expect(r.reason).toContain("replica-torn-read");
  });

  test("⭐⭐ a SUSTAINED tear is OVERRULED — the guard can never wedge the feed forever", () => {
    // The failure mode that matters: deleting a workspace label really does remove
    // labels from the whole corpus, and it does NOT resolve on its own. A guard with
    // no overrule would refuse it every tick, permanently.
    let consecutive = 0;
    const seen = [];
    for (let tick = 1; tick <= DEFAULT_TORN_SUSTAINED_TICKS + 1; tick++) {
      const r = classifyLabelMapTear({ vanished: 900, baselinedWithLabels: 1000, consecutiveTorn: consecutive });
      consecutive = r.nextConsecutive;
      seen.push(r.accept);
    }
    // Held for exactly sustainedTicks, then accepted.
    expect(seen.slice(0, DEFAULT_TORN_SUSTAINED_TICKS)).toEqual(
      Array(DEFAULT_TORN_SUSTAINED_TICKS).fill(false),
    );
    expect(seen[DEFAULT_TORN_SUSTAINED_TICKS]).toBe(true);
  });

  test("a tear that RESOLVES resets the counter — a later tear gets a full fresh hold", () => {
    const t1 = classifyLabelMapTear({ vanished: 900, baselinedWithLabels: 1000, consecutiveTorn: 0 });
    expect(t1.nextConsecutive).toBe(1);
    const clear = classifyLabelMapTear({ vanished: 0, baselinedWithLabels: 1000, consecutiveTorn: t1.nextConsecutive });
    expect(clear.nextConsecutive).toBe(0);
    const t2 = classifyLabelMapTear({ vanished: 900, baselinedWithLabels: 1000, consecutiveTorn: clear.nextConsecutive });
    expect(t2.accept).toBe(false); // full hold again, not one tick from overrule
  });

  test("⛔ malformed input FAILS OPEN, and says so — silence would be worse than the burst", () => {
    for (const bad of [null, undefined, -1, 1.5, "12", NaN]) {
      const r = classifyLabelMapTear({ vanished: bad, baselinedWithLabels: 100 });
      expect(r.accept).toBe(true); // emits rather than silencing dispatch
      expect(r.reason).toBe("torn-check-uncomputable"); // but never reads as clean
    }
  });
});

describe("createTearTracker", () => {
  test("tenants cannot borrow each other's suspicion", () => {
    const t = createTearTracker();
    t.set("tenant-a", 2);
    expect(t.get("tenant-a")).toBe(2);
    expect(t.get("tenant-b")).toBe(0);
  });
  test("resetting to 0 releases the key rather than retaining a zero", () => {
    const t = createTearTracker();
    t.set("a", 3);
    t.set("a", 0);
    expect(t.size()).toBe(0);
  });
});

describe("runDiffSweep — the incident, end to end", () => {
  test("⭐⭐ THE INCIDENT: a mid-re-seed tick emits NOTHING and leaves the baseline intact", () => {
    const { rows, labels } = corpus(60);
    const emitted = [];
    const emit = (e) => emitted.push(e);
    const store = makeStore();
    const src = raceSource(rows, labels);
    const tornTracker = createTearTracker();
    const opts = { source: src, store, cursorPath, teams: TEAMS, emit, tornTracker };

    runDiffSweep(opts); // seed baseline (silent, by the first-seed precedent)
    runDiffSweep(opts); // steady state
    expect(emitted).toEqual([]);

    // THE RE-SEED: `issue_labels` is truncated; `issues` is already restored.
    labels.clear();
    const torn = runDiffSweep(opts);

    expect(emitted).toEqual([]); // ⭐ the 200 that used to fire
    expect(torn.labels.tornVanished).toBe(60);
    // The baseline still holds pre-tear truth — this is what prevents the SECOND wave.
    expect(store.get("i000").labels).toEqual(["refactor"]);
  });

  test("⭐⭐ NO SECOND WAVE: when the replica comes back, only the GENUINE change emits", () => {
    // The measured burst was 200 + 200: the first wave emitted, and writing the empty
    // label set into the baseline manufactured the second. This is the regression test
    // for that second half.
    const { rows, labels } = corpus(60);
    const restore = new Map([...labels]);
    const emitted = [];
    const emit = (e) => emitted.push(e?.body?.payload?.updatedFromKeys ?? []);
    const store = makeStore();
    const src = raceSource(rows, labels);
    const tornTracker = createTearTracker();
    const opts = { source: src, store, cursorPath, teams: TEAMS, emit, tornTracker };

    runDiffSweep(opts);
    runDiffSweep(opts);
    labels.clear();
    runDiffSweep(opts); // torn — held
    expect(emitted).toEqual([]);

    // Replica restored, and ONE issue genuinely changed while it was down.
    for (const [k, v] of restore) labels.set(k, v);
    labels.set("i007", ["refactor", "urgent"]);
    runDiffSweep(opts);

    expect(emitted).toHaveLength(1); // ⭐ 1, not 60
    expect(emitted[0]).toContain("labels");
  });

  test("⭐ a SUSTAINED mass removal is eventually emitted — bounded delay, not lost work", () => {
    const { rows, labels } = corpus(60);
    const emitted = [];
    const store = makeStore();
    const src = raceSource(rows, labels);
    const tornTracker = createTearTracker();
    const opts = {
      source: src, store, cursorPath, teams: TEAMS,
      emit: (e) => emitted.push(e), tornTracker,
      labelBudget: 1000,
    };

    runDiffSweep(opts);
    runDiffSweep(opts);
    labels.clear(); // a REAL workspace-label deletion: never resolves on its own
    for (let i = 0; i < DEFAULT_TORN_SUSTAINED_TICKS; i++) {
      runDiffSweep(opts);
      expect(emitted).toEqual([]); // held...
    }
    const overruled = runDiffSweep(opts); // ...then overruled
    expect(emitted.length).toBe(60);
    expect(overruled.labels.tornOverruled).toBe(60);
  });

  test("⛔ NEGATIVE CONTROL: the guard does NOT break the branch it guards", () => {
    // Removing the last label from ONE issue is exactly what branch (b) exists for.
    // A guard that suppressed it would have silently deleted the CTL-1904 fix.
    const { rows, labels } = corpus(60);
    const emitted = [];
    const store = makeStore();
    const src = raceSource(rows, labels);
    const opts = {
      source: src, store, cursorPath, teams: TEAMS,
      emit: (e) => emitted.push(e?.body?.payload?.updatedFromKeys ?? []),
      tornTracker: createTearTracker(),
    };

    runDiffSweep(opts);
    runDiffSweep(opts);
    expect(emitted).toEqual([]);

    labels.set("i003", []); // one issue loses its last label
    runDiffSweep(opts);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain("labels");
  });

  test("⛔ readiness UN-ARMS on a torn tick, judged by the REAL predicate", () => {
    const { rows, labels } = corpus(60);
    const store = makeStore();
    const src = raceSource(rows, labels);
    const opts = { source: src, store, cursorPath, teams: TEAMS, emit: () => {}, tornTracker: createTearTracker() };

    runDiffSweep(opts);
    const healthy = runDiffSweep(opts);
    expect(countsClean(healthy.labels)).toBe(true); // positive control

    labels.clear();
    const torn = runDiffSweep(opts);

    expect(countsClean(torn.labels)).toBe(false);
    const reason = sweepUnreadyReason(
      { sweep: torn },
      { healthy: true, reason: "ok" },
    );
    expect(reason).toContain("labels:");
    expect(reason).toContain("replica-torn-read");
  });
});
