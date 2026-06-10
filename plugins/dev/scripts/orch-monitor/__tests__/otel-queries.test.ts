import { describe, it, expect } from "bun:test";
import {
  costByTicket,
  costByTaskType,
  tokensByType,
  cacheHitRate,
  costRateByModel,
  toolUsageByName,
  modelLatency,
  modelLatencyLogQL,
  modelEventCountLogQL,
  toolLatency,
  toolLatencyLogQL,
  apiErrors,
  apiErrorsLogQL,
  recentTail,
  recentTailLogQL,
  eventsHeatmap,
  eventsHeatmapLogQL,
  extractHeatmap,
  HEATMAP_BUCKET_SECONDS,
  costValidation,
  costToday,
  costSeries,
  cacheSavings,
  costAtHour,
  activeTimeRatio,
  scoreSpikes,
  avgPrior7FullDays,
  secondsSinceLocalMidnight,
  inputPricePerToken,
  safeDuration,
  workerHistoryBySession,
  workerHistoryLogQL,
  parseHistoryLine,
  isValidCcSessionId,
} from "../lib/otel-queries";
import type { PrometheusFetcher, PrometheusQueryResult } from "../lib/prometheus";
import type { LokiFetcher, LokiQueryResult } from "../lib/loki";

function mockProm(
  queryResult: PrometheusQueryResult | null,
): PrometheusFetcher {
  return {
    query: () => Promise.resolve(queryResult),
    queryRange: () => Promise.resolve(queryResult),
    isAvailable: () => queryResult !== null,
  };
}

function mockLoki(result: LokiQueryResult | null): LokiFetcher {
  return {
    queryRange: () => Promise.resolve(result),
    isAvailable: () => result !== null,
  };
}

describe("safeDuration", () => {
  it("accepts valid duration strings", () => {
    expect(safeDuration("1h", "1h")).toBe("1h");
    expect(safeDuration("30m", "1h")).toBe("30m");
    expect(safeDuration("5s", "1h")).toBe("5s");
    expect(safeDuration("100ms", "1h")).toBe("100ms");
    expect(safeDuration("7d", "1h")).toBe("7d");
  });

  it("rejects PromQL/LogQL injection attempts", () => {
    expect(safeDuration('1h])) or up or vector(1#', "1h")).toBe("1h");
    expect(safeDuration("1h; drop", "1h")).toBe("1h");
    expect(safeDuration("", "1h")).toBe("1h");
    expect(safeDuration("abc", "5m")).toBe("5m");
    expect(safeDuration("1x", "1h")).toBe("1h");
  });
});

describe("costByTicket", () => {
  it("returns cost map from Prometheus vector result", async () => {
    const prom = mockProm({
      data: {
        resultType: "vector",
        result: [
          { metric: { linear_key: "CTL-39" }, value: [1713100000, "1.234"] },
          { metric: { linear_key: "CTL-40" }, value: [1713100000, "0.567"] },
        ],
      },
    });
    const result = await costByTicket(prom, "1h");
    expect(result).not.toBeNull();
    expect(result!["CTL-39"]).toBeCloseTo(1.234);
    expect(result!["CTL-40"]).toBeCloseTo(0.567);
  });

  // OBS-9: the MANDATORY zero-series filter. increase() returns a series for every
  // ticket that ever carried the metric, most exact-0 in any window (live: ~24 of
  // ~36). A topk/bottomk/table on those renders all-zeros garbage — so costByTicket
  // MUST drop value===0 series at the query layer.
  it("OBS-9: filters out exact-0 ticket series (the zero-series filter)", async () => {
    const prom = mockProm({
      data: {
        resultType: "vector",
        result: [
          { metric: { linear_key: "CTL-850" }, value: [0, "621.0"] },
          { metric: { linear_key: "CTL-ZERO" }, value: [0, "0"] },
          { metric: { linear_key: "CTL-696" }, value: [0, "214.0"] },
          { metric: { linear_key: "CTL-ZERO2" }, value: [0, "0.0"] },
        ],
      },
    });
    const result = await costByTicket(prom, "24h");
    expect(result).not.toBeNull();
    expect(result!["CTL-850"]).toBeCloseTo(621);
    expect(result!["CTL-696"]).toBeCloseTo(214);
    // The two exact-0 tickets are GONE, not present-as-0.
    expect("CTL-ZERO" in result!).toBe(false);
    expect("CTL-ZERO2" in result!).toBe(false);
    expect(Object.keys(result!)).toHaveLength(2);
  });

  it("returns null when Prometheus is unavailable", async () => {
    const result = await costByTicket(mockProm(null), "1h");
    expect(result).toBeNull();
  });

  it("handles empty result set", async () => {
    const prom = mockProm({
      data: { resultType: "vector", result: [] },
    });
    const result = await costByTicket(prom, "1h");
    expect(result).not.toBeNull();
    expect(Object.keys(result!)).toHaveLength(0);
  });
});

describe("tokensByType", () => {
  it("returns token counts by type", async () => {
    const prom = mockProm({
      data: {
        resultType: "vector",
        result: [
          { metric: { type: "input" }, value: [1713100000, "50000"] },
          { metric: { type: "output" }, value: [1713100000, "12000"] },
          { metric: { type: "cacheRead" }, value: [1713100000, "30000"] },
        ],
      },
    });
    const result = await tokensByType(prom, "1h");
    expect(result).not.toBeNull();
    expect(result!["input"]).toBe(50000);
    expect(result!["output"]).toBe(12000);
    expect(result!["cacheRead"]).toBe(30000);
  });

  it("returns null when unavailable", async () => {
    expect(await tokensByType(mockProm(null), "1h")).toBeNull();
  });
});

describe("cacheHitRate", () => {
  it("computes ratio of cacheRead to cacheRead + input", async () => {
    const prom = mockProm({
      data: {
        resultType: "vector",
        result: [
          { metric: { type: "input" }, value: [0, "70000"] },
          { metric: { type: "cacheRead" }, value: [0, "30000"] },
        ],
      },
    });
    const result = await cacheHitRate(prom, "1h");
    expect(result).toBeCloseTo(0.3);
  });

  it("returns 0 when no tokens", async () => {
    const prom = mockProm({
      data: { resultType: "vector", result: [] },
    });
    expect(await cacheHitRate(prom, "1h")).toBe(0);
  });

  it("returns null when unavailable", async () => {
    expect(await cacheHitRate(mockProm(null), "1h")).toBeNull();
  });
});

describe("costRateByModel", () => {
  it("returns cost rate per model", async () => {
    const prom = mockProm({
      data: {
        resultType: "vector",
        result: [
          { metric: { model: "claude-opus-4-6" }, value: [0, "0.015"] },
          { metric: { model: "claude-sonnet-4-6" }, value: [0, "0.003"] },
        ],
      },
    });
    const result = await costRateByModel(prom, "5m");
    expect(result).not.toBeNull();
    expect(result!["claude-opus-4-6"]).toBeCloseTo(0.015);
  });
});

// CTL-495: cost-by-task-type slicing (phase-research vs phase-implement vs
// interactive vs orchestrate, etc.). Mirrors costByTicket shape but uses the
// `task_type` Prom label (underscored conversion of the `task.type` OTEL
// resource-attribute key).
describe("costByTaskType", () => {
  it("returns cost map keyed by task_type", async () => {
    const prom = mockProm({
      data: {
        resultType: "vector",
        result: [
          { metric: { task_type: "phase-research" }, value: [1713100000, "0.91"] },
          { metric: { task_type: "phase-implement" }, value: [1713100000, "4.27"] },
          { metric: { task_type: "interactive" }, value: [1713100000, "0.12"] },
        ],
      },
    });
    const result = await costByTaskType(prom, "1h");
    expect(result).not.toBeNull();
    expect(result!["phase-research"]).toBeCloseTo(0.91);
    expect(result!["phase-implement"]).toBeCloseTo(4.27);
    expect(result!["interactive"]).toBeCloseTo(0.12);
  });

  it("returns null when Prometheus is unavailable", async () => {
    const result = await costByTaskType(mockProm(null), "1h");
    expect(result).toBeNull();
  });

  it("handles empty result set", async () => {
    const prom = mockProm({
      data: { resultType: "vector", result: [] },
    });
    const result = await costByTaskType(prom, "1h");
    expect(result).not.toBeNull();
    expect(Object.keys(result!)).toHaveLength(0);
  });

  // Deliberate redundancy against the data-driven tests above: pin the actual
  // PromQL shape so a refactor that copies costByTicket and forgets to swap
  // `linear_key` → `task_type` in both the `sum by` clause and the selector
  // is caught here even when the mock would otherwise return the desired data.
  it("issues PromQL with `sum by (task_type)` and `task_type=~\".+\"` selector", async () => {
    let capturedQuery = "";
    const emptyResult: PrometheusQueryResult = {
      data: { resultType: "vector", result: [] },
    };
    const prom: PrometheusFetcher = {
      query: (q: string) => {
        capturedQuery = q;
        return Promise.resolve(emptyResult);
      },
      queryRange: () => Promise.resolve(emptyResult),
      isAvailable: () => true,
    };
    await costByTaskType(prom, "1h");
    expect(capturedQuery).toContain("sum by (task_type)");
    expect(capturedQuery).toContain(`task_type=~".+"`);
    expect(capturedQuery).toContain("claude_code_cost_usage_USD_total");
  });

  // OBS-9: by-stage gets the same zero-series filter — live, ~5 of 12 task_types
  // are exact-0 over 24h and must not render as empty phases in the P-B bar.
  it("OBS-9: filters out exact-0 task_type series", async () => {
    const prom = mockProm({
      data: {
        resultType: "vector",
        result: [
          { metric: { task_type: "interactive" }, value: [0, "1382.05"] },
          { metric: { task_type: "phase-triage" }, value: [0, "0"] },
          { metric: { task_type: "phase-research" }, value: [0, "39.21"] },
          { metric: { task_type: "phase-pr" }, value: [0, "0.0"] },
        ],
      },
    });
    const result = await costByTaskType(prom, "24h");
    expect(result).not.toBeNull();
    expect(result!["interactive"]).toBeCloseTo(1382.05);
    expect(result!["phase-research"]).toBeCloseTo(39.21);
    expect("phase-triage" in result!).toBe(false);
    expect("phase-pr" in result!).toBe(false);
    expect(Object.keys(result!)).toHaveLength(2);
  });
});

// ── OBS-9 (FINOPS) ───────────────────────────────────────────────────────────

/** A Prometheus mock that returns DIFFERENT results for `query` vs `queryRange`
 *  (the today-vs-7d hero fires both), and records every PromQL it sees. */
function mockPromSplit(opts: {
  query?: PrometheusQueryResult | null;
  queryRange?: PrometheusQueryResult | null;
}): { prom: PrometheusFetcher; queries: string[]; ranges: string[] } {
  const queries: string[] = [];
  const ranges: string[] = [];
  const prom: PrometheusFetcher = {
    query: (q: string) => {
      queries.push(q);
      return Promise.resolve(opts.query ?? null);
    },
    queryRange: (q: string) => {
      ranges.push(q);
      return Promise.resolve(opts.queryRange ?? null);
    },
    isAvailable: () => true,
  };
  return { prom, queries, ranges };
}

describe("secondsSinceLocalMidnight", () => {
  it("returns whole seconds elapsed since local midnight", () => {
    const noon = new Date(2026, 5, 10, 12, 0, 0); // local 12:00:00
    expect(secondsSinceLocalMidnight(noon)).toBe(12 * 3600);
    const t = new Date(2026, 5, 10, 1, 2, 3); // 01:02:03
    expect(secondsSinceLocalMidnight(t)).toBe(3723);
  });

  it("clamps to a 1s floor so the today window is never 0-width", () => {
    const midnight = new Date(2026, 5, 10, 0, 0, 0);
    expect(secondsSinceLocalMidnight(midnight)).toBe(1);
  });
});

describe("avgPrior7FullDays", () => {
  it("averages the prior full days, EXCLUDING the current partial day", () => {
    // 8 daily buckets; the LAST is today (partial) and must be dropped.
    const pts: Array<[number, number]> = [
      [1, 600],
      [2, 300],
      [3, 300],
      [4, 300],
      [5, 380],
      [6, 600],
      [7, 340],
      [8, 9999], // today — partial — EXCLUDED
    ];
    // mean of the 7 full days = (600+300+300+300+380+600+340)/7 = 2820/7
    expect(avgPrior7FullDays(pts)).toBeCloseTo(2820 / 7);
  });

  it("keeps only the last 7 full days when more are present", () => {
    const pts: Array<[number, number]> = Array.from({ length: 12 }, (_, i) => [
      i,
      i === 11 ? 0 : 100, // last is partial-today=0, the rest are 100
    ]);
    // last 7 full days are all 100 → avg 100
    expect(avgPrior7FullDays(pts)).toBeCloseTo(100);
  });

  it("returns 0 for empty or single-bucket input", () => {
    expect(avgPrior7FullDays([])).toBe(0);
    expect(avgPrior7FullDays([[1, 500]])).toBe(0); // only the partial day
  });
});

describe("costToday", () => {
  it("computes todayUsd, avg7d baseline, delta, and EOD projection", async () => {
    const noon = new Date(2026, 5, 10, 12, 0, 0); // half the day elapsed
    const { prom, queries, ranges } = mockPromSplit({
      query: {
        data: { resultType: "vector", result: [{ metric: {}, value: [0, "300"] }] },
      },
      queryRange: {
        data: {
          resultType: "matrix",
          result: [
            {
              metric: {},
              values: [
                [1, "200"],
                [2, "200"],
                [3, "200"],
                [4, "200"],
                [5, "200"],
                [6, "200"],
                [7, "200"],
                [8, "150"], // today partial — excluded from baseline
              ],
            },
          ],
        },
      },
    });
    const result = await costToday(prom, noon);
    expect(result).not.toBeNull();
    expect(result!.todayUsd).toBeCloseTo(300);
    expect(result!.avg7dUsd).toBeCloseTo(200);
    // delta = (300 - 200) / 200 = +0.5
    expect(result!.deltaFraction).toBeCloseTo(0.5);
    // half a day elapsed → projection ≈ 300 / (43200/86400) = 600
    expect(result!.projectionEodUsd).toBeCloseTo(600);
    expect(result!.elapsedTodaySeconds).toBe(12 * 3600);
    // today is an instant query over the elapsed-today window; baseline is a range.
    expect(queries[0]).toContain(`increase(claude_code_cost_usage_USD_total[${12 * 3600}s]))`);
    expect(ranges[0]).toContain("increase(claude_code_cost_usage_USD_total[1d])");
  });

  it("null delta when there is no 7d baseline (avg===0)", async () => {
    const { prom } = mockPromSplit({
      query: {
        data: { resultType: "vector", result: [{ metric: {}, value: [0, "50"] }] },
      },
      queryRange: { data: { resultType: "matrix", result: [] } },
    });
    const result = await costToday(prom, new Date(2026, 5, 10, 6, 0, 0));
    expect(result).not.toBeNull();
    expect(result!.avg7dUsd).toBe(0);
    expect(result!.deltaFraction).toBeNull();
  });

  it("returns null when Prometheus is unavailable", async () => {
    const result = await costToday(mockProm(null));
    expect(result).toBeNull();
  });
});

describe("scoreSpikes", () => {
  it("flags an hour exceeding both 2× median and μ+2σ", () => {
    // calm baseline at 10, one big spike at 200.
    const pts: Array<[number, number]> = [
      [1, 10],
      [2, 12],
      [3, 9],
      [4, 11],
      [5, 200], // the spike
      [6, 10],
    ];
    const scored = scoreSpikes(pts);
    expect(scored.find((p) => p.t === 5)!.isSpike).toBe(true);
    // every other hour is calm — not a spike.
    expect(scored.filter((p) => p.isSpike)).toHaveLength(1);
  });

  it("never flags an all-zero or quiet series", () => {
    const scored = scoreSpikes([
      [1, 0],
      [2, 0],
      [3, 0],
    ]);
    expect(scored.every((p) => !p.isSpike)).toBe(true);
  });

  it("flags nothing with fewer than 3 points (no distribution)", () => {
    const scored = scoreSpikes([
      [1, 1],
      [2, 1000],
    ]);
    expect(scored.every((p) => !p.isSpike)).toBe(true);
  });

  it("preserves the points and their order", () => {
    const pts: Array<[number, number]> = [
      [100, 5],
      [200, 6],
      [300, 7],
    ];
    const scored = scoreSpikes(pts);
    expect(scored.map((p) => [p.t, p.usd])).toEqual(pts);
  });
});

describe("costSeries", () => {
  it("returns hourly points with spike flags from a query_range matrix", async () => {
    const { prom, ranges } = mockPromSplit({
      queryRange: {
        data: {
          resultType: "matrix",
          result: [
            {
              metric: {},
              values: [
                [1, "10"],
                [2, "11"],
                [3, "9"],
                [4, "250"], // spike — clears both thresholds against the calm tail
                [5, "10"],
                [6, "11"],
                [7, "9"],
                [8, "10"],
                [9, "11"],
                [10, "10"],
              ],
            },
          ],
        },
      },
    });
    const result = await costSeries(prom, "24h");
    expect(result).not.toBeNull();
    expect(result!).toHaveLength(10);
    expect(result!.find((p) => p.t === 4)!.isSpike).toBe(true);
    expect(result!.filter((p) => p.isSpike)).toHaveLength(1);
    // hourly bars: a 1h window stepped at 1h.
    expect(ranges[0]).toContain("increase(claude_code_cost_usage_USD_total[1h])");
  });

  it("returns null when Prometheus is unavailable", async () => {
    const result = await costSeries(mockProm(null), "24h");
    expect(result).toBeNull();
  });

  it("returns [] honestly for a reachable-but-empty stack", async () => {
    const { prom } = mockPromSplit({
      queryRange: { data: { resultType: "matrix", result: [] } },
    });
    const result = await costSeries(prom, "24h");
    expect(result).toEqual([]);
  });
});

describe("inputPricePerToken", () => {
  it("maps each model family to its per-token input price", () => {
    expect(inputPricePerToken("claude-opus-4-8")).toBeCloseTo(5.0 / 1e6);
    expect(inputPricePerToken("claude-opus-4-8[1m]")).toBeCloseTo(5.0 / 1e6);
    expect(inputPricePerToken("claude-sonnet-4-6")).toBeCloseTo(3.0 / 1e6);
    expect(inputPricePerToken("claude-haiku-4-5-20251001")).toBeCloseTo(1.0 / 1e6);
    expect(inputPricePerToken("claude-fable-5")).toBeCloseTo(5.0 / 1e6);
  });

  it("falls back to the sonnet rate for an unknown model (never zero)", () => {
    expect(inputPricePerToken("some-future-model")).toBeCloseTo(3.0 / 1e6);
  });
});

describe("cacheSavings", () => {
  it("computes per-model savings = cacheRead × input × 0.9 + the multiplier", async () => {
    // cacheSavings fires two query() calls — cacheRead-by-model first, total spend
    // second — so a call-ordered mock returns the right shape per call.
    let call = 0;
    const promOrdered: PrometheusFetcher = {
      query: () => {
        call += 1;
        if (call === 1) {
          return Promise.resolve({
            data: {
              resultType: "vector",
              result: [
                { metric: { model: "claude-opus-4-8" }, value: [0, "1000000"] },
                { metric: { model: "claude-sonnet-4-6" }, value: [0, "2000000"] },
                { metric: { model: "claude-zero" }, value: [0, "0"] }, // dropped
              ],
            },
          } as PrometheusQueryResult);
        }
        return Promise.resolve({
          data: { resultType: "vector", result: [{ metric: {}, value: [0, "100"] }] },
        } as PrometheusQueryResult);
      },
      queryRange: () => Promise.resolve(null),
      isAvailable: () => true,
    };
    const result = await cacheSavings(promOrdered, "24h");
    expect(result).not.toBeNull();
    // opus: 1e6 tokens × 5/1e6 × 0.9 = 4.5 ; sonnet: 2e6 × 3/1e6 × 0.9 = 5.4
    expect(result!.savedUsd).toBeCloseTo(4.5 + 5.4);
    expect(result!.cacheReadTokens).toBe(3_000_000);
    expect(result!.actualSpendUsd).toBeCloseTo(100);
    expect(result!.multiplier).toBeCloseTo((4.5 + 5.4) / 100);
    // per-model, descending; the zero-token model is filtered out.
    expect(result!.byModel.map((m) => m.model)).toEqual([
      "claude-sonnet-4-6",
      "claude-opus-4-8",
    ]);
  });

  it("null multiplier when actual spend is 0", async () => {
    let call = 0;
    const prom: PrometheusFetcher = {
      query: () => {
        call += 1;
        if (call === 1) {
          return Promise.resolve({
            data: {
              resultType: "vector",
              result: [{ metric: { model: "claude-opus-4-8" }, value: [0, "1000000"] }],
            },
          } as PrometheusQueryResult);
        }
        return Promise.resolve({
          data: { resultType: "vector", result: [] },
        } as PrometheusQueryResult);
      },
      queryRange: () => Promise.resolve(null),
      isAvailable: () => true,
    };
    const result = await cacheSavings(prom, "24h");
    expect(result).not.toBeNull();
    expect(result!.actualSpendUsd).toBe(0);
    expect(result!.multiplier).toBeNull();
    expect(result!.savedUsd).toBeGreaterThan(0);
  });

  it("returns null when Prometheus is unavailable", async () => {
    const result = await cacheSavings(mockProm(null), "24h");
    expect(result).toBeNull();
  });
});

describe("costAtHour", () => {
  it("anchors a 1h window to the target hour via PromQL offset + zero-filters both maps", async () => {
    const queries: string[] = [];
    let call = 0;
    const prom: PrometheusFetcher = {
      query: (q: string) => {
        queries.push(q);
        call += 1;
        // call 1 = by-ticket, call 2 = by-model (the Promise.all order).
        if (call === 1) {
          return Promise.resolve({
            data: {
              resultType: "vector",
              result: [
                { metric: { linear_key: "CTL-928" }, value: [0, "31.7"] },
                { metric: { linear_key: "CTL-ZERO" }, value: [0, "0"] }, // dropped
                { metric: { linear_key: "CTL-850" }, value: [0, "14.22"] },
              ],
            },
          } as PrometheusQueryResult);
        }
        return Promise.resolve({
          data: {
            resultType: "vector",
            result: [
              { metric: { model: "claude-opus-4-8[1m]" }, value: [0, "28.84"] },
              { metric: { model: "claude-zero" }, value: [0, "0"] }, // dropped
            ],
          },
        } as PrometheusQueryResult);
      },
      queryRange: () => Promise.resolve(null),
      isAvailable: () => true,
    };
    // Fix "now" 2h after the target hour-end → offset = 7200s.
    const hourEnd = 1781000000;
    const now = new Date((hourEnd + 7200) * 1000);
    const result = await costAtHour(prom, hourEnd, now);
    expect(result).not.toBeNull();
    expect(result!.hourEndSeconds).toBe(hourEnd);
    // by-ticket zero-filtered, by-model zero-filtered.
    expect(result!.byTicket).toEqual({ "CTL-928": 31.7, "CTL-850": 14.22 });
    expect(result!.byModel).toEqual({ "claude-opus-4-8[1m]": 28.84 });
    // Both queries carry the computed offset + a 1h increase window.
    expect(queries[0]).toContain("offset 7200s");
    expect(queries[0]).toContain("[1h]");
    expect(queries[0]).toContain("sum by (linear_key)");
    expect(queries[1]).toContain("offset 7200s");
    expect(queries[1]).toContain("sum by (model)");
  });

  it("omits the offset clause when the hour is current (offset 0)", async () => {
    const queries: string[] = [];
    const prom: PrometheusFetcher = {
      query: (q: string) => {
        queries.push(q);
        return Promise.resolve({
          data: { resultType: "vector", result: [] },
        } as PrometheusQueryResult);
      },
      queryRange: () => Promise.resolve(null),
      isAvailable: () => true,
    };
    const now = new Date(1781000000 * 1000);
    await costAtHour(prom, 1781000000, now);
    expect(queries[0]).not.toContain("offset");
  });

  it("clamps a future hour to offset 0 (never a negative-offset 400)", async () => {
    const queries: string[] = [];
    const prom: PrometheusFetcher = {
      query: (q: string) => {
        queries.push(q);
        return Promise.resolve({
          data: { resultType: "vector", result: [] },
        } as PrometheusQueryResult);
      },
      queryRange: () => Promise.resolve(null),
      isAvailable: () => true,
    };
    // hour-end 1h in the FUTURE relative to now → offset clamps to 0.
    const now = new Date(1781000000 * 1000);
    await costAtHour(prom, 1781000000 + 3600, now);
    expect(queries[0]).not.toContain("offset -");
    expect(queries[0]).not.toContain("offset");
  });

  it("returns null when Prometheus is unavailable", async () => {
    const result = await costAtHour(mockProm(null), 1781000000);
    expect(result).toBeNull();
  });
});

describe("toolUsageByName", () => {
  it("returns tool counts from Loki metric result", async () => {
    const loki = mockLoki({
      data: {
        resultType: "matrix",
        result: [
          { metric: { tool_name: "Read" }, values: [[0, "42"]] },
          { metric: { tool_name: "Edit" }, values: [[0, "18"]] },
        ],
      },
    });
    const result = await toolUsageByName(loki, "1h");
    expect(result).not.toBeNull();
    expect(result!["Read"]).toBe(42);
    expect(result!["Edit"]).toBe(18);
  });

  it("returns null when Loki unavailable", async () => {
    expect(await toolUsageByName(mockLoki(null), "1h")).toBeNull();
  });
});

describe("apiErrors", () => {
  it("returns error log entries from Loki streams", async () => {
    const loki = mockLoki({
      data: {
        resultType: "streams",
        result: [
          {
            stream: { service_name: "claude-code.s1" },
            values: [
              ["1713100000000000000", '{"error":"rate_limited","model":"opus"}'],
              ["1713100001000000000", '{"error":"timeout","model":"sonnet"}'],
            ],
          },
        ],
      },
    });
    const result = await apiErrors(loki, "1h", 50);
    expect(result).not.toBeNull();
    expect(result!).toHaveLength(2);
    expect(result![0].line).toContain("rate_limited");
  });

  it("returns null when unavailable", async () => {
    expect(await apiErrors(mockLoki(null), "1h")).toBeNull();
  });

  it("filters event_name=api_error via a PIPE label-filter (the error string + model live in the labels)", () => {
    const q = apiErrorsLogQL();
    expect(q).toContain('{service_name=~"claude-code.*"}');
    expect(q).toContain('| event_name="api_error"');
    expect(q).not.toMatch(/\{[^}]*event_name\s*=/); // not a stream-selector matcher
    expect(q).not.toContain("| json"); // structured metadata, no json stage
  });
});

// ── OBS-7 (TELEMETRY P4): per-model latency + error% ─────────────────────────
// modelLatency fans out FOUR distinct LogQL queries (p50, p95, request-count,
// error-count) and joins them by model, so the mock routes each query to a result
// by matching a substring — the same idiom as mockPromRange below.
function mockLokiRange(
  routes: Array<{ match: string; result: LokiQueryResult | null }>,
  available = true,
): LokiFetcher {
  return {
    queryRange: (logql: string) => {
      for (const r of routes) {
        if (logql.includes(r.match)) return Promise.resolve(r.result);
      }
      // no registered match → an honest empty matrix (model not on that axis).
      return Promise.resolve({ data: { resultType: "matrix", result: [] } });
    },
    isAvailable: () => available,
  };
}

function lokiMatrix(
  series: Array<{ model: string; values: Array<[number, string]> }>,
): LokiQueryResult {
  return {
    data: {
      resultType: "matrix",
      result: series.map((s) => ({ metric: { model: s.model }, values: s.values })),
    },
  };
}

describe("modelLatencyLogQL / modelEventCountLogQL — pin the LogQL shape", () => {
  it("latency query filters event_name via a PIPE label-filter and unwraps duration_ms by (model)", () => {
    const q = modelLatencyLogQL(0.95, "1h");
    expect(q).toContain("quantile_over_time(0.95,");
    // The event filter MUST be a `| event_name="api_request"` PIPE label-filter on
    // structured metadata — NOT a `{event_name=…}` selector (returns 0) and NOT a
    // body match `|= "claude_code.api_request"` + `| json` (the body is the
    // event-name string, not JSON → JSONParserErr 400, the shipped bug).
    expect(q).toContain('| event_name="api_request"');
    expect(q).toContain("| unwrap duration_ms");
    expect(q).not.toContain("| json"); // no json stage — fields are structured metadata
    expect(q).not.toContain('|= "claude_code.api_request"'); // not a body match
    expect(q).not.toMatch(/\{[^}]*event_name\s*=/); // not a stream-selector matcher
    expect(q).toContain("by (model)");
  });

  it("error-count query filters event_name=api_error via a PIPE label-filter by (model)", () => {
    const q = modelEventCountLogQL("api_error", "1h");
    expect(q).toContain("sum by (model)");
    expect(q).toContain("count_over_time");
    // The structured-metadata value MUST be the lowercase bare event name.
    expect(q).toContain('| event_name="api_error"');
    expect(q).not.toContain("API_ERROR");
    expect(q).not.toContain("| json");
  });

  it("a bad range duration falls back, never injected into the LogQL", () => {
    const q = modelLatencyLogQL(0.5, "1h])) or vector(1#");
    expect(q).toContain("[1h]"); // safeDuration fallback
    expect(q).not.toContain("vector(1#");
  });
});

describe("modelLatency", () => {
  it("joins p50/p95/requests/errors by model and derives error%", async () => {
    const loki = mockLokiRange([
      {
        match: "quantile_over_time(0.5,",
        result: lokiMatrix([
          { model: "fable-5", values: [[160, "3100"]] },
          { model: "haiku-4.5", values: [[160, "900"]] },
        ]),
      },
      {
        match: "quantile_over_time(0.95,",
        result: lokiMatrix([
          { model: "fable-5", values: [[160, "22000"]] },
          { model: "haiku-4.5", values: [[160, "4000"]] },
        ]),
      },
      {
        match: '| event_name="api_request"',
        result: lokiMatrix([
          { model: "fable-5", values: [[160, "300"]] },
          { model: "haiku-4.5", values: [[160, "120"]] },
        ]),
      },
      {
        match: '| event_name="api_error"',
        result: lokiMatrix([{ model: "fable-5", values: [[160, "3"]] }]),
      },
    ]);
    const rows = await modelLatency(loki, "1h");
    expect(rows).not.toBeNull();
    // sorted slowest-p95 first
    expect(rows![0]!.model).toBe("fable-5");
    expect(rows![0]!.p50Ms).toBe(3100);
    expect(rows![0]!.p95Ms).toBe(22000);
    expect(rows![0]!.requests).toBe(300);
    expect(rows![0]!.errors).toBe(3);
    expect(rows![0]!.errorRate).toBeCloseTo(0.01);
    // haiku has no errors → errorRate 0 (it HAS requests, so not null)
    const haiku = rows!.find((r) => r.model === "haiku-4.5")!;
    expect(haiku.errors).toBe(0);
    expect(haiku.errorRate).toBe(0);
  });

  it("a model with requests===0 gets errorRate null (never a fabricated 0%)", async () => {
    const loki = mockLokiRange([
      {
        match: "quantile_over_time(0.95,",
        result: lokiMatrix([{ model: "ghost", values: [[160, "5000"]] }]),
      },
      // no request-count or error-count series for "ghost"
    ]);
    const rows = await modelLatency(loki, "1h");
    const ghost = rows!.find((r) => r.model === "ghost")!;
    expect(ghost.requests).toBe(0);
    expect(ghost.errorRate).toBeNull();
    expect(ghost.p95Ms).toBe(5000);
    expect(ghost.p50Ms).toBeNull(); // only p95 had a sample
  });

  it("an empty stream is an HONEST [] (reachable-but-no-samples), NOT null", async () => {
    const loki = mockLokiRange([]); // every query → empty matrix
    const rows = await modelLatency(loki, "1h");
    expect(rows).toEqual([]);
  });

  it("returns null ONLY when Loki is unavailable (every probe null)", async () => {
    const loki: LokiFetcher = {
      queryRange: () => Promise.resolve(null),
      isAvailable: () => false,
    };
    expect(await modelLatency(loki, "1h")).toBeNull();
  });
});

describe("toolLatency", () => {
  it("filters event_name=tool_result via a PIPE label-filter and unwraps duration_ms by (tool_name)", () => {
    const q = toolLatencyLogQL(0.95, "1h");
    expect(q).toContain("quantile_over_time(0.95,");
    expect(q).toContain('| event_name="tool_result"');
    expect(q).toContain("| unwrap duration_ms");
    expect(q).not.toContain("| json"); // fields are structured metadata, body is not JSON
    expect(q).not.toContain('|= "claude_code.tool_result"'); // not a body match
    // The grouping label is `tool_name` (verified live: by(tool)→1 empty series).
    expect(q).toContain("by (tool_name)");
    expect(q).not.toMatch(/by \(tool\)/);
  });

  it("joins p50/p95 into a tool→latency map", async () => {
    const loki = mockLokiRange([
      {
        match: "quantile_over_time(0.5,",
        result: {
          data: {
            resultType: "matrix",
            result: [
              { metric: { tool_name: "Bash" }, values: [[160, "1200"]] },
              { metric: { tool_name: "Read" }, values: [[160, "150"]] },
            ],
          },
        },
      },
      {
        match: "quantile_over_time(0.95,",
        result: {
          data: {
            resultType: "matrix",
            result: [
              { metric: { tool_name: "Bash" }, values: [[160, "8200"]] },
              { metric: { tool_name: "Read" }, values: [[160, "300"]] },
            ],
          },
        },
      },
    ]);
    const map = await toolLatency(loki, "1h");
    expect(map).not.toBeNull();
    expect(map!["Bash"]).toEqual({ p50Ms: 1200, p95Ms: 8200 });
    expect(map!["Read"]).toEqual({ p50Ms: 150, p95Ms: 300 });
  });

  it("an empty stream is an HONEST {} (counts-only fallback), NOT null", async () => {
    const loki = mockLokiRange([]);
    expect(await toolLatency(loki, "1h")).toEqual({});
  });

  it("returns null when Loki is unavailable", async () => {
    const loki: LokiFetcher = {
      queryRange: () => Promise.resolve(null),
      isAvailable: () => false,
    };
    expect(await toolLatency(loki, "1h")).toBeNull();
  });
});

// CTL-914 (DETAIL3): the worker-page [history] tail — REAL today (no plumbing).
// The single non-negotiable correctness property is the LogQL shape: a
// `| session_id=\`UUID\`` STRUCTURED-METADATA pipe, NOT a `{session_id="UUID"}`
// label matcher (which returns 0). Plus session-id validation so the pipe can
// never be a LogQL injection vector.
describe("workerHistoryLogQL", () => {
  it("filters with a `| session_id` structured-metadata pipe, never a `{session_id=}` matcher", () => {
    const q = workerHistoryLogQL("11111111-2222-3333-4444-555555555555");
    expect(q).toContain('{service_name=~"claude-code.*"}');
    expect(q).toContain("| session_id=`11111111-2222-3333-4444-555555555555`");
    // The fatal anti-pattern: session_id as a stream-label matcher returns 0.
    expect(q).not.toMatch(/\{[^}]*session_id\s*=/);
  });
});

describe("isValidCcSessionId", () => {
  it("accepts a UUID and rejects injection / traversal", () => {
    expect(isValidCcSessionId("11111111-2222-3333-4444-555555555555")).toBe(true);
    expect(isValidCcSessionId("a".repeat(32))).toBe(true);
    expect(isValidCcSessionId("not a uuid!")).toBe(false);
    expect(isValidCcSessionId("../etc/passwd")).toBe(false);
    expect(isValidCcSessionId("abc`} |= `x")).toBe(false);
    expect(isValidCcSessionId("short")).toBe(false);
  });
});

describe("parseHistoryLine", () => {
  // catalyst-otel carries every field as a STRUCTURED-METADATA STREAM LABEL; the
  // line BODY is just the event-name string. The non-negotiable property: fields
  // come from the LABELS, not the body (reading the body gave all-null → the
  // "event — —" shipped bug).
  it("extracts event_name/tool_name/duration_ms/cost_usd/model/prompt_id FROM THE STREAM LABELS", () => {
    const row = parseHistoryLine(
      1713100000000,
      // the BODY is the event-name string, NOT JSON
      "claude_code.tool_result",
      {
        event_name: "tool_result",
        tool_name: "Edit",
        tool_input: "board-data.mjs",
        duration_ms: "1100",
        cost_usd: "0.0042",
        tokens: "318",
        model: "claude-opus-4-8",
        success: "true",
        prompt_id: "239db6a1-e125-4a2a-b0c1-4f471c0cd8f4",
      },
    );
    expect(row.ts).toBe(1713100000000);
    expect(row.eventName).toBe("tool_result");
    expect(row.toolName).toBe("Edit");
    expect(row.toolInput).toBe("board-data.mjs");
    expect(row.durationMs).toBe(1100);
    expect(row.costUsd).toBeCloseTo(0.0042);
    expect(row.tokens).toBe(318);
    expect(row.model).toBe("claude-opus-4-8");
    expect(row.success).toBe(true);
    expect(row.promptId).toBe("239db6a1-e125-4a2a-b0c1-4f471c0cd8f4");
  });

  it("reads the labels even when the body is the bare event-name string (NOT JSON)", () => {
    // This is the real shape: body is "claude_code.api_request", fields in labels.
    const row = parseHistoryLine(1713100000000, "claude_code.api_request", {
      event_name: "api_request",
      model: "claude-opus-4-8",
      duration_ms: "28700",
      cost_usd: "0.08",
    });
    // The body is unparseable as JSON, yet every field is populated from labels —
    // proving we do NOT depend on the body.
    expect(row.eventName).toBe("api_request");
    expect(row.model).toBe("claude-opus-4-8");
    expect(row.durationMs).toBe(28700);
    expect(row.costUsd).toBeCloseTo(0.08);
  });

  it("falls back to a JSON body when present and labels omit a field (older ingest)", () => {
    const row = parseHistoryLine(
      42,
      JSON.stringify({ event_name: "claude_code.tool_result", tool_name: "Read", duration_ms: 200 }),
      {}, // no labels
    );
    expect(row.eventName).toBe("claude_code.tool_result");
    expect(row.toolName).toBe("Read");
    expect(row.durationMs).toBe(200);
  });

  it("never crashes when the body is non-JSON and no labels are given — fields stay null", () => {
    const row = parseHistoryLine(42, "this is not json");
    expect(row.ts).toBe(42);
    expect(row.eventName).toBeNull();
    expect(row.toolName).toBeNull();
    expect(row.durationMs).toBeNull();
    expect(row.success).toBeNull();
    expect(row.promptId).toBeNull();
  });
});

describe("workerHistoryBySession", () => {
  const UUID = "11111111-2222-3333-4444-555555555555";

  it("returns parsed rows newest-first from the Loki stream", async () => {
    const loki = mockLoki({
      data: {
        resultType: "streams",
        result: [
          {
            stream: { service_name: "claude-code" },
            values: [
              ["1713100000000000000", '{"event_name":"claude_code.tool_result","tool_name":"Read","duration_ms":200}'],
              ["1713100005000000000", '{"event_name":"claude_code.tool_result","tool_name":"Edit","duration_ms":1100}'],
            ],
          },
        ],
      },
    });
    const rows = await workerHistoryBySession(loki, UUID, "24h");
    expect(rows).not.toBeNull();
    expect(rows!).toHaveLength(2);
    // newest-first: the later (Edit) timestamp leads.
    expect(rows![0].toolName).toBe("Edit");
    expect(rows![0].ts).toBe(1713100005000);
    expect(rows![1].toolName).toBe("Read");
  });

  it("returns [] (a real 'no logs' answer) when the stream is empty", async () => {
    const loki = mockLoki({ data: { resultType: "streams", result: [] } });
    const rows = await workerHistoryBySession(loki, UUID, "24h");
    expect(rows).toEqual([]);
  });

  it("returns null when Loki is unavailable", async () => {
    expect(await workerHistoryBySession(mockLoki(null), UUID, "24h")).toBeNull();
  });

  it("returns null (refuses to query) for a malformed session id", async () => {
    const loki = mockLoki({ data: { resultType: "streams", result: [] } });
    expect(await workerHistoryBySession(loki, "not a uuid!", "24h")).toBeNull();
  });

  it("issues the `| session_id` pipe LogQL to Loki", async () => {
    let captured = "";
    const loki: LokiFetcher = {
      queryRange: (logql: string) => {
        captured = logql;
        return Promise.resolve({ data: { resultType: "streams", result: [] } });
      },
      isAvailable: () => true,
    };
    await workerHistoryBySession(loki, UUID, "24h");
    expect(captured).toContain(`| session_id=\`${UUID}\``);
    expect(captured).not.toMatch(/\{[^}]*session_id\s*=/);
  });
});

describe("costValidation", () => {
  it("detects discrepancy between signal and OTel costs", async () => {
    const prom = mockProm({
      data: {
        resultType: "vector",
        result: [
          { metric: { linear_key: "CTL-39" }, value: [0, "1.50"] },
          { metric: { linear_key: "CTL-40" }, value: [0, "2.00"] },
        ],
      },
    });
    const signalCosts: Record<string, number> = {
      "CTL-39": 1.45,
      "CTL-40": 3.00,
    };
    const result = await costValidation(prom, signalCosts, "6h");
    expect(result).not.toBeNull();
    expect(result!).toHaveLength(2);
    const ctl39 = result!.find((r) => r.ticket === "CTL-39")!;
    expect(ctl39.signalCost).toBeCloseTo(1.45);
    expect(ctl39.otelCost).toBeCloseTo(1.50);
    expect(ctl39.discrepancy).toBeCloseTo(0.05);
    const ctl40 = result!.find((r) => r.ticket === "CTL-40")!;
    expect(ctl40.discrepancy).toBeCloseTo(1.00);
  });

  it("returns null when unavailable", async () => {
    expect(
      await costValidation(mockProm(null), { "CTL-39": 1.0 }, "1h"),
    ).toBeNull();
  });
});

// ── CTL-917 (DETAIL6): burn metrics off the OTEL pipeline ───────────────────
import {
  isValidLinearKey,
  workerBurnSeries,
  ticketTelemetrySeries,
} from "../lib/otel-queries";

/** A Prometheus mock that routes each `queryRange` call to a matrix result by
 *  matching a substring of the PromQL — so a single helper that fans out four
 *  different range queries can be asserted series-by-series. A query with no
 *  registered match resolves to an empty matrix (an honest "no series yet"). */
function mockPromRange(
  routes: Array<{ match: string; result: PrometheusQueryResult | null }>,
  available = true,
): PrometheusFetcher {
  const find = (promql: string): PrometheusQueryResult | null => {
    for (const r of routes) {
      if (promql.includes(r.match)) return r.result;
    }
    return { data: { resultType: "matrix", result: [] } };
  };
  return {
    query: (promql) => Promise.resolve(find(promql)),
    queryRange: (promql) => Promise.resolve(find(promql)),
    isAvailable: () => available,
  };
}

function matrix(
  labels: Record<string, string>,
  values: Array<[number, string]>,
): PrometheusQueryResult {
  return { data: { resultType: "matrix", result: [{ metric: labels, values }] } };
}

describe("isValidLinearKey", () => {
  it("accepts canonical Linear keys", () => {
    expect(isValidLinearKey("CTL-917")).toBe(true);
    expect(isValidLinearKey("ADV-1")).toBe(true);
    expect(isValidLinearKey("ENG-12345")).toBe(true);
  });
  it("rejects PromQL-injection / malformed values", () => {
    expect(isValidLinearKey('CTL-1"} or up(')).toBe(false);
    expect(isValidLinearKey("CTL-")).toBe(false);
    expect(isValidLinearKey("917")).toBe(false);
    expect(isValidLinearKey("")).toBe(false);
    expect(isValidLinearKey("CTL 917")).toBe(false);
  });
});

describe("workerBurnSeries", () => {
  it("returns the four sparkline series keyed on the CC session UUID", async () => {
    const uuid = "7f3a91ab-cdef-4012-89ab-cdef01234567";
    const prom = mockPromRange([
      {
        match: "sum(claude_code_cost_usage_USD_total{session_id",
        result: matrix({}, [[100, "0.40"], [160, "0.84"]]),
      },
      {
        match: "sum(claude_code_token_usage_tokens_total{session_id",
        result: matrix({}, [[100, "318000"], [160, "412000"]]),
      },
      {
        match: "sum by (type) (claude_code_token_usage_tokens_total{session_id",
        result: {
          data: {
            resultType: "matrix",
            result: [
              { metric: { type: "input" }, values: [[160, "318000"]] },
              { metric: { type: "output" }, values: [[160, "94000"]] },
            ],
          },
        },
      },
      {
        match: "sum(claude_code_active_time_seconds_total{session_id",
        result: matrix({}, [[100, "600"], [160, "708"]]),
      },
    ]);
    const res = await workerBurnSeries(prom, uuid, "1h");
    expect(res).not.toBeNull();
    expect(res!.cost).toEqual([[100, 0.4], [160, 0.84]]);
    expect(res!.tokens[res!.tokens.length - 1]).toEqual([160, 412000]);
    expect(res!.tokensByType["input"]).toEqual([[160, 318000]]);
    expect(res!.tokensByType["output"]).toEqual([[160, 94000]]);
    expect(res!.activeSeconds[res!.activeSeconds.length - 1]).toEqual([160, 708]);
  });

  it("returns empty series (not null) for a just-spawned worker with no points", async () => {
    const uuid = "7f3a91ab-cdef-4012-89ab-cdef01234567";
    // every query returns an empty matrix → the helper returns empty arrays, and
    // the UI falls back to the resident BoardWorker scalar (never a blank chart).
    const prom = mockPromRange([]);
    const res = await workerBurnSeries(prom, uuid, "1h");
    expect(res).not.toBeNull();
    expect(res!.cost).toEqual([]);
    expect(res!.tokens).toEqual([]);
    expect(res!.activeSeconds).toEqual([]);
    expect(res!.tokensByType).toEqual({});
  });

  it("rejects an invalid session id (no PromQL injection)", async () => {
    const prom = mockPromRange([]);
    expect(await workerBurnSeries(prom, 'x"} or up(', "1h")).toBeNull();
  });

  it("returns null when Prometheus is unavailable", async () => {
    const prom: PrometheusFetcher = {
      query: () => Promise.resolve(null),
      queryRange: () => Promise.resolve(null),
      isAvailable: () => false,
    };
    expect(
      await workerBurnSeries(prom, "7f3a91ab-cdef-4012-89ab-cdef01234567", "1h"),
    ).toBeNull();
  });
});

describe("ticketTelemetrySeries", () => {
  it("returns total series plus cost-by-phase and cost-by-model breakdowns", async () => {
    const prom = mockPromRange([
      {
        match: "sum(claude_code_cost_usage_USD_total{linear_key",
        result: matrix({}, [[100, "0.6"], [160, "1.14"]]),
      },
      {
        match: "sum(claude_code_token_usage_tokens_total{linear_key",
        result: matrix({}, [[160, "2500000"]]),
      },
      {
        match: "sum by (type) (claude_code_token_usage_tokens_total{linear_key",
        result: {
          data: {
            resultType: "matrix",
            result: [{ metric: { type: "input" }, values: [[160, "2100000"]] }],
          },
        },
      },
      {
        match: "sum by (task_type) (claude_code_cost_usage_USD_total{linear_key",
        result: {
          data: {
            resultType: "matrix",
            result: [
              { metric: { task_type: "plan" }, values: [[160, "0.38"]] },
              { metric: { task_type: "implement" }, values: [[160, "0.51"]] },
            ],
          },
        },
      },
      {
        match: "sum by (model) (claude_code_cost_usage_USD_total{linear_key",
        result: {
          data: {
            resultType: "matrix",
            result: [
              { metric: { model: "opus" }, values: [[160, "0.89"]] },
              { metric: { model: "sonnet" }, values: [[160, "0.25"]] },
            ],
          },
        },
      },
    ]);
    const res = await ticketTelemetrySeries(prom, "CTL-845", "1h");
    expect(res).not.toBeNull();
    expect(res!.cost[res!.cost.length - 1]).toEqual([160, 1.14]);
    expect(res!.tokens[0]).toEqual([160, 2500000]);
    expect(res!.tokensByType["input"]).toEqual([[160, 2100000]]);
    expect(res!.costByPhase["plan"]).toEqual([[160, 0.38]]);
    expect(res!.costByPhase["implement"]).toEqual([[160, 0.51]]);
    expect(res!.costByModel["opus"]).toEqual([[160, 0.89]]);
    expect(res!.costByModel["sonnet"]).toEqual([[160, 0.25]]);
  });

  it("returns empty series for an instant-paint ticket with no points", async () => {
    const prom = mockPromRange([]);
    const res = await ticketTelemetrySeries(prom, "CTL-845", "1h");
    expect(res).not.toBeNull();
    expect(res!.cost).toEqual([]);
    expect(res!.costByPhase).toEqual({});
    expect(res!.costByModel).toEqual({});
  });

  it("rejects an invalid linear key", async () => {
    const prom = mockPromRange([]);
    expect(await ticketTelemetrySeries(prom, 'CTL-1"} or up(', "1h")).toBeNull();
  });

  it("returns null when Prometheus is unavailable", async () => {
    const prom: PrometheusFetcher = {
      query: () => Promise.resolve(null),
      queryRange: () => Promise.resolve(null),
      isAvailable: () => false,
    };
    expect(await ticketTelemetrySeries(prom, "CTL-845", "1h")).toBeNull();
  });
});

// ── OBS-6 (TELEMETRY): the fleet-wide grouped live tail + freshness ──────────
describe("recentTailLogQL", () => {
  it("scans the whole claude-code stream un-filtered by session", () => {
    expect(recentTailLogQL()).toBe('{service_name=~"claude-code.*"}');
  });
});

describe("recentTail", () => {
  // A Loki stream value carries per-line `[tsNanos, jsonBody]` plus stream labels.
  function lokiStream(
    stream: Record<string, string>,
    values: Array<[string, string]>,
  ): LokiQueryResult {
    return { data: { resultType: "streams", result: [{ stream, values }] } };
  }

  it("parses rows newest-first FROM STREAM LABELS and derives freshnessMs (body is the event-name string)", async () => {
    const now = Date.now();
    const newest = now - 4_000; // 4s ago
    const older = now - 60_000;
    // REAL shape: each line's fields are STREAM LABELS; the body is the event-name
    // string. Two separate streams (Loki groups by label set), out-of-order to
    // prove the newest-first sort.
    const loki = mockLoki({
      data: {
        resultType: "streams",
        result: [
          {
            stream: { service_name: "claude-code", event_name: "tool_result", tool_name: "Read" },
            values: [[String(older * 1_000_000), "claude_code.tool_result"]],
          },
          {
            stream: { service_name: "claude-code", event_name: "api_request", model: "fable" },
            values: [[String(newest * 1_000_000), "claude_code.api_request"]],
          },
        ],
      },
    });
    const res = await recentTail(loki, "15m");
    expect(res).not.toBeNull();
    expect(res!.rows).toHaveLength(2);
    // newest-first — and the fields came from the LABELS, not the (non-JSON) body.
    expect(res!.rows[0]!.eventName).toBe("api_request");
    expect(res!.rows[0]!.model).toBe("fable");
    // freshness ≈ 4s (allow a little slack for the now() taken inside recentTail)
    expect(res!.freshnessMs).not.toBeNull();
    expect(res!.freshnessMs!).toBeGreaterThanOrEqual(3_000);
    expect(res!.freshnessMs!).toBeLessThan(10_000);
  });

  it("lifts tool_name / duration_ms / cost_usd / session_id / linear_key FROM THE STREAM LABELS", async () => {
    const loki = mockLoki(
      lokiStream(
        {
          service_name: "claude-code",
          event_name: "tool_result",
          tool_name: "Bash",
          duration_ms: "296",
          cost_usd: "0.0042",
          session_id: "abc-123",
          linear_key: "CTL-928",
        },
        // the body is the event-name string, never JSON
        [[String(Date.now() * 1_000_000), "claude_code.tool_result"]],
      ),
    );
    const res = await recentTail(loki, "15m");
    const row = res!.rows[0]!;
    expect(row.eventName).toBe("tool_result");
    expect(row.toolName).toBe("Bash");
    expect(row.durationMs).toBe(296);
    expect(row.costUsd).toBeCloseTo(0.0042);
    expect(row.sessionId).toBe("abc-123");
    expect(row.linearKey).toBe("CTL-928");
  });

  it("still lifts session_id / linear_key from a JSON body (older ingest fallback)", async () => {
    const loki = mockLoki(
      lokiStream({ service_name: "claude-code" }, [
        [
          String(Date.now() * 1_000_000),
          JSON.stringify({
            event_name: "claude_code.tool_result",
            session_id: "abc-123",
            linear_key: "CTL-928",
          }),
        ],
      ]),
    );
    const res = await recentTail(loki, "15m");
    expect(res!.rows[0]!.sessionId).toBe("abc-123");
    expect(res!.rows[0]!.linearKey).toBe("CTL-928");
  });

  it("an empty stream is an HONEST result with freshnessMs null (QUIET), NOT null", async () => {
    const loki = mockLoki({ data: { resultType: "streams", result: [] } });
    const res = await recentTail(loki, "15m");
    expect(res).not.toBeNull();
    expect(res!.rows).toHaveLength(0);
    expect(res!.freshnessMs).toBeNull();
  });

  it("returns null ONLY when Loki is unavailable (probe failed)", async () => {
    expect(await recentTail(mockLoki(null), "15m")).toBeNull();
  });

  it("tolerates a non-JSON line — row is present with null fields, never crashes", async () => {
    const loki = mockLoki(
      lokiStream({ service_name: "claude-code" }, [
        [String(Date.now() * 1_000_000), "not json at all"],
      ]),
    );
    const res = await recentTail(loki, "15m");
    expect(res!.rows).toHaveLength(1);
    expect(res!.rows[0]!.eventName).toBeNull();
    expect(res!.rows[0]!.sessionId).toBeNull();
  });
});

// ── OBS-8 (TELEMETRY P5): events/min heatmap ──────────────────────────────────

/** A Loki matrix keyed by session_id (mirrors lokiMatrix but on the session label). */
function lokiSessionMatrix(
  series: Array<{ session: string; values: Array<[number, string]> }>,
): LokiQueryResult {
  return {
    data: {
      resultType: "matrix",
      result: series.map((s) => ({
        metric: { session_id: s.session },
        values: s.values,
      })),
    },
  };
}

describe("eventsHeatmapLogQL — pin the LogQL shape", () => {
  it("counts claude-code lines by (session_id) in 15m windows, NO json stage", () => {
    const q = eventsHeatmapLogQL();
    expect(q).toContain("sum by (session_id)");
    expect(q).toContain("count_over_time");
    expect(q).toContain('{service_name=~"claude-code.*"}');
    expect(q).toContain(`[${HEATMAP_BUCKET_SECONDS}s]`);
    // session_id is a STREAM label — a `| json` stage errors on malformed lines and
    // would silently zero the matrix. It must NOT be present.
    expect(q).not.toContain("| json");
  });

  it("uses a 900s (15m) bucket", () => {
    expect(HEATMAP_BUCKET_SECONDS).toBe(900);
  });
});

describe("extractHeatmap — matrix → cells + bucket axis", () => {
  it("keeps positive cells, unions the sorted bucket axis, drops zeros", () => {
    const result = lokiSessionMatrix([
      { session: "sess-a", values: [[300, "5"], [1200, "0"], [2100, "3"]] },
      { session: "sess-b", values: [[1200, "7"]] },
    ]);
    const hm = extractHeatmap(result);
    // axis is the union of every point ts, ascending.
    expect(hm.buckets).toEqual([300, 1200, 2100]);
    // zero cell (sess-a @1200) is dropped — silence is represented by ABSENCE.
    expect(hm.cells).toEqual([
      { x: 300, sessionId: "sess-a", value: 5 },
      { x: 2100, sessionId: "sess-a", value: 3 },
      { x: 1200, sessionId: "sess-b", value: 7 },
    ]);
  });

  it("skips a series with no session_id label (never a fabricated key)", () => {
    const result: LokiQueryResult = {
      data: {
        resultType: "matrix",
        result: [{ metric: {}, values: [[300, "9"]] } as never],
      },
    };
    const hm = extractHeatmap(result);
    expect(hm.cells).toHaveLength(0);
    expect(hm.buckets).toHaveLength(0);
  });

  it("an empty matrix → empty model (honest silence, not an error)", () => {
    const hm = extractHeatmap({ data: { resultType: "matrix", result: [] } });
    expect(hm).toEqual({ buckets: [], cells: [] });
  });
});

describe("eventsHeatmap", () => {
  it("returns the extracted model and passes a 15m step to Loki", async () => {
    let seenStep: number | undefined;
    const loki: LokiFetcher = {
      queryRange: (_q, _s, _e, _limit, step) => {
        seenStep = step;
        return Promise.resolve(
          lokiSessionMatrix([{ session: "sess-a", values: [[300, "4"]] }]),
        );
      },
      isAvailable: () => true,
    };
    const hm = await eventsHeatmap(loki, "6h");
    expect(seenStep).toBe(HEATMAP_BUCKET_SECONDS);
    expect(hm!.cells).toEqual([{ x: 300, sessionId: "sess-a", value: 4 }]);
  });

  it("returns null ONLY when Loki is unavailable (probe failed)", async () => {
    const loki: LokiFetcher = {
      queryRange: () => Promise.resolve(null),
      isAvailable: () => false,
    };
    expect(await eventsHeatmap(loki, "6h")).toBeNull();
  });
});

// ── OBS-16 (UTILIZATION P_active): active-time ratio ─────────────────────────
describe("activeTimeRatio", () => {
  function vectorScalar(value: string): PrometheusQueryResult {
    return {
      data: { resultType: "vector", result: [{ metric: {}, value: [0, value] }] },
    };
  }

  it("reads the fleet-wide active seconds-per-second scalar", async () => {
    // The live ground-truth shape: a single sum(rate(...)) series ≈ 0.076 s/s.
    const prom = mockProm(vectorScalar("0.0760"));
    const result = await activeTimeRatio(prom, "1h");
    expect(result).not.toBeNull();
    expect(result!.activeSecondsPerSecond).toBeCloseTo(0.076, 4);
  });

  it("returns an HONEST 0 for a fully-idle fleet (empty vector)", async () => {
    const prom = mockProm({ data: { resultType: "vector", result: [] } });
    const result = await activeTimeRatio(prom, "1h");
    expect(result).toEqual({ activeSecondsPerSecond: 0 });
  });

  it("returns null ONLY when Prometheus is unavailable (query failed)", async () => {
    expect(await activeTimeRatio(mockProm(null), "1h")).toBeNull();
  });
});
