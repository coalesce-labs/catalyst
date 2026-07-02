// board-health.test.mjs — CTL-1290. Validates the board-health delegate module.
//
// Run: cd plugins/dev/scripts/execution-core && bun test board-health.test.mjs
//
// The module is split pure-core / injected-IO precisely so the invariants and
// the cheap-gate funnel are unit-testable WITHOUT a daemon, a DB, or wall-clock.
// These tests hand-build boardState snapshots (pure) and stub every IO dep
// (impure) — the load-bearing safety property (shadow takes zero mutating
// action) is asserted by passing `act: () => { throw }` and proving no throw.

import { describe, test, expect } from "bun:test";
import {
  assembleBoardState,
  evaluateInvariants,
  decideBoardHealth,
  proposeMoves,
  selectAnchor,
  buildBoardContext,
  buildBoardScanEvent,
  boardHealthPass,
} from "./board-health.mjs";

const NOW = Date.parse("2026-06-20T12:00:00Z");
const MIN = 60_000;
const HOUR = 3_600_000;

// mkPrStatusMap — build the composite `Map<number, Map<repoKey, entry>>` shape
// (CTL-1157, Codex #4) that broker-state.getAllPrStatuses now returns, from flat
// {prNumber, repo, status, updatedAt} rows. Mirrors how the real reader nests
// per-(repo, number); multiple rows with the same number but different repos form
// the collision case.
function mkPrStatusMap(rows = []) {
  const map = new Map();
  for (const { prNumber, repo = null, status, updatedAt } of rows) {
    const key = repo ?? "";
    let byRepo = map.get(prNumber);
    if (!byRepo) {
      byRepo = new Map();
      map.set(prNumber, byRepo);
    }
    byRepo.set(key, { status, updatedAt, repo });
  }
  return map;
}

// A complete, default-healthy boardState shape (the frozen output assembleBoardState
// produces). Overrides are shallow-merged per top-level key.
function mkBoard(o = {}) {
  return {
    ticketsById: o.ticketsById ?? new Map(),
    signals: o.signals ?? [],
    eligible: o.eligible ?? [],
    roster: o.roster ?? [],
    self: o.self ?? "mini",
    multiHost: o.multiHost ?? false,
    // CTL-1157: assembleBoardState now records the run mode on the board so
    // evaluateInvariants can default-gate the cohort checks (off → dark).
    mode: o.mode,
    capacity: { maxParallel: 4, liveCount: 0, freeSlots: 4, ...(o.capacity ?? {}) },
    reconcileMarkers: o.reconcileMarkers ?? {},
    // CTL-1157 (Codex #4): the filter_state PR-lifecycle map — composite
    // `Map<number, Map<repoKey, {status,updatedAt,repo}>>`. Default empty Map ⇒ the
    // phantom/orphaned-PR cohorts stay observable:false, exactly like an unwired
    // board. `mkPrStatusMap` below builds the nested shape from flat rows.
    prStatusMap: o.prStatusMap ?? new Map(),
    ring: {
      recentDispatchTs: null,
      cacheReconcile: null,
      accountRatelimit: null,
      reconcileFailing: new Set(),
      ...(o.ring ?? {}),
    },
    ownerForTicket: o.ownerForTicket ?? null,
    // CTL-1157 (Codex #4): ticket→owner/repo resolver for the composite lookup.
    repoForTicket: o.repoForTicket ?? null,
    now: o.now ?? NOW,
  };
}

// ─── evaluateInvariants — one green + one failing per invariant ──────────────
describe("evaluateInvariants — per-invariant green/fail", () => {
  test("cacheCoherence: reconcile changed>0 → fail; changed=0 → ok; unseen → not observable", () => {
    const failed = evaluateInvariants(mkBoard({ ring: { cacheReconcile: { changed: 3 } } }));
    expect(failed.cacheCoherence.ok).toBe(false);
    expect(failed.cacheCoherence.failed).toBe(1);
    expect(failed.cacheCoherence.observable).toBe(true);

    const green = evaluateInvariants(mkBoard({ ring: { cacheReconcile: { changed: 0 } } }));
    expect(green.cacheCoherence.ok).toBe(true);
    expect(green.cacheCoherence.failed).toBe(0);

    const unseen = evaluateInvariants(mkBoard({ ring: { cacheReconcile: null } }));
    expect(unseen.cacheCoherence.observable).toBe(false);
  });

  test("dispatchLiveness: free slots + queue + stale dispatch → wedge; live dispatch → ok", () => {
    const wedged = evaluateInvariants(
      mkBoard({
        capacity: { maxParallel: 4, liveCount: 0, freeSlots: 4 },
        eligible: [{ id: "CTL-1" }, { id: "CTL-2" }],
        ring: { recentDispatchTs: NOW - 30 * MIN }, // > 10min default stall
      }),
    );
    expect(wedged.dispatchLiveness.ok).toBe(false);
    expect(wedged.dispatchLiveness.failed).toBe(1);
    expect(wedged.dispatchLiveness.flagged).toContain("CTL-1");

    const live = evaluateInvariants(
      mkBoard({
        eligible: [{ id: "CTL-1" }],
        capacity: { maxParallel: 4, liveCount: 0, freeSlots: 4 },
        ring: { recentDispatchTs: NOW - 1 * MIN }, // recent
      }),
    );
    expect(live.dispatchLiveness.ok).toBe(true);
  });

  test("dispatchLiveness: no free slots OR empty queue → no wedge (ok)", () => {
    const noSlots = evaluateInvariants(
      mkBoard({ capacity: { freeSlots: 0 }, eligible: [{ id: "CTL-1" }], ring: { recentDispatchTs: null } }),
    );
    expect(noSlots.dispatchLiveness.ok).toBe(true);
    const noQueue = evaluateInvariants(
      mkBoard({ capacity: { freeSlots: 4 }, eligible: [], ring: { recentDispatchTs: null } }),
    );
    expect(noQueue.dispatchLiveness.ok).toBe(true);
  });

  test("workerAge: non-terminal worker past phase-normal age flags; within-age + terminal do not", () => {
    const r = evaluateInvariants(
      mkBoard({
        signals: [
          { ticket: "CTL-OLD", phase: "implement", status: "running", ageMs: 5 * HOUR }, // > 4h impl normal
          { ticket: "CTL-YOUNG", phase: "implement", status: "running", ageMs: 1 * HOUR },
          { ticket: "CTL-DONE", phase: "implement", status: "complete", ageMs: 99 * HOUR }, // terminal → skip
        ],
      }),
    );
    expect(r.workerAge.ok).toBe(false);
    expect(r.workerAge.failed).toBe(1);
    expect(r.workerAge.flagged).toEqual(["CTL-OLD"]);
  });

  test("workerAge: research phase has a tighter (1h) normal than the 4h default", () => {
    const r = evaluateInvariants(
      mkBoard({ signals: [{ ticket: "CTL-R", phase: "research", status: "running", ageMs: 2 * HOUR }] }),
    );
    expect(r.workerAge.flagged).toEqual(["CTL-R"]);
  });

  test("blockedTree: blocked by an unscheduled non-done blocker → flag; done/scheduled blocker → ok", () => {
    const ticketsById = new Map([
      ["CTL-A", { identifier: "CTL-A", relations: [{ type: "blocked_by", identifier: "CTL-B" }] }],
      ["CTL-B", { identifier: "CTL-B", state: "In Progress" }],
    ]);
    const flagged = evaluateInvariants(mkBoard({ ticketsById }));
    expect(flagged.blockedTree.ok).toBe(false);
    expect(flagged.blockedTree.flagged).toEqual(["CTL-A"]);

    const doneById = new Map([
      ["CTL-A", { identifier: "CTL-A", relations: [{ type: "blocked_by", identifier: "CTL-B" }] }],
      ["CTL-B", { identifier: "CTL-B", state: "Done" }],
    ]);
    expect(evaluateInvariants(mkBoard({ ticketsById: doneById })).blockedTree.ok).toBe(true);

    // blocker present in the eligible queue → scheduled → not a dead chain
    const scheduled = evaluateInvariants(
      mkBoard({ ticketsById, eligible: [{ id: "CTL-B" }] }),
    );
    expect(scheduled.blockedTree.ok).toBe(true);
  });

  test("projectSilence: project quiet past threshold flags; recent movement ok; no join → not observable", () => {
    const silent = evaluateInvariants(
      mkBoard({ eligible: [{ id: "CTL-A", project: "P1", updatedAt: new Date(NOW - 25 * HOUR).toISOString() }] }),
    );
    expect(silent.projectSilence.ok).toBe(false);
    expect(silent.projectSilence.flagged).toEqual(["P1"]);

    const moving = evaluateInvariants(
      mkBoard({ eligible: [{ id: "CTL-A", project: "P1", updatedAt: new Date(NOW - 1 * HOUR).toISOString() }] }),
    );
    expect(moving.projectSilence.ok).toBe(true);

    const noJoin = evaluateInvariants(mkBoard({ eligible: [{ id: "CTL-A" }] }));
    expect(noJoin.projectSilence.observable).toBe(false);
  });

  test("rateLimitHeadroom: near-cliff flags (observable); absent signal → not observable", () => {
    const near = evaluateInvariants(mkBoard({ ring: { accountRatelimit: { nearCliff: true } } }));
    expect(near.rateLimitHeadroom.ok).toBe(false);
    expect(near.rateLimitHeadroom.failed).toBe(1);
    expect(near.rateLimitHeadroom.observable).toBe(true);

    const absent = evaluateInvariants(mkBoard({ ring: { accountRatelimit: null } }));
    expect(absent.rateLimitHeadroom.observable).toBe(false);
  });

  test("strandedNode: rostered host owns work + reconcile failing → flag (observable)", () => {
    const ticketsById = new Map([["CTL-A", { identifier: "CTL-A" }]]);
    const ownerForTicket = () => "mini-2";
    const r = evaluateInvariants(
      mkBoard({
        ticketsById,
        roster: ["mini", "mini-2"],
        ownerForTicket,
        reconcileMarkers: { "mini-2": { consecutiveFailures: 3 } },
      }),
    );
    expect(r.strandedNode.ok).toBe(false);
    expect(r.strandedNode.observable).toBe(true);
    expect(r.strandedNode.flagged).toEqual(["mini-2"]);
  });

  test("strandedNode: no HRW owner fn OR no reconcile signal → not observable", () => {
    const noHrw = evaluateInvariants(mkBoard({ roster: ["mini", "mini-2"], ownerForTicket: null }));
    expect(noHrw.strandedNode.observable).toBe(false);

    const ticketsById = new Map([["CTL-A", { identifier: "CTL-A" }]]);
    const noSignal = evaluateInvariants(
      mkBoard({ ticketsById, roster: ["mini", "mini-2"], ownerForTicket: () => "mini-2", reconcileMarkers: {} }),
    );
    expect(noSignal.strandedNode.observable).toBe(false);
  });

  test("a throwing invariant fails OPEN ({ok:true,error}) and never aborts the scan", () => {
    // ticketsById that throws when iterated (blockedTree walks it).
    const boom = {
      get size() { return 1; },
      [Symbol.iterator]() { throw new Error("boom"); },
    };
    const r = evaluateInvariants(mkBoard({ ticketsById: boom }));
    expect(r.blockedTree.ok).toBe(true);
    expect(r.blockedTree.error).toBeDefined();
    // the rest of the scan still completed
    expect(r.dispatchLiveness).toBeDefined();
    expect(r.workerAge).toBeDefined();
  });
});

// ─── CTL-1157 off-gate: off = truly dark (no cohort code, no PR SELECT) ──────
describe("CTL-1157 off-gate — cohort invariants + PR SELECT are dark in off", () => {
  const COHORT_KEYS = ["phantomMergedPr", "orphanedOpenPr", "frozenNeedsHuman", "needsHumanPile"];

  test("evaluateInvariants(mode:off) omits ALL four cohort invariants (legacy set only)", () => {
    const r = evaluateInvariants(mkBoard(), { mode: "off" });
    for (const k of COHORT_KEYS) expect(r[k]).toBeUndefined();
    // the legacy invariants still all ran → byte-identical key set to origin/main.
    expect(Object.keys(r).sort()).toEqual(
      [
        "blockedTree",
        "cacheCoherence",
        "dispatchLiveness",
        "projectSilence",
        "rateLimitHeadroom",
        "strandedNode",
        "workerAge",
      ].sort(),
    );
  });

  test("evaluateInvariants(mode:shadow) RUNS all four cohort invariants (telemetry)", () => {
    const r = evaluateInvariants(mkBoard(), { mode: "shadow" });
    for (const k of COHORT_KEYS) expect(r[k]).toBeDefined();
    // needsHumanPile is the status-based catch-all → observable in shadow (it judges
    // the signal-status set, always present), exactly like its siblings when wired.
    expect(r.needsHumanPile.observable).toBe(true);
  });

  test("evaluateInvariants picks up board.mode (off) when no explicit mode passed", () => {
    const r = evaluateInvariants(mkBoard({ mode: "off" }));
    for (const k of COHORT_KEYS) expect(r[k]).toBeUndefined();
  });

  test("assembleBoardState(mode:off) NEVER invokes getPrStatusMap (no getAllPrStatuses SELECT)", () => {
    let called = 0;
    const board = assembleBoardState({
      orchDir: "/tmp/x",
      getBoard: () => [],
      getWorkerSignals: () => [],
      getEligible: () => [],
      getPrStatusMap: () => {
        called += 1;
        return new Map([[1, { status: "merged" }]]);
      },
      mode: "off",
      now: () => NOW,
    });
    expect(called).toBe(0); // the filter_state SELECT did not run
    expect(board.prStatusMap.size).toBe(0); // empty Map → invariants would be inert anyway
  });

  test("assembleBoardState(mode:shadow) DOES invoke getPrStatusMap (telemetry needs it)", () => {
    let called = 0;
    assembleBoardState({
      orchDir: "/tmp/x",
      getBoard: () => [],
      getWorkerSignals: () => [],
      getEligible: () => [],
      getPrStatusMap: () => {
        called += 1;
        return new Map();
      },
      mode: "shadow",
      now: () => NOW,
    });
    expect(called).toBe(1);
  });
});

// ─── CTL-1157 (Codex #4): multi-repo PR-number collision — composite keying ──
// A (repo, pr_number) pair — not pr_number alone — identifies a PR. getAllPrStatuses
// now returns a composite Map<number, Map<repo, status>>; board-health resolves the
// stuck ticket's repo (repoForTicket) and looks up the EXACT (repo, number). A
// cross-repo #-collision is disambiguated by the ticket's repo — it NO LONGER hides
// a genuine orphaned open PR. Only a collision whose repo is genuinely underivable
// stays the ambiguous skip (the documented true residual).
describe("CTL-1157 multi-repo collision — composite (repo,number) disambiguation", () => {
  // #42 collides: MERGED in org/x, OPEN in org/y — two different PRs.
  const COLLIDE_42 = () =>
    mkPrStatusMap([
      { prNumber: 42, repo: "org/x", status: "merged" },
      { prNumber: 42, repo: "org/y", status: "open" },
    ]);

  test("phantom-merged: a ticket in org/x (the MERGED repo) IS flagged despite the collision", () => {
    const ticketsById = new Map([["CTL-Y", { identifier: "CTL-Y", state: "In Review", prNumber: 42 }]]);
    const r = evaluateInvariants(
      mkBoard({ ticketsById, prStatusMap: COLLIDE_42(), repoForTicket: () => "org/x" }),
      { mode: "shadow" },
    );
    expect(r.phantomMergedPr.flagged).toContain("CTL-Y"); // genuine phantom still caught
  });

  test("phantom-merged: a ticket in org/y (the OPEN repo) is NOT flagged — no false phantom from org/x's merged", () => {
    const ticketsById = new Map([["CTL-Y", { identifier: "CTL-Y", state: "In Review", prNumber: 42 }]]);
    const r = evaluateInvariants(
      mkBoard({ ticketsById, prStatusMap: COLLIDE_42(), repoForTicket: () => "org/y" }),
      { mode: "shadow" },
    );
    expect(r.phantomMergedPr.flagged).not.toContain("CTL-Y"); // org/y's #42 is open, not merged
    expect(r.phantomMergedPr.ok).toBe(true);
  });

  test("phantom-merged: collision + repo UNDERIVABLE (no repoForTicket) → ambiguous skip (true residual)", () => {
    const ticketsById = new Map([["CTL-Y", { identifier: "CTL-Y", state: "In Review", prNumber: 42 }]]);
    const r = evaluateInvariants(
      mkBoard({ ticketsById, prStatusMap: COLLIDE_42() /* repoForTicket: null */ }),
      { mode: "shadow" },
    );
    expect(r.phantomMergedPr.flagged).not.toContain("CTL-Y"); // can't pick → skip, never borrow
  });

  // THE HEADLINE FIX (Codex #4 missed-detection): a genuine orphaned open PR in the
  // ticket's OWN repo must be flagged even when an UNRELATED repo reuses the number.
  test("orphaned-open: a stale open PR in org/y IS flagged even though org/x reuses #99 (no longer hidden)", () => {
    const ticketsById = new Map([["CTL-Z", { identifier: "CTL-Z", prNumber: 99 }]]);
    const prStatusMap = mkPrStatusMap([
      // org/x's #99 is merged & fresh — the unrelated collision that used to hide CTL-Z.
      { prNumber: 99, repo: "org/x", status: "merged", updatedAt: new Date(NOW - 1 * HOUR).toISOString() },
      // org/y's #99 — CTL-Z's real PR: open, stale, no live worker → orphaned.
      { prNumber: 99, repo: "org/y", status: "open", updatedAt: new Date(NOW - 100 * HOUR).toISOString() },
    ]);
    const r = evaluateInvariants(
      mkBoard({ ticketsById, prStatusMap, repoForTicket: () => "org/y" }),
      { mode: "shadow" },
    );
    expect(r.orphanedOpenPr.flagged).toContain("CTL-Z"); // detection no longer hidden
  });

  test("orphaned-open: collision + repo UNDERIVABLE → ambiguous skip (true residual)", () => {
    const ticketsById = new Map([["CTL-Z", { identifier: "CTL-Z", prNumber: 99 }]]);
    const prStatusMap = mkPrStatusMap([
      { prNumber: 99, repo: "org/x", status: "merged", updatedAt: new Date(NOW - 1 * HOUR).toISOString() },
      { prNumber: 99, repo: "org/y", status: "open", updatedAt: new Date(NOW - 100 * HOUR).toISOString() },
    ]);
    const r = evaluateInvariants(
      mkBoard({ ticketsById, prStatusMap /* repoForTicket: null */ }),
      { mode: "shadow" },
    );
    expect(r.orphanedOpenPr.flagged).not.toContain("CTL-Z"); // can't pick → skip
  });

  // N=1 / single-repo: NO collision (one inner entry per number) → number-only
  // resolution, byte-identical whether or not the ticket's repo was derived.
  test("single-repo (N=1): phantom-merged still flags with NO repoForTicket bound", () => {
    const ticketsById = new Map([["CTL-Y", { identifier: "CTL-Y", state: "In Review", prNumber: 42 }]]);
    const r = evaluateInvariants(
      mkBoard({ ticketsById, prStatusMap: mkPrStatusMap([{ prNumber: 42, repo: "org/solo", status: "merged" }]) }),
      { mode: "shadow" },
    );
    expect(r.phantomMergedPr.flagged).toContain("CTL-Y");
  });

  test("single-repo (N=1): orphaned-open still flags with NO repoForTicket bound", () => {
    const ticketsById = new Map([["CTL-Z", { identifier: "CTL-Z", prNumber: 99 }]]);
    const prStatusMap = mkPrStatusMap([
      { prNumber: 99, repo: "org/solo", status: "open", updatedAt: new Date(NOW - 100 * HOUR).toISOString() },
    ]);
    const r = evaluateInvariants(mkBoard({ ticketsById, prStatusMap }), { mode: "shadow" });
    expect(r.orphanedOpenPr.flagged).toContain("CTL-Z");
  });

  // THE ROUND-4 FIX (Codex #4 borrow-across-repos): the ticket repo is KNOWN and the
  // ONLY row for #42 belongs to a DIFFERENT repo. The pre-fix `byRepo.size===1` fast
  // path returned that unrelated row, so a ticket in org/y inherited org/x#42's MERGED
  // status → a FALSE phantom. Now a known repo requires the exact row → never borrow.
  test("phantom-merged: known repo org/y is NOT flagged when the ONLY #42 row is org/x (no cross-repo borrow)", () => {
    const ticketsById = new Map([["CTL-Y", { identifier: "CTL-Y", state: "In Review", prNumber: 42 }]]);
    const prStatusMap = mkPrStatusMap([{ prNumber: 42, repo: "org/x", status: "merged" }]);
    const r = evaluateInvariants(
      mkBoard({ ticketsById, prStatusMap, repoForTicket: () => "org/y" }),
      { mode: "shadow" },
    );
    expect(r.phantomMergedPr.flagged).not.toContain("CTL-Y"); // org/x#42's status is not CTL-Y's
    expect(r.phantomMergedPr.ok).toBe(true);
  });

  // Single-repo preservation: a KNOWN repo with a LONE UNATTRIBUTED ("") lifecycle row
  // (written before repo attribution) is still trusted — detection must not regress on
  // the single-repo fleet whose filter_state rows carry no repo.
  test("phantom-merged: known repo still flags off a lone UNATTRIBUTED row (single-repo preservation)", () => {
    const ticketsById = new Map([["CTL-Y", { identifier: "CTL-Y", state: "In Review", prNumber: 42 }]]);
    const prStatusMap = mkPrStatusMap([{ prNumber: 42, repo: null, status: "merged" }]); // repoKey ""
    const r = evaluateInvariants(
      mkBoard({ ticketsById, prStatusMap, repoForTicket: () => "org/y" }),
      { mode: "shadow" },
    );
    expect(r.phantomMergedPr.flagged).toContain("CTL-Y");
  });
});

// ─── CTL-1157 (Group 2, Codex) — cohort liveness/terminal correctness ────────
// (1) orphaned-open PR: a failed/stalled worker FREES the slot → NOT live, so a
//     PR stuck behind it IS the orphaned case (must not read as "has a worker").
// (2) frozen-needs-human: a terminal (Done/Canceled/Duplicate) ticket carrying a
//     stale cached needs-human label must NOT be flagged for recovery.
describe("CTL-1157 cohort correctness — dead-worker orphans + terminal stale-label", () => {
  const staleOpen = { prNumber: 7, repo: "org/solo", status: "open", updatedAt: new Date(NOW - 100 * HOUR).toISOString() };

  test("orphaned-open: a stale open PR whose ONLY worker signal is FAILED IS flagged", () => {
    const ticketsById = new Map([["CTL-DEAD", { identifier: "CTL-DEAD", prNumber: 7 }]]);
    const r = evaluateInvariants(
      mkBoard({
        ticketsById,
        prStatusMap: mkPrStatusMap([staleOpen]),
        signals: [{ ticket: "CTL-DEAD", phase: "implement", status: "failed" }],
      }),
      { mode: "shadow" },
    );
    expect(r.orphanedOpenPr.flagged).toContain("CTL-DEAD"); // failed worker ≠ live
  });

  test("orphaned-open: a stale open PR whose ONLY worker signal is STALLED IS flagged", () => {
    const ticketsById = new Map([["CTL-STALL", { identifier: "CTL-STALL", prNumber: 7 }]]);
    const r = evaluateInvariants(
      mkBoard({
        ticketsById,
        prStatusMap: mkPrStatusMap([staleOpen]),
        signals: [{ ticket: "CTL-STALL", phase: "implement", status: "stalled" }],
      }),
      { mode: "shadow" },
    );
    expect(r.orphanedOpenPr.flagged).toContain("CTL-STALL");
  });

  // CTL-1157 (Codex round-6): a TERMINAL ticket (Done/Canceled/Duplicate) whose PR was
  // never merged/closed still carries an "open" filter_state row, but must NOT be flagged
  // as an orphaned-PR anchor — dispatching a recovery-pass on already-finished work wastes
  // a slot. Mirrors the terminal exclusion the needs-human cohorts already apply.
  test("orphaned-open: a TERMINAL (Canceled) ticket with a stale open PR is NOT flagged", () => {
    const ticketsById = new Map([["CTL-TERM", { identifier: "CTL-TERM", prNumber: 7, state: "Canceled" }]]);
    const r = evaluateInvariants(
      mkBoard({
        ticketsById,
        prStatusMap: mkPrStatusMap([staleOpen]),
        signals: [{ ticket: "CTL-TERM", phase: "implement", status: "failed" }],
      }),
      { mode: "shadow" },
    );
    expect(r.orphanedOpenPr.flagged).not.toContain("CTL-TERM"); // terminal → not a recovery anchor
    expect(r.orphanedOpenPr.ok).toBe(true);
  });

  test("orphaned-open: a Done ticket with a stale open PR is NOT flagged", () => {
    const ticketsById = new Map([["CTL-DONE", { identifier: "CTL-DONE", prNumber: 7, state: "Done" }]]);
    const r = evaluateInvariants(
      mkBoard({ ticketsById, prStatusMap: mkPrStatusMap([staleOpen]), signals: [] }),
      { mode: "shadow" },
    );
    expect(r.orphanedOpenPr.flagged).not.toContain("CTL-DONE");
  });

  test("orphaned-open: a LIVE (running) worker still masks the PR as not-orphaned", () => {
    const ticketsById = new Map([["CTL-LIVE", { identifier: "CTL-LIVE", prNumber: 7 }]]);
    const r = evaluateInvariants(
      mkBoard({
        ticketsById,
        prStatusMap: mkPrStatusMap([staleOpen]),
        signals: [{ ticket: "CTL-LIVE", phase: "implement", status: "running" }],
      }),
      { mode: "shadow" },
    );
    expect(r.orphanedOpenPr.flagged).not.toContain("CTL-LIVE"); // running worker → live
  });

  test("frozen-needs-human: a TERMINAL ticket with a stale needs-human label is NOT flagged", () => {
    const old = new Date(NOW - 100 * HOUR).toISOString();
    const ticketsById = new Map([
      ["CTL-DONE", { identifier: "CTL-DONE", state: "Done", labels: [{ name: "needs-human" }], updatedAt: old }],
      ["CTL-CANCEL", { identifier: "CTL-CANCEL", state: "Canceled", labels: [{ name: "needs-human" }], updatedAt: old }],
      ["CTL-DUP", { identifier: "CTL-DUP", state: "Duplicate", labels: [{ name: "needs-human" }], updatedAt: old }],
    ]);
    const r = evaluateInvariants(mkBoard({ ticketsById }), { mode: "shadow" });
    expect(r.frozenNeedsHuman.flagged).not.toContain("CTL-DONE");
    expect(r.frozenNeedsHuman.flagged).not.toContain("CTL-CANCEL");
    expect(r.frozenNeedsHuman.flagged).not.toContain("CTL-DUP");
    expect(r.frozenNeedsHuman.observable).toBe(true); // labels present → still observable
  });

  test("frozen-needs-human: a NON-terminal ticket with a stale needs-human label IS still flagged", () => {
    const ticketsById = new Map([
      ["CTL-STUCK", {
        identifier: "CTL-STUCK",
        state: "In Progress",
        labels: [{ name: "needs-human" }],
        updatedAt: new Date(NOW - 100 * HOUR).toISOString(),
      }],
    ]);
    const r = evaluateInvariants(mkBoard({ ticketsById }), { mode: "shadow" });
    expect(r.frozenNeedsHuman.flagged).toContain("CTL-STUCK"); // real frozen escalation preserved
  });
});

// ─── decideBoardHealth — the cheap-gate funnel (§6) ─────────────────────────
function inv(ok, failed = 0, observable = true, flagged = []) {
  return { ok, failed, observable, flagged, note: "" };
}
function allGreen() {
  return {
    cacheCoherence: inv(true),
    dispatchLiveness: inv(true),
    workerAge: inv(true),
    blockedTree: inv(true),
    projectSilence: inv(true),
    rateLimitHeadroom: inv(true),
    strandedNode: inv(true),
  };
}

describe("decideBoardHealth — ordered gates, first match wins", () => {
  test("Gate 1: all observable green → skip/all-green, proposed all 0", () => {
    const d = decideBoardHealth(allGreen(), mkBoard({ capacity: { freeSlots: 4 } }));
    expect(d.gate.decision).toBe("skip");
    expect(d.gate.reason).toBe("all-green");
    expect(d.proposed).toEqual({ tier1: 0, tier2: 0, tier3: 0 });
    expect(d.invariantsFailed).toBe(0);
  });

  test("Gate 2: failures but freeSlots===0 → skip/no-free-slots", () => {
    const invs = { ...allGreen(), dispatchLiveness: inv(false, 1) };
    const d = decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 0 } }));
    expect(d.gate.decision).toBe("skip");
    expect(d.gate.reason).toBe("no-free-slots");
  });

  test("Gate 3: failures + free slots + rate-limit cliff → skip/rate-limit-cliff", () => {
    const invs = { ...allGreen(), dispatchLiveness: inv(false, 1), rateLimitHeadroom: inv(false, 1) };
    const d = decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 4 } }));
    expect(d.gate.decision).toBe("skip");
    expect(d.gate.reason).toBe("rate-limit-cliff");
  });

  test("Gate 4: real observable failures + headroom → proceed + tiered proposals", () => {
    const invs = { ...allGreen(), dispatchLiveness: inv(false, 1) };
    const d = decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 4 } }));
    expect(d.gate.decision).toBe("proceed");
    expect(d.gate.reason).toMatch(/invariant\(s\) flagged/);
    expect(d.invariantsFailed).toBe(1);
    expect(d.proposed.tier1).toBe(1); // dispatch wedge → kick-dispatch
  });

  test("every return carries a non-empty gate.reason", () => {
    for (const board of [mkBoard({ capacity: { freeSlots: 4 } }), mkBoard({ capacity: { freeSlots: 0 } })]) {
      const d = decideBoardHealth({ ...allGreen(), dispatchLiveness: inv(false, 1) }, board);
      expect(typeof d.gate.reason).toBe("string");
      expect(d.gate.reason.length).toBeGreaterThan(0);
    }
  });

  test("observable:false failure is EXCLUDED from invariantsFailed and never triggers proceed", () => {
    const invs = { ...allGreen(), rateLimitHeadroom: inv(false, 1, /*observable*/ false) };
    const d = decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 4 } }));
    expect(d.gate.decision).toBe("skip");
    expect(d.gate.reason).toBe("all-green");
    expect(d.invariantsFailed).toBe(0);
  });
});

// ─── proposeMoves — failed invariants → correct tier buckets ────────────────
describe("proposeMoves — tiering", () => {
  test("dispatch wedge → tier1 kick-dispatch; worker-age → tier1 nudge per ticket", () => {
    const invs = {
      ...allGreen(),
      dispatchLiveness: inv(false, 1),
      workerAge: inv(false, 2, true, ["CTL-1", "CTL-2"]),
    };
    const m = proposeMoves(invs, mkBoard());
    expect(m.tier1.some((x) => x.move === "kick-dispatch")).toBe(true);
    expect(m.tier1.filter((x) => x.move === "nudge").map((x) => x.ticket)).toEqual(["CTL-1", "CTL-2"]);
  });

  test("blocked-tree → tier2; stranded-node + project-silence → tier3", () => {
    const invs = {
      ...allGreen(),
      blockedTree: inv(false, 1, true, ["CTL-A"]),
      strandedNode: inv(false, 1, true, ["mini-2"]),
      projectSilence: inv(false, 1, true, ["P1"]),
    };
    const m = proposeMoves(invs, mkBoard());
    expect(m.tier2.map((x) => x.move)).toContain("re-dispatch-blocker");
    expect(m.tier3.map((x) => x.move)).toEqual(
      expect.arrayContaining(["escalate-stranded-node", "escalate-project-silence"]),
    );
  });

  test("all-green → no moves; counts in decideBoardHealth match the arrays", () => {
    const m = proposeMoves(allGreen(), mkBoard());
    expect(m).toEqual({ tier1: [], tier2: [], tier3: [] });

    const invs = { ...allGreen(), dispatchLiveness: inv(false, 1), blockedTree: inv(false, 1, true, ["CTL-A"]) };
    const d = decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 4 } }));
    expect(d.proposed.tier1).toBe(d.moves.tier1.length);
    expect(d.proposed.tier2).toBe(d.moves.tier2.length);
    expect(d.proposed.tier3).toBe(d.moves.tier3.length);
  });
});

// ─── buildBoardScanEvent — the flat event the emit envelope rides ───────────
describe("buildBoardScanEvent", () => {
  test("type/ticket/scalars at top of details; rosters as arrays; mode echoed", () => {
    const invs = { ...allGreen(), dispatchLiveness: inv(false, 1, true, ["CTL-1"]) };
    const decision = decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 4 } }));
    const ev = buildBoardScanEvent({ mode: "shadow", invariants: invs, decision });

    expect(ev.type).toBe("recovery.board-scan");
    expect(ev.ticket).toBeNull();
    expect(ev.fix_class).toBeNull();
    expect(ev.details.mode).toBe("shadow");
    expect(ev.details.invariantsFailed).toBe(1);
    expect(ev.details.gateDecision).toBe("proceed");
    expect(typeof ev.details.gateReason).toBe("string");
    expect(ev.details.proposedTier1).toBe(decision.proposed.tier1);
    // per-invariant {ok,failed,observable}
    expect(ev.details.invariants.dispatchLiveness).toEqual({ ok: false, failed: 1, observable: true });
    // rosters/move arrays live in details (→ body.payload), as arrays
    expect(Array.isArray(ev.details.flagged)).toBe(true);
    expect(ev.details.flagged).toContain("CTL-1");
    expect(Array.isArray(ev.details.tier1Moves)).toBe(true);
  });
});

// ─── buildBoardContext — the whole-board brief the delegate gets injected ────
describe("buildBoardContext", () => {
  test("stuckWorkers from flagged signals; invariants block; slots + queue", () => {
    const board = mkBoard({
      self: "mini",
      roster: ["mini"],
      capacity: { maxParallel: 4, liveCount: 2, freeSlots: 2 },
      eligible: [{ id: "CTL-1" }, { id: "CTL-2" }],
      signals: [{ ticket: "CTL-OLD", phase: "implement", status: "running", ageMs: 5 * HOUR }],
    });
    const invs = { ...allGreen(), workerAge: inv(false, 1, true, ["CTL-OLD"]) };
    const ctx = buildBoardContext(board, invs);

    expect(ctx.schema).toBe("recovery-board-context/v2");
    expect(ctx.slots).toEqual({ capacity: 4, inUse: 2, free: 2 });
    expect(ctx.eligibleQueue.depth).toBe(2);
    expect(ctx.eligibleQueue.topTickets).toEqual(["CTL-1", "CTL-2"]);
    expect(ctx.stuckWorkers).toEqual([
      { ticket: "CTL-OLD", phase: "implement", status: "running", ageSeconds: Math.round(5 * HOUR / 1000) },
    ]);
    expect(ctx.invariants.workerAge).toEqual({ ok: false, failed: 1 });
  });

  test("strandedNodes carry their HRW-owned tickets (schema {host, ownedTickets})", () => {
    const board = mkBoard({
      roster: ["mini", "mini-2"],
      ticketsById: new Map([
        ["CTL-A", { identifier: "CTL-A" }],
        ["CTL-B", { identifier: "CTL-B" }],
        ["CTL-C", { identifier: "CTL-C" }],
      ]),
      ownerForTicket: (id) => (id === "CTL-C" ? "mini" : "mini-2"),
    });
    const invs = { ...allGreen(), strandedNode: inv(false, 1, true, ["mini-2"]) };
    const ctx = buildBoardContext(board, invs);
    expect(ctx.strandedNodes).toEqual([{ host: "mini-2", ownedTickets: ["CTL-A", "CTL-B"] }]);
  });
});

// ─── assembleBoardState — the one impure reader (reads only) ─────────────────
describe("assembleBoardState", () => {
  test("normalizes descriptors/signals/eligible; reads signal.updatedAt/phase TOP-LEVEL (no evidence.signal)", () => {
    const board = assembleBoardState({
      orchDir: "/tmp/x",
      getBoard: () => [{ identifier: "CTL-A", state: "In Progress" }],
      // a raw signal with NO `evidence` field — age must still compute from top-level updatedAt
      getWorkerSignals: () => [{ ticket: "CTL-A", phase: "implement", status: "running", updatedAt: new Date(NOW - 5 * HOUR).toISOString() }],
      getEligible: () => [{ identifier: "CTL-B", project: "P1" }],
      roster: ["mini"],
      self: "mini",
      multiHost: false,
      capacity: { maxParallel: 4, liveCount: 1, freeSlots: 3 },
      readEventRing: () => [],
      getReconcileMarkers: () => ({}),
      now: () => NOW,
    });
    expect(board.ticketsById.get("CTL-A").state).toBe("In Progress");
    expect(board.signals[0].ageMs).toBe(5 * HOUR);
    expect(board.eligible[0].id).toBe("CTL-B");
    // worker-age still flags off the top-level signal fields — no evidence.signal needed
    const r = evaluateInvariants(board);
    expect(r.workerAge.flagged).toEqual(["CTL-A"]);
  });

  test("deriveRing: dispatch SUCCESS events set recentDispatchTs; failed/escalated/runaway do NOT", () => {
    const ring = (name) =>
      assembleBoardState({
        readEventRing: () => [{ attributes: { "event.name": name }, ts: new Date(NOW - MIN).toISOString() }],
        now: () => NOW,
      }).ring.recentDispatchTs;
    // success / activity signals → counted (dispatcher is alive)
    expect(ring("phase.dispatch.launched.CTL-1")).toBe(NOW - MIN);
    expect(ring("phase.dispatch.requested.CTL-1")).toBe(NOW - MIN);
    expect(ring("new-work")).toBe(NOW - MIN);
    // loud-failure signals → NOT counted (must not green the silent-hold wedge)
    expect(ring("phase.dispatch.failed.CTL-1")).toBeNull();
    expect(ring("phase.dispatch.escalated.CTL-1")).toBeNull();
    expect(ring("phase.dispatch.runaway.CTL-1")).toBeNull();
  });

  test("dispatchLiveness stays WEDGED when the only recent dispatch events are failures", () => {
    const board = assembleBoardState({
      getEligible: () => [{ identifier: "CTL-1" }],
      capacity: { maxParallel: 4, liveCount: 0, freeSlots: 4 },
      // a fail-loop: recent phase.dispatch.failed events, no launched/requested
      readEventRing: () => [{ attributes: { "event.name": "phase.dispatch.failed.CTL-1" }, ts: new Date(NOW - MIN).toISOString() }],
      now: () => NOW,
    });
    expect(evaluateInvariants(board).dispatchLiveness.ok).toBe(false); // wedge NOT masked by failures
  });

  test("each reader fails soft — a throwing dep degrades to []/{}, never throws", () => {
    const board = assembleBoardState({
      orchDir: "/tmp/x",
      getBoard: () => { throw new Error("db down"); },
      getWorkerSignals: () => { throw new Error("signals down"); },
      getEligible: () => { throw new Error("eligible down"); },
      readEventRing: () => { throw new Error("ring down"); },
      getReconcileMarkers: () => { throw new Error("markers down"); },
      now: () => NOW,
    });
    expect(board.ticketsById.size).toBe(0);
    expect(board.signals).toEqual([]);
    expect(board.eligible).toEqual([]);
    // and a full scan over the degraded board still runs
    expect(() => evaluateInvariants(board)).not.toThrow();
  });
});

// ─── boardHealthPass — injected IO, the ONE place mode branches ──────────────
function flaggedDeps(extra = {}) {
  // a board that trips dispatchLiveness (free slots + queue + no recent dispatch)
  return {
    orchDir: "/tmp/x",
    getBoard: () => [],
    getWorkerSignals: () => [],
    getEligible: () => [{ identifier: "CTL-1" }, { identifier: "CTL-2" }],
    roster: [],
    self: "mini",
    multiHost: false,
    capacity: { maxParallel: 4, liveCount: 0, freeSlots: 4 },
    readEventRing: () => [], // no dispatch events → wedge
    getReconcileMarkers: () => ({}),
    lastRunMs: 0,
    intervalMs: 0, // never throttled
    now: () => NOW,
    ...extra,
  };
}

describe("boardHealthPass — mode branching + shadow safety", () => {
  test("mode:off → strict no-op: no emit, act never called, returns {ran:false,reason:off}", () => {
    const emits = [];
    const r = boardHealthPass(
      flaggedDeps({ mode: "off", emit: (e) => emits.push(e), act: () => { throw new Error("must not act"); } }),
    );
    expect(r).toEqual({ ran: false, reason: "off" });
    expect(emits.length).toBe(0);
  });

  test("mode:shadow → emits ONE recovery.board-scan (mode=shadow); act is NEVER called (no throw)", () => {
    const emits = [];
    const r = boardHealthPass(
      flaggedDeps({ mode: "shadow", emit: (e) => emits.push(e), act: () => { throw new Error("shadow must not act"); } }),
    );
    expect(r.ran).toBe(true);
    expect(emits.length).toBe(1);
    expect(emits[0].type).toBe("recovery.board-scan");
    expect(emits[0].details.mode).toBe("shadow");
    // CTL-1157: shadow telemetry carries the cohort counts (OTEL before/after
    // baseline) — present in the scan event, but the act seam threw and was never
    // reached → telemetry-only, zero action.
    for (const k of ["phantomMergedPr", "orphanedOpenPr", "frozenNeedsHuman", "needsHumanPile"]) {
      expect(emits[0].details.invariants[k]).toBeDefined();
    }
    expect(r.act).toBeNull();
  });

  test("mode:enforce with NO act seam (the scheduler reality) → emits, mutates nothing, no throw", () => {
    const emits = [];
    const r = boardHealthPass(flaggedDeps({ mode: "enforce", emit: (e) => emits.push(e) }));
    expect(r.ran).toBe(true);
    expect(emits.length).toBe(1);
    expect(emits[0].details.mode).toBe("enforce");
  });

  test("mode:enforce WITH act → ONE holistic dispatch carrying anchor + boardContext (CTL-1300)", () => {
    const emits = [];
    const acted = [];
    const r = boardHealthPass(
      flaggedDeps({
        mode: "enforce",
        emit: (e) => emits.push(e),
        act: (payload) => { acted.push(payload); return { dispatched: true, attempts: 1 }; },
      }),
    );
    // ONE delegate per proceeding scan — NOT one per proposed move.
    expect(acted.length).toBe(1);
    // the dispatch-wedge board proposes only a (ticketless) kick-dispatch → anchor
    // falls back to the top eligible ticket.
    expect(acted[0].anchor).toBe("CTL-1");
    // the delegate gets the WHOLE-board context, not a per-item brief.
    expect(acted[0].boardContext.schema).toBe("recovery-board-context/v2");
    expect(acted[0].decision.gate.decision).toBe("proceed");
    // the act result is threaded back into the pass result (observability).
    expect(r.act).toEqual({ dispatched: true, attempts: 1 });
  });

  test("anchor prefers a flagged stuck worker (tier-1 nudge) over the eligible queue", () => {
    const acted = [];
    boardHealthPass(
      flaggedDeps({
        mode: "enforce",
        emit: () => {},
        // a worker idling well past phase-normal → worker-age flags it → tier-1 nudge w/ ticket
        getWorkerSignals: () => [
          { ticket: "CTL-STUCK", phase: "implement", status: "running", updatedAt: new Date(NOW - 10 * HOUR).toISOString() },
        ],
        act: (payload) => acted.push(payload),
      }),
    );
    expect(acted.length).toBe(1);
    expect(acted[0].anchor).toBe("CTL-STUCK"); // nudge ticket beats eligible[0]=CTL-1
  });

  test("proceed but NO ticket anchor (only a host/project move + empty queue) → no dispatch", () => {
    const acted = [];
    const r = boardHealthPass({
      orchDir: "/tmp/x",
      mode: "enforce",
      getBoard: () => [{ identifier: "CTL-A" }],
      getWorkerSignals: () => [],
      getEligible: () => [], // empty queue → no eligible-fallback anchor
      roster: ["mini", "mini-2"],
      self: "mini",
      multiHost: true,
      capacity: { maxParallel: 4, liveCount: 1, freeSlots: 3 }, // free>0 → past the no-free-slots gate
      readEventRing: () => [],
      ownerForTicket: () => "mini", // mini owns CTL-A
      getReconcileMarkers: () => ({ mini: { consecutiveFailures: 2 } }), // stranded: owns work + reconcile failing
      lastRunMs: 0,
      intervalMs: 0,
      now: () => NOW,
      emit: () => {},
      act: (payload) => acted.push(payload),
    });
    // strandedNode → tier-3 host move (no ticket); empty queue → selectAnchor null → no dispatch
    expect(acted.length).toBe(0);
    expect(r.ran).toBe(true);
  });

  test("enforce + multiHost: no self-owned flagged ticket → no dispatch (CTL-1302: selectAnchor returns null)", () => {
    const acted = [];
    boardHealthPass({
      orchDir: "/tmp/x",
      mode: "enforce",
      getBoard: () => [{ identifier: "CTL-OWNED-ELSEWHERE" }],
      getWorkerSignals: () => [{ ticket: "CTL-OWNED-ELSEWHERE", phase: "implement", status: "running", updatedAt: new Date(NOW - 5 * HOUR).toISOString() }],
      getEligible: () => [],
      roster: ["mini", "mini-2"],
      self: "mini",
      multiHost: true,
      capacity: { maxParallel: 4, liveCount: 1, freeSlots: 3 },
      readEventRing: () => [],
      ownerForTicket: () => "mini-2", // the anchor (nudge CTL-OWNED-ELSEWHERE) is owned by the OTHER host
      getReconcileMarkers: () => ({}),
      lastRunMs: 0,
      intervalMs: 0,
      now: () => NOW,
      emit: () => {},
      act: (payload) => acted.push(payload),
    });
    // anchor = CTL-OWNED-ELSEWHERE, owned by mini-2 → HRW gate skips the holistic dispatch
    expect(acted.length).toBe(0);
  });

  test("selectAnchor: tier-1 nudge > tier-2 re-dispatch-blocker > top eligible > null", () => {
    const board = { eligible: [{ id: "CTL-ELIG" }] };
    expect(selectAnchor({ tier1: [{ move: "kick-dispatch" }, { ticket: "CTL-N", move: "nudge" }], tier2: [{ ticket: "CTL-B", move: "re-dispatch-blocker" }], tier3: [] }, board)).toBe("CTL-N");
    expect(selectAnchor({ tier1: [{ move: "kick-dispatch" }], tier2: [{ ticket: "CTL-B", move: "re-dispatch-blocker" }], tier3: [] }, board)).toBe("CTL-B");
    expect(selectAnchor({ tier1: [{ move: "kick-dispatch" }], tier2: [], tier3: [{ host: "mini-2" }] }, board)).toBe("CTL-ELIG");
    expect(selectAnchor({ tier1: [], tier2: [], tier3: [{ host: "mini-2" }] }, { eligible: [] })).toBe(null);
  });

  // ─── CTL-1302: selectAnchor must prefer a SELF-OWNED flagged ticket ──────────
  // The bug (observed live on mini 2026-06-21): selectAnchor picked the FIRST
  // flagged ticket regardless of HRW ownership; if that was foreign-owned the act
  // block HRW-skipped the WHOLE scan instead of trying a later flagged ticket this
  // host owns. So on a multi-host board, board-health stalled instead of acting on
  // owned work. selectAnchor must filter to self-owned (single-host owns all).
  test("selectAnchor (CTL-1302) prefers a self-owned flagged ticket over a foreign-owned earlier one", () => {
    const board = {
      self: "mini", multiHost: true, roster: ["mini", "mini-2"],
      ownerForTicket: (t) => (t === "CTL-MINE" ? "mini" : "mini-2"),
      eligible: [],
    };
    const moves = { tier1: [{ ticket: "CTL-FOREIGN", move: "nudge" }, { ticket: "CTL-MINE", move: "nudge" }], tier2: [], tier3: [] };
    expect(selectAnchor(moves, board)).toBe("CTL-MINE");
  });

  test("selectAnchor (CTL-1302) returns null when this host owns NONE of the flagged/eligible", () => {
    const board = {
      self: "mini", multiHost: true, roster: ["mini", "mini-2"],
      ownerForTicket: () => "mini-2", eligible: [{ id: "CTL-E" }],
    };
    const moves = { tier1: [{ ticket: "CTL-A", move: "nudge" }], tier2: [{ ticket: "CTL-B", move: "re-dispatch-blocker" }], tier3: [] };
    expect(selectAnchor(moves, board)).toBe(null);
  });

  test("selectAnchor (CTL-1302) falls back to a self-owned eligible ticket (skips foreign eligible)", () => {
    const board = {
      self: "mini", multiHost: true, roster: ["mini", "mini-2"],
      ownerForTicket: (t) => (t === "CTL-E2" ? "mini" : "mini-2"),
      eligible: [{ id: "CTL-E1" }, { id: "CTL-E2" }], // E1 foreign, E2 mine
    };
    const moves = { tier1: [{ move: "kick-dispatch" }], tier2: [], tier3: [] };
    expect(selectAnchor(moves, board)).toBe("CTL-E2");
  });

  test("selectAnchor (CTL-1302) single-host (no ownerForTicket / multiHost false) owns all — unchanged", () => {
    expect(selectAnchor({ tier1: [{ ticket: "CTL-X", move: "nudge" }], tier2: [], tier3: [] }, { eligible: [{ id: "CTL-1" }] })).toBe("CTL-X");
    expect(selectAnchor({ tier1: [{ ticket: "CTL-X", move: "nudge" }], tier2: [], tier3: [] }, { multiHost: false, ownerForTicket: () => "mini-2", self: "mini", eligible: [] })).toBe("CTL-X");
  });

  test("boardHealthPass (CTL-1302): multiHost dispatches against the self-owned flagged ticket, not the foreign first one", () => {
    const acted = [];
    boardHealthPass({
      orchDir: "/tmp/x",
      mode: "enforce",
      // two stalled workers: CTL-FOREIGN (mini-2) flagged first, CTL-MINE (mini) flagged second
      getBoard: () => [{ identifier: "CTL-FOREIGN" }, { identifier: "CTL-MINE" }],
      getWorkerSignals: () => [
        { ticket: "CTL-FOREIGN", phase: "implement", status: "running", updatedAt: new Date(NOW - 6 * HOUR).toISOString() },
        { ticket: "CTL-MINE", phase: "implement", status: "running", updatedAt: new Date(NOW - 6 * HOUR).toISOString() },
      ],
      getEligible: () => [],
      roster: ["mini", "mini-2"],
      self: "mini",
      multiHost: true,
      capacity: { maxParallel: 4, liveCount: 2, freeSlots: 2 },
      readEventRing: () => [],
      ownerForTicket: (t) => (t === "CTL-MINE" ? "mini" : "mini-2"),
      getReconcileMarkers: () => ({}),
      lastRunMs: 0,
      intervalMs: 0,
      now: () => NOW,
      emit: () => {},
      act: (payload) => { acted.push(payload); return { dispatched: true }; },
    });
    expect(acted.length).toBe(1);
    expect(acted[0].anchor).toBe("CTL-MINE"); // NOT CTL-FOREIGN (which it doesn't own)
  });

  test("throttle: a call within intervalMs returns {ran:false,reason:throttled} with NO emit", () => {
    const emits = [];
    const r = boardHealthPass(
      flaggedDeps({
        mode: "shadow",
        emit: (e) => emits.push(e),
        lastRunMs: NOW - 1 * MIN, // 1min ago
        intervalMs: 5 * MIN, // 5min floor → throttled
      }),
    );
    expect(r).toEqual({ ran: false, reason: "throttled" });
    expect(emits.length).toBe(0);
  });

  test("fail-soft: a throwing emit is caught — the pass still returns {ran:true}", () => {
    const r = boardHealthPass(
      flaggedDeps({ mode: "shadow", emit: () => { throw new Error("emit blew up"); } }),
    );
    expect(r.ran).toBe(true);
  });
});
