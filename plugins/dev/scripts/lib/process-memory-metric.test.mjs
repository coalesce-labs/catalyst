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
  test("falls back to the shared collector default when OTEL_EXPORTER_OTLP_ENDPOINT is unset", () => {
    expect(resolveCollectorBase({})).toBe("http://100.65.193.30:4318");
  });

  test("honors OTEL_EXPORTER_OTLP_ENDPOINT when present", () => {
    expect(resolveCollectorBase({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.internal:4318" })).toBe(
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
      pid: 4242,
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

  test("pid rides ONLY on the data point, encoded as a stringValue (not intValue)", () => {
    const metrics = payload().resourceMetrics[0].scopeMetrics[0].metrics;
    for (const m of metrics) {
      const dp = m.gauge.dataPoints[0];
      const dpAttrs = attrMap(dp.attributes);
      expect(dpAttrs.pid).toEqual({ stringValue: "4242" });
      expect(dpAttrs.pid).not.toHaveProperty("intValue");
    }
    // service.name is NOT duplicated onto the data point.
    const dpAttrs = attrMap(metrics[0].gauge.dataPoints[0].attributes);
    expect("service.name" in dpAttrs).toBe(false);
  });
});

describe("emitProcessMemoryMetric — transport contract", () => {
  test("POSTs to <collector-default>/v1/metrics and resolves true on a 2xx", async () => {
    let captured = null;
    const fetchImpl = async (url, opts) => {
      captured = { url, opts };
      return { status: 200 };
    };
    const ok = await emitProcessMemoryMetric({ serviceName: "catalyst.execution-core", env: {}, fetchImpl });
    expect(ok).toBe(true);
    expect(captured.url).toBe("http://100.65.193.30:4318/v1/metrics");
    expect(captured.opts.method).toBe("POST");
    const body = JSON.parse(captured.opts.body);
    const names = body.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name);
    expect(names).toEqual(["process.memory.usage", "process.memory.heap.used", "process.memory.external"]);
    const res = attrMap(body.resourceMetrics[0].resource.attributes);
    expect(res["service.name"]).toEqual({ stringValue: "catalyst.execution-core" });
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
        result = await emitProcessMemoryMetric({ serviceName: "catalyst.svc-throw", env: {}, fetchImpl, log });
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
      await emitProcessMemoryMetric({ serviceName: "catalyst.svc-repeat", env: {}, fetchImpl, log });
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
