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
