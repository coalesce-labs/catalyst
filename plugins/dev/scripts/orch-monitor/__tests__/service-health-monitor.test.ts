// service-health-monitor.test.ts — CTL-1050: the server-side poller's I/O glue.
// Proves the event-recency read (readEmissionAge), the collector recency
// fallback's no-cascade (Loki down ⇒ collector unknown, not red), and that a
// failing probe crosses to down only after 3 ticks (the registry tick is the
// counter clock).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createServiceHealthMonitor,
  readEmissionAge,
} from "../lib/service-health-monitor";

let catalystDir: string;

beforeEach(() => {
  catalystDir = mkdtempSync(join(tmpdir(), "svc-health-monitor-"));
  mkdirSync(join(catalystDir, "events"), { recursive: true });
});

afterEach(() => {
  rmSync(catalystDir, { recursive: true, force: true });
});

function writeEvent(ts: string, serviceName: string): void {
  const now = new Date(ts);
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const path = join(catalystDir, "events", `${y}-${m}.jsonl`);
  const line =
    JSON.stringify({
      ts,
      attributes: { "event.name": "catalyst.heartbeat" },
      resource: { "service.name": serviceName },
    }) + "\n";
  writeFileSync(path, line, { flag: "a" });
}

describe("readEmissionAge", () => {
  it("returns the age of the newest matching emission", () => {
    const now = Date.parse("2026-06-11T12:00:00.000Z");
    writeEvent("2026-06-11T11:58:00.000Z", "broker"); // 2m ago
    writeEvent("2026-06-11T11:55:00.000Z", "broker"); // 5m ago (older)
    const age = readEmissionAge(catalystDir, { serviceName: "broker" }, now);
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(2 * 60_000 - 1000);
    expect(age!).toBeLessThan(3 * 60_000);
  });

  it("returns null when no match found", () => {
    const now = Date.parse("2026-06-11T12:00:00.000Z");
    writeEvent("2026-06-11T11:58:00.000Z", "broker");
    const age = readEmissionAge(catalystDir, { serviceName: "execution-core" }, now);
    expect(age).toBeNull();
  });
});

describe("broker / execution-core recency uses catalyst.* service names", () => {
  it("broker shows up when catalyst.broker emitted recently", async () => {
    // The catalyst event log records service.name as "catalyst.broker" (prefixed),
    // not the bare "broker". The RECENCY_MATCHERS must use the prefixed form.
    const now = Date.parse("2026-06-11T12:00:00.000Z");
    writeEvent("2026-06-11T11:59:00.000Z", "catalyst.broker"); // 1m ago → within 3m degraded
    const monitor = createServiceHealthMonitor({
      config: {
        lokiUrl: null,
        prometheusUrl: null,
        grafanaUrl: null,
        collectorHealthUrl: null,
        webhookConfigured: false,
      },
      catalystDir,
      now: () => now,
    });
    await monitor.tick();
    const snap = monitor.snapshot();
    expect(snap.services.find((s) => s.id === "broker")!.severity).toBe("up");
  });

  it("execution-core shows up when catalyst.execution-core emitted recently", async () => {
    const now = Date.parse("2026-06-11T12:00:00.000Z");
    writeEvent("2026-06-11T11:59:30.000Z", "catalyst.execution-core"); // 30s ago
    const monitor = createServiceHealthMonitor({
      config: {
        lokiUrl: null,
        prometheusUrl: null,
        grafanaUrl: null,
        collectorHealthUrl: null,
        webhookConfigured: false,
      },
      catalystDir,
      now: () => now,
    });
    await monitor.tick();
    const snap = monitor.snapshot();
    expect(snap.services.find((s) => s.id === "execution-core")!.severity).toBe("up");
  });
});

describe("collector recency fallback — no cascade", () => {
  it("marks collector unknown (not down) when Loki itself is down", async () => {
    // Loki probe always fails → after 3 ticks Loki is down. No ingest events at
    // all → the collector recency would otherwise read null/down, but since Loki
    // is down we must NOT cascade — collector = unknown.
    const monitor = createServiceHealthMonitor({
      config: {
        lokiUrl: "http://loki",
        prometheusUrl: null,
        grafanaUrl: null,
        collectorHealthUrl: null, // ⇒ collector falls back to recency
        webhookConfigured: false,
      },
      catalystDir,
      fetcher: () => Promise.reject(new Error("unreachable")),
    });
    await monitor.tick();
    await monitor.tick();
    await monitor.tick();
    const snap = monitor.snapshot();
    expect(snap.services.find((s) => s.id === "loki")!.severity).toBe("down");
    expect(snap.services.find((s) => s.id === "otel-collector")!.severity).toBe("unknown");
  });

  it("marks collector up when Loki is up (no direct probe configured)", async () => {
    // When collectorHealthUrl is absent and the catalyst event log doesn't carry
    // claude-code telemetry (it goes direct to Loki via OTel), the collector
    // recency fallback infers liveness from Loki: Loki up → collector up.
    const monitor = createServiceHealthMonitor({
      config: {
        lokiUrl: "http://loki",
        prometheusUrl: null,
        grafanaUrl: null,
        collectorHealthUrl: null,
        webhookConfigured: false,
      },
      catalystDir,
      fetcher: () => Promise.resolve(new Response(null, { status: 200 })),
    });
    await monitor.tick();
    const snap = monitor.snapshot();
    expect(snap.services.find((s) => s.id === "loki")!.severity).toBe("up");
    expect(snap.services.find((s) => s.id === "otel-collector")!.severity).toBe("up");
  });
});

describe("probe-url crosses to down only after 3 ticks", () => {
  it("degraded on ticks 1-2, down on tick 3", async () => {
    const monitor = createServiceHealthMonitor({
      config: {
        lokiUrl: "http://loki",
        prometheusUrl: null,
        grafanaUrl: null,
        collectorHealthUrl: null,
        webhookConfigured: false,
      },
      catalystDir,
      fetcher: () => Promise.reject(new Error("unreachable")),
      // Disable the inner probe cache so each tick re-probes (the registry tick
      // is the counter clock).
      probeCacheTtlMs: 0,
    });
    await monitor.tick();
    expect(monitor.snapshot().services.find((s) => s.id === "loki")!.severity).toBe("degraded");
    await monitor.tick();
    expect(monitor.snapshot().services.find((s) => s.id === "loki")!.severity).toBe("degraded");
    await monitor.tick();
    expect(monitor.snapshot().services.find((s) => s.id === "loki")!.severity).toBe("down");
  });

  it("monitor (self) is up; unconfigured webhook is unknown", async () => {
    const monitor = createServiceHealthMonitor({
      config: {
        lokiUrl: null,
        prometheusUrl: null,
        grafanaUrl: null,
        collectorHealthUrl: null,
        webhookConfigured: false,
      },
      catalystDir,
    });
    await monitor.tick();
    const snap = monitor.snapshot();
    expect(snap.services.find((s) => s.id === "monitor")!.severity).toBe("up");
    expect(snap.services.find((s) => s.id === "webhook")!.severity).toBe("unknown");
  });
});
