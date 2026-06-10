import { describe, it, expect } from "bun:test";
import {
  costByTicket,
  costByTaskType,
  tokensByType,
  cacheHitRate,
  costRateByModel,
  toolUsageByName,
  apiErrors,
  recentTail,
  recentTailLogQL,
  costValidation,
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
  it("extracts event_name/tool_name/tool_input/duration_ms/cost_usd/tokens/model/success", () => {
    const row = parseHistoryLine(
      1713100000000,
      JSON.stringify({
        event_name: "claude_code.tool_result",
        tool_name: "Edit",
        tool_input: "board-data.mjs",
        duration_ms: 1100,
        cost_usd: 0.0042,
        tokens: 318,
        model: "claude-opus-4-8",
        success: true,
      }),
    );
    expect(row.ts).toBe(1713100000000);
    expect(row.eventName).toBe("claude_code.tool_result");
    expect(row.toolName).toBe("Edit");
    expect(row.toolInput).toBe("board-data.mjs");
    expect(row.durationMs).toBe(1100);
    expect(row.costUsd).toBeCloseTo(0.0042);
    expect(row.tokens).toBe(318);
    expect(row.model).toBe("claude-opus-4-8");
    expect(row.success).toBe(true);
  });

  it("never crashes on a non-JSON line — fields stay null", () => {
    const row = parseHistoryLine(42, "this is not json");
    expect(row.ts).toBe(42);
    expect(row.eventName).toBeNull();
    expect(row.toolName).toBeNull();
    expect(row.durationMs).toBeNull();
    expect(row.success).toBeNull();
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

  it("parses rows newest-first and derives freshnessMs from the newest line", async () => {
    const now = Date.now();
    const newest = now - 4_000; // 4s ago
    const older = now - 60_000;
    const loki = mockLoki(
      lokiStream({ service_name: "claude-code" }, [
        // Loki returns ns timestamps as strings; give them out-of-order to prove sort.
        [String(older * 1_000_000), JSON.stringify({ event_name: "claude_code.tool_result", tool_name: "Read" })],
        [String(newest * 1_000_000), JSON.stringify({ event_name: "claude_code.api_request", model: "fable" })],
      ]),
    );
    const res = await recentTail(loki, "15m");
    expect(res).not.toBeNull();
    expect(res!.rows).toHaveLength(2);
    // newest-first
    expect(res!.rows[0]!.eventName).toBe("claude_code.api_request");
    expect(res!.rows[0]!.model).toBe("fable");
    // freshness ≈ 4s (allow a little slack for the now() taken inside recentTail)
    expect(res!.freshnessMs).not.toBeNull();
    expect(res!.freshnessMs!).toBeGreaterThanOrEqual(3_000);
    expect(res!.freshnessMs!).toBeLessThan(10_000);
  });

  it("lifts session_id / linear_key from the JSON body (the grouping keys)", async () => {
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

  it("falls back to stream labels for session_id when the body omits it", async () => {
    const loki = mockLoki(
      lokiStream({ service_name: "claude-code", session_id: "label-sess" }, [
        [String(Date.now() * 1_000_000), JSON.stringify({ event_name: "claude_code.api_request" })],
      ]),
    );
    const res = await recentTail(loki, "15m");
    expect(res!.rows[0]!.sessionId).toBe("label-sess");
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
