import { describe, it, expect } from "bun:test";
import {
  costByTicket,
  tokensByType,
  cacheHitRate,
  costRateByModel,
  toolUsageByName,
  apiErrors,
  costValidation,
  safeDuration,
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
