import { describe, it, expect } from "bun:test";
import {
  createPrometheusFetcher,
  type Fetcher,
  type PrometheusQueryResult,
} from "../lib/prometheus";

function successResponse(data: PrometheusQueryResult["data"]): Response {
  return Response.json({ status: "success", data });
}

function errorResponse(error: string, status = 500): Response {
  return new Response(JSON.stringify({ status: "error", error }), { status });
}

function makeFetcher(
  handler: (url: string) => Response | Promise<Response>,
): Fetcher {
  return (url: string) => Promise.resolve(handler(url));
}

const vectorResult: PrometheusQueryResult["data"] = {
  resultType: "vector",
  result: [
    { metric: { linear_key: "CTL-39" }, value: [1713100000, "1.234"] },
    { metric: { linear_key: "CTL-40" }, value: [1713100000, "0.567"] },
  ],
};

const matrixResult: PrometheusQueryResult["data"] = {
  resultType: "matrix",
  result: [
    {
      metric: { type: "input" },
      values: [
        [1713100000, "5000"],
        [1713100060, "5100"],
      ],
    },
  ],
};

describe("createPrometheusFetcher", () => {
  it("returns null from query when probe fails", async () => {
    const fetcher = createPrometheusFetcher({
      baseUrl: "http://localhost:9098",
      fetcher: makeFetcher(() => errorResponse("connection refused")),
    });
    const result = await fetcher.query('up{job="prometheus"}');
    expect(result).toBeNull();
  });

  it("successfully probes and caches availability", async () => {
    let calls = 0;
    const fetcher = createPrometheusFetcher({
      baseUrl: "http://localhost:9098",
      fetcher: makeFetcher((url) => {
        calls++;
        if (url.includes("/api/v1/status/buildinfo")) {
          return Response.json({ status: "success", data: {} });
        }
        return successResponse(vectorResult);
      }),
    });
    const r1 = await fetcher.query("up");
    expect(r1).not.toBeNull();
    const probeCalls = calls;
    await fetcher.query("up");
    expect(calls - probeCalls).toBe(0);
  });

  it("parses instant query response", async () => {
    const fetcher = createPrometheusFetcher({
      baseUrl: "http://localhost:9098",
      fetcher: makeFetcher((url) => {
        if (url.includes("/api/v1/status/buildinfo")) {
          return Response.json({ status: "success", data: {} });
        }
        return successResponse(vectorResult);
      }),
    });
    const result = await fetcher.query(
      'sum by (linear_key) (increase(claude_code_cost_usage_USD_total[1h]))',
    );
    expect(result).not.toBeNull();
    expect(result!.data.resultType).toBe("vector");
    expect(result!.data.result).toHaveLength(2);
  });

  it("passes time parameter in instant query", async () => {
    let capturedUrl = "";
    const fetcher = createPrometheusFetcher({
      baseUrl: "http://localhost:9098",
      fetcher: makeFetcher((url) => {
        capturedUrl = url;
        if (url.includes("/api/v1/status/buildinfo")) {
          return Response.json({ status: "success", data: {} });
        }
        return successResponse(vectorResult);
      }),
    });
    await fetcher.query("up", "2026-04-14T12:00:00Z");
    expect(capturedUrl).toContain("time=2026-04-14T12%3A00%3A00Z");
  });

  it("parses range query response", async () => {
    const fetcher = createPrometheusFetcher({
      baseUrl: "http://localhost:9098",
      fetcher: makeFetcher((url) => {
        if (url.includes("/api/v1/status/buildinfo")) {
          return Response.json({ status: "success", data: {} });
        }
        return successResponse(matrixResult);
      }),
    });
    const result = await fetcher.queryRange(
      'sum by (type) (increase(claude_code_token_usage_tokens_total[1h]))',
      "2026-04-14T00:00:00Z",
      "2026-04-14T12:00:00Z",
      "60s",
    );
    expect(result).not.toBeNull();
    expect(result!.data.resultType).toBe("matrix");
  });

  it("passes correct params in range query URL", async () => {
    let capturedUrl = "";
    const fetcher = createPrometheusFetcher({
      baseUrl: "http://localhost:9098",
      fetcher: makeFetcher((url) => {
        capturedUrl = url;
        if (url.includes("/api/v1/status/buildinfo")) {
          return Response.json({ status: "success", data: {} });
        }
        return successResponse(matrixResult);
      }),
    });
    await fetcher.queryRange("up", "2026-04-14T00:00:00Z", "2026-04-14T12:00:00Z", "60s");
    expect(capturedUrl).toContain("start=2026-04-14T00%3A00%3A00Z");
    expect(capturedUrl).toContain("end=2026-04-14T12%3A00%3A00Z");
    expect(capturedUrl).toContain("step=60s");
  });

  it("returns null on HTTP error response", async () => {
    const fetcher = createPrometheusFetcher({
      baseUrl: "http://localhost:9098",
      fetcher: makeFetcher((url) => {
        if (url.includes("/api/v1/status/buildinfo")) {
          return Response.json({ status: "success", data: {} });
        }
        return errorResponse("bad request", 400);
      }),
    });
    const result = await fetcher.query("invalid{");
    expect(result).toBeNull();
  });

  it("returns null on malformed JSON response", async () => {
    const fetcher = createPrometheusFetcher({
      baseUrl: "http://localhost:9098",
      fetcher: makeFetcher((url) => {
        if (url.includes("/api/v1/status/buildinfo")) {
          return Response.json({ status: "success", data: {} });
        }
        return new Response("not json", { status: 200 });
      }),
    });
    const result = await fetcher.query("up");
    expect(result).toBeNull();
  });

  it("returns null on network error (fetch throws)", async () => {
    const fetcher = createPrometheusFetcher({
      baseUrl: "http://localhost:9098",
      fetcher: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    const result = await fetcher.query("up");
    expect(result).toBeNull();
  });

  it("returns cached result within TTL", async () => {
    let calls = 0;
    const fetcher = createPrometheusFetcher({
      baseUrl: "http://localhost:9098",
      cacheTtlMs: 60_000,
      fetcher: makeFetcher((url) => {
        if (url.includes("/api/v1/status/buildinfo")) {
          return Response.json({ status: "success", data: {} });
        }
        calls++;
        return successResponse(vectorResult);
      }),
    });
    await fetcher.query("up");
    await fetcher.query("up");
    expect(calls).toBe(1);
  });

  it("re-fetches after TTL expires", async () => {
    let calls = 0;
    const fetcher = createPrometheusFetcher({
      baseUrl: "http://localhost:9098",
      cacheTtlMs: 1,
      fetcher: makeFetcher((url) => {
        if (url.includes("/api/v1/status/buildinfo")) {
          return Response.json({ status: "success", data: {} });
        }
        calls++;
        return successResponse(vectorResult);
      }),
    });
    await fetcher.query("up");
    await new Promise((r) => setTimeout(r, 10));
    await fetcher.query("up");
    expect(calls).toBe(2);
  });

  it("reports availability via isAvailable()", async () => {
    const fetcher = createPrometheusFetcher({
      baseUrl: "http://localhost:9098",
      fetcher: makeFetcher((url) => {
        if (url.includes("/api/v1/status/buildinfo")) {
          return Response.json({ status: "success", data: {} });
        }
        return successResponse(vectorResult);
      }),
    });
    expect(fetcher.isAvailable()).toBe(false);
    await fetcher.query("up");
    expect(fetcher.isAvailable()).toBe(true);
  });

  it("strips trailing slash from baseUrl", async () => {
    let capturedUrl = "";
    const fetcher = createPrometheusFetcher({
      baseUrl: "http://localhost:9098/",
      fetcher: makeFetcher((url) => {
        capturedUrl = url;
        if (url.includes("/api/v1/status/buildinfo")) {
          return Response.json({ status: "success", data: {} });
        }
        return successResponse(vectorResult);
      }),
    });
    await fetcher.query("up");
    expect(capturedUrl).not.toContain("//api");
  });
});
