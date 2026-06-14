// finops-breakdowns.test.ts — units for the OBS-11 FINOPS breakdown pure logic
// (finops-breakdowns.ts). The load-bearing honesty invariants:
//   1. rankCostMap applies the MANDATORY zero-series filter (drop usd <= 0) — the
//      caught-a-shipped-bug discipline; a ranked view of raw /api/otel/cost would
//      otherwise render all-zeros garbage.
//   2. toTokenSlices NEVER collapses cache into input — always four fixed buckets.
//   3. concentration ("top 3 = N%") and worstDrift (A8) are honest on empty input.
//
// All pure (no React render), so they run under the ui package's `bun test`:
//   cd ui && bun test src/components/observe/finops-breakdowns.test.ts
import { describe, it, expect } from "bun:test";
import type { CostValidationRow } from "@/lib/types";
import {
  rankCostMap,
  maxUsd,
  totalUsd,
  toTokenSlices,
  hasTokenData,
  compactTokens,
  tokenBucketLabel,
  formatHitRate,
  concentration,
  worstDrift,
  TOKEN_BUCKETS,
  costByWorkType,
} from "./finops-breakdowns";

describe("rankCostMap — the mandatory zero-series filter", () => {
  it("drops exact-0 series and ranks the rest descending", () => {
    // The live /api/otel/cost shape: many exact-0 tickets mixed with real spend.
    const map = {
      "CTL-693": 0,
      "CTL-850": 586.54,
      "CTL-862": 0,
      "CTL-928": 403.91,
      "ADV-1294": 0,
      "CTL-696": 42.71,
    };
    const rows = rankCostMap(map);
    expect(rows.map((r) => r.label)).toEqual(["CTL-850", "CTL-928", "CTL-696"]);
    expect(rows[0]!.usd).toBe(586.54);
    // not a single zero series survived (the all-zeros-garbage guard).
    expect(rows.every((r) => r.usd > 0)).toBe(true);
  });

  it("drops negative and non-finite values too", () => {
    const rows = rankCostMap({ A: -5, B: NaN, C: 10, D: Infinity });
    expect(rows.map((r) => r.label)).toEqual(["C"]);
  });

  it("null / empty map → empty rows (no fabricated row)", () => {
    expect(rankCostMap(null)).toEqual([]);
    expect(rankCostMap({})).toEqual([]);
    // an all-zero map (a quiet window) is honestly empty, not a forest of $0 bars.
    expect(rankCostMap({ A: 0, B: 0 })).toEqual([]);
  });
});

describe("maxUsd + totalUsd", () => {
  it("max is the top row's spend; total sums all", () => {
    const rows = rankCostMap({ A: 100, B: 40, C: 10 });
    expect(maxUsd(rows)).toBe(100);
    expect(totalUsd(rows)).toBe(150);
  });

  it("empty rows → 0 (no divide-by-zero for the bar scale)", () => {
    expect(maxUsd([])).toBe(0);
    expect(totalUsd([])).toBe(0);
  });
});

describe("toTokenSlices — NEVER collapse cache into input", () => {
  // The live /api/otel/tokens shape: cacheRead dwarfs every other bucket.
  const tokens = {
    input: 6_698_817,
    output: 9_259_550,
    cacheRead: 1_326_434_860,
    cacheCreation: 50_556_358,
  };

  it("keeps all four buckets separate, in fixed order", () => {
    const slices = toTokenSlices(tokens);
    expect(slices.map((s) => s.bucket)).toEqual([
      "input",
      "output",
      "cacheRead",
      "cacheCreation",
    ]);
    // cacheRead is its OWN bucket — never folded into input.
    const cacheRead = slices.find((s) => s.bucket === "cacheRead")!;
    const input = slices.find((s) => s.bucket === "input")!;
    expect(cacheRead.tokens).toBe(1_326_434_860);
    expect(input.tokens).toBe(6_698_817);
    expect(cacheRead.tokens).toBeGreaterThan(input.tokens * 100);
  });

  it("shares sum to ~1 and reflect the real split (cacheRead ~96%)", () => {
    const slices = toTokenSlices(tokens);
    const sum = slices.reduce((s, x) => s + x.share, 0);
    expect(sum).toBeCloseTo(1, 6);
    const cacheRead = slices.find((s) => s.bucket === "cacheRead")!;
    expect(cacheRead.share).toBeGreaterThan(0.9);
  });

  it("ALWAYS returns four slices, even for a partial / null map", () => {
    // A map missing two buckets still yields four slices (absent → 0, never dropped).
    const partial = toTokenSlices({ input: 100, output: 50 });
    expect(partial).toHaveLength(4);
    expect(partial.find((s) => s.bucket === "cacheRead")!.tokens).toBe(0);

    const nul = toTokenSlices(null);
    expect(nul).toHaveLength(4);
    expect(nul.every((s) => s.tokens === 0 && s.share === 0)).toBe(true);
  });

  it("TOKEN_BUCKETS is exactly the four canonical buckets", () => {
    expect([...TOKEN_BUCKETS]).toEqual([
      "input",
      "output",
      "cacheRead",
      "cacheCreation",
    ]);
  });
});

describe("hasTokenData", () => {
  it("true when any bucket is positive; false for null / all-zero", () => {
    expect(hasTokenData({ cacheRead: 5 })).toBe(true);
    expect(hasTokenData(null)).toBe(false);
    expect(hasTokenData({ input: 0, output: 0 })).toBe(false);
  });
});

describe("compactTokens + tokenBucketLabel + formatHitRate", () => {
  it("compacts to B/M/k", () => {
    expect(compactTokens(1_326_434_860)).toBe("1.3B");
    expect(compactTokens(50_556_358)).toBe("50.6M");
    expect(compactTokens(9_259)).toBe("9.3k");
    expect(compactTokens(42)).toBe("42");
    expect(compactTokens(NaN)).toBe("0");
  });

  it("labels cache buckets in plain language", () => {
    expect(tokenBucketLabel("cacheRead")).toBe("cache read");
    expect(tokenBucketLabel("cacheCreation")).toBe("cache write");
    expect(tokenBucketLabel("input")).toBe("input");
  });

  it("formats the hit rate; null → '—'", () => {
    expect(formatHitRate(0.994975)).toBe("99.5%");
    expect(formatHitRate(null)).toBe("—");
    expect(formatHitRate(Infinity)).toBe("—");
  });
});

describe("concentration — footer A4 'top 3 = N% of spend'", () => {
  it("computes the top-3 share over ranked rows", () => {
    const rows = rankCostMap({
      "CTL-850": 586,
      "CTL-928": 404,
      "ADV-1121": 314,
      "ADR-0045": 48,
      "CTL-696": 43,
    });
    const c = concentration(rows, 3);
    expect(c.count).toBe(3);
    // (586+404+314) / 1395 ≈ 0.792
    expect(c.share).toBeCloseTo((586 + 404 + 314) / (586 + 404 + 314 + 48 + 43), 4);
    expect(c.totalUsd).toBe(586 + 404 + 314 + 48 + 43);
  });

  it("counts fewer than N honestly when there are fewer tickets", () => {
    const rows = rankCostMap({ A: 10, B: 5 });
    const c = concentration(rows, 3);
    expect(c.count).toBe(2);
    expect(c.share).toBe(1);
  });

  it("empty rows → 0 share / 0 count (footer shows '—')", () => {
    const c = concentration([], 3);
    expect(c).toEqual({ count: 0, share: 0, totalUsd: 0 });
  });
});

describe("costByWorkType — CTL-1040 honest cost-by-type aggregation", () => {
  it("sums costUSD per type", () => {
    const tickets = [
      { type: "feature", costUSD: 2 },
      { type: "feature", costUSD: 3 },
      { type: "bug", costUSD: 1 },
    ];
    expect(costByWorkType(tickets)).toEqual({ feature: 5, bug: 1 });
  });

  it("keeps 'unknown' as an honest bucket, never dropped or renamed", () => {
    const tickets = [
      { type: "unknown", costUSD: 4 },
      { type: "feature", costUSD: 1 },
    ];
    expect(costByWorkType(tickets).unknown).toBe(4);
  });

  it("folds null/absent type into 'unknown' (board uses 'task' fallback)", () => {
    const tickets = [
      { type: "task", costUSD: 2 },
      { type: "", costUSD: 1 },
      { type: null as unknown as string, costUSD: 1 },
    ];
    expect(costByWorkType(tickets).unknown).toBe(4);
  });

  it("treats null/0 costUSD as 0 (no NaN, no negative)", () => {
    const tickets = [
      { type: "docs", costUSD: null },
      { type: "docs", costUSD: 0 },
    ];
    expect(rankCostMap(costByWorkType(tickets))).toEqual([]);
  });

  it("flows through rankCostMap zero-filter (zero-spend types dropped)", () => {
    const map = costByWorkType([
      { type: "feature", costUSD: 5 },
      { type: "chore", costUSD: 0 },
    ]);
    expect(rankCostMap(map)).toEqual([{ label: "feature", usd: 5 }]);
  });
});

describe("worstDrift — footer A8 signal-vs-OTEL data-trust", () => {
  const rows: CostValidationRow[] = [
    { ticket: "CTL-850", signalCost: 580, otelCost: 586, discrepancy: 6 },
    { ticket: "CTL-928", signalCost: 404, otelCost: 404, discrepancy: 0 },
    { ticket: "CTL-696", signalCost: 30, otelCost: 43, discrepancy: 13 },
  ];

  it("picks the largest absolute discrepancy", () => {
    const w = worstDrift(rows);
    expect(w?.ticket).toBe("CTL-696");
    expect(w?.discrepancy).toBe(13);
  });

  it("null / empty → null (footer shows '—', never a fabricated $0)", () => {
    expect(worstDrift(null)).toBeNull();
    expect(worstDrift([])).toBeNull();
  });
});
