// service-health-endpoints.test.ts — CTL-1050 / CTL-1039: HTTP route-plumbing
// for the service-health registry. Proves GET /api/health/services returns the
// { generatedAt, services[] } snapshot from the injected monitor, that the board
// payload is decorated with current outages, and that /api/health/otel carries
// the new `severity` field while staying backward-compatible.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";
import {
  createServiceHealthMonitor,
  type ServiceHealthMonitor,
} from "../lib/service-health-monitor";
import { createOtelHealthChecker } from "../lib/otel-health";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;
let monitor: ServiceHealthMonitor;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "svc-health-endpoint-"));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });

  // A deterministic monitor: Loki probe FAILS (so after 3 ticks it goes down),
  // Grafana unconfigured (unknown), broker recency fresh (up). Inject a fetcher
  // that always rejects loki/prometheus → repeated failures.
  monitor = createServiceHealthMonitor({
    config: {
      lokiUrl: "http://loki",
      prometheusUrl: "http://prom",
      grafanaUrl: null,
      collectorHealthUrl: null,
      webhookConfigured: false,
    },
    catalystDir: tmpDir,
    fetcher: () => Promise.reject(new Error("unreachable")),
    recencyReader: () => 30_000, // fresh broker/exec-core
  });
  // Drive 3 ticks so Loki crosses the 3-consecutive-failure boundary into down.
  await monitor.tick();
  await monitor.tick();
  await monitor.tick();

  server = createServer({
    port: 0,
    wtDir,
    catalystDir: tmpDir,
    startWatcher: false,
    serviceHealthMonitor: monitor,
    lokiUrl: "http://loki",
    prometheusUrl: "http://prom",
    // Wire an otel-health checker that reads the SAME monitor severity (the
    // single severity model).
    otelHealthChecker: createOtelHealthChecker({
      lokiUrl: "http://loki",
      prometheusUrl: "http://prom",
      severityTracker: {
        lokiSeverity: () =>
          monitor.snapshot().services.find((s) => s.id === "loki")?.severity ?? null,
        prometheusSeverity: () =>
          monitor.snapshot().services.find((s) => s.id === "prometheus")?.severity ?? null,
      },
    }),
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("GET /api/health/services", () => {
  it("returns the { generatedAt, services[] } registry snapshot", async () => {
    const res = await fetch(`${baseUrl}/api/health/services`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      generatedAt: number;
      services: Array<{ id: string; severity: string; target: string | null }>;
    };
    expect(typeof body.generatedAt).toBe("number");
    expect(body.services).toHaveLength(8);

    const loki = body.services.find((s) => s.id === "loki")!;
    expect(loki.severity).toBe("down"); // 3 failed probes
    const grafana = body.services.find((s) => s.id === "grafana")!;
    expect(grafana.severity).toBe("unknown"); // unconfigured
    expect(grafana.target).toBeNull();
    const broker = body.services.find((s) => s.id === "broker")!;
    expect(broker.severity).toBe("up"); // fresh recency
  });
});

describe("/api/health/otel carries severity (single model)", () => {
  it("loki.severity = down + reachable=false from the registry tracker", async () => {
    const res = await fetch(`${baseUrl}/api/health/otel`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configured: boolean;
      loki: { url: string | null; reachable: boolean; severity?: string };
      prometheus: { reachable: boolean; severity?: string };
    };
    // Backward-compatible shape (configured + loki.url + reachable) intact.
    expect(body.configured).toBe(true);
    expect(body.loki.url).toBe("http://loki");
    // New severity field, sourced from the registry.
    expect(body.loki.severity).toBe("down");
    expect(body.loki.reachable).toBe(false);
  });
});

describe("/api/board decorated with outages", () => {
  it("carries serviceHealth.outages with the current down services", async () => {
    const res = await fetch(`${baseUrl}/api/board`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      serviceHealth?: { outages: Array<{ id: string; label: string }> };
    };
    expect(body.serviceHealth).toBeDefined();
    const ids = body.serviceHealth!.outages.map((o) => o.id);
    // Loki + Prometheus failed all probes → down → outages. Grafana (unknown) NOT.
    expect(ids).toContain("loki");
    expect(ids).not.toContain("grafana");
  });
});
