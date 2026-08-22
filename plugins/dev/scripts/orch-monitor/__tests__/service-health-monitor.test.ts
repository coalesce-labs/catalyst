// service-health-monitor.test.ts — CTL-1050: the server-side poller's I/O glue.
// Proves the event-recency read (readEmissionAge), the collector recency
// fallback's no-cascade (Loki down ⇒ collector unknown, not red), and that a
// failing probe crosses to down only after 3 ticks (the registry tick is the
// counter clock).

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "fs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createServiceHealthMonitor,
  readEmissionAge,
} from "../lib/service-health-monitor";

// bytesRequested — total `length` argument across readSync calls. The spy's
// call tuple resolves to the 3-arg `readSync(fd, buffer, opts)` overload under
// TS, so index positionally through `unknown[]` rather than fighting the
// overload set (CTL-1529).
function bytesRequested(calls: readonly unknown[][]): number {
  return calls.reduce<number>(
    (sum, c) => sum + (typeof c[3] === "number" ? c[3] : 0),
    0,
  );
}

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

  // ── CTL-1529 ─────────────────────────────────────────────────────────────
  // This function's comment has always said "Read only the tail of the file —
  // Cap at 512KB to bound the read". The code did `readFileSync(path, "utf8")`
  // and THEN sliced the last 512 KB back off, i.e. it materialized the entire
  // monthly event log (344 MB on mini) to keep 0.15% of it, on every poll of a
  // 15-second health tick. The guard could not see it because the argument was
  // a bare `path` variable rather than a spelled-out event-log expression.
  it("reads only the 512 KiB tail of a multi-megabyte log, not the whole file", () => {
    const now = Date.parse("2026-06-11T12:00:00.000Z");
    const path = join(catalystDir, "events", "2026-06.jsonl");
    // ~6 MB of older noise, then the match we actually want, at the end.
    const noise =
      JSON.stringify({
        ts: "2026-06-11T00:00:00.000Z",
        attributes: { "event.name": "noise" },
        resource: { "service.name": "other" },
        pad: "q".repeat(400),
      }) + "\n";
    writeFileSync(path, noise.repeat(12_000));
    writeEvent("2026-06-11T11:58:00.000Z", "broker");

    const readSyncSpy = spyOn(fs, "readSync");
    const readFileSyncSpy = spyOn(fs, "readFileSync");
    let age: number | null;
    try {
      age = readEmissionAge(catalystDir, { serviceName: "broker" }, now);
      expect(readFileSyncSpy.mock.calls.filter((c) => c[0] === path)).toEqual([]);
      const requested = bytesRequested(readSyncSpy.mock.calls as unknown[][]);
      expect(requested).toBeGreaterThan(0);
      // CTL-1550: readTailUtf8's boundary-aware first-line drop reads ONE extra
      // byte (the byte immediately before the window) to tell a mid-record cut
      // from an exact record boundary, so the bounded read is at most cap + 1.
      // This matches event-log-reader.test.ts's own `<= cap + 1` assertion.
      expect(requested).toBeLessThanOrEqual(512 * 1024 + 1);
    } finally {
      readSyncSpy.mockRestore();
      readFileSyncSpy.mockRestore();
    }
    // …and the answer is unchanged: the newest match is still found.
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(2 * 60_000 - 1000);
    expect(age!).toBeLessThan(3 * 60_000);
  });

  it("still finds a match that sits DEEPER than one chunk but inside the 512 KiB tail", () => {
    const now = Date.parse("2026-06-11T12:00:00.000Z");
    const path = join(catalystDir, "events", "2026-06.jsonl");
    writeEvent("2026-06-11T11:58:00.000Z", "broker");
    const noise =
      JSON.stringify({ ts: "2026-06-11T11:59:00.000Z", attributes: {}, resource: {}, pad: "q".repeat(400) }) + "\n";
    writeFileSync(path, noise.repeat(500), { flag: "a" }); // ~250 KB after the match
    const age = readEmissionAge(catalystDir, { serviceName: "broker" }, now);
    expect(age).not.toBeNull();
    expect(age!).toBeLessThan(3 * 60_000);
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
});

describe("collector inference from Loki state (CTL-1087)", () => {
  const config = {
    lokiUrl: "http://loki",
    prometheusUrl: null,
    grafanaUrl: null,
    collectorHealthUrl: null, // ⇒ collector falls back to recency/inference
    webhookConfigured: false,
  };

  it("reports collector up (inferred) when Loki probes up", async () => {
    const monitor = createServiceHealthMonitor({
      config,
      catalystDir,
      fetcher: () => Promise.resolve(new Response("ready", { status: 200 })),
    });
    await monitor.tick();
    const snap = monitor.snapshot();
    expect(snap.services.find((s) => s.id === "loki")!.severity).toBe("up");
    const collector = snap.services.find((s) => s.id === "otel-collector")!;
    expect(collector.severity).toBe("up");
    expect(collector.detail).toContain("inferred from Loki reachability");
  });

  it("reports collector unknown while Loki is only degraded", async () => {
    // One failing tick ⇒ Loki degraded (not yet down). Collector must read
    // unknown — neither an inferred up nor a cascaded down.
    const monitor = createServiceHealthMonitor({
      config,
      catalystDir,
      fetcher: () => Promise.reject(new Error("unreachable")),
      probeCacheTtlMs: 0,
    });
    await monitor.tick();
    const snap = monitor.snapshot();
    expect(snap.services.find((s) => s.id === "loki")!.severity).toBe("degraded");
    expect(snap.services.find((s) => s.id === "otel-collector")!.severity).toBe("unknown");
  });
});

describe("daemon recency matches catalyst-prefixed service names (CTL-1087)", () => {
  it("reports broker and execution-core up from fresh catalyst.* events", async () => {
    // The unified event log records service.name as "catalyst.<component>" —
    // the monitor's matchers must use the prefixed form end-to-end.
    const nowMs = Date.parse("2026-06-11T12:00:00.000Z");
    writeEvent("2026-06-11T11:59:30.000Z", "catalyst.broker"); // 30s ago
    writeEvent("2026-06-11T11:59:30.000Z", "catalyst.execution-core");
    const monitor = createServiceHealthMonitor({
      config: {
        lokiUrl: null,
        prometheusUrl: null,
        grafanaUrl: null,
        collectorHealthUrl: null,
        webhookConfigured: false,
      },
      catalystDir,
      now: () => nowMs,
    });
    await monitor.tick();
    const snap = monitor.snapshot();
    expect(snap.services.find((s) => s.id === "broker")!.severity).toBe("up");
    expect(snap.services.find((s) => s.id === "execution-core")!.severity).toBe("up");
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
