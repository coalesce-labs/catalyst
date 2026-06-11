// worker-burn-data.test.ts — units for the worker Burn Strip derivations
// (CTL-917 / DETAIL6). Each describe maps to a Gherkin scenario in the DETAIL6
// ticket spec; the strip's acceptance surface is these pure functions.
//
// Pure module — no DOM (mirrors worker-detail-data.test.ts style). Run from ui:
//   cd ui && bun test src/board/worker-burn-data.test.ts
import { describe, it, expect } from "bun:test";
import {
  buildBurnTiles,
  deriveIdleRatio,
  deriveActivityBuckets,
  activityHasData,
  inferBucketWidthSeconds,
  DEFAULT_BUCKET_WIDTH_SECONDS,
  seriesIsLive,
  seriesLast,
  type WorkerBurnSeries,
  type SparklinePoint,
} from "./worker-burn-data";
import type { BoardWorker } from "./types";

function worker(over: Partial<BoardWorker>): BoardWorker {
  return {
    name: "CTL-845:2",
    ticket: "CTL-845",
    tickets: ["CTL-845"],
    phase: "implement",
    status: "running",
    activeState: "active",
    working: true,
    lastActiveMs: Date.now() - 5000,
    repo: "plugins/dev",
    team: "CTL",
    runtimeMs: 842_000, // 14m02s
    costUSD: 0.84,
    sessionId: "7f3a91ab-cdef-4012-89ab-cdef01234567",
    ...over,
  };
}

const liveSeries: WorkerBurnSeries = {
  cost: [[100, 0.4], [160, 0.84]],
  tokens: [[100, 318000], [160, 412000]],
  tokensByType: { input: [[160, 318000]], output: [[160, 94000]] },
  activeSeconds: [[100, 600], [160, 708]],
};

// ── Scenario: Worker Burn Strip renders REAL Prometheus sparklines ───────────
describe("Scenario: Worker Burn Strip renders REAL Prometheus sparklines", () => {
  it("COST/TOKENS/ACTIVE each render a query_range sparkline keyed on the session", () => {
    const tiles = buildBurnTiles(liveSeries, worker({}));
    const byLabel = Object.fromEntries(tiles.map((t) => [t.label, t]));
    expect(byLabel["COST"].source).toBe("sparkline");
    expect(byLabel["COST"].points).toEqual([[100, 0.4], [160, 0.84]]);
    expect(byLabel["COST"].value).toBe(0.84);
    expect(byLabel["TOKENS"].source).toBe("sparkline");
    expect(byLabel["TOKENS"].value).toBe(412000);
    expect(byLabel["ACTIVE"].source).toBe("sparkline");
    expect(byLabel["ACTIVE"].value).toBe(708);
  });

  it("the idle-ratio bar = active_time ÷ runtimeMs, a shrinking fraction the stuck-tell", () => {
    // active 708s of an 842s wall → ~0.84 (the design's 84% example).
    const ratio = deriveIdleRatio(liveSeries.activeSeconds, 842_000);
    expect(ratio.activeSeconds).toBe(708);
    expect(ratio.wallSeconds).toBeCloseTo(842);
    expect(ratio.fraction).toBeCloseTo(0.84, 2);
  });

  it("clamps the idle-ratio to [0,1] (an active>wall rounding artefact never reads >100%)", () => {
    const ratio = deriveIdleRatio([[0, 900]], 842_000);
    expect(ratio.fraction).toBe(1);
  });

  it("dims the idle-ratio (null fraction) when runtime is missing — never a fabricated bar", () => {
    expect(deriveIdleRatio(liveSeries.activeSeconds, null).fraction).toBeNull();
    expect(deriveIdleRatio(liveSeries.activeSeconds, 0).fraction).toBeNull();
    expect(deriveIdleRatio(null, 842_000).fraction).toBeNull();
  });
});

// ── Scenario: Just-spawned worker falls back to scalars, never blank ─────────
describe("Scenario: Just-spawned worker falls back to scalars, never blank", () => {
  it("a flat (all-zero) cost series falls back to BoardWorker.costUSD with a (live in …) hint", () => {
    const flat: WorkerBurnSeries = {
      cost: [[100, 0], [160, 0]],
      tokens: [],
      tokensByType: {},
      activeSeconds: [],
    };
    const tiles = buildBurnTiles(flat, worker({ costUSD: 0.05 }));
    const cost = tiles.find((t) => t.label === "COST")!;
    expect(cost.source).toBe("scalar-fallback");
    expect(cost.value).toBe(0.05); // the resident scalar, never blank
    expect(cost.points).toEqual([]); // no sparkline drawn
    expect(cost.hint).toBeTruthy(); // the honest "(live in …)" hint
  });

  it("an absent series object (endpoint 503 / no session id) still falls back, never null tile", () => {
    const tiles = buildBurnTiles(null, worker({ costUSD: 0.84 }));
    const cost = tiles.find((t) => t.label === "COST")!;
    expect(cost.source).toBe("scalar-fallback");
    expect(cost.value).toBe(0.84);
  });

  it("TOKENS has no resident scalar on BoardWorker → falls back to null (honest), never faked", () => {
    const tiles = buildBurnTiles(null, worker({}));
    const tokens = tiles.find((t) => t.label === "TOKENS")!;
    expect(tokens.source).toBe("scalar-fallback");
    expect(tokens.value).toBeNull();
  });
});

// ── Scenario: Counters stay honest to their source ───────────────────────────
describe("Scenario: Counters stay honest to their source", () => {
  it("COMMITS is NEEDS-PLUMBING (git-sourced, no session_id Prometheus series)", () => {
    const tiles = buildBurnTiles(liveSeries, worker({}));
    const commits = tiles.find((t) => t.label === "COMMITS")!;
    expect(commits.source).toBe("needs-plumbing");
    expect(commits.value).toBeNull(); // never a fabricated count
    expect(commits.points).toEqual([]);
  });
});

// ── Scenario: Idle-vs-working timeline (Pass B §5B) ──────────────────────────
// GROUND-TRUTH: the live activeSeconds series is per-bucket and NON-MONOTONIC,
// and a bucket can OVER-report (>60s against a 60s wall) when a worker's summed
// session streams reset — so we clamp working to [0, width] and never read >100%.
describe("Scenario: idle-vs-working timeline buckets", () => {
  it("infers the bucket width from the first adjacent timestamp gap (60s)", () => {
    expect(inferBucketWidthSeconds([[100, 5], [160, 9], [220, 3]])).toBe(60);
  });

  it("falls back to the default width when <2 points or a bad gap", () => {
    expect(inferBucketWidthSeconds([])).toBe(DEFAULT_BUCKET_WIDTH_SECONDS);
    expect(inferBucketWidthSeconds([[100, 5]])).toBe(DEFAULT_BUCKET_WIDTH_SECONDS);
    expect(inferBucketWidthSeconds([[100, 5], [100, 9]])).toBe(DEFAULT_BUCKET_WIDTH_SECONDS);
  });

  it("splits each bucket into working + idle that sum to the wall width", () => {
    // 19s active of a 60s bucket → 19 working / 41 idle.
    const buckets = deriveActivityBuckets([[100, 19.1], [160, 79.3]]);
    expect(buckets).toHaveLength(2);
    expect(buckets[0].workingSeconds).toBeCloseTo(19.1, 1);
    expect(buckets[0].idleSeconds).toBeCloseTo(40.9, 1);
    expect(buckets[0].workingSeconds + buckets[0].idleSeconds).toBeCloseTo(60, 5);
  });

  it("CLAMPS an over-report (active>width) to fully-working, zero idle (never >100%)", () => {
    // Observed live: a 197s reading against a 60s bucket — clamp to 60 working.
    const buckets = deriveActivityBuckets([[100, 197.2], [160, 32.6]]);
    expect(buckets[0].workingSeconds).toBe(60);
    expect(buckets[0].idleSeconds).toBe(0);
  });

  it("clamps a negative reading to zero working / full idle (never a negative bar)", () => {
    const buckets = deriveActivityBuckets([[100, -5], [160, 30]]);
    expect(buckets[0].workingSeconds).toBe(0);
    expect(buckets[0].idleSeconds).toBe(60);
  });

  it("skips non-finite points rather than zero-filling them", () => {
    const buckets = deriveActivityBuckets([[100, 30], [Number.NaN, 40], [220, 10]]);
    expect(buckets).toHaveLength(2);
    expect(buckets.map((b) => b.t)).toEqual([100, 220]);
  });

  it("an absent / empty series yields [] (the ChartCard shows no-data, not flat bars)", () => {
    expect(deriveActivityBuckets(null)).toEqual([]);
    expect(deriveActivityBuckets(undefined)).toEqual([]);
    expect(deriveActivityBuckets([])).toEqual([]);
  });

  it("activityHasData is true only when some bucket has positive working time", () => {
    expect(activityHasData(null)).toBe(false);
    expect(activityHasData([[100, 0], [160, 0]])).toBe(false);
    expect(activityHasData([[100, 0], [160, 12]])).toBe(true);
  });
});

// ── series predicates ────────────────────────────────────────────────────────
describe("series predicates", () => {
  it("seriesIsLive is true only when a positive point exists", () => {
    expect(seriesIsLive([])).toBe(false);
    expect(seriesIsLive([[0, 0], [60, 0]])).toBe(false);
    expect(seriesIsLive([[0, 0], [60, 0.01]])).toBe(true);
  });

  it("seriesLast returns the final value or null on empty", () => {
    const pts: SparklinePoint[] = [[0, 1], [60, 5]];
    expect(seriesLast(pts)).toBe(5);
    expect(seriesLast([])).toBeNull();
  });
});
