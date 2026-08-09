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
  selectAnchorCandidates,
  buildBoardContext,
  buildBoardScanEvent,
  boardHealthPass,
  // CTL-1524 (C4b): lazy deadHosts resolution (array OR thunk)
  resolveDeadHosts,
  // CTL-1644: pure revival-route classifier
  classifyRevivalRoute,
  // CTL-1552: the parked-by-human label reader + the deferred-anchor filter it feeds.
  isParkedByHuman,
  eligibleDeferredAnchors,
  makeOwnsFilter,
  resolveRosterSeam,
  deriveRing,
} from "./board-health.mjs";
// CTL-1435 (Codex P1/P2): round-trip the REAL emit envelope so the ring test
// exercises the production body.payload.details nesting + attribute promotion.
import { buildRecoveryEnvelope } from "./recovery-reasoning.mjs";

const NOW = Date.parse("2026-06-20T12:00:00Z");
const MIN = 60_000;
const HOUR = 3_600_000;

function quotaSnapshot({ remaining = 5000, sampledAt = new Date(NOW).toISOString() } = {}) {
  return {
    core: {
      limit: 5000,
      used: 5000 - remaining,
      remaining,
      resetAt: "2026-06-20T13:00:00.000Z",
    },
    host: "mini",
    sampledAt,
  };
}

// CAT-58: the account usage cliff is its OWN invariant (accountUsageHeadroom) —
// `rateLimitHeadroom` belongs to CAT-40's GitHub core REST quota check.
test("account usage headroom is derived from sampled utilization", () => {
  const ring = deriveRing([{ "event.name": "account.ratelimit.sampled", payload: { sevenDayPct: 100, sevenDayResetsAt: "2026-08-10T17:59:59Z" } }]);
  const inv = evaluateInvariants({ ring, mode: "enforce", ticketsById: new Map(), signals: [], eligible: [], capacity: { free: 0 }, now: NOW }).accountUsageHeadroom;
  expect(inv.observable).toBe(true);
  expect(inv.ok).toBe(false);
  expect(inv).toMatchObject({ sevenDayPct: 100, resetsAt: "2026-08-10T17:59:59Z" });
});

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
    dispatchRoster: o.dispatchRoster ?? o.roster ?? [],
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
    // CTL-1608: pre-fetched stalled-PR state map (timer-stamped durations).
    stalledPrMap: o.stalledPrMap ?? new Map(),
    githubQuota: o.githubQuota ?? null,
    githubQuotaMode: o.githubQuotaMode ?? "shadow",
    peerProductivity: o.peerProductivity ?? null,
    productivityMode: o.productivityMode ?? "shadow",
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
    // CTL-1432 (B2): deferred board-health anchor candidates.
    deferredBoardHealth: o.deferredBoardHealth ?? [],
    // CTL-1644: per-ticket evidence map for the stranded-mid-pipeline check.
    // Empty Map default ⇒ checkStrandedMidPipeline stays observable:false (shadow-first).
    strandedEvidence: o.strandedEvidence ?? new Map(),
    now: o.now ?? NOW,
  };
}

function mkOwnedBoard({ owner = () => "mini", ...overrides } = {}) {
  return mkBoard({
    multiHost: true,
    roster: ["mini", "peer"],
    dispatchRoster: ["mini", "peer"],
    ownerForTicket: owner,
    ...overrides,
  });
}

// CTL-1552: build a ticketsById Map whose listed ids each carry the parked-by-human
// label — the cluster-wide successor to the per-host sanctioned-latch env var.
// Suppression now reads this label off the descriptor, so a "parked" ticket is one
// present in this map.
function parkedMap(...ids) {
  return new Map(ids.map((id) => [id, { labels: [{ name: "parked-by-human" }] }]));
}

// ─── CTL-1552: isParkedByHuman — the standalone parked-by-human label reader ──
describe("isParkedByHuman — descriptor label reader", () => {
  test("true when descriptor carries the label (alongside needs-human)", () => {
    expect(
      isParkedByHuman({ labels: [{ name: "needs-human" }, { name: "parked-by-human" }] }),
    ).toBe(true);
  });
  test("false when absent / labels missing / null / undefined", () => {
    expect(isParkedByHuman({ labels: [{ name: "needs-human" }] })).toBe(false);
    expect(isParkedByHuman({})).toBe(false);
    expect(isParkedByHuman(undefined)).toBe(false);
    expect(isParkedByHuman(null)).toBe(false);
  });
  test("tolerates string labels and {name} labels (labelName shape)", () => {
    expect(isParkedByHuman({ labels: ["parked-by-human"] })).toBe(true);
    expect(isParkedByHuman({ labels: ["needs-human"] })).toBe(false);
  });
  test("case-insensitive on the label name", () => {
    expect(isParkedByHuman({ labels: [{ name: "Parked-By-Human" }] })).toBe(true);
  });
});

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

  test("rateLimitHeadroom is dark by default and shadow publishes an exhausted sample", () => {
    const absent = evaluateInvariants(mkBoard());
    expect(absent.rateLimitHeadroom).toMatchObject({ ok: true, failed: 0, observable: false });

    const exhausted = evaluateInvariants(mkBoard({
      githubQuotaMode: "shadow",
      githubQuota: quotaSnapshot({ remaining: 0 }),
    })).rateLimitHeadroom;
    expect(exhausted).toMatchObject({ ok: true, failed: 0, observable: false });
    expect(exhausted.note).toContain("0/5000");
    expect(exhausted.note).toContain("2026-06-20T13:00:00.000Z");
  });

  test("rateLimitHeadroom enforce maps ok/low/exhausted and stale samples safely", () => {
    const ok = evaluateInvariants(mkBoard({
      githubQuotaMode: "enforce", githubQuota: quotaSnapshot({ remaining: 501 }),
    })).rateLimitHeadroom;
    expect(ok).toMatchObject({ ok: true, failed: 0, observable: true });

    for (const remaining of [500, 0]) {
      const result = evaluateInvariants(mkBoard({
        githubQuotaMode: "enforce", githubQuota: quotaSnapshot({ remaining }),
      })).rateLimitHeadroom;
      expect(result).toMatchObject({ ok: false, failed: 1, observable: true });
      expect(result.flagged).toEqual([]);
    }

    const stale = evaluateInvariants(mkBoard({
      githubQuotaMode: "enforce",
      githubQuota: quotaSnapshot({ remaining: 0, sampledAt: new Date(NOW - 16 * MIN).toISOString() }),
    })).rateLimitHeadroom;
    expect(stale).toMatchObject({ ok: true, failed: 0, observable: false });
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
  const COHORT_KEYS = ["phantomMergedPr", "orphanedOpenPr", "frozenNeedsHuman", "needsHumanPile", "stalledPr"];

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

  test("Gate 3: failures + free slots + account usage cliff → skip/account-usage-cliff", () => {
    const invs = { ...allGreen(), dispatchLiveness: inv(false, 1), accountUsageHeadroom: inv(false, 1, true, ["account-usage"]) };
    const d = decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 4 } }));
    expect(d.gate.decision).toBe("skip");
    expect(d.gate.reason).toBe("account-usage-cliff");
  });

  test("Gate 3: an unobservable account usage invariant does not gate", () => {
    const invs = { ...allGreen(), dispatchLiveness: inv(false, 1), accountUsageHeadroom: inv(false, 1, false) };
    const d = decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 4 } }));
    expect(d.gate.decision).toBe("proceed");
  });

  test("Gate 3: the GitHub cliff wins when both quota cliffs are tripped", () => {
    const invs = {
      ...allGreen(),
      dispatchLiveness: inv(false, 1),
      rateLimitHeadroom: inv(false, 1),
      accountUsageHeadroom: inv(false, 1),
    };
    const d = decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 4 } }));
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

// ─── CTL-1432 (B3) / CTL-1552: parked latches suppressed from proposeMoves ─────
// (Mechanism migrated from the per-host sanctioned-latch env var to the
// parked-by-human label; the suppression behavior these pin is unchanged.)
describe("proposeMoves — parked-latch suppression (B3, via parked-by-human label)", () => {
  test("a parked frozen ticket is NOT re-proposed; a non-parked one still is", () => {
    const invs = { ...allGreen(), frozenNeedsHuman: inv(false, 2, true, ["CTL-SANCT", "CTL-REAL"]) };
    const m = proposeMoves(invs, mkBoard({ ticketsById: parkedMap("CTL-SANCT") }));
    const t2 = m.tier2.filter((x) => x.move === "review-needs-human").map((x) => x.ticket);
    expect(t2).toContain("CTL-REAL");
    expect(t2).not.toContain("CTL-SANCT");
  });

  test("nothing parked → every frozen ticket still proposed (default behavior unchanged)", () => {
    const invs = { ...allGreen(), frozenNeedsHuman: inv(false, 1, true, ["CTL-REAL"]) };
    const m = proposeMoves(invs, mkBoard());
    expect(m.tier2.map((x) => x.ticket)).toContain("CTL-REAL");
  });

  test("(Codex P1) a parked ticket in the needs-human PILE is not proposed as a tier1 holistic-triage", () => {
    const invs = { ...allGreen(), needsHumanPile: inv(false, 1, true, ["CTL-SANCT"]) };
    const m = proposeMoves(invs, mkBoard({ ticketsById: parkedMap("CTL-SANCT") }));
    expect(m.tier1.map((x) => x.ticket)).not.toContain("CTL-SANCT");
  });
});

// ─── CTL-1552: parked-by-human LABEL suppression (the cluster-wide successor to
// the per-host sanctioned-latch env var) ─────────────────────────────────────
describe("CTL-1552 — parked-by-human label suppression", () => {
  test("proposeMoves: a parked-by-human ticket is suppressed from tier1 (needsHumanPile)", () => {
    const invs = { ...allGreen(), needsHumanPile: inv(false, 1, true, ["CTL-9"]) };
    const board = mkBoard({
      ticketsById: new Map([["CTL-9", { labels: [{ name: "parked-by-human" }] }]]),
    });
    const m = proposeMoves(invs, board);
    expect([...m.tier1, ...m.tier2].some((x) => x.ticket === "CTL-9")).toBe(false);
  });

  test("proposeMoves: a parked-by-human ticket is suppressed from tier2 (frozenNeedsHuman)", () => {
    const invs = { ...allGreen(), frozenNeedsHuman: inv(false, 2, true, ["CTL-9", "CTL-REAL"]) };
    const board = mkBoard({
      ticketsById: new Map([["CTL-9", { labels: [{ name: "parked-by-human" }] }]]),
    });
    const m = proposeMoves(invs, board);
    const t2 = m.tier2.map((x) => x.ticket);
    expect(t2).toContain("CTL-REAL"); // a NON-parked frozen ticket is still proposed
    expect(t2).not.toContain("CTL-9");
  });

  test("eligibleDeferredAnchors: a parked-by-human ticket is not an anchor candidate (even HRW-owned & present)", () => {
    const board = mkBoard({
      deferredBoardHealth: ["CTL-9"],
      ticketsById: new Map([["CTL-9", { labels: [{ name: "parked-by-human" }], state: "Todo" }]]),
    });
    expect(eligibleDeferredAnchors(board)).not.toContain("CTL-9");
  });

  test("VISIBILITY invariant: a parked ticket STAYS in buildBoardContext.frozenNeedsHuman", () => {
    // suppression is in proposeMoves ONLY, never in the cohort surfaces — a human
    // must still see a parked ticket. CTL-9 carries needs-human + parked-by-human.
    const invs = { ...allGreen(), frozenNeedsHuman: inv(false, 1, true, ["CTL-9"]) };
    const board = mkBoard({
      ticketsById: new Map([
        ["CTL-9", { labels: [{ name: "needs-human" }, { name: "parked-by-human" }] }],
      ]),
    });
    const ctx = buildBoardContext(board, invs);
    expect(ctx.frozenNeedsHuman).toContain("CTL-9");
  });

  test("buildBoardScanEvent: details.sanctioned lists the suppressed (parked) ticket ids", () => {
    const invs = { ...allGreen(), frozenNeedsHuman: inv(false, 2, true, ["CTL-9", "CTL-REAL"]) };
    const board = mkBoard({
      capacity: { freeSlots: 4 },
      ticketsById: new Map([["CTL-9", { labels: [{ name: "parked-by-human" }] }]]),
    });
    const decision = decideBoardHealth(invs, board);
    const ev = buildBoardScanEvent({ mode: "shadow", invariants: invs, decision });
    expect(ev.details.sanctioned).toContain("CTL-9");
    expect(ev.details.sanctioned).not.toContain("CTL-REAL"); // only what was actually suppressed
  });

});

// ─── CTL-1432 (B2): deferred board-health intents become anchor candidates ──────
describe("selectAnchorCandidates — CTL-1432 deferred board-health (B2)", () => {
  test("a deferred board-health ticket (on the live board) with NO invariant flag is a self-owned anchor candidate", () => {
    const board = mkBoard({ deferredBoardHealth: ["ADV-1403"], ticketsById: new Map([["ADV-1403", {}]]) });
    const out = selectAnchorCandidates({ tier1: [], tier2: [], tier3: [] }, board);
    expect(out).toContain("ADV-1403");
  });

  test("(Codex P1) deferred candidates rank AFTER flagged work but BEFORE the eligible queue", () => {
    const board = mkBoard({
      deferredBoardHealth: ["ADV-1403"],
      eligible: [{ id: "CTL-ELIG" }],
      ticketsById: new Map([["ADV-1403", {}]]),
    });
    const moves = { tier1: [{ ticket: "CTL-FLAG" }], tier2: [], tier3: [] };
    const out = selectAnchorCandidates(moves, board);
    expect(out).toEqual(["CTL-FLAG", "ADV-1403", "CTL-ELIG"]);
  });

  test("(Codex P1) a deferred ticket NOT on the live board (removed) is dropped", () => {
    const board = mkBoard({ deferredBoardHealth: ["ADV-DONE"], ticketsById: new Map() });
    const out = selectAnchorCandidates({ tier1: [], tier2: [], tier3: [] }, board);
    expect(out).not.toContain("ADV-DONE");
  });

  test("(Codex P1 r3) a deferred ticket in a TERMINAL Linear state is dropped (getBoard keeps Done descriptors)", () => {
    const board = mkBoard({ deferredBoardHealth: ["CTL-DONE"], ticketsById: new Map([["CTL-DONE", { state: "Done" }]]) });
    const out = selectAnchorCandidates({ tier1: [], tier2: [], tier3: [] }, board);
    expect(out).not.toContain("CTL-DONE");
  });

  test("(Codex P1 r3) a deferred ticket that is ALSO parked is dropped from the deferred anchors", () => {
    const board = mkBoard({
      deferredBoardHealth: ["CTL-SANCT"],
      ticketsById: parkedMap("CTL-SANCT"),
    });
    const out = selectAnchorCandidates({ tier1: [], tier2: [], tier3: [] }, board);
    expect(out).not.toContain("CTL-SANCT");
  });

  test("(Codex P2 r4) a FOREIGN-owned deferred marker is dropped (multi-host HRW)", () => {
    const board = mkBoard({
      deferredBoardHealth: ["ADV-FOREIGN"],
      ticketsById: new Map([["ADV-FOREIGN", {}]]),
      multiHost: true,
      self: "mini",
      roster: ["mini", "mini-2"],
      ownerForTicket: () => "mini-2", // owned by the OTHER host
    });
    const out = selectAnchorCandidates({ tier1: [], tier2: [], tier3: [] }, board);
    expect(out).not.toContain("ADV-FOREIGN");
  });
});

// ─── CTL-1432 (B2/B3 — Codex P1): the gate accounts for deferred work + suppression ─
describe("decideBoardHealth — CTL-1432 gate (deferred proceed / all-sanctioned skip)", () => {
  test("(F1) a deferred board-health intent (on the live board) makes the gate PROCEED even when all invariants are green", () => {
    const board = mkBoard({
      deferredBoardHealth: ["ADV-1403"],
      ticketsById: new Map([["ADV-1403", {}]]),
      capacity: { freeSlots: 4 },
    });
    const d = decideBoardHealth(allGreen(), board);
    expect(d.gate.decision).toBe("proceed");
    expect(d.gate.reason).toMatch(/deferred/);
  });

  test("(Codex P1) a deferred intent whose ticket is terminal (not on the board) does NOT proceed", () => {
    const board = mkBoard({ deferredBoardHealth: ["ADV-DONE"], ticketsById: new Map(), capacity: { freeSlots: 4 } });
    const d = decideBoardHealth(allGreen(), board);
    expect(d.gate.decision).toBe("skip");
  });

  test("(Codex P2 r4) a tier3-only board SKIPS dispatch but still SURFACES the tier3 proposals in decision.moves", () => {
    const invs = { ...allGreen(), strandedNode: inv(false, 1, true, ["mini-2"]) };
    const d = decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 4 } }));
    expect(d.gate.decision).toBe("skip"); // escalate-only → no holistic dispatch
    expect(d.moves.tier3.map((x) => x.move)).toContain("escalate-stranded-node"); // …but surfaced
  });

  test("(F2) an all-parked frozenNeedsHuman as the ONLY failure → gate SKIPS (no actionable moves)", () => {
    const invs = { ...allGreen(), frozenNeedsHuman: inv(false, 2, true, ["CTL-SANCT-1", "CTL-SANCT-2"]) };
    const board = mkBoard({
      ticketsById: parkedMap("CTL-SANCT-1", "CTL-SANCT-2"),
      capacity: { freeSlots: 4 },
    });
    const d = decideBoardHealth(invs, board);
    expect(d.gate.decision).toBe("skip");
    expect(d.gate.reason).toBe("no-actionable-moves");
  });

  test("a partially-parked frozenNeedsHuman still PROCEEDS on the non-parked ticket", () => {
    const invs = { ...allGreen(), frozenNeedsHuman: inv(false, 2, true, ["CTL-SANCT", "CTL-REAL"]) };
    const board = mkBoard({ ticketsById: parkedMap("CTL-SANCT"), capacity: { freeSlots: 4 } });
    const d = decideBoardHealth(invs, board);
    expect(d.gate.decision).toBe("proceed");
    expect(d.moves.tier2.map((x) => x.ticket)).toEqual(["CTL-REAL"]);
  });
});

// ─── buildBoardScanEvent — the flat event the emit envelope rides ───────────
describe("buildBoardScanEvent", () => {
  test("publishes GitHub quota numerics and reset/host payload fields", () => {
    const board = mkBoard({ githubQuota: quotaSnapshot({ remaining: 250 }) });
    const invs = evaluateInvariants(board);
    const ev = buildBoardScanEvent({ mode: "shadow", invariants: invs, decision: decideBoardHealth(invs, board), board });
    expect(ev.details.githubCoreRemaining).toBe(250);
    expect(ev.details.githubCoreRemainingPct).toBe(5);
    expect(ev.details.githubQuotaResetAt).toBe("2026-06-20T13:00:00.000Z");
    expect(ev.details.githubQuotaHost).toBe("mini");
  });

  // Codex P1 (CAT-40): the forwarder ships attributes and DROPS body.payload
  // off-host, so a scalar left only in details is unqueryable in Loki/Grafana —
  // the default shadow rollout would emit board scans with no chartable quota,
  // leaving an operator unable to validate the feature before enforcing it.
  test("Codex P1: quota scalars are promoted into OTel attributes, not just details", () => {
    const board = mkBoard({ githubQuota: quotaSnapshot({ remaining: 250 }) });
    const invs = evaluateInvariants(board);
    const flat = buildBoardScanEvent({ mode: "shadow", invariants: invs, decision: decideBoardHealth(invs, board), board });
    const attrs = buildRecoveryEnvelope(flat, { now: () => "2026-06-20T11:59:00Z" }).attributes;
    expect(attrs["recovery.github.core_remaining"]).toBe(250);
    expect(attrs["recovery.github.core_remaining_pct"]).toBe(5);
  });

  test("Codex P1: an absent snapshot promotes nothing rather than charting a fake zero", () => {
    const invs = evaluateInvariants(mkBoard());
    const flat = buildBoardScanEvent({ mode: "shadow", invariants: invs, decision: decideBoardHealth(invs, mkBoard()) });
    const attrs = buildRecoveryEnvelope(flat, { now: () => "2026-06-20T11:59:00Z" }).attributes;
    expect(attrs).not.toHaveProperty("recovery.github.core_remaining");
    expect(attrs).not.toHaveProperty("recovery.github.core_remaining_pct");
  });

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

  // CTL-1607: per-host slot census threaded onto the board-scan event.
  test("threads board.capacity into details.slot* scalars", () => {
    const invs = { ...allGreen(), dispatchLiveness: inv(false, 1, true, ["CTL-1"]) };
    const board = mkBoard({ capacity: { maxParallel: 4, liveCount: 3, freeSlots: 1 } });
    const decision = decideBoardHealth(invs, board);
    const ev = buildBoardScanEvent({ mode: "shadow", invariants: invs, decision, board });
    expect(ev.details.slotCapacity).toBe(4);
    expect(ev.details.slotInUse).toBe(3); // capacity − free = 4 − 1
    expect(ev.details.slotFree).toBe(1);
  });

  // CTL-1607 (Codex #2985 P2 #1): in_use is derived from capacity − freeSlots, so it
  // reflects the FULL occupancy basis (liveCount + queued delegates + SDK inflight)
  // the scheduler admits against — NOT the raw bg liveCount. Here occupancy is 4
  // (freeSlots 0) while only 1 bg job is live: in_use must be 4, not 1.
  test("slotInUse reflects occupancy (capacity − free), not bare liveCount", () => {
    const invs = allGreen();
    const board = mkBoard({ capacity: { maxParallel: 4, liveCount: 1, freeSlots: 0 } });
    const ev = buildBoardScanEvent({
      mode: "shadow",
      invariants: invs,
      decision: decideBoardHealth(invs, board),
      board,
    });
    expect(ev.details.slotInUse).toBe(4);
    expect(ev.details.slotFree).toBe(0);
  });

  // CTL-1607 (Codex #2985 P2 #2): a draining / stale-liveness node admits no new
  // work, so its PUBLISHED slotFree collapses to 0 — while slotInUse still reports
  // actual occupancy (capacity − rawFree = 2), not a collapsed value.
  test("admissionGated collapses slotFree to 0 (in_use still real occupancy)", () => {
    const invs = allGreen();
    const board = mkBoard({
      capacity: { maxParallel: 4, liveCount: 1, freeSlots: 2, admissionGated: true },
    });
    const ev = buildBoardScanEvent({
      mode: "shadow",
      invariants: invs,
      decision: decideBoardHealth(invs, board),
      board,
    });
    expect(ev.details.slotFree).toBe(0);
    expect(ev.details.slotInUse).toBe(2);
  });

  // CTL-1607 (Codex #2985 P2 #3): a board-health delegate dispatched THIS scan
  // reserves a slot the scheduler charges right after the pass returns, so free is
  // debited (2 → 1) and in_use credited ((4−2)+1 = 3) here.
  test("dispatched delegate debits slotFree and credits slotInUse", () => {
    const invs = allGreen();
    const board = mkBoard({ capacity: { maxParallel: 4, liveCount: 2, freeSlots: 2 } });
    const ev = buildBoardScanEvent({
      mode: "enforce",
      invariants: invs,
      decision: decideBoardHealth(invs, board),
      board,
      act: { dispatched: true, anchor: "CTL-1" },
    });
    expect(ev.details.slotFree).toBe(1);
    expect(ev.details.slotInUse).toBe(3);
  });

  test("no board arg → slot* scalars default to null (back-compat)", () => {
    const invs = allGreen();
    const decision = decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 4 } }));
    const ev = buildBoardScanEvent({ mode: "shadow", invariants: invs, decision });
    expect(ev.details.slotCapacity).toBeNull();
    expect(ev.details.slotInUse).toBeNull();
    expect(ev.details.slotFree).toBeNull();
  });
});

// ─── buildBoardContext — the whole-board brief the delegate gets injected ────
describe("buildBoardContext", () => {
  test("publishes normalized githubQuota separately from stripped invariants", () => {
    const board = mkBoard({ githubQuota: quotaSnapshot({ remaining: 250 }) });
    const ctx = buildBoardContext(board, evaluateInvariants(board));
    expect(ctx.githubQuota).toMatchObject({
      state: "low", remaining: 250, limit: 5000, remainingPct: 5,
      resetAt: "2026-06-20T13:00:00.000Z", host: "mini", ageMs: 0,
    });
    expect(ctx.invariants.rateLimitHeadroom).toEqual({ ok: true, failed: 0 });
    const empty = mkBoard();
    expect(buildBoardContext(empty, evaluateInvariants(empty)).githubQuota).toBeNull();
  });

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

    expect(ctx.schema).toBe("recovery-board-context/v4");
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
  test("github quota seam is skipped in off and sampled in shadow", () => {
    let calls = 0;
    const getGithubQuota = () => { calls += 1; return quotaSnapshot(); };
    expect(assembleBoardState({ mode: "off", getGithubQuota, now: () => NOW }).githubQuota).toBeNull();
    expect(calls).toBe(0);
    expect(assembleBoardState({ mode: "shadow", getGithubQuota, now: () => NOW }).githubQuota).toEqual(quotaSnapshot());
    expect(calls).toBe(1);
  });

  test("account quota ring retains Anthropic payload without synthesizing nearCliff", () => {
    const board = assembleBoardState({
      now: () => NOW,
      readEventRing: () => [{
        ts: new Date(NOW).toISOString(),
        attributes: { "event.name": "account.ratelimit.sampled" },
        body: { payload: { fiveHourPct: 42, sevenDayPct: 17 } },
      }],
    });
    expect(board.ring.accountRatelimit).toEqual({ fiveHourPct: 42, sevenDayPct: 17 });
    expect(board.ring.accountRatelimit).not.toHaveProperty("nearCliff");
  });

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
    expect(acted[0].boardContext.schema).toBe("recovery-board-context/v4");
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

// ─── CTL-1435 (C1) — act-outcome on the board-scan event ─────────────────────
// The journal used to carry proposedMoves but never whether a proposal became a
// dispatch — the blind spot behind the propose-forever/dispatch-never incident.
describe("buildBoardScanEvent — C1 act-outcome (CTL-1435)", () => {
  const decisionFor = (invs) => decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 4 } }));

  test("no act param → default shadow outcome; actDispatched 0", () => {
    const invs = { ...allGreen(), dispatchLiveness: inv(false, 1, true, ["CTL-1"]) };
    const ev = buildBoardScanEvent({ mode: "shadow", invariants: invs, decision: decisionFor(invs) });
    expect(ev.details.act).toEqual({ dispatched: false, anchor: null, skippedReason: "shadow", skippedReasonNoClock: false });
    expect(ev.details.actDispatched).toBe(0);
  });

  test("dispatched act → act.dispatched true + anchor; actDispatched 1; reason string notes the dispatch", () => {
    const invs = { ...allGreen(), dispatchLiveness: inv(false, 1, true, ["CTL-1"]) };
    const ev = buildBoardScanEvent({
      mode: "enforce",
      invariants: invs,
      decision: decisionFor(invs),
      act: { dispatched: true, anchor: "CTL-7", skippedReason: null },
    });
    expect(ev.details.act).toEqual({ dispatched: true, anchor: "CTL-7", skippedReason: null, skippedReasonNoClock: false });
    expect(ev.details.actDispatched).toBe(1);
    expect(ev.reason).toContain("dispatched CTL-7");
  });

  test("skipped act → skippedReason surfaced in details.act AND the reason string", () => {
    const invs = { ...allGreen(), dispatchLiveness: inv(false, 1, true, ["CTL-1"]) };
    const ev = buildBoardScanEvent({
      mode: "enforce",
      invariants: invs,
      decision: decisionFor(invs),
      act: { dispatched: false, anchor: null, skippedReason: "all-candidates-cooldown" },
    });
    expect(ev.details.act.skippedReason).toBe("all-candidates-cooldown");
    expect(ev.details.actDispatched).toBe(0);
    expect(ev.reason).toContain("no dispatch (all-candidates-cooldown)");
  });
});

describe("boardHealthPass — C1 act-outcome captured on the emitted scan (CTL-1435)", () => {
  test("enforce dispatch → emitted details.act.dispatched true + the dispatched anchor + actDispatched 1", () => {
    const emits = [];
    boardHealthPass(
      flaggedDeps({
        mode: "enforce",
        emit: (e) => emits.push(e),
        act: () => ({ dispatched: true, attempts: 1, candidate: "CTL-1" }),
      }),
    );
    expect(emits.length).toBe(1);
    expect(emits[0].details.act.dispatched).toBe(true);
    expect(emits[0].details.act.anchor).toBe("CTL-1");
    expect(emits[0].details.act.skippedReason).toBeNull();
    expect(emits[0].details.actDispatched).toBe(1);
  });

  test("enforce proceed but no self-owned anchor → skippedReason:no-owned-anchor, dispatched:false", () => {
    const emits = [];
    boardHealthPass({
      orchDir: "/tmp/x",
      mode: "enforce",
      getBoard: () => [{ identifier: "CTL-OWNED-ELSEWHERE" }],
      getWorkerSignals: () => [
        { ticket: "CTL-OWNED-ELSEWHERE", phase: "implement", status: "running", updatedAt: new Date(NOW - 5 * HOUR).toISOString() },
      ],
      getEligible: () => [],
      roster: ["mini", "mini-2"],
      self: "mini",
      multiHost: true,
      capacity: { maxParallel: 4, liveCount: 1, freeSlots: 3 },
      readEventRing: () => [],
      ownerForTicket: () => "mini-2", // the only flagged ticket is foreign-owned → no self anchor
      getReconcileMarkers: () => ({}),
      lastRunMs: 0,
      intervalMs: 0,
      now: () => NOW,
      emit: (e) => emits.push(e),
      act: () => { throw new Error("must not act — no anchor"); },
    });
    expect(emits.length).toBe(1);
    expect(emits[0].details.act.dispatched).toBe(false);
    expect(emits[0].details.act.skippedReason).toBe("no-owned-anchor");
  });

  test("enforce gate-hold (all-green) → skippedReason echoes the gate reason; act never runs", () => {
    const emits = [];
    boardHealthPass(
      flaggedDeps({
        mode: "enforce",
        getEligible: () => [], // no queue → no dispatch wedge → all-green → gate=skip
        emit: (e) => emits.push(e),
        act: () => { throw new Error("must not act — gate held"); },
      }),
    );
    expect(emits.length).toBe(1);
    expect(emits[0].details.act.dispatched).toBe(false);
    expect(emits[0].details.act.skippedReason).toBe("all-green");
  });

  test("shadow → emitted scan records skippedReason:shadow, dispatched:false (never actuates)", () => {
    const emits = [];
    boardHealthPass(
      flaggedDeps({ mode: "shadow", emit: (e) => emits.push(e), act: () => { throw new Error("shadow must not act"); } }),
    );
    expect(emits[0].details.act).toEqual({ dispatched: false, anchor: null, skippedReason: "shadow", skippedReasonNoClock: false });
  });

  test("Codex round-2: enforce with NO act seam → skippedReason:no-actuator (a miswired-actuator wedge)", () => {
    const emits = [];
    boardHealthPass(flaggedDeps({ mode: "enforce", emit: (e) => emits.push(e) })); // no act seam wired
    expect(emits[0].details.act.dispatched).toBe(false);
    expect(emits[0].details.act.skippedReason).toBe("no-actuator");
  });

  test("ORDER: act runs BEFORE emit (so the scan carries a real outcome)", () => {
    const order = [];
    boardHealthPass(
      flaggedDeps({
        mode: "enforce",
        emit: () => order.push("emit"),
        act: () => { order.push("act"); return { dispatched: true, candidate: "CTL-1" }; },
      }),
    );
    expect(order).toEqual(["act", "emit"]);
  });
});

// ─── CTL-1435 (C2) — actuation-liveness invariant ────────────────────────────
describe("deriveRing → board.ring.boardScans via assembleBoardState (CTL-1435 C2)", () => {
  test("Codex P1 REGRESSION: the REAL emit envelope (body.payload.details) is read, not a flat payload", () => {
    // Round-trip through the production envelope builder so the test exercises the
    // exact nesting the daemon writes (buildRecoveryEnvelope → body.payload.details).
    // Before the fix, deriveRing read payload.mode (null) and every enforce scan was
    // filtered out — silently disabling the invariant in production.
    const invs = { ...allGreen(), dispatchLiveness: inv(false, 1, true, ["CTL-1"]) };
    const decision = decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 4 } }));
    const flat = buildBoardScanEvent({
      mode: "enforce",
      invariants: invs,
      decision,
      act: { dispatched: false, anchor: "CTL-1", skippedReason: "all-candidates-cooldown" },
    });
    const envelope = buildRecoveryEnvelope(flat, { now: () => "2026-06-20T11:59:00Z" });
    const board = assembleBoardState({
      orchDir: "/tmp/x",
      getBoard: () => [],
      getWorkerSignals: () => [],
      getEligible: () => [],
      readEventRing: () => [envelope],
      mode: "enforce",
      now: () => NOW,
    });
    expect(board.ring.boardScans.length).toBe(1);
    expect(board.ring.boardScans[0].mode).toBe("enforce");
    expect(board.ring.boardScans[0].gate).toBe("proceed");
    expect(board.ring.boardScans[0].dispatched).toBe(false);
    expect(board.ring.boardScans[0].skippedReason).toBe("all-candidates-cooldown");
  });

  test("flat/legacy payload shape still reads (back-compat)", () => {
    const events = [
      {
        ts: "2026-06-20T11:59:00Z",
        type: "recovery.board-scan",
        payload: { mode: "enforce", gateDecision: "proceed", proposedTier1: 1, proposedTier2: 2, proposedTier3: 0, act: { dispatched: true, skippedReason: null } },
      },
    ];
    const board = assembleBoardState({
      orchDir: "/tmp/x", getBoard: () => [], getWorkerSignals: () => [], getEligible: () => [],
      readEventRing: () => events, mode: "enforce", now: () => NOW,
    });
    expect(board.ring.boardScans[0]).toEqual({
      tsMs: Date.parse("2026-06-20T11:59:00Z"),
      mode: "enforce", gate: "proceed", proposedMoves: 3, dispatched: true, skippedReason: null, skippedReasonNoClock: false,
    });
  });
});

describe("checkActuationLiveness — via evaluateInvariants (CTL-1435 C2)", () => {
  // default scan = an owned-but-undispatched wedge (all-candidates-cooldown).
  const mkScan = (o = {}) => ({ tsMs: NOW, mode: "enforce", gate: "proceed", proposedMoves: 3, dispatched: false, skippedReason: "all-candidates-cooldown", ...o });

  test("K enforce scans ALL owned-but-undispatched (all-candidates-cooldown) → flags", () => {
    const boardScans = Array.from({ length: 6 }, () => mkScan());
    const r = evaluateInvariants(mkBoard({ mode: "enforce", ring: { boardScans } }));
    expect(r.actuationLiveness.observable).toBe(true);
    expect(r.actuationLiveness.ok).toBe(false);
    expect(r.actuationLiveness.failed).toBe(1);
  });

  test("Codex P2: deferred-only wedge (proposedMoves 0, all-candidates-cooldown) STILL flags", () => {
    const boardScans = Array.from({ length: 6 }, () => mkScan({ proposedMoves: 0 }));
    const r = evaluateInvariants(mkBoard({ mode: "enforce", ring: { boardScans } }));
    expect(r.actuationLiveness.ok).toBe(false); // old proposedMoves>0 predicate missed this
  });

  test("act-error across the window also flags", () => {
    const boardScans = Array.from({ length: 6 }, () => mkScan({ skippedReason: "act-error" }));
    const r = evaluateInvariants(mkBoard({ mode: "enforce", ring: { boardScans } }));
    expect(r.actuationLiveness.ok).toBe(false);
  });

  test("no-owned-anchor scans are BENIGN (nothing this host owns) → NOT flagged", () => {
    const boardScans = Array.from({ length: 6 }, () => mkScan({ skippedReason: "no-owned-anchor" }));
    const r = evaluateInvariants(mkBoard({ mode: "enforce", ring: { boardScans } }));
    expect(r.actuationLiveness.ok).toBe(true);
  });

  test("one dispatched:true within the K window → passes (ok:true)", () => {
    const boardScans = [...Array.from({ length: 5 }, () => mkScan()), mkScan({ dispatched: true, skippedReason: null })];
    const r = evaluateInvariants(mkBoard({ mode: "enforce", ring: { boardScans } }));
    expect(r.actuationLiveness.ok).toBe(true);
  });

  test("fewer than K enforce scans → observable:false (no flag on thin evidence)", () => {
    const boardScans = Array.from({ length: 3 }, () => mkScan());
    const r = evaluateInvariants(mkBoard({ mode: "enforce", ring: { boardScans } }));
    expect(r.actuationLiveness.observable).toBe(false);
    expect(r.actuationLiveness.ok).toBe(true);
  });

  test("shadow scans are filtered out (not the delegate's dispatch job) → observable:false", () => {
    const boardScans = Array.from({ length: 8 }, () => mkScan({ mode: "shadow" }));
    const r = evaluateInvariants(mkBoard({ mode: "enforce", ring: { boardScans } }));
    expect(r.actuationLiveness.observable).toBe(false);
  });

  test("off mode omits actuationLiveness entirely (cohort-gated)", () => {
    const boardScans = Array.from({ length: 6 }, () => mkScan());
    const r = evaluateInvariants(mkBoard({ ring: { boardScans } }), { mode: "off" });
    expect(r.actuationLiveness).toBeUndefined();
  });

  test("Codex round-2: host currently in SHADOW → observable:false even with K stale enforce scans", () => {
    const boardScans = Array.from({ length: 6 }, () => mkScan());
    const r = evaluateInvariants(mkBoard({ mode: "shadow", ring: { boardScans } }));
    expect(r.actuationLiveness.observable).toBe(false); // rolled back to shadow → don't flag stale enforce history
  });

  test("Codex round-2: enforce + no-actuator (miswired daemon proposes but can't dispatch) → flags", () => {
    const boardScans = Array.from({ length: 6 }, () => mkScan({ skippedReason: "no-actuator" }));
    const r = evaluateInvariants(mkBoard({ mode: "enforce", ring: { boardScans } }));
    expect(r.actuationLiveness.ok).toBe(false);
  });

  test("Codex round-2: K scans spanning a downtime gap (oldest > windowMs ago) → observable:false", () => {
    // 5 stale scans from ~3h ago + 1 fresh → the window is not recent/contiguous.
    const boardScans = [
      ...Array.from({ length: 5 }, () => mkScan({ tsMs: NOW - 3 * HOUR })),
      mkScan({ tsMs: NOW }),
    ];
    const r = evaluateInvariants(mkBoard({ mode: "enforce", ring: { boardScans } }));
    expect(r.actuationLiveness.observable).toBe(false);
  });

  test("a missing/non-finite tsMs in the window → observable:false (can't verify recency)", () => {
    const boardScans = [mkScan({ tsMs: null }), ...Array.from({ length: 5 }, () => mkScan())];
    const r = evaluateInvariants(mkBoard({ mode: "enforce", ring: { boardScans } }));
    expect(r.actuationLiveness.observable).toBe(false);
  });
});

// ─── CTL-1435 (C1, Codex P2) — actDispatched promoted to a chartable attribute ─
describe("buildRecoveryEnvelope — recovery.act_dispatched promotion (CTL-1435)", () => {
  const mkEvent = (act) => {
    const invs = { ...allGreen(), dispatchLiveness: inv(false, 1, true, ["CTL-1"]) };
    const decision = decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 4 } }));
    return buildBoardScanEvent({ mode: "enforce", invariants: invs, decision, act });
  };

  test("dispatched scan → attributes['recovery.act_dispatched'] === 1 (chartable dispatch rate)", () => {
    const env = buildRecoveryEnvelope(mkEvent({ dispatched: true, anchor: "CTL-1", skippedReason: null }));
    expect(env.attributes["recovery.act_dispatched"]).toBe(1);
    // the high-cardinality anchor stays in body.payload.details, never promoted.
    expect(env.attributes["recovery.act_anchor"]).toBeUndefined();
    expect(env.body.payload.details.act.anchor).toBe("CTL-1");
  });

  test("non-dispatch scan → attributes['recovery.act_dispatched'] === 0", () => {
    const env = buildRecoveryEnvelope(mkEvent({ dispatched: false, anchor: null, skippedReason: "all-candidates-cooldown" }));
    expect(env.attributes["recovery.act_dispatched"]).toBe(0);
  });
});

// ─── CTL-1524 (C4b) — deadHosts is resolved LAZILY, past the throttle ─────────
// The scheduler used to evaluate `_boardHealth.deadHosts(roster)` EAGERLY at the
// call site, so boardHealthPass's 5-minute internal throttle could never protect it:
// the whole-log heartbeat read behind it was paid on every tick, ~59 of every 60 of
// which the throttle then discarded. The seam now accepts a THUNK (and still an
// array), and boardHealthPass calls it only once it has decided to proceed.
describe("boardHealthPass — CTL-1524 C4b lazy deadHosts", () => {
  test("THROTTLED pass → the thunk is NEVER invoked", () => {
    let calls = 0;
    const r = boardHealthPass(
      flaggedDeps({
        mode: "shadow",
        lastRunMs: NOW, // just ran
        intervalMs: 5 * MIN, // → throttled
        deadHosts: () => {
          calls++;
          return ["mini-2"];
        },
      })
    );
    expect(r).toEqual({ ran: false, reason: "throttled" });
    expect(calls).toBe(0); // the expensive read was not paid on a discarded tick
  });

  test("mode:off → the thunk is NEVER invoked either (strict no-op)", () => {
    let calls = 0;
    const r = boardHealthPass(
      flaggedDeps({
        mode: "off",
        deadHosts: () => {
          calls++;
          return ["mini-2"];
        },
      })
    );
    expect(r).toEqual({ ran: false, reason: "off" });
    expect(calls).toBe(0);
  });

  test("PROCEEDING pass → the thunk is invoked EXACTLY ONCE", () => {
    let calls = 0;
    const r = boardHealthPass(
      flaggedDeps({
        mode: "shadow",
        deadHosts: () => {
          calls++;
          return ["mini-2"];
        },
      })
    );
    expect(r.ran).toBe(true);
    expect(calls).toBe(1);
  });

  test("BACKWARD COMPATIBLE: a plain ARRAY still works exactly as before", () => {
    const emits = [];
    const r = boardHealthPass(
      flaggedDeps({ mode: "shadow", deadHosts: ["mini-2"], emit: (e) => emits.push(e) })
    );
    expect(r.ran).toBe(true);
    expect(emits.length).toBe(1); // the pass ran to completion on an array seam
  });

  test("a thunk and the equivalent array produce the SAME board state", () => {
    const fromArray = assembleBoardState({ roster: ["mini", "mini-2"], deadHosts: ["mini-2"] });
    const fromThunk = assembleBoardState({ roster: ["mini", "mini-2"], deadHosts: () => ["mini-2"] });
    expect(fromThunk.deadHosts).toEqual(fromArray.deadHosts);
    expect(fromThunk.deadHosts).toEqual(["mini-2"]);
  });
});

describe("resolveDeadHosts (CTL-1524 C4b)", () => {
  test("passes an array through untouched", () => {
    expect(resolveDeadHosts(["a", "b"])).toEqual(["a", "b"]);
    expect(resolveDeadHosts([])).toEqual([]);
  });

  test("invokes a thunk exactly once and returns its array", () => {
    let calls = 0;
    const out = resolveDeadHosts(() => {
      calls++;
      return ["dead-1"];
    });
    expect(calls).toBe(1);
    expect(out).toEqual(["dead-1"]);
  });

  test("NEVER throws: a throwing thunk degrades to an empty dead set", () => {
    expect(
      resolveDeadHosts(() => {
        throw new Error("heartbeat read blew up");
      })
    ).toEqual([]);
  });

  test("non-array inputs / non-array thunk returns degrade to []", () => {
    expect(resolveDeadHosts(undefined)).toEqual([]);
    expect(resolveDeadHosts(null)).toEqual([]);
    expect(resolveDeadHosts("mini-2")).toEqual([]);
    expect(resolveDeadHosts(() => null)).toEqual([]);
    expect(resolveDeadHosts(() => "nope")).toEqual([]);
  });
});

// ─── CTL-1475: unowned in-flight ────────────────────────────────────────────
// The blind spot every other invariant misses by construction. A ticket whose
// Linear state CLAIMS a worker is on it, with no worker and no PR to back that
// claim, was invisible: admission only pulls Todo, the recovery census scans
// worker dirs, and every other cohort keys on an artifact these tickets lack.
describe("checkUnownedInFlight (CTL-1475)", () => {
  const HOUR = 3_600_000;
  const NOW = Date.parse("2026-07-27T00:00:00.000Z");
  const at = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();
  const board = (o = {}) =>
    mkBoard({ now: NOW, mode: "enforce", ...o });
  const one = (over = {}) =>
    new Map([["CTL-9", { id: "CTL-9", state: "Implement", updatedAt: at(72), ...over }]]);

  test("flags a ticket whose state claims in-flight with no worker and no PR", () => {
    const r = evaluateInvariants(board({ ticketsById: one() })).unownedInFlight;
    expect(r.observable).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.flagged).toEqual(["CTL-9"]);
  });

  test("does NOT flag when a LIVE worker signal owns it", () => {
    const r = evaluateInvariants(
      board({ ticketsById: one(), signals: [{ ticket: "CTL-9", status: "running" }] })
    ).unownedInFlight;
    expect(r.ok).toBe(true);
    expect(r.flagged).toEqual([]);
  });

  // REGRESSION (Codex P2): counting ANY signal — live or terminal — as ownership made
  // this invariant blind itself. The recovery pass that THIS cohort dispatches writes
  // `phase-recovery-pass.json` with status `complete`; under the old predicate that
  // artifact exempted the ticket forever, so a ticket got exactly one sweep and then
  // went permanently invisible even while still stuck. Mutation-checked: reverting
  // `hasLiveSignal` to "any signal" turns each case below RED.
  test("DOES flag a ticket whose only signal is TERMINAL — a completed artifact is not ownership", () => {
    for (const status of ["complete", "failed", "stalled", "aborted", "turn-cap-exhausted"]) {
      const r = evaluateInvariants(
        board({ ticketsById: one(), signals: [{ ticket: "CTL-9", status }] })
      ).unownedInFlight;
      expect(r.ok).toBe(false);
      expect(r.flagged).toEqual(["CTL-9"]);
    }
  });

  test("DOES flag after its own recovery pass completed — the cohort must stay re-flaggable", () => {
    const r = evaluateInvariants(
      board({
        ticketsById: one(),
        signals: [{ ticket: "CTL-9", phase: "recovery-pass", status: "complete" }],
      })
    ).unownedInFlight;
    expect(r.flagged).toEqual(["CTL-9"]);
  });

  test("does NOT flag a ticket with a confirmed-open PR — a PR IS ownership", () => {
    const r = evaluateInvariants(
      board({
        ticketsById: one({ pr_number: 42 }),
        prStatusMap: mkPrStatusMap([{ prNumber: 42, status: "open", repo: "r" }]),
      })
    ).unownedInFlight;
    expect(r.ok).toBe(true);
  });

  // REGRESSION (Codex P2): the old check was `prNumber != null && prMap.size > 0`, so a
  // ticket carrying a HISTORICAL PR number was exempted by the mere existence of any
  // unrelated row in the global map. A closed/merged PR is not ownership — that is the
  // stuck shape this cohort exists to catch.
  test("DOES flag a ticket whose linked PR is closed or merged, not open", () => {
    for (const status of ["closed", "merged"]) {
      const r = evaluateInvariants(
        board({
          ticketsById: one({ pr_number: 42 }),
          prStatusMap: mkPrStatusMap([{ prNumber: 42, status, repo: "r" }]),
        })
      ).unownedInFlight;
      expect(r.flagged).toEqual(["CTL-9"]);
    }
  });

  test("DOES flag when the PR map holds only an UNRELATED number", () => {
    const r = evaluateInvariants(
      board({
        ticketsById: one({ pr_number: 42 }),
        prStatusMap: mkPrStatusMap([{ prNumber: 999, status: "open", repo: "r" }]),
      })
    ).unownedInFlight;
    expect(r.flagged).toEqual(["CTL-9"]);
  });

  test("does NOT flag a FRESH ticket (a worker between phases must never trip this)", () => {
    const r = evaluateInvariants(board({ ticketsById: one({ updatedAt: at(2) }) })).unownedInFlight;
    expect(r.ok).toBe(true);
  });

  test("does NOT flag a terminal ticket", () => {
    const r = evaluateInvariants(board({ ticketsById: one({ state: "Done" }) })).unownedInFlight;
    expect(r.ok).toBe(true);
  });

  test("does NOT flag Todo/Backlog — those are not a claim of ownership", () => {
    for (const state of ["Todo", "Backlog"]) {
      const r = evaluateInvariants(board({ ticketsById: one({ state }) })).unownedInFlight;
      expect(r.ok).toBe(true);
    }
  });

  // REGRESSION (Codex P2): the state matcher was written against THIS fleet's config,
  // where `reviewing` maps onto "Validate" — so the shipped template's
  // `stateMap.reviewing = "Review"` never appeared in our data and the gap was
  // invisible locally. Every configured in-flight phase name must be covered.
  test("covers every in-flight state in the shipped template stateMap", () => {
    for (const state of ["Research", "Plan", "Implement", "Validate", "Review", "Remediate", "PR"]) {
      const r = evaluateInvariants(board({ ticketsById: one({ state }) })).unownedInFlight;
      expect(r.flagged).toEqual(["CTL-9"]);
    }
  });

  // Triage is the ADMISSION boundary (eligibleQuery = {status:"Todo", triageStatus:"Triage"}),
  // not a claim that a worker is on the ticket. Flagging it would race new-work pull and
  // dispatch recovery for tickets that are merely queued.
  test("does NOT flag Triage — that is the admission boundary, not an ownership claim", () => {
    const r = evaluateInvariants(board({ ticketsById: one({ state: "Triage" }) })).unownedInFlight;
    expect(r.ok).toBe(true);
  });

  test("FAILS SAFE on an unreadable timestamp — unknown age is never staleness", () => {
    const r = evaluateInvariants(
      board({ ticketsById: one({ updatedAt: "not-a-date" }) })
    ).unownedInFlight;
    expect(r.ok).toBe(true);
    expect(r.unobservableAges).toBe(1);
  });

  // REGRESSION: the replica stores updated_at as an epoch-ms INTEGER, not an ISO
  // string, and Date.parse(number) is NaN. With parse-only, all 13 live in-flight
  // tickets read as "age unknown" and the invariant reported a permanently clean
  // board — blind on the exact population it exists to catch. Caught by running it
  // against real data, not by any unit test, which is why this one exists.
  test("accepts an epoch-ms NUMBER timestamp (the shape the replica actually stores)", () => {
    const ms = NOW - 72 * HOUR;
    const r = evaluateInvariants(board({ ticketsById: one({ updatedAt: ms }) })).unownedInFlight;
    expect(r.ok).toBe(false);
    expect(r.flagged).toEqual(["CTL-9"]);
    expect(r.unobservableAges).toBe(0);
  });

  test("accepts a numeric STRING timestamp too", () => {
    const r = evaluateInvariants(
      board({ ticketsById: one({ updatedAt: String(NOW - 72 * HOUR) }) })
    ).unownedInFlight;
    expect(r.ok).toBe(false);
  });

  test("a FRESH epoch-ms timestamp is still spared (the number path honours the age gate)", () => {
    const r = evaluateInvariants(
      board({ ticketsById: one({ updatedAt: NOW - 2 * HOUR }) })
    ).unownedInFlight;
    expect(r.ok).toBe(true);
  });

  test("is not observable with no ticket descriptors", () => {
    const r = evaluateInvariants(board({ ticketsById: new Map() })).unownedInFlight;
    expect(r.observable).toBe(false);
    expect(r.ok).toBe(true);
  });

  test("proposes an ANCHORABLE tier2 move so the delegate actually sweeps it up", () => {
    // tier3 is "escalate-only, never anchorable" — a tier3 proposal would be
    // detected, reported, and then left as stuck as before. That is precisely how
    // this cohort sat untouched for 13 days. It must be anchorable.
    const inv = evaluateInvariants(board({ ticketsById: one() }));
    const moves = proposeMoves(inv, {});
    const m = moves.tier2.find((x) => x.move === "recover-unowned-in-flight");
    expect(m).toBeTruthy();
    expect(m.ticket).toBe("CTL-9");
    expect(moves.tier3.some((x) => x.ticket === "CTL-9")).toBe(false);
  });

  test("an operator-parked ticket is not re-proposed", () => {
    const inv = evaluateInvariants(board({ ticketsById: one() }));
    const moves = proposeMoves(inv, { ticketsById: parkedMap("CTL-9") });
    expect(moves.tier2.some((x) => x.move === "recover-unowned-in-flight")).toBe(false);
  });

  test("mode:off omits the invariant entirely (the off set stays byte-identical)", () => {
    const off = evaluateInvariants(board({ ticketsById: one(), mode: "off" }));
    expect(off.unownedInFlight).toBeUndefined();
  });

  // REGRESSION (Codex P2): the delegate's mandate here is HOLISTIC — one ticket is the
  // dispatch anchor, but the worker must sweep the whole cohort. The recovery-pass skill
  // CONSUMES this brief instead of re-running the board scan, so a cohort missing from
  // the context is one the worker cannot enumerate: it would fix the single anchor and
  // leave the rest exactly as stuck. Mutation-checked: drop the field → RED.
  test("buildBoardContext surfaces the WHOLE cohort, not just the anchor", () => {
    const many = new Map(
      ["CTL-9", "CTL-10", "CTL-11"].map((id) => [
        id,
        { id, state: "Implement", updatedAt: at(72) },
      ]),
    );
    const b = board({ ticketsById: many });
    const ctx = buildBoardContext(b, evaluateInvariants(b));
    expect(ctx.unownedInFlight).toEqual(["CTL-9", "CTL-10", "CTL-11"]);
  });

  test("buildBoardContext defaults the cohort to [] when green (shadow-safe)", () => {
    const b = board({ ticketsById: one({ updatedAt: at(2) }) });
    expect(buildBoardContext(b, evaluateInvariants(b)).unownedInFlight).toEqual([]);
  });
});

// ─── CTL-1610 (Phase 2): skippedReasonNoClock threading ─────────────────────
describe("checkActuationLiveness — skippedReasonNoClock (CTL-1610)", () => {
  const mkScan = (o = {}) => ({ tsMs: NOW, mode: "enforce", gate: "proceed", proposedMoves: 3, dispatched: false, skippedReason: "all-candidates-cooldown", skippedReasonNoClock: false, ...o });

  test("(CTL-1610) all-candidates-exhausted with skippedReasonNoClock:true across the window → flags (wedge)", () => {
    const boardScans = Array.from({ length: 6 }, () =>
      mkScan({ skippedReason: "all-candidates-exhausted", skippedReasonNoClock: true }));
    const r = evaluateInvariants(mkBoard({ mode: "enforce", ring: { boardScans } }));
    expect(r.actuationLiveness.observable).toBe(true);
    expect(r.actuationLiveness.ok).toBe(false);
  });

  test("(CTL-1610) all-candidates-exhausted with a valid clock (skippedReasonNoClock:false) stays BENIGN (not flagged)", () => {
    const boardScans = Array.from({ length: 6 }, () =>
      mkScan({ skippedReason: "all-candidates-exhausted", skippedReasonNoClock: false }));
    const r = evaluateInvariants(mkBoard({ mode: "enforce", ring: { boardScans } }));
    expect(r.actuationLiveness.ok).toBe(true);
  });

  test("(CTL-1610) a dispatched scan within a no-clock-latch window still clears the wedge", () => {
    const boardScans = [
      ...Array.from({ length: 5 }, () => mkScan({ skippedReason: "all-candidates-exhausted", skippedReasonNoClock: true })),
      mkScan({ dispatched: true, skippedReason: null }),
    ];
    const r = evaluateInvariants(mkBoard({ mode: "enforce", ring: { boardScans } }));
    expect(r.actuationLiveness.ok).toBe(true);
  });
});

describe("buildBoardScanEvent — act.skippedReasonNoClock round-trip (CTL-1610)", () => {
  test("(CTL-1610) buildBoardScanEvent carries act.skippedReasonNoClock", () => {
    const invs = { ...allGreen(), dispatchLiveness: inv(false, 1, true, ["CTL-1"]) };
    const decision = decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 4 } }));
    const ev = buildBoardScanEvent({ mode: "enforce", invariants: invs, decision,
      act: { dispatched: false, anchor: null, skippedReason: "all-candidates-exhausted", skippedReasonNoClock: true } });
    expect(ev.details.act.skippedReasonNoClock).toBe(true);
  });
});

// ─── CTL-1610 (Phase 3): boardHealthPass maps actResult.latchedNoClock →
//     the emitted scan's skippedReasonNoClock (the glue seam between
//     holisticBoardHealthAct's return and checkActuationLiveness). Added by
//     phase-verify to close the one line (board-health.mjs:1496) that neither
//     the holisticBoardHealthAct nor the buildBoardScanEvent test exercised. ──
describe("boardHealthPass — latchedNoClock → scan.skippedReasonNoClock (CTL-1610)", () => {
  test("(CTL-1610) an exhausted act with latchedNoClock:true emits skippedReasonNoClock:true", () => {
    const emits = [];
    boardHealthPass(
      flaggedDeps({
        mode: "enforce",
        emit: (e) => emits.push(e),
        act: () => ({ dispatched: false, reason: "all-candidates-exhausted", latchedNoClock: true }),
      }),
    );
    expect(emits.length).toBe(1);
    expect(emits[0].details.act.dispatched).toBe(false);
    expect(emits[0].details.act.skippedReason).toBe("all-candidates-exhausted");
    expect(emits[0].details.act.skippedReasonNoClock).toBe(true);
  });

  test("(CTL-1610) a well-formed exhausted act (latchedNoClock:false) stays skippedReasonNoClock:false", () => {
    const emits = [];
    boardHealthPass(
      flaggedDeps({
        mode: "enforce",
        emit: (e) => emits.push(e),
        act: () => ({ dispatched: false, reason: "all-candidates-exhausted", latchedNoClock: false }),
      }),
    );
    expect(emits[0].details.act.skippedReason).toBe("all-candidates-exhausted");
    expect(emits[0].details.act.skippedReasonNoClock).toBe(false);
  });

  test("(CTL-1610) a dispatched act forces skippedReasonNoClock:false regardless of latch signal", () => {
    const emits = [];
    boardHealthPass(
      flaggedDeps({
        mode: "enforce",
        emit: (e) => emits.push(e),
        act: () => ({ dispatched: true, candidate: "CTL-1", latchedNoClock: true }),
      }),
    );
    expect(emits[0].details.act.dispatched).toBe(true);
    expect(emits[0].details.act.skippedReasonNoClock).toBe(false);
  });
});

// ─── CTL-1644: classifyRevivalRoute — pure route classification ──────────────
describe("classifyRevivalRoute (CTL-1644)", () => {
  test("open PR present ⇒ pr-not-merged (highest precedence)", () => {
    const c = classifyRevivalRoute({ openPr: { number: 42, status: "open" } });
    expect(c.route).toBe("pr-not-merged");
    expect(c.dispatchable).toBe(true);
  });

  test("remote branch exists, no local unpushed worktree ⇒ resume-from-remote", () => {
    const c = classifyRevivalRoute({ remoteBranchExists: true, worktreeUnpushed: false });
    expect(c.route).toBe("resume-from-remote");
    expect(c.dispatchable).toBe(true);
  });

  test("remote branch exists but local salvage UNCHECKED ⇒ held, NOT resume-from-remote [Codex P2 round 3]", () => {
    // worktreeUnpushed omitted (local probe failed/skipped): !undefined would have
    // wrongly picked resume-from-remote and discarded possible unpushed local work.
    const c = classifyRevivalRoute({ remoteBranchExists: true });
    expect(c.route).toBe("unknown-salvage");
    expect(c.dispatchable).toBe(false);
  });

  test("local worktree with unpushed commits ⇒ adopt (stubbed dispatchable:false, CTL-1642)", () => {
    const c = classifyRevivalRoute({ worktreeUnpushed: true });
    expect(c.route).toBe("adopt");
    expect(c.dispatchable).toBe(false);
  });

  test("salvage UNCHECKED (fields absent) ⇒ unknown-salvage (held, not restart-fresh) [Codex P1]", () => {
    // Phase-2 evidence omits remoteBranchExists/worktreeUnpushed → we must NOT
    // restart-fresh (destructive) on unchecked evidence; hold as non-dispatchable.
    const c = classifyRevivalRoute({});
    expect(c.route).toBe("unknown-salvage");
    expect(c.dispatchable).toBe(false);
  });

  test("salvage CHECKED and absent (fields present & false) ⇒ restart-fresh", () => {
    const c = classifyRevivalRoute({
      openPr: null, remoteBranchExists: false, worktreeUnpushed: false,
      hasWorkerDir: false, hasLiveBg: false, hasFreshIntent: false,
    });
    expect(c.route).toBe("restart-fresh");
  });

  test("open PR takes precedence over remote branch", () => {
    const c = classifyRevivalRoute({ openPr: { number: 7 }, remoteBranchExists: true, worktreeUnpushed: true });
    expect(c.route).toBe("pr-not-merged");
  });
});

// ─── CTL-1644: checkStrandedMidPipeline invariant ───────────────────────────
describe("checkStrandedMidPipeline (CTL-1644)", () => {
  const HOUR = 3_600_000;
  const NOW_SMP = Date.parse("2026-08-06T00:00:00.000Z");
  const at = (hoursAgo) => new Date(NOW_SMP - hoursAgo * HOUR).toISOString();
  // Board builder: mode:enforce so the cohort gate is open; now fixed.
  const board = (o = {}) => mkBoard({ now: NOW_SMP, mode: "enforce", ...o });
  // One stale in-flight ticket in Implement, 72h stale (well past 24h threshold).
  const one = (over = {}) =>
    new Map([["CTL-9", { id: "CTL-9", state: "Implement", updatedAt: at(72), ...over }]]);
  // Evidence stub helper: array of rows → Map<id, evidence>
  const ev = (rows) => new Map(rows.map((r) => [r.id, r]));
  // Full "nothing salvageable" evidence row for CTL-9.
  const noActuation = { id: "CTL-9", hasWorkerDir: false, hasLiveBg: false,
    hasFreshIntent: false, openPr: null, remoteBranchExists: false, worktreeUnpushed: false };

  test("observable:false when no evidence seam provided (empty Map → shadow-first wiring)", () => {
    // strandedEvidence defaults to new Map() in mkBoard → size 0 → not observable.
    const r = evaluateInvariants(board({ ticketsById: one() })).strandedMidPipeline;
    expect(r.observable).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.flagged).toEqual([]);
  });

  test("flags an HRW-owned in-flight ticket with NO actuation past threshold, and classifies it", () => {
    const r = evaluateInvariants(board({
      ticketsById: one(),
      self: "mini",
      ownerForTicket: () => "mini",
      strandedEvidence: ev([noActuation]),
    })).strandedMidPipeline;
    expect(r.observable).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.flagged).toEqual(["CTL-9"]);
    expect(r.classified["CTL-9"].route).toBe("restart-fresh");
  });

  test("does NOT flag when a worker dir exists (actuation present)", () => {
    const r = evaluateInvariants(board({
      ticketsById: one(),
      self: "mini",
      ownerForTicket: () => "mini",
      strandedEvidence: ev([{ id: "CTL-9", hasWorkerDir: true }]),
    })).strandedMidPipeline;
    expect(r.ok).toBe(true);
    expect(r.flagged).toEqual([]);
  });

  test("does NOT flag when a live bg worker exists", () => {
    const r = evaluateInvariants(board({
      ticketsById: one(),
      self: "mini",
      ownerForTicket: () => "mini",
      strandedEvidence: ev([{ id: "CTL-9", hasLiveBg: true }]),
    })).strandedMidPipeline;
    expect(r.flagged).toEqual([]);
  });

  test("does NOT flag when a FRESH live-status signal exists (active worker)", () => {
    const r = evaluateInvariants(board({
      ticketsById: one(),
      self: "mini",
      ownerForTicket: () => "mini",
      signals: [{ ticket: "CTL-9", phase: "implement", status: "running", ageMs: 1 * HOUR }],
      strandedEvidence: ev([noActuation]),
    })).strandedMidPipeline;
    expect(r.flagged).toEqual([]);
  });

  test("DOES flag when the only 'live' signal is STALE past threshold [Codex P2 round 5]", () => {
    // A dead worker's persisted `running` signal (never wrote a terminal signal)
    // must NOT mask the stranded ticket once it has sat live past the window.
    const r = evaluateInvariants(board({
      ticketsById: one(),
      self: "mini",
      ownerForTicket: () => "mini",
      signals: [{ ticket: "CTL-9", phase: "implement", status: "running", ageMs: 72 * HOUR }],
      strandedEvidence: ev([noActuation]),
    })).strandedMidPipeline;
    expect(r.flagged).toEqual(["CTL-9"]);
  });

  test("does NOT flag when a fresh recovery intent exists", () => {
    const r = evaluateInvariants(board({
      ticketsById: one(),
      self: "mini",
      ownerForTicket: () => "mini",
      strandedEvidence: ev([{ id: "CTL-9", hasFreshIntent: true }]),
    })).strandedMidPipeline;
    expect(r.flagged).toEqual([]);
  });

  test("does NOT flag a foreign-owned ticket (HRW belongs to another host)", () => {
    const r = evaluateInvariants(board({
      ticketsById: one(),
      self: "mini",
      ownerForTicket: () => "studio",
      strandedEvidence: ev([noActuation]),
    })).strandedMidPipeline;
    expect(r.flagged).toEqual([]);
  });

  test("does NOT flag a needs-human LABELLED ticket (parked contract, label not status)", () => {
    const r = evaluateInvariants(board({
      ticketsById: one({ labels: [{ name: "needs-human" }] }),
      self: "mini",
      ownerForTicket: () => "mini",
      strandedEvidence: ev([noActuation]),
    })).strandedMidPipeline;
    expect(r.flagged).toEqual([]);
  });

  test("does NOT flag before the age threshold (1h stale, threshold is 24h)", () => {
    const r = evaluateInvariants(board({
      ticketsById: one({ updatedAt: at(1) }),
      self: "mini",
      ownerForTicket: () => "mini",
      strandedEvidence: ev([noActuation]),
    })).strandedMidPipeline;
    expect(r.flagged).toEqual([]);
  });

  test("does NOT flag a terminal ticket (Done)", () => {
    const r = evaluateInvariants(board({
      ticketsById: one({ state: "Done" }),
      self: "mini",
      ownerForTicket: () => "mini",
      strandedEvidence: ev([noActuation]),
    })).strandedMidPipeline;
    expect(r.flagged).toEqual([]);
  });

  test("does NOT flag Todo/Backlog (not an ownership claim)", () => {
    for (const state of ["Todo", "Backlog"]) {
      const r = evaluateInvariants(board({
        ticketsById: one({ state }),
        self: "mini",
        ownerForTicket: () => "mini",
        strandedEvidence: ev([noActuation]),
      })).strandedMidPipeline;
      expect(r.flagged).toEqual([]);
    }
  });

  test("FAILS SAFE on an unreadable timestamp — unknown age is never staleness", () => {
    const r = evaluateInvariants(board({
      ticketsById: one({ updatedAt: "not-a-date" }),
      self: "mini",
      ownerForTicket: () => "mini",
      strandedEvidence: ev([noActuation]),
    })).strandedMidPipeline;
    expect(r.ok).toBe(true);
    expect(r.unobservableAges).toBe(1);
  });

  test("routes to pr-not-merged when an open PR exists in evidence", () => {
    const r = evaluateInvariants(board({
      ticketsById: one(),
      self: "mini",
      ownerForTicket: () => "mini",
      strandedEvidence: ev([{ ...noActuation, openPr: { number: 42, status: "open" } }]),
    })).strandedMidPipeline;
    expect(r.classified["CTL-9"].route).toBe("pr-not-merged");
  });

  test("routes to resume-from-remote when remote branch exists but no worktree", () => {
    const r = evaluateInvariants(board({
      ticketsById: one(),
      self: "mini",
      ownerForTicket: () => "mini",
      strandedEvidence: ev([{ ...noActuation, remoteBranchExists: true }]),
    })).strandedMidPipeline;
    expect(r.classified["CTL-9"].route).toBe("resume-from-remote");
  });

  test("mode:off omits the invariant entirely (the off set stays byte-identical)", () => {
    const r = evaluateInvariants(board({
      ticketsById: one(),
      mode: "off",
      ownerForTicket: () => "mini",
      strandedEvidence: ev([noActuation]),
    }));
    expect(r.strandedMidPipeline).toBeUndefined();
  });

  test("proposes route-stranded-mid-pipeline in tier2 so the delegate sweeps it", () => {
    const b = board({
      ticketsById: one(),
      self: "mini",
      ownerForTicket: () => "mini",
      strandedEvidence: ev([noActuation]),
    });
    const moves = proposeMoves(evaluateInvariants(b), { sanctionedNeedsHuman: [] });
    const m = moves.tier2.find((x) => x.move === "route-stranded-mid-pipeline");
    expect(m).toBeTruthy();
    expect(m.ticket).toBe("CTL-9");
    // must be tier2 (anchorable), never tier3
    expect(moves.tier3.some((x) => x.ticket === "CTL-9")).toBe(false);
  });

  test("a classified ticket is suppressed from recover-unowned-in-flight (de-dup)", () => {
    // CTL-9 triggers BOTH checkStrandedMidPipeline (owned+classified) AND
    // checkUnownedInFlight. Only the classified route move must appear.
    const b = board({
      ticketsById: one(),
      self: "mini",
      ownerForTicket: () => "mini",
      strandedEvidence: ev([noActuation]),
    });
    const moves = proposeMoves(evaluateInvariants(b), { sanctionedNeedsHuman: [] });
    const ctlNineMoves = moves.tier2.filter((m) => m.ticket === "CTL-9");
    expect(ctlNineMoves.some((m) => m.move === "recover-unowned-in-flight")).toBe(false);
    expect(ctlNineMoves.some((m) => m.move === "route-stranded-mid-pipeline")).toBe(true);
  });

  test("buildBoardContext surfaces strandedMidPipeline classified routes", () => {
    const b = board({
      ticketsById: one(),
      self: "mini",
      ownerForTicket: () => "mini",
      strandedEvidence: ev([noActuation]),
    });
    const ctx = buildBoardContext(b, evaluateInvariants(b));
    expect(ctx.strandedMidPipeline).toBeDefined();
    expect(ctx.strandedMidPipeline["CTL-9"]).toBeDefined();
    expect(ctx.strandedMidPipeline["CTL-9"].route).toBe("restart-fresh");
  });

  test("buildBoardContext defaults strandedMidPipeline to {} when green (shadow-safe)", () => {
    const b = board({ ticketsById: one({ updatedAt: at(2) }) });
    const ctx = buildBoardContext(b, evaluateInvariants(b));
    expect(ctx.strandedMidPipeline).toEqual({});
  });
});

// ─── CTL-1644: getStrandedEvidence off-gate ──────────────────────────────────
describe("CTL-1644 off-gate — getStrandedEvidence never invoked in off mode", () => {
  test("assembleBoardState(mode:off) NEVER invokes getStrandedEvidence", () => {
    let called = 0;
    const b = assembleBoardState({
      orchDir: "/tmp/x",
      getBoard: () => [],
      getWorkerSignals: () => [],
      getEligible: () => [],
      getStrandedEvidence: () => { called += 1; return new Map([["CTL-9", {}]]); },
      mode: "off",
      now: () => NOW,
    });
    expect(called).toBe(0);
    expect(b.strandedEvidence.size).toBe(0);
  });

  test("assembleBoardState(mode:shadow) DOES invoke getStrandedEvidence", () => {
    let called = 0;
    assembleBoardState({
      orchDir: "/tmp/x",
      getBoard: () => [],
      getWorkerSignals: () => [],
      getEligible: () => [],
      getStrandedEvidence: () => { called += 1; return new Map(); },
      mode: "shadow",
      now: () => NOW,
    });
    expect(called).toBe(1);
  });
});

// ─── CTL-1608 checkStalledPr — review-latency / CI-health / no-push ──────────
function mkStalledPrMap(rows = []) {
  const map = new Map();
  for (const r of rows) map.set(r.ticket, { state: "OPEN", ...r });
  return map;
}

describe("CTL-1608 checkStalledPr — review/CI/no-push staleness, liveness-independent", () => {
  const DAY = 24 * HOUR;
  const openPrTicket = (id) => new Map([[id, { identifier: id, linear_state: "In Review", pr_number: 1 }]]);

  test("empty map → observable:false (shadow-first seam)", () => {
    const r = evaluateInvariants(mkBoard({ stalledPrMap: new Map() }), { mode: "shadow" });
    expect(r.stalledPr.observable).toBe(false);
    expect(r.stalledPr.ok).toBe(true);
  });

  test("CI failing past threshold → flagged", () => {
    const r = evaluateInvariants(mkBoard({
      ticketsById: openPrTicket("CTL-CI"),
      stalledPrMap: mkStalledPrMap([
        { ticket: "CTL-CI", prNumber: 1, ciFirstFailedAt: new Date(NOW - 3 * DAY).toISOString() },
      ]),
    }), { mode: "shadow" });
    expect(r.stalledPr.flagged).toContain("CTL-CI");
    expect(r.stalledPr.ok).toBe(false);
  });

  test("review requested past threshold → flagged", () => {
    const r = evaluateInvariants(mkBoard({
      ticketsById: openPrTicket("CTL-RV"),
      stalledPrMap: mkStalledPrMap([
        { ticket: "CTL-RV", prNumber: 1, reviewRequestedAt: new Date(NOW - 5 * DAY).toISOString() },
      ]),
    }), { mode: "shadow" });
    expect(r.stalledPr.flagged).toContain("CTL-RV");
  });

  test("no push past threshold → flagged", () => {
    const r = evaluateInvariants(mkBoard({
      ticketsById: openPrTicket("CTL-NP"),
      stalledPrMap: mkStalledPrMap([
        { ticket: "CTL-NP", prNumber: 1, lastPushAt: new Date(NOW - 8 * DAY).toISOString() },
      ]),
    }), { mode: "shadow" });
    expect(r.stalledPr.flagged).toContain("CTL-NP");
  });

  test("flags EVEN WITH a live worker (independent of worker liveness — the ticket's whole point)", () => {
    const r = evaluateInvariants(mkBoard({
      ticketsById: openPrTicket("CTL-LIVE"),
      signals: [{ ticket: "CTL-LIVE", phase: "monitor-merge", status: "running" }],
      stalledPrMap: mkStalledPrMap([
        { ticket: "CTL-LIVE", prNumber: 1, ciFirstFailedAt: new Date(NOW - 3 * DAY).toISOString() },
      ]),
    }), { mode: "shadow" });
    expect(r.stalledPr.flagged).toContain("CTL-LIVE"); // orphanedOpenPr would EXCLUDE this
  });

  test("fresh stall (under threshold) → not flagged", () => {
    const r = evaluateInvariants(mkBoard({
      ticketsById: openPrTicket("CTL-FRESH"),
      stalledPrMap: mkStalledPrMap([
        { ticket: "CTL-FRESH", prNumber: 1, ciFirstFailedAt: new Date(NOW - 1 * HOUR).toISOString() },
      ]),
    }), { mode: "shadow" });
    expect(r.stalledPr.flagged).not.toContain("CTL-FRESH");
    expect(r.stalledPr.ok).toBe(true);
  });

  test("null stamps → not flagged (CI green / review arrived / recently pushed)", () => {
    const r = evaluateInvariants(mkBoard({
      ticketsById: openPrTicket("CTL-OK"),
      stalledPrMap: mkStalledPrMap([
        { ticket: "CTL-OK", prNumber: 1, ciFirstFailedAt: null, reviewRequestedAt: null, lastPushAt: null },
      ]),
    }), { mode: "shadow" });
    expect(r.stalledPr.flagged).not.toContain("CTL-OK");
  });

  test("terminal Linear state → skipped (no recovery anchor on finished work)", () => {
    const r = evaluateInvariants(mkBoard({
      ticketsById: new Map([["CTL-DONE", { identifier: "CTL-DONE", linear_state: "Done", pr_number: 1 }]]),
      stalledPrMap: mkStalledPrMap([
        { ticket: "CTL-DONE", prNumber: 1, ciFirstFailedAt: new Date(NOW - 9 * DAY).toISOString() },
      ]),
    }), { mode: "shadow" });
    expect(r.stalledPr.flagged).not.toContain("CTL-DONE");
  });

  test("proposeMoves → tier1 nudge-stalled-pr for a flagged ticket", () => {
    const invs = evaluateInvariants(mkBoard({
      ticketsById: openPrTicket("CTL-CI"),
      stalledPrMap: mkStalledPrMap([
        { ticket: "CTL-CI", prNumber: 1, ciFirstFailedAt: new Date(NOW - 3 * DAY).toISOString() },
      ]),
    }), { mode: "shadow" });
    const moves = proposeMoves(invs, mkBoard());
    expect(moves.tier1.find((m) => m.ticket === "CTL-CI" && m.move === "nudge-stalled-pr")).toBeTruthy();
  });

  test("parked-by-human label suppresses the stalled-pr move (stays visible in the invariant)", () => {
    // CTL-1552: suppression is label-only (the env-var sanctionedNeedsHuman latch
    // this test used before Phase 3 no longer exists) — a parked ticket carries
    // BOTH the open-PR shape checkStalledPr needs AND the parked-by-human label
    // makeSuppressed reads.
    const parkedOpenPr = new Map([
      ["CTL-CI", { identifier: "CTL-CI", linear_state: "In Review", pr_number: 1, labels: [{ name: "parked-by-human" }] }],
    ]);
    const invs = evaluateInvariants(mkBoard({
      ticketsById: openPrTicket("CTL-CI"),
      stalledPrMap: mkStalledPrMap([
        { ticket: "CTL-CI", prNumber: 1, ciFirstFailedAt: new Date(NOW - 3 * DAY).toISOString() },
      ]),
    }), { mode: "shadow" });
    const moves = proposeMoves(invs, mkBoard({ ticketsById: parkedOpenPr }));
    expect(moves.tier1.find((m) => m.ticket === "CTL-CI")).toBeFalsy();
    expect(invs.stalledPr.flagged).toContain("CTL-CI"); // suppression is in proposeMoves ONLY
  });

  test("buildBoardContext surfaces stalledPrs additively", () => {
    const invs = evaluateInvariants(mkBoard({
      ticketsById: openPrTicket("CTL-CI"),
      stalledPrMap: mkStalledPrMap([
        { ticket: "CTL-CI", prNumber: 1, ciFirstFailedAt: new Date(NOW - 3 * DAY).toISOString() },
      ]),
    }), { mode: "shadow" });
    const ctx = buildBoardContext(mkBoard(), invs);
    expect(ctx.stalledPrs).toContain("CTL-CI");
  });
});
// ─── CTL-1649: triageLaunchFailureOnlyTickets + selectAnchorCandidates exclusion ─

describe("assembleBoardState — attentionReason on signals (CTL-1649)", () => {
  test("attentionReason from s.raw?.attentionReason is carried on the normalised signal", () => {
    const board = assembleBoardState({
      getWorkerSignals: () => [
        { ticket: "CTL-1", phase: "triage", status: "stalled", raw: { attentionReason: "sdk-overloaded-exhausted" } },
      ],
    });
    expect(board.signals[0].attentionReason).toBe("sdk-overloaded-exhausted");
  });

  test("attentionReason from s.attentionReason (flat) is carried when raw is absent", () => {
    const board = assembleBoardState({
      getWorkerSignals: () => [
        { ticket: "CTL-2", phase: "triage", status: "stalled", attentionReason: "sdk-launch-failed" },
      ],
    });
    expect(board.signals[0].attentionReason).toBe("sdk-launch-failed");
  });

  test("attentionReason is null when absent on both raw and flat", () => {
    const board = assembleBoardState({
      getWorkerSignals: () => [{ ticket: "CTL-3", phase: "triage", status: "stalled" }],
    });
    expect(board.signals[0].attentionReason).toBeNull();
  });

  test("existing fields (ticket, phase, status, failureReason) are byte-identical (no regression)", () => {
    const board = assembleBoardState({
      getWorkerSignals: () => [
        { ticket: "CTL-4", phase: "implement", status: "running", raw: { failureReason: "timeout" } },
      ],
    });
    const s = board.signals[0];
    expect(s.ticket).toBe("CTL-4");
    expect(s.phase).toBe("implement");
    expect(s.status).toBe("running");
    expect(s.failureReason).toBe("timeout");
  });
});

describe("assembleBoardState — triageLaunchFailureOnlyTickets (CTL-1649)", () => {
  const launchFailSig = (ticket, overrides = {}) => ({
    ticket,
    phase: "triage",
    status: "stalled",
    attentionReason: "sdk-overloaded-exhausted",
    ...overrides,
  });

  test("Scenario 1: triage launch-failure ticket with no artifact → IN the set (hasTriageArtifact returns false)", () => {
    const board = assembleBoardState({
      getWorkerSignals: () => [launchFailSig("CTL-1")],
      hasTriageArtifact: () => false,
    });
    expect(board.triageLaunchFailureOnlyTickets instanceof Set).toBe(true);
    expect(board.triageLaunchFailureOnlyTickets.has("CTL-1")).toBe(true);
  });

  test("Scenario 2: same ticket but hasTriageArtifact returns true → NOT in the set (real triage completed)", () => {
    const board = assembleBoardState({
      getWorkerSignals: () => [launchFailSig("CTL-1")],
      hasTriageArtifact: () => true,
    });
    expect(board.triageLaunchFailureOnlyTickets.has("CTL-1")).toBe(false);
  });

  test("Scenario: triage stall without attentionReason → NOT in the set (non-launch triage stall stays actionable)", () => {
    const board = assembleBoardState({
      getWorkerSignals: () => [{ ticket: "CTL-1", phase: "triage", status: "stalled" }],
      hasTriageArtifact: () => false,
    });
    expect(board.triageLaunchFailureOnlyTickets.has("CTL-1")).toBe(false);
  });

  test("Scenario 3: triage launch-failure AND a separate implement stall → NOT in the set (real post-triage work)", () => {
    const board = assembleBoardState({
      getWorkerSignals: () => [
        launchFailSig("CTL-1"),
        { ticket: "CTL-1", phase: "implement", status: "stalled" },
      ],
      hasTriageArtifact: () => false,
    });
    expect(board.triageLaunchFailureOnlyTickets.has("CTL-1")).toBe(false);
  });

  test("with default hasTriageArtifact seam (unbound), set is always empty (shadow-safe)", () => {
    const board = assembleBoardState({
      getWorkerSignals: () => [launchFailSig("CTL-1")],
      // hasTriageArtifact defaults to () => true
    });
    expect(board.triageLaunchFailureOnlyTickets.size).toBe(0);
  });

  test("a ticket in the set with needs_human status variant is also excluded", () => {
    const board = assembleBoardState({
      getWorkerSignals: () => [{
        ticket: "CTL-1", phase: "triage", status: "needs_human",
        attentionReason: "sdk-launch-failed",
      }],
      hasTriageArtifact: () => false,
    });
    expect(board.triageLaunchFailureOnlyTickets.has("CTL-1")).toBe(true);
  });
});

describe("selectAnchorCandidates — CTL-1649 triage-launch-failure exclusion", () => {
  const launchFailBoard = (ticket, extraSignals = []) =>
    assembleBoardState({
      getWorkerSignals: () => [
        { ticket, phase: "triage", status: "stalled", attentionReason: "sdk-overloaded" },
        ...extraSignals,
      ],
      hasTriageArtifact: () => false,
    });

  test("Acceptance 2: a tier-1 holistic-triage move for a launch-failure-only ticket is ABSENT from candidates", () => {
    const board = launchFailBoard("CTL-1");
    const moves = { tier1: [{ ticket: "CTL-1" }], tier2: [], tier3: [] };
    const out = selectAnchorCandidates(moves, board);
    expect(out).not.toContain("CTL-1");
  });

  test("Acceptance 3: a ticket with triage artifact (completed triage) + stalled implement → STILL a candidate", () => {
    const board = assembleBoardState({
      getWorkerSignals: () => [
        { ticket: "CTL-2", phase: "triage", status: "stalled", attentionReason: "sdk-overloaded" },
        { ticket: "CTL-2", phase: "implement", status: "stalled" },
      ],
      hasTriageArtifact: () => false, // no artifact, but the other-stuck signal removes it from exclusion
    });
    const moves = { tier1: [{ ticket: "CTL-2" }], tier2: [], tier3: [] };
    const out = selectAnchorCandidates(moves, board);
    expect(out).toContain("CTL-2");
  });

  test("with empty exclusion set (unbound seam), output is byte-identical to today", () => {
    // Use assembleBoardState with default seam → triageLaunchFailureOnlyTickets is empty
    const board = assembleBoardState({
      getWorkerSignals: () => [{ ticket: "CTL-3", phase: "triage", status: "stalled", attentionReason: "sdk" }],
      // default hasTriageArtifact → () => true → exclusion set empty
    });
    const moves = { tier1: [{ ticket: "CTL-3" }], tier2: [], tier3: [] };
    const out = selectAnchorCandidates(moves, board);
    expect(out).toContain("CTL-3"); // NOT excluded — byte-identical to pre-CTL-1649
  });

  test("exclusion applies across all source lists (tier1, tier2, eligible, deferred)", () => {
    const board = assembleBoardState({
      getWorkerSignals: () => [
        { ticket: "CTL-EXCL", phase: "triage", status: "stalled", attentionReason: "sdk" },
      ],
      hasTriageArtifact: () => false,
      eligible: [{ identifier: "CTL-EXCL" }],
      getDeferredBoardHealthTickets: () => ["CTL-EXCL"],
    });
    const moves = {
      tier1: [{ ticket: "CTL-EXCL" }],
      tier2: [{ ticket: "CTL-EXCL" }],
      tier3: [],
    };
    const out = selectAnchorCandidates(moves, board);
    expect(out).not.toContain("CTL-EXCL");
  });
});

describe("boardHealthPass enforce — launch-failure exclusion prevents recovery-pass dispatch (CTL-1649)", () => {
  test("when the sole flagged ticket is a launch-failure-only ticket, act is NOT invoked", () => {
    let actInvoked = false;
    boardHealthPass({
      mode: "enforce",
      lastRunMs: 0,
      intervalMs: 0,
      now: () => NOW,
      emit: () => {},
      act: (ctx) => {
        // selectAnchorCandidates should return [] (the ticket is excluded),
        // so act's candidates array is empty and it returns no-owned-anchor.
        actInvoked = ctx.candidates && ctx.candidates.length > 0;
        return { dispatched: false, anchor: null, skippedReason: "no-owned-anchor" };
      },
      getWorkerSignals: () => [
        { ticket: "CTL-EXCL", phase: "triage", status: "stalled", attentionReason: "sdk-overloaded" },
      ],
      hasTriageArtifact: () => false,
      // The invariant must fire so the gate proceeds
      capacity: { maxParallel: 4, liveCount: 0, freeSlots: 4 },
      eligible: [{ identifier: "CTL-EXCL", state: "Todo" }],
    });
    expect(actInvoked).toBe(false);
  });
});

describe("CAT-57 host-scoped board health", () => {
  test("recovery anchors do not re-home an offline peer's raw-roster slice outside holistic failover", () => {
    const b = mkOwnedBoard({
      roster: ["mini", "offline"],
      dispatchRoster: ["mini"],
      eligible: [],
      owner: (_ticket, roster) => roster.includes("offline") ? "offline" : "mini",
    });
    const moves = { tier1: [{ ticket: "CAT-PEER" }], tier2: [], tier3: [] };
    expect(selectAnchorCandidates(moves, b)).toEqual([]);
    expect(selectAnchorCandidates(moves, b, {
      holistic: true,
      strandedOrDeadHosts: new Set(["offline"]),
    })).toEqual(["CAT-PEER"]);
  });

  test("makeOwnsFilter defaults to raw roster, supports dispatch scope, and fails open", () => {
    const seen = [];
    const b = mkOwnedBoard({
      roster: ["mini", "stale"],
      dispatchRoster: ["mini", "peer"],
      owner: (_ticket, roster) => { seen.push(roster); return "mini"; },
    });
    expect(makeOwnsFilter(b)("CAT-57")).toBe(true);
    expect(makeOwnsFilter(b, { scope: "dispatch" })("CAT-57")).toBe(true);
    expect(seen).toEqual([["mini", "stale"], ["mini", "peer"]]);
    expect(makeOwnsFilter(mkOwnedBoard({ owner: () => { throw new Error("hrw"); } }))("CAT-57")).toBe(true);
  });

  test("resolveRosterSeam resolves arrays/thunks and falls back on invalid/throw", () => {
    const fallback = ["mini"];
    expect(resolveRosterSeam(["peer"], fallback)).toEqual(["peer"]);
    expect(resolveRosterSeam(() => ["peer"], fallback)).toEqual(["peer"]);
    expect(resolveRosterSeam(null, fallback)).toBe(fallback);
    expect(resolveRosterSeam(() => { throw new Error("down"); }, fallback)).toBe(fallback);
  });

  test("dispatch liveness judges only this host's eligible share and reports both depths", () => {
    const foreign = mkOwnedBoard({
      eligible: [{ id: "CAT-FOREIGN" }],
      owner: () => "peer",
      capacity: { freeSlots: 4 },
      ring: { recentDispatchTs: null },
    });
    expect(evaluateInvariants(foreign).dispatchLiveness).toMatchObject({
      ok: true, queuedTotal: 1, queuedOwned: 0, flagged: [],
    });
    const owned = mkOwnedBoard({
      eligible: [{ id: "CAT-OWNED" }, { id: "CAT-FOREIGN" }],
      owner: (id) => id === "CAT-OWNED" ? "mini" : "peer",
      capacity: { freeSlots: 4 }, ring: { recentDispatchTs: null },
    });
    expect(evaluateInvariants(owned).dispatchLiveness).toMatchObject({
      ok: false, queuedTotal: 2, queuedOwned: 1, flagged: ["CAT-OWNED"],
    });
  });

  test("deriveRing ignores a peer-stamped dispatch but accepts unattributed/local dispatch", () => {
    const event = (host) => ({
      attributes: { "event.name": "phase.dispatch.launched.CAT-1" },
      resource: host ? { "host.name": host } : {},
      ts: new Date(NOW - MIN).toISOString(),
    });
    const base = { self: "mini", now: () => NOW };
    expect(assembleBoardState({ ...base, readEventRing: () => [event("peer")] }).ring.recentDispatchTs).toBeNull();
    expect(assembleBoardState({ ...base, readEventRing: () => [event()] }).ring.recentDispatchTs).toBe(NOW - MIN);
    expect(assembleBoardState({ ...base, readEventRing: () => [event("mini")] }).ring.recentDispatchTs).toBe(NOW - MIN);
  });

  test("context and scan expose additive owned eligible depth", () => {
    const b = mkOwnedBoard({ eligible: [{ id: "A" }, { id: "B" }], owner: (id) => id === "A" ? "mini" : "peer" });
    const invs = evaluateInvariants(b);
    const ctx = buildBoardContext(b, invs);
    expect(ctx.schema).toBe("recovery-board-context/v4");
    expect(ctx.eligibleQueue).toMatchObject({ depth: 2, topTickets: ["A", "B"], ownedDepth: 1, ownedTopTickets: ["A"] });
    const event = buildBoardScanEvent({ mode: "shadow", invariants: invs, decision: decideBoardHealth(invs, b), board: b });
    expect(event.details.eligibleOwnedDepth).toBe(1);
  });
});

describe("CAT-57 nodeProductivity invariant", () => {
  const stale = new Date(NOW - 48 * HOUR).toISOString();
  const fresh = new Date(NOW - HOUR).toISOString();
  const seen = new Date(NOW - 30_000).toISOString();
  const productivityBoard = (o = {}) => mkOwnedBoard({
    ticketsById: new Map([["CAT-PEER", { identifier: "CAT-PEER" }]]),
    owner: () => "peer",
    productivityMode: "enforce",
    peerProductivity: { peer: { last_seen: seen, last_advance_at: stale } },
    ...o,
  });

  test("flags only live peers with owned work and stale advances", () => {
    const bad = evaluateInvariants(productivityBoard()).nodeProductivity;
    expect(bad).toMatchObject({ ok: false, failed: 1, flagged: ["peer"], observable: true });
    expect(evaluateInvariants(productivityBoard({ peerProductivity: { peer: { last_seen: seen, last_advance_at: fresh } } })).nodeProductivity.flagged).toEqual([]);
    expect(evaluateInvariants(productivityBoard({ owner: () => "mini" })).nodeProductivity.flagged).toEqual([]);
    expect(evaluateInvariants(productivityBoard({ peerProductivity: { peer: { last_seen: stale, last_advance_at: stale } } })).nodeProductivity.flagged).toEqual([]);
    expect(evaluateInvariants(productivityBoard({ peerProductivity: { peer: { last_seen: seen } } })).nodeProductivity.flagged).toEqual([]);
  });

  test("mode and seam gates are fail-open; self is never judged", () => {
    for (const mode of ["off", "shadow"]) {
      const r = evaluateInvariants(productivityBoard({ productivityMode: mode })).nodeProductivity;
      expect(r.observable).toBe(false);
      expect(r.note.length).toBeGreaterThan(0);
    }
    expect(evaluateInvariants(productivityBoard({ peerProductivity: null })).nodeProductivity.observable).toBe(false);
    expect(evaluateInvariants(productivityBoard({ peerProductivity: {} })).nodeProductivity.observable).toBe(false);
    expect(evaluateInvariants(productivityBoard({ roster: ["mini"] })).nodeProductivity.observable).toBe(false);
    expect(evaluateInvariants(productivityBoard({ ticketsById: new Map([["SELF", {}]]), owner: () => "mini", peerProductivity: { mini: { last_seen: seen, last_advance_at: stale } } })).nodeProductivity.flagged).toEqual([]);
    expect(evaluateInvariants(productivityBoard({ owner: () => { throw new Error("hrw"); } })).nodeProductivity.observable).toBe(false);
  });

  test("is tier3-only, non-actionable, and included in context/event", () => {
    const b = productivityBoard();
    const invs = evaluateInvariants(b);
    const moves = proposeMoves(invs, b);
    expect(moves.tier3).toContainEqual(expect.objectContaining({ host: "peer", move: "escalate-unproductive-node" }));
    expect(moves.tier1.some((m) => m.move === "escalate-unproductive-node")).toBe(false);
    expect(moves.tier2.some((m) => m.move === "escalate-unproductive-node")).toBe(false);
    expect(decideBoardHealth({ nodeProductivity: invs.nodeProductivity }, b).gate).toMatchObject({ decision: "skip", reason: "no-actionable-moves" });
    expect(buildBoardContext(b, invs).unproductiveNodes).toEqual([{ host: "peer", lastAdvanceAt: stale, ageMs: 48 * HOUR, ownedTickets: ["CAT-PEER"] }]);
    const ev = buildBoardScanEvent({ mode: "shadow", invariants: invs, decision: decideBoardHealth(invs, b), board: b });
    expect(ev.details.unproductiveNodeCount).toBe(1);
  });

  // CAT-57 (Codex P1): shadow used to pass [] as `flagged`, so both telemetry
  // sinks derived from it read 0/empty and a shadow scan that DID detect an
  // unproductive peer was indistinguishable from a healthy one — the shadow-first
  // observation period observed nothing.
  test("shadow REPORTS the detected peers without actuating on them", () => {
    const b = productivityBoard({ productivityMode: "shadow" });
    const invs = evaluateInvariants(b);
    const r = invs.nodeProductivity;

    // Detection is preserved and reaches BOTH telemetry sinks...
    expect(r.flagged).toEqual(["peer"]);
    expect(r.unproductive.peer).toMatchObject({ ageMs: 48 * HOUR, ownedTickets: ["CAT-PEER"] });
    expect(buildBoardContext(b, invs).unproductiveNodes).toEqual([
      { host: "peer", lastAdvanceAt: stale, ageMs: 48 * HOUR, ownedTickets: ["CAT-PEER"] },
    ]);
    expect(
      buildBoardScanEvent({ mode: "shadow", invariants: invs, decision: decideBoardHealth(invs, b), board: b })
        .details.unproductiveNodeCount,
    ).toBe(1);

    // ...while staying strictly non-actuating: ok stays true and observable false,
    // so proposeMoves' `!ok` gate yields no tier-3 escalate.
    expect(r).toMatchObject({ ok: true, failed: 0, observable: false });
    expect(proposeMoves(invs, b).tier3.some((m) => m.move === "escalate-unproductive-node")).toBe(false);
  });

  // CAT-57 (Codex P2): the board snapshot retains Done/Canceled rows, so a peer
  // whose entire HRW share has already shipped must not count as owning work.
  test("terminal tickets are not part of a peer's owned share", () => {
    for (const state of ["Done", "Canceled", "Duplicate", "Merged"]) {
      const r = evaluateInvariants(productivityBoard({
        ticketsById: new Map([["CAT-PEER", { identifier: "CAT-PEER", state }]]),
      })).nodeProductivity;
      expect(r.flagged).toEqual([]);
    }
    // Non-vacuity: the identical fixture in a NON-terminal state is still flagged,
    // and a peer keeps its share when only SOME of its tickets are terminal.
    expect(evaluateInvariants(productivityBoard({
      ticketsById: new Map([["CAT-PEER", { identifier: "CAT-PEER", state: "In Progress" }]]),
    })).nodeProductivity.flagged).toEqual(["peer"]);
    expect(evaluateInvariants(productivityBoard({
      ticketsById: new Map([
        ["CAT-DONE", { identifier: "CAT-DONE", state: "Done" }],
        ["CAT-PEER", { identifier: "CAT-PEER", state: "Todo" }],
      ]),
    })).nodeProductivity.unproductive.peer.ownedTickets).toEqual(["CAT-PEER"]);
  });

  test("off omits key and never reads productivity seam", () => {
    expect(evaluateInvariants(productivityBoard({ mode: "off" }), { mode: "off" }).nodeProductivity).toBeUndefined();
    let called = 0;
    expect(() => assembleBoardState({ mode: "off", productivityMode: "enforce", getPeerProductivity: () => { called += 1; throw new Error("must not run"); } })).not.toThrow();
    expect(called).toBe(0);
  });
});
