import { describe, it, expect } from "bun:test";
import {
  createLokiFetcher,
  type Fetcher,
  type LokiQueryResult,
} from "../lib/loki";

function successResponse(data: LokiQueryResult["data"]): Response {
  return Response.json({ status: "success", data });
}

function makeFetcher(
  handler: (url: string) => Response | Promise<Response>,
): Fetcher {
  return (url: string) => Promise.resolve(handler(url));
}

const streamsResult: LokiQueryResult["data"] = {
  resultType: "streams",
  result: [
    {
      stream: { service_name: "claude-code.session-1" },
      values: [
        ["1713100000000000000", '{"tool_name":"Read","duration_ms":42}'],
        ["1713100001000000000", '{"tool_name":"Edit","duration_ms":18}'],
      ],
    },
  ],
};

const metricResult: LokiQueryResult["data"] = {
  resultType: "matrix",
  result: [
    {
      metric: { tool_name: "Read" },
      values: [
        [1713100000, "15"],
        [1713100060, "23"],
      ],
    },
    {
      metric: { tool_name: "Edit" },
      values: [
        [1713100000, "5"],
        [1713100060, "8"],
      ],
    },
  ],
};

describe("createLokiFetcher", () => {
  it("returns null when probe fails", async () => {
    const fetcher = createLokiFetcher({
      baseUrl: "http://localhost:3100",
      fetcher: makeFetcher(() => new Response("", { status: 503 })),
    });
    const result = await fetcher.queryRange(
      '{service_name=~"claude-code.*"}',
      "2026-04-14T00:00:00Z",
      "2026-04-14T12:00:00Z",
    );
    expect(result).toBeNull();
  });

  it("probes loki readiness and caches result", async () => {
    let probeCalls = 0;
    const fetcher = createLokiFetcher({
      baseUrl: "http://localhost:3100",
      fetcher: makeFetcher((url) => {
        if (url.includes("/ready")) {
          probeCalls++;
          return new Response("ready", { status: 200 });
        }
        return successResponse(streamsResult);
      }),
    });
    await fetcher.queryRange("{}", "t0", "t1");
    await fetcher.queryRange("{}", "t0", "t1");
    expect(probeCalls).toBe(1);
  });

  it("parses streams result from queryRange", async () => {
    const fetcher = createLokiFetcher({
      baseUrl: "http://localhost:3100",
      fetcher: makeFetcher((url) => {
        if (url.includes("/ready")) return new Response("ready");
        return successResponse(streamsResult);
      }),
    });
    const result = await fetcher.queryRange(
      '{service_name=~"claude-code.*"} |= "tool_result"',
      "2026-04-14T00:00:00Z",
      "2026-04-14T12:00:00Z",
    );
    expect(result).not.toBeNull();
    expect(result!.data.resultType).toBe("streams");
    expect(result!.data.result).toHaveLength(1);
    expect((result!.data.result[0] as { values: unknown[] }).values).toHaveLength(2);
  });

  it("parses metric/matrix result from queryRange", async () => {
    const fetcher = createLokiFetcher({
      baseUrl: "http://localhost:3100",
      fetcher: makeFetcher((url) => {
        if (url.includes("/ready")) return new Response("ready");
        return successResponse(metricResult);
      }),
    });
    const result = await fetcher.queryRange(
      'sum by (tool_name) (count_over_time({service_name=~"claude-code.*"}[1h]))',
      "2026-04-14T00:00:00Z",
      "2026-04-14T12:00:00Z",
    );
    expect(result).not.toBeNull();
    expect(result!.data.resultType).toBe("matrix");
  });

  it("passes correct URL params including limit", async () => {
    let capturedUrl = "";
    const fetcher = createLokiFetcher({
      baseUrl: "http://localhost:3100",
      fetcher: makeFetcher((url) => {
        capturedUrl = url;
        if (url.includes("/ready")) return new Response("ready");
        return successResponse(streamsResult);
      }),
    });
    await fetcher.queryRange('{job="test"}', "t0", "t1", 100);
    expect(capturedUrl).toContain("query=%7Bjob%3D%22test%22%7D");
    expect(capturedUrl).toContain("start=t0");
    expect(capturedUrl).toContain("end=t1");
    expect(capturedUrl).toContain("limit=100");
  });

  it("uses default limit of 1000 when not specified", async () => {
    let capturedUrl = "";
    const fetcher = createLokiFetcher({
      baseUrl: "http://localhost:3100",
      fetcher: makeFetcher((url) => {
        capturedUrl = url;
        if (url.includes("/ready")) return new Response("ready");
        return successResponse(streamsResult);
      }),
    });
    await fetcher.queryRange("{}", "t0", "t1");
    expect(capturedUrl).toContain("limit=1000");
  });

  it("returns null on HTTP error", async () => {
    const fetcher = createLokiFetcher({
      baseUrl: "http://localhost:3100",
      fetcher: makeFetcher((url) => {
        if (url.includes("/ready")) return new Response("ready");
        return new Response("bad request", { status: 400 });
      }),
    });
    const result = await fetcher.queryRange("invalid{", "t0", "t1");
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    let first = true;
    const fetcher = createLokiFetcher({
      baseUrl: "http://localhost:3100",
      fetcher: (url) => {
        if (url.includes("/ready")) {
          return Promise.resolve(new Response("ready"));
        }
        if (first) {
          first = false;
          return Promise.resolve(new Response("ready"));
        }
        return Promise.reject(new Error("ECONNREFUSED"));
      },
    });
    const result = await fetcher.queryRange("{}", "t0", "t1");
    expect(result).toBeNull();
  });

  it("caches within TTL", async () => {
    let calls = 0;
    const fetcher = createLokiFetcher({
      baseUrl: "http://localhost:3100",
      cacheTtlMs: 60_000,
      fetcher: makeFetcher((url) => {
        if (url.includes("/ready")) return new Response("ready");
        calls++;
        return successResponse(streamsResult);
      }),
    });
    await fetcher.queryRange("{}", "t0", "t1");
    await fetcher.queryRange("{}", "t0", "t1");
    expect(calls).toBe(1);
  });

  it("re-fetches after TTL", async () => {
    let calls = 0;
    const fetcher = createLokiFetcher({
      baseUrl: "http://localhost:3100",
      cacheTtlMs: 1,
      fetcher: makeFetcher((url) => {
        if (url.includes("/ready")) return new Response("ready");
        calls++;
        return successResponse(streamsResult);
      }),
    });
    await fetcher.queryRange("{}", "t0", "t1");
    await new Promise((r) => setTimeout(r, 10));
    await fetcher.queryRange("{}", "t0", "t1");
    expect(calls).toBe(2);
  });

  it("reports availability via isAvailable()", async () => {
    const fetcher = createLokiFetcher({
      baseUrl: "http://localhost:3100",
      fetcher: makeFetcher((url) => {
        if (url.includes("/ready")) return new Response("ready");
        return successResponse(streamsResult);
      }),
    });
    expect(fetcher.isAvailable()).toBe(false);
    await fetcher.queryRange("{}", "t0", "t1");
    expect(fetcher.isAvailable()).toBe(true);
  });
});
