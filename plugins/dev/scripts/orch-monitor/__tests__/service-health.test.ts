// service-health.test.ts — CTL-1050 / CTL-1039: the SHARED severity-model
// transition rules (applyProbeResult) + the config-driven registry. The pure
// contract: boot→unknown, threshold-based degraded↦down, self-clearing success,
// event-recency tiering, target:null stays unknown, collector no-cascade.

import { describe, it, expect } from "bun:test";
import {
  type ServiceDescriptor,
  type ServiceStatus,
  applyProbeResult,
  buildRegistry,
  initialStatus,
  DAEMON_DEGRADED_MS,
  DAEMON_DOWN_MS,
} from "../lib/service-health";

const probeDescriptor: ServiceDescriptor = {
  id: "loki",
  label: "Loki",
  kind: "probe-url",
  target: "http://loki/ready",
  configSource: "otel.lokiUrl",
  intervalMs: 30_000,
  slowMs: 1500,
  downAfterConsecutive: 3,
};

const recencyDescriptor: ServiceDescriptor = {
  id: "broker",
  label: "Broker",
  kind: "event-recency",
  target: "event-log service.name=broker",
  configSource: "event-log",
  intervalMs: 30_000,
  degradedAfterMs: DAEMON_DEGRADED_MS,
  downAfterMs: DAEMON_DOWN_MS,
};

describe("initialStatus / boot", () => {
  it("boots unknown until the first result resolves (never flashes red)", () => {
    const s = initialStatus(probeDescriptor);
    expect(s.severity).toBe("unknown");
    expect(s.lastCheckedAt).toBeNull();
    expect(s.consecutiveFailures).toBe(0);
  });

  it("an unconfigured (target:null) entry boots unknown with a 'not configured' detail", () => {
    const d: ServiceDescriptor = { ...probeDescriptor, target: null };
    const s = initialStatus(d);
    expect(s.severity).toBe("unknown");
    expect(s.detail).toBe("not configured");
  });
});

describe("probe-url failure threshold (degraded vs down)", () => {
  it("1st failure → degraded, 2nd → degraded, 3rd → down with downSince stamped once", () => {
    let s = initialStatus(probeDescriptor);
    s = applyProbeResult(s, probeDescriptor, { kind: "probe-url", ok: false }, 1000);
    expect(s.severity).toBe("degraded");
    expect(s.consecutiveFailures).toBe(1);
    expect(s.downSince).toBeNull();

    s = applyProbeResult(s, probeDescriptor, { kind: "probe-url", ok: false }, 2000);
    expect(s.severity).toBe("degraded");
    expect(s.consecutiveFailures).toBe(2);

    s = applyProbeResult(s, probeDescriptor, { kind: "probe-url", ok: false }, 3000);
    expect(s.severity).toBe("down");
    expect(s.consecutiveFailures).toBe(3);
    expect(s.downSince).toBe(3000);

    // 4th failure: still down, downSince UNCHANGED (stamped once).
    s = applyProbeResult(s, probeDescriptor, { kind: "probe-url", ok: false }, 4000);
    expect(s.severity).toBe("down");
    expect(s.downSince).toBe(3000);
  });
});

describe("probe-url success (self-clearing — CTL-1039)", () => {
  it("success after ANY failure count → up immediately + counter reset", () => {
    let s = initialStatus(probeDescriptor);
    for (const t of [1000, 2000, 3000, 4000]) {
      s = applyProbeResult(s, probeDescriptor, { kind: "probe-url", ok: false }, t);
    }
    expect(s.severity).toBe("down");

    s = applyProbeResult(s, probeDescriptor, { kind: "probe-url", ok: true, latencyMs: 40 }, 5000);
    expect(s.severity).toBe("up");
    expect(s.consecutiveFailures).toBe(0);
    expect(s.downSince).toBeNull();
    expect(s.lastOkAt).toBe(5000);
  });

  it("slow OK (latency > slowMs) → degraded with a slow-probe detail", () => {
    let s = initialStatus(probeDescriptor);
    s = applyProbeResult(s, probeDescriptor, { kind: "probe-url", ok: true, latencyMs: 1800 }, 1000);
    expect(s.severity).toBe("degraded");
    expect(s.detail).toContain("slow probe");
    expect(s.consecutiveFailures).toBe(0);
  });
});

describe("event-recency tiering (broker / exec-core)", () => {
  it("fresh age → up, 3m+ → degraded, 10m+ → down boundaries", () => {
    let s = initialStatus(recencyDescriptor);
    const now = 1_000_000;

    s = applyProbeResult(s, recencyDescriptor, { kind: "event-recency", ageMs: 30_000 }, now);
    expect(s.severity).toBe("up");

    // Just below 3m → still up.
    s = applyProbeResult(s, recencyDescriptor, { kind: "event-recency", ageMs: DAEMON_DEGRADED_MS - 1 }, now);
    expect(s.severity).toBe("up");

    // At 3m → degraded.
    s = applyProbeResult(s, recencyDescriptor, { kind: "event-recency", ageMs: DAEMON_DEGRADED_MS }, now);
    expect(s.severity).toBe("degraded");

    // At 10m → down.
    s = applyProbeResult(s, recencyDescriptor, { kind: "event-recency", ageMs: DAEMON_DOWN_MS }, now);
    expect(s.severity).toBe("down");
  });

  it("null age (no emission found) → down (no recent emission)", () => {
    let s = initialStatus(recencyDescriptor);
    s = applyProbeResult(s, recencyDescriptor, { kind: "event-recency", ageMs: null }, 1000);
    expect(s.severity).toBe("down");
    expect(s.detail).toContain("no recent emission");
  });
});

describe("forced severity (unconfigured + collector no-cascade)", () => {
  it("target:null forced unknown stays unknown, never down", () => {
    const d: ServiceDescriptor = { ...probeDescriptor, target: null };
    let s = initialStatus(d);
    s = applyProbeResult(s, d, { kind: "probe-url", forcedSeverity: "unknown", detail: "not configured" }, 1000);
    expect(s.severity).toBe("unknown");
    expect(s.consecutiveFailures).toBe(0);
  });

  it("collector recency fallback forced unknown when Loki down (no cascade red)", () => {
    const d: ServiceDescriptor = {
      id: "otel-collector",
      label: "Collector",
      kind: "event-recency",
      target: "inferred from telemetry ingest",
      configSource: "inferred",
      intervalMs: 30_000,
    };
    let s = initialStatus(d);
    s = applyProbeResult(
      s,
      d,
      { kind: "event-recency", forcedSeverity: "unknown", detail: "Loki unreachable" },
      1000,
    );
    expect(s.severity).toBe("unknown");
  });
});

describe("buildRegistry (config-driven, never hardcoded)", () => {
  it("derives the eight entries with targets read from config", () => {
    const reg = buildRegistry({
      lokiUrl: "http://loki",
      prometheusUrl: "http://prom",
      grafanaUrl: "http://grafana",
      collectorHealthUrl: null,
      webhookConfigured: true,
    });
    const byId = (id: string): ServiceDescriptor => reg.find((d) => d.id === id)!;
    expect(reg).toHaveLength(8);
    expect(byId("loki").target).toBe("http://loki/ready");
    expect(byId("prometheus").target).toBe("http://prom/api/v1/status/buildinfo");
    expect(byId("grafana").target).toBe("http://grafana/api/health");
    // collectorHealthUrl unset + loki present → event-recency fallback.
    expect(byId("otel-collector").kind).toBe("event-recency");
    expect(byId("otel-collector").target).toBe("inferred from telemetry ingest");
    expect(byId("webhook").target).not.toBeNull();
  });

  it("grafana absent ⇒ target null ⇒ unknown/grey, never red", () => {
    const reg = buildRegistry({
      lokiUrl: "http://loki",
      prometheusUrl: null,
      grafanaUrl: null,
      collectorHealthUrl: null,
      webhookConfigured: false,
    });
    const grafana = reg.find((d) => d.id === "grafana")!;
    expect(grafana.target).toBeNull();
    expect(initialStatus(grafana).severity).toBe("unknown");
    // webhook unconfigured → target null.
    expect(reg.find((d) => d.id === "webhook")!.target).toBeNull();
  });

  it("collectorHealthUrl set ⇒ collector is a probe-url entry", () => {
    const reg = buildRegistry({
      lokiUrl: "http://loki",
      prometheusUrl: null,
      grafanaUrl: null,
      collectorHealthUrl: "http://collector:13133",
      webhookConfigured: false,
    });
    const collector = reg.find((d) => d.id === "otel-collector")!;
    expect(collector.kind).toBe("probe-url");
    expect(collector.target).toBe("http://collector:13133");
  });
});

// Type-only guard: the snapshot shape the strip + decoration consume.
const _typeGuard: ServiceStatus = initialStatus(probeDescriptor);
void _typeGuard;
