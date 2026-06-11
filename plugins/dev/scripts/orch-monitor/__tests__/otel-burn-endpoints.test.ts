// CTL-917 (DETAIL6): HTTP route-plumbing tests for the two burn-metric
// endpoints — `GET /api/otel/burn/<sessionId>` (worker Burn Strip) and
// `GET /api/otel/ticket-telemetry/<linearKey>` (ticket telemetry strip). The
// query LOGIC (PromQL shape, multi-series extraction, scalar-fallback emptiness)
// is covered by the injectable unit tests in otel-queries.test.ts; these prove
// each route is mounted, matched, id-validated (400, no PromQL injection), 503
// when Prometheus is absent, and returns the shaped sparkline series when a mock
// Prometheus answers query_range.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";
import type { PrometheusFetcher, PrometheusQueryResult } from "../lib/prometheus";

const UUID = "11111111-2222-3333-4444-555555555555";

let promQueries: string[];

/** Mock Prometheus that routes each query_range by a PromQL substring to a matrix
 *  result; unmatched queries resolve to an empty matrix (honest "no series"). */
function makeMockProm(
  routes: Array<{ match: string; result: PrometheusQueryResult }>,
): PrometheusFetcher {
  const find = (promql: string): PrometheusQueryResult => {
    for (const r of routes) if (promql.includes(r.match)) return r.result;
    return { data: { resultType: "matrix", result: [] } };
  };
  return {
    query: (promql) => {
      promQueries.push(promql);
      return Promise.resolve(find(promql));
    },
    queryRange: (promql) => {
      promQueries.push(promql);
      return Promise.resolve(find(promql));
    },
    isAvailable: () => true,
  };
}

function matrix(
  labels: Record<string, string>,
  values: Array<[number, string]>,
): PrometheusQueryResult {
  return { data: { resultType: "matrix", result: [{ metric: labels, values }] } };
}

describe("GET /api/otel/burn/:sessionId (CTL-917) — Prometheus configured", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let tmpDir: string;

  beforeAll(() => {
    promQueries = [];
    tmpDir = mkdtempSync(join(tmpdir(), "otel-burn-"));
    const wtDir = join(tmpDir, "wt");
    mkdirSync(wtDir, { recursive: true });
    server = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      prometheusFetcher: makeMockProm([
        {
          match: "sum(claude_code_cost_usage_USD_total{session_id",
          result: matrix({}, [[100, "0.40"], [160, "0.84"]]),
        },
        {
          match: "sum(claude_code_token_usage_tokens_total{session_id",
          result: matrix({}, [[160, "412000"]]),
        },
        {
          match: "sum(claude_code_active_time_seconds_total{session_id",
          result: matrix({}, [[160, "708"]]),
        },
      ]),
      annotationsDbPath: join(tmpDir, "annotations.db"),
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    void server?.stop(true);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("rejects a malformed sessionId with 400 (no PromQL injection / traversal)", async () => {
    expect((await fetch(`${baseUrl}/api/otel/burn/not a uuid!`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/otel/burn/short`)).status).toBe(400);
  });

  it("returns the four shaped sparkline series for a known CC session UUID", async () => {
    const res = await fetch(`${baseUrl}/api/otel/burn/${UUID}?range=1h`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        cost: Array<[number, number]>;
        tokens: Array<[number, number]>;
        activeSeconds: Array<[number, number]>;
      };
    };
    expect(body.data.cost).toEqual([[100, 0.4], [160, 0.84]]);
    expect(body.data.tokens).toEqual([[160, 412000]]);
    expect(body.data.activeSeconds).toEqual([[160, 708]]);
  });

  it("keys the PromQL on session_id=<UUID>", async () => {
    promQueries = [];
    await fetch(`${baseUrl}/api/otel/burn/${UUID}`);
    expect(promQueries.length).toBeGreaterThan(0);
    expect(promQueries.some((q) => q.includes(`session_id="${UUID}"`))).toBe(true);
  });
});

describe("GET /api/otel/ticket-telemetry/:linearKey (CTL-917) — Prometheus configured", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let tmpDir: string;

  beforeAll(() => {
    promQueries = [];
    tmpDir = mkdtempSync(join(tmpdir(), "otel-telemetry-"));
    const wtDir = join(tmpDir, "wt");
    mkdirSync(wtDir, { recursive: true });
    server = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      prometheusFetcher: makeMockProm([
        {
          match: "sum(claude_code_cost_usage_USD_total{linear_key",
          result: matrix({}, [[160, "1.14"]]),
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
              result: [{ metric: { model: "opus" }, values: [[160, "0.89"]] }],
            },
          },
        },
      ]),
      annotationsDbPath: join(tmpDir, "annotations.db"),
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    void server?.stop(true);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("rejects a malformed linear key with 400", async () => {
    expect((await fetch(`${baseUrl}/api/otel/ticket-telemetry/not%20a%20key`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/otel/ticket-telemetry/917`)).status).toBe(400);
  });

  it("returns total cost plus cost-by-phase and cost-by-model breakdowns", async () => {
    const res = await fetch(`${baseUrl}/api/otel/ticket-telemetry/CTL-845?range=1h`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        cost: Array<[number, number]>;
        costByPhase: Record<string, Array<[number, number]>>;
        costByModel: Record<string, Array<[number, number]>>;
      };
    };
    expect(body.data.cost).toEqual([[160, 1.14]]);
    expect(body.data.costByPhase["plan"]).toEqual([[160, 0.38]]);
    expect(body.data.costByPhase["implement"]).toEqual([[160, 0.51]]);
    expect(body.data.costByModel["opus"]).toEqual([[160, 0.89]]);
  });

  it("keys the PromQL on linear_key=<T>", async () => {
    promQueries = [];
    await fetch(`${baseUrl}/api/otel/ticket-telemetry/CTL-845`);
    expect(promQueries.some((q) => q.includes(`linear_key="CTL-845"`))).toBe(true);
  });
});

describe("burn / telemetry endpoints (CTL-917) — Prometheus absent", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "otel-burn-noprom-"));
    const wtDir = join(tmpDir, "wt");
    mkdirSync(wtDir, { recursive: true });
    server = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      prometheusFetcher: null,
      annotationsDbPath: join(tmpDir, "annotations.db"),
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    void server?.stop(true);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("returns 503 for the burn endpoint — the UI falls back to BoardWorker scalars", async () => {
    expect((await fetch(`${baseUrl}/api/otel/burn/${UUID}`)).status).toBe(503);
  });

  it("returns 503 for the telemetry endpoint — the UI falls back to BoardTicket scalars", async () => {
    expect((await fetch(`${baseUrl}/api/otel/ticket-telemetry/CTL-845`)).status).toBe(503);
  });

  it("still validates the id first — a bad id is 400 even without Prometheus", async () => {
    expect((await fetch(`${baseUrl}/api/otel/burn/not a uuid!`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/otel/ticket-telemetry/917`)).status).toBe(400);
  });
});
