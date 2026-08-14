// webhook-route-health-io.test.ts — CTL-1841. IO / stateful-monitor tests.
// Covers: stamping, atomic marker write, latch hydration (no double-emit across restart),
// disabled kill-switch no-op.

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRouteHealthMonitor,
  getLinearWebhook401MarkerPath,
  resolveWebhookRouteHealthConfig,
} from "../webhook-route-health";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ctl1841-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("createRouteHealthMonitor — stamping", () => {
  it("stamps a 401 as a Linear failure", () => {
    const mon = createRouteHealthMonitor({ now: () => 1000 });
    mon.stampLinear(401);
    expect(mon.snapshot().lastLinearFailMs).toBe(1000);
    expect(mon.snapshot().lastLinear2xxMs).toBeNull();
  });

  it("stamps a 200 as a Linear success", () => {
    const mon = createRouteHealthMonitor({ now: () => 2000 });
    mon.stampLinear(200);
    expect(mon.snapshot().lastLinear2xxMs).toBe(2000);
    expect(mon.snapshot().lastLinearFailMs).toBeNull();
  });

  it("stamps a 500 as a Linear failure", () => {
    const mon = createRouteHealthMonitor({ now: () => 3000 });
    mon.stampLinear(500);
    expect(mon.snapshot().lastLinearFailMs).toBe(3000);
  });

  it("stamps a GitHub 200 as the control", () => {
    const mon = createRouteHealthMonitor({ now: () => 4000 });
    mon.stampGithub(200);
    expect(mon.snapshot().lastGithub2xxMs).toBe(4000);
  });

  it("does not update stamps when GitHub returns non-2xx", () => {
    const mon = createRouteHealthMonitor({ now: () => 5000 });
    mon.stampGithub(400);
    expect(mon.snapshot().lastGithub2xxMs).toBeNull();
  });
});

describe("createRouteHealthMonitor — evaluate + marker write", () => {
  it("writes the durable marker atomically on a raise edge", () => {
    const markerPath = join(tmpDir, "linear-webhook-401-latch.json");
    let t = 500 * 60_000;
    const mon = createRouteHealthMonitor({ now: () => t, markerPath });

    // First beat: GitHub ok, Linear fails
    mon.stampGithub(200);
    mon.stampLinear(401);

    // Advance time past the silent threshold (default 15m = 900_000ms)
    t += 20 * 60_000;
    mon.stampGithub(200);
    mon.stampLinear(401);

    mon.evaluate(); // should RAISE + write marker

    expect(existsSync(markerPath)).toBe(true);
    const m = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    expect(m.latched).toBe(true);
    expect(m).toHaveProperty("lastLinearFailMs");
    expect(m).toHaveProperty("ts");
  });

  it("hydrates latch from marker and does NOT re-emit 'raised' on the same edge", () => {
    const markerPath = join(tmpDir, "linear-webhook-401-latch.json");
    const emits: string[] = [];

    let t = 500 * 60_000;
    const mon = createRouteHealthMonitor({ now: () => t, markerPath });
    mon.stampGithub(200);
    mon.stampLinear(401);
    t += 20 * 60_000;
    mon.stampGithub(200);
    mon.stampLinear(401);
    mon.evaluate(); // should raise and write marker

    // A fresh monitor hydrates latched:true and must NOT re-emit
    const mon2 = createRouteHealthMonitor({
      now: () => t,
      markerPath,
      onEmit: (k) => emits.push(k),
    });
    mon2.stampGithub(200);
    mon2.stampLinear(401);
    mon2.evaluate();
    expect(emits).not.toContain("raised");
  });

  it("emits 'recovered' after a Linear 2xx clears the latch", () => {
    const markerPath = join(tmpDir, "linear-webhook-401-latch.json");
    const emits: string[] = [];
    const mon = createRouteHealthMonitor({
      now: () => 1_000 * 60_000,
      markerPath,
      onEmit: (k) => emits.push(k),
    });

    // Write a pre-latched marker to simulate a prior raise
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(markerPath, JSON.stringify({ latched: true, latchedAtMs: 1000 }));

    // Now a Linear 2xx arrives (operator fixed the secret)
    mon.stampGithub(200);
    mon.stampLinear(200); // 2xx — most recent outcome is success
    mon.evaluate();

    expect(emits).toContain("recovered");
  });

  it("logs a RAISED line on EVERY episode, not just the first (regression: sparse-warn total=1)", () => {
    const markerPath = join(tmpDir, "linear-webhook-401-latch.json");
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      let t = 500 * 60_000;
      const mon = createRouteHealthMonitor({ now: () => t, markerPath });

      // Episode 1 — raise.
      mon.stampGithub(200);
      mon.stampLinear(401);
      t += 20 * 60_000;
      mon.stampGithub(200);
      mon.stampLinear(401);
      mon.evaluate(); // RAISED #1

      // Operator fixes the secret — recover.
      t += 1 * 60_000;
      mon.stampLinear(200);
      mon.evaluate(); // RECOVERED

      // A SECOND outage days later — this must RAISE and log again. With the
      // old `total = 1` sparse-warn gate this line was suppressed after the first.
      t += 1 * 60_000;
      mon.stampGithub(200);
      mon.stampLinear(401);
      t += 19 * 60_000; // past silentThreshold since the recovery 2xx
      mon.stampGithub(200);
      mon.evaluate(); // RAISED #2

      const raised = warnings.filter((w) => w.includes("RAISED"));
      expect(raised.length).toBeGreaterThanOrEqual(2);
      expect(warnings.some((w) => w.includes("RECOVERED"))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  it("restores persisted route timestamps on hydration and does not erase them on marker refresh", () => {
    // A prior process latched an episode carrying real route evidence.
    const markerPath = join(tmpDir, "linear-webhook-401-latch.json");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      markerPath,
      JSON.stringify({
        latched: true,
        latchedAtMs: 100 * 60_000,
        lastLinear2xxMs: 10 * 60_000,
        lastLinearFailMs: 120 * 60_000,
        lastGithub2xxMs: 121 * 60_000,
      }),
    );

    // A fresh process hydrates (latched) and its first evaluate() hits the
    // marker-refresh branch. Without hydrating the timestamps, that refresh would
    // rewrite the marker from an all-null in-memory state and ERASE the evidence.
    const mon = createRouteHealthMonitor({ now: () => 130 * 60_000, markerPath });
    mon.evaluate();

    const m = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    expect(m.latched).toBe(true);
    expect(m.lastLinear2xxMs).toBe(10 * 60_000);
    expect(m.lastLinearFailMs).toBe(120 * 60_000);
    expect(m.lastGithub2xxMs).toBe(121 * 60_000);
  });

  it("still emits the log alarm when the durable marker write fails, deduped per episode", () => {
    // Force writeMarker() to throw by placing the marker under a path whose parent
    // is a regular FILE (mkdirSync of the dirname → ENOTDIR).
    const blocker = join(tmpDir, "blocker");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(blocker, "x");
    const markerPath = join(blocker, "latch.json");

    const emits: string[] = [];
    let t = 500 * 60_000;
    const mon = createRouteHealthMonitor({
      now: () => t,
      markerPath,
      onEmit: (k) => emits.push(k),
    });
    mon.stampGithub(200);
    mon.stampLinear(401);
    t += 20 * 60_000;
    mon.stampGithub(200);
    mon.stampLinear(401);

    mon.evaluate(); // RAISE — marker write throws, but the log alarm must still fire
    expect(emits).toContain("raised");
    expect(existsSync(markerPath)).toBe(false); // marker never persisted

    // Same raise edge next tick (marker still unwritable) must NOT re-log every tick.
    mon.evaluate();
    expect(emits.filter((e) => e === "raised")).toHaveLength(1);
  });

  it("onEmit fires with 'raised' on the rising edge", () => {
    const markerPath = join(tmpDir, "linear-webhook-401-latch.json");
    const emits: string[] = [];

    let t = 500 * 60_000;
    const mon = createRouteHealthMonitor({
      now: () => t,
      markerPath,
      onEmit: (k) => emits.push(k),
    });
    mon.stampGithub(200);
    mon.stampLinear(401);
    t += 20 * 60_000;
    mon.stampGithub(200);
    mon.stampLinear(401);
    mon.evaluate();

    expect(emits).toContain("raised");
  });
});

describe("createRouteHealthMonitor — disabled kill-switch", () => {
  it("is a no-op when CATALYST_LINEAR_WEBHOOK_ALARM=0", () => {
    const prev = process.env.CATALYST_LINEAR_WEBHOOK_ALARM;
    process.env.CATALYST_LINEAR_WEBHOOK_ALARM = "0";
    try {
      const markerPath = join(tmpDir, "linear-webhook-401-latch.json");
      const emits: string[] = [];
      let t = 500 * 60_000;
      const mon = createRouteHealthMonitor({
        now: () => t,
        markerPath,
        onEmit: (k) => emits.push(k),
      });
      mon.stampGithub(200);
      mon.stampLinear(401);
      t += 20 * 60_000;
      mon.stampGithub(200);
      mon.stampLinear(401);
      mon.evaluate();
      expect(emits).toHaveLength(0);
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CATALYST_LINEAR_WEBHOOK_ALARM;
      else process.env.CATALYST_LINEAR_WEBHOOK_ALARM = prev;
    }
  });

  it("config.enabled is false when kill-switch is set", () => {
    const prev = process.env.CATALYST_LINEAR_WEBHOOK_ALARM;
    process.env.CATALYST_LINEAR_WEBHOOK_ALARM = "0";
    try {
      const cfg = resolveWebhookRouteHealthConfig({});
      expect(cfg.enabled).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CATALYST_LINEAR_WEBHOOK_ALARM;
      else process.env.CATALYST_LINEAR_WEBHOOK_ALARM = prev;
    }
  });
});

describe("getLinearWebhook401MarkerPath", () => {
  it("returns a path under CATALYST_DIR when set", () => {
    const prev = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = tmpDir;
    try {
      const p = getLinearWebhook401MarkerPath();
      expect(p).toContain(tmpDir);
      expect(p).toContain("linear-webhook-401-latch.json");
    } finally {
      if (prev === undefined) delete process.env.CATALYST_DIR;
      else process.env.CATALYST_DIR = prev;
    }
  });
});
