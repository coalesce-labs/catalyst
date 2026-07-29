// process-memory-metric.test.mjs — CTL-1517. Unit-tests the per-process memory OTLP
// gauge helper: the OTLP JSON shape (resource carries service.name; data point carries
// pid as stringValue; three semconv-named "By" gauges), the collector-default endpoint
// resolution when the env is unset, and the never-throw / silent-no-op-on-fetch-throw
// contract. NOTE: a green unit test is necessary but NOT sufficient — it injects an
// endpoint + fetch. The real verification is querying live Prometheus for
// process_memory_usage_bytes by (service_name) across all six daemons after deploy.

import { describe, test, expect, beforeEach } from "bun:test";
import {
  resolveCollectorBase,
  buildProcessMemoryMetricsPayload,
  emitProcessMemoryMetric,
  __resetProcessMemoryMetricState,
} from "./process-memory-metric.mjs";

// Pull the flat { key: value } out of an OTLP KeyValue[] (scalars only) for assertions.
const attrMap = (kvs = []) => Object.fromEntries(kvs.map((kv) => [kv.key, kv.value]));

const FIXED_MEM = { rss: 111_000_000, heapTotal: 90_000_000, heapUsed: 55_000_000, external: 7_000_000, arrayBuffers: 1_000 };

beforeEach(() => __resetProcessMemoryMetricState());

describe("resolveCollectorBase (CTL-1517 — the critical endpoint correction)", () => {
  test("returns null when neither OTEL_EXPORTER_OTLP_ENDPOINT nor CATALYST_OTLP_ENDPOINT is set (no live default)", () => {
    expect(resolveCollectorBase({})).toBeNull();
  });

  test("honors OTEL_EXPORTER_OTLP_ENDPOINT when present", () => {
    expect(resolveCollectorBase({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.internal:4318" })).toBe(
      "http://collector.internal:4318",
    );
  });

  test("honors CATALYST_OTLP_ENDPOINT when OTEL_EXPORTER_OTLP_ENDPOINT is absent", () => {
    expect(resolveCollectorBase({ CATALYST_OTLP_ENDPOINT: "http://collector.internal:4318" })).toBe(
      "http://collector.internal:4318",
    );
  });

  test("maps a gRPC :4317 endpoint to the HTTP :4318 and strips trailing slashes", () => {
    expect(resolveCollectorBase({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://host:4317/" })).toBe("http://host:4318");
  });
});

describe("buildProcessMemoryMetricsPayload — OTLP JSON shape", () => {
  const payload = () =>
    buildProcessMemoryMetricsPayload({
      serviceName: "catalyst.broker",
      memoryUsage: FIXED_MEM,
      timeUnixNano: "1700000000000000000",
    });

  test("the resource carries service.name (and only there), plus the shared identity keys", () => {
    const rm = payload().resourceMetrics[0];
    const res = attrMap(rm.resource.attributes);
    expect(res["service.name"]).toEqual({ stringValue: "catalyst.broker" });
    expect(res["service.namespace"]).toEqual({ stringValue: "catalyst" });
    expect("host.name" in res).toBe(true);
    expect("catalyst.node.class" in res).toBe(true);
  });

  test("emits exactly the three semconv-named byte gauges", () => {
    const metrics = payload().resourceMetrics[0].scopeMetrics[0].metrics;
    expect(metrics.map((m) => m.name)).toEqual([
      "process.memory.usage",
      "process.memory.heap.used",
      "process.memory.external",
    ]);
    for (const m of metrics) {
      expect(m.unit).toBe("By");
      expect(m.gauge.dataPoints).toHaveLength(1);
    }
  });

  test("each gauge carries the sampled value as asDouble", () => {
    const metrics = payload().resourceMetrics[0].scopeMetrics[0].metrics;
    const byName = Object.fromEntries(metrics.map((m) => [m.name, m.gauge.dataPoints[0]]));
    expect(byName["process.memory.usage"].asDouble).toBe(FIXED_MEM.rss);
    expect(byName["process.memory.heap.used"].asDouble).toBe(FIXED_MEM.heapUsed);
    expect(byName["process.memory.external"].asDouble).toBe(FIXED_MEM.external);
  });

  test("the data points carry NO pid label (a restart's dead-pid series can't double-count)", () => {
    const metrics = payload().resourceMetrics[0].scopeMetrics[0].metrics;
    for (const m of metrics) {
      const dp = m.gauge.dataPoints[0];
      // The series is keyed only by the resource (service.name + host); the running
      // process overwrites it on restart, so `sum by (service_name)` never adds a
      // terminated pid's stale value (Codex P2 on #2732).
      const dpAttrs = attrMap(dp.attributes ?? []);
      expect("pid" in dpAttrs).toBe(false);
      expect("service.name" in dpAttrs).toBe(false); // not duplicated onto the data point
    }
  });
});

describe("emitProcessMemoryMetric — transport contract", () => {
  test("POSTs to <configured-collector>/v1/metrics and resolves true on a 2xx", async () => {
    let captured = null;
    const fetchImpl = async (url, opts) => {
      captured = { url, opts };
      return { status: 200 };
    };
    const ok = await emitProcessMemoryMetric({
      serviceName: "catalyst.execution-core",
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.internal:4318" },
      fetchImpl,
    });
    expect(ok).toBe(true);
    expect(captured.url).toBe("http://collector.internal:4318/v1/metrics");
    expect(captured.opts.method).toBe("POST");
    const body = JSON.parse(captured.opts.body);
    const names = body.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name);
    expect(names).toEqual(["process.memory.usage", "process.memory.heap.used", "process.memory.external"]);
    const res = attrMap(body.resourceMetrics[0].resource.attributes);
    expect(res["service.name"]).toEqual({ stringValue: "catalyst.execution-core" });
  });

  test("no-ops (returns false, never fetches) when no endpoint is configured — no test-process pollution (Codex P1)", async () => {
    __resetProcessMemoryMetricState();
    let fetched = false;
    const fetchImpl = async () => {
      fetched = true;
      return { status: 200 };
    };
    const warnCalls = [];
    const ok = await emitProcessMemoryMetric({
      serviceName: "catalyst.broker",
      env: {}, // no OTEL_EXPORTER_OTLP_ENDPOINT / CATALYST_OTLP_ENDPOINT
      fetchImpl,
      log: { warn: (_obj, msg) => warnCalls.push(msg) },
    });
    expect(ok).toBe(false);
    expect(fetched).toBe(false); // never posts to a live default → no production pollution
    expect(warnCalls).toHaveLength(1); // but loud once, so a misconfigured daemon is visible
  });

  test("is a silent no-op when the POST fetch throws — returns false, never throws, does not warn on a single failure", async () => {
    const warnCalls = [];
    const log = { warn: (obj, msg) => warnCalls.push({ obj, msg }) };
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    let result;
    await expect(
      (async () => {
        result = await emitProcessMemoryMetric({ serviceName: "catalyst.svc-throw", env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.internal:4318" }, fetchImpl, log });
      })(),
    ).resolves.toBeUndefined();
    expect(result).toBe(false);
    expect(warnCalls).toHaveLength(0); // a single transient failure stays silent
  });

  test("warn-once fires after repeated consecutive failures (loud dark-gauge)", async () => {
    const warnCalls = [];
    const log = { warn: (obj, msg) => warnCalls.push({ obj, msg }) };
    const fetchImpl = async () => {
      throw new Error("ENETUNREACH");
    };
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await emitProcessMemoryMetric({ serviceName: "catalyst.svc-repeat", env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.internal:4318" }, fetchImpl, log });
    }
    expect(warnCalls).toHaveLength(1); // exactly one warn despite five failures
    expect(warnCalls[0].msg).toContain("per-process memory gauge is dark");
  });

  test("a non-2xx response resolves false without throwing", async () => {
    const fetchImpl = async () => ({ status: 503 });
    const ok = await emitProcessMemoryMetric({ serviceName: "catalyst.svc-503", env: {}, fetchImpl });
    expect(ok).toBe(false);
  });

  test("missing serviceName is a safe no-op (returns false, no fetch)", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return { status: 200 };
    };
    const ok = await emitProcessMemoryMetric({ env: {}, fetchImpl });
    expect(ok).toBe(false);
    expect(called).toBe(false);
  });
});
