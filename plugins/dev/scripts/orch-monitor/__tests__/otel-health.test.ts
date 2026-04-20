import { describe, it, expect } from "bun:test";
import {
  createOtelHealthChecker,
  type Fetcher,
} from "../lib/otel-health";

function makeFetcher(
  handler: (url: string) => Response | Promise<Response>,
): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: Fetcher = (url: string) => {
    calls.push(url);
    return Promise.resolve(handler(url));
  };
  return { fetcher, calls };
}

function ok(): Response {
  return new Response("ok", { status: 200 });
}

function serviceUnavailable(): Response {
  return new Response("down", { status: 503 });
}

describe("createOtelHealthChecker", () => {
  it("reports both endpoints reachable when probes succeed", async () => {
    const { fetcher } = makeFetcher(() => ok());
    const checker = createOtelHealthChecker({
      prometheusUrl: "http://prom:9090",
      lokiUrl: "http://loki:3100",
      fetcher,
    });
    const health = await checker.check();
    expect(health).toEqual({
      configured: true,
      prometheus: { url: "http://prom:9090", reachable: true },
      loki: { url: "http://loki:3100", reachable: true },
    });
  });

  it("reports endpoints unreachable when fetcher throws", async () => {
    const { fetcher } = makeFetcher(() => {
      throw new Error("connection refused");
    });
    const checker = createOtelHealthChecker({
      prometheusUrl: "http://prom:9090",
      lokiUrl: "http://loki:3100",
      fetcher,
    });
    const health = await checker.check();
    expect(health.configured).toBe(true);
    expect(health.prometheus.reachable).toBe(false);
    expect(health.loki.reachable).toBe(false);
    expect(health.prometheus.url).toBe("http://prom:9090");
    expect(health.loki.url).toBe("http://loki:3100");
  });

  it("reports unreachable when response is non-2xx", async () => {
    const { fetcher } = makeFetcher(() => serviceUnavailable());
    const checker = createOtelHealthChecker({
      prometheusUrl: "http://prom:9090",
      lokiUrl: "http://loki:3100",
      fetcher,
    });
    const health = await checker.check();
    expect(health.prometheus.reachable).toBe(false);
    expect(health.loki.reachable).toBe(false);
  });

  it("reports mixed reachability when only one endpoint is up", async () => {
    const { fetcher } = makeFetcher((url) => {
      if (url.includes("prom")) return ok();
      return serviceUnavailable();
    });
    const checker = createOtelHealthChecker({
      prometheusUrl: "http://prom:9090",
      lokiUrl: "http://loki:3100",
      fetcher,
    });
    const health = await checker.check();
    expect(health.prometheus.reachable).toBe(true);
    expect(health.loki.reachable).toBe(false);
  });

  it("reports configured=false when both URLs are null and does not call fetcher", async () => {
    const { fetcher, calls } = makeFetcher(() => ok());
    const checker = createOtelHealthChecker({
      prometheusUrl: null,
      lokiUrl: null,
      fetcher,
    });
    const health = await checker.check();
    expect(health).toEqual({
      configured: false,
      prometheus: { url: null, reachable: false },
      loki: { url: null, reachable: false },
    });
    expect(calls).toHaveLength(0);
  });

  it("considers configured=true when only one URL is set", async () => {
    const { fetcher } = makeFetcher(() => ok());
    const checker = createOtelHealthChecker({
      prometheusUrl: "http://prom:9090",
      lokiUrl: null,
      fetcher,
    });
    const health = await checker.check();
    expect(health.configured).toBe(true);
    expect(health.prometheus.reachable).toBe(true);
    expect(health.loki).toEqual({ url: null, reachable: false });
  });

  it("probes the correct paths on each endpoint", async () => {
    const { fetcher, calls } = makeFetcher(() => ok());
    const checker = createOtelHealthChecker({
      prometheusUrl: "http://prom:9090",
      lokiUrl: "http://loki:3100",
      fetcher,
    });
    await checker.check();
    expect(calls).toHaveLength(2);
    expect(calls.some((u) => u === "http://prom:9090/api/v1/status/buildinfo")).toBe(true);
    expect(calls.some((u) => u === "http://loki:3100/ready")).toBe(true);
  });

  it("caches results within the TTL window", async () => {
    const { fetcher, calls } = makeFetcher(() => ok());
    const checker = createOtelHealthChecker({
      prometheusUrl: "http://prom:9090",
      lokiUrl: "http://loki:3100",
      fetcher,
      cacheTtlMs: 10_000,
    });
    await checker.check();
    const firstBatch = calls.length;
    await checker.check();
    await checker.check();
    expect(calls.length).toBe(firstBatch);
  });

  it("refetches after the cache TTL expires", async () => {
    const { fetcher, calls } = makeFetcher(() => ok());
    const checker = createOtelHealthChecker({
      prometheusUrl: "http://prom:9090",
      lokiUrl: "http://loki:3100",
      fetcher,
      cacheTtlMs: 1,
    });
    await checker.check();
    const firstBatch = calls.length;
    await new Promise((r) => setTimeout(r, 5));
    await checker.check();
    expect(calls.length).toBeGreaterThan(firstBatch);
  });

  it("treats a stalled probe as unreachable via timeout", async () => {
    const fetcher: Fetcher = () =>
      new Promise<Response>((resolve, reject) => {
        // Never resolve on its own; abort signal should fire
        // (handled by the helper's AbortController when timeoutMs elapses).
        const id = setTimeout(() => resolve(ok()), 10_000);
        // Reject if AbortSignal fires — matches real `fetch` semantics.
        // Since we receive `init` as second arg, we need the fetcher signature.
        // Keep simple: resolve never; rely on timer in checker.
        void id;
        void reject;
      });
    const checker = createOtelHealthChecker({
      prometheusUrl: "http://prom:9090",
      lokiUrl: "http://loki:3100",
      fetcher,
      timeoutMs: 20,
    });
    const start = Date.now();
    const health = await checker.check();
    const elapsed = Date.now() - start;
    expect(health.prometheus.reachable).toBe(false);
    expect(health.loki.reachable).toBe(false);
    // Should not hang — complete well under a second.
    expect(elapsed).toBeLessThan(500);
  });

  it("strips trailing slashes on URLs before probing", async () => {
    const { fetcher, calls } = makeFetcher(() => ok());
    const checker = createOtelHealthChecker({
      prometheusUrl: "http://prom:9090/",
      lokiUrl: "http://loki:3100///",
      fetcher,
    });
    const health = await checker.check();
    expect(calls).toContain("http://prom:9090/api/v1/status/buildinfo");
    expect(calls).toContain("http://loki:3100/ready");
    expect(health.prometheus.url).toBe("http://prom:9090");
    expect(health.loki.url).toBe("http://loki:3100");
  });
});
