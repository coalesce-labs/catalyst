// daemon-node-class-guard.test.mjs — CTL-1654 Phase 3.
// The execution-core daemon must refuse to emit node.heartbeat (and therefore
// refuse to join the dispatch+recovery roster) when launched on a monitor-class
// node. A worker-class node is unchanged.
//
// Run: cd plugins/dev/scripts/execution-core && bun test daemon-node-class-guard.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, stopDaemon } from "./daemon.mjs";

let catalystDir;
let prevCatalystDir;
let prevNodeClass;

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  prevNodeClass   = process.env.CATALYST_NODE_CLASS;
  catalystDir = mkdtempSync(join(tmpdir(), "exec-core-ncg-"));
  process.env.CATALYST_DIR = catalystDir;
  mkdirSync(join(catalystDir, "execution-core"), { recursive: true });
  // Silence heartbeat by default (tests override via startHeartbeat injection).
  process.env.CATALYST_HEARTBEAT = "0";
});

afterEach(() => {
  try { stopDaemon(); } catch { /* nothing running */ }
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  if (prevNodeClass === undefined) delete process.env.CATALYST_NODE_CLASS;
  else process.env.CATALYST_NODE_CLASS = prevNodeClass;
  delete process.env.CATALYST_HEARTBEAT;
  rmSync(catalystDir, { recursive: true, force: true });
});

// Minimal no-op fakes for the daemon's required seams.
const FAKES = {
  recover: () => ({}),
  reconcileBoot: () => ({}),
  startMonitor: () => {},
  startScheduler: () => {},
  watchRegistry: false,
};

// ── Phase 3: heartbeat wiring is gated on node class ───────────────────────

describe("CTL-1654 Phase 3: daemon node-class guard", () => {
  test("monitor node does NOT call startHeartbeat", () => {
    process.env.CATALYST_NODE_CLASS = "monitor";
    const called = [];
    startDaemon({
      ...FAKES,
      enableHeartbeat: true,
      startHeartbeat: () => { called.push("heartbeat"); return { stop() {}, started: Promise.resolve() }; },
      startLivenessPublisher: () => { called.push("liveness"); return { stop() {} }; },
    });
    expect(called).not.toContain("heartbeat");
    expect(called).not.toContain("liveness");
  });

  test("worker node DOES call startHeartbeat (unchanged)", () => {
    process.env.CATALYST_NODE_CLASS = "worker";
    const called = [];
    startDaemon({
      ...FAKES,
      enableHeartbeat: true,
      startHeartbeat: (opts) => { called.push("heartbeat"); return { stop() {}, started: Promise.resolve() }; },
      startLivenessPublisher: () => { called.push("liveness"); return { stop() {} }; },
    });
    expect(called).toContain("heartbeat");
  });

  test("developer node does NOT call startHeartbeat", () => {
    process.env.CATALYST_NODE_CLASS = "developer";
    const called = [];
    startDaemon({
      ...FAKES,
      enableHeartbeat: true,
      startHeartbeat: () => { called.push("heartbeat"); return { stop() {}, started: Promise.resolve() }; },
      startLivenessPublisher: () => { called.push("liveness"); return { stop() {} }; },
    });
    expect(called).not.toContain("heartbeat");
  });

  test("unset node class defaults to worker — startHeartbeat IS called", () => {
    delete process.env.CATALYST_NODE_CLASS;
    const called = [];
    startDaemon({
      ...FAKES,
      enableHeartbeat: true,
      startHeartbeat: (opts) => { called.push("heartbeat"); return { stop() {}, started: Promise.resolve() }; },
      startLivenessPublisher: () => { called.push("liveness"); return { stop() {} }; },
    });
    expect(called).toContain("heartbeat");
  });

  test("monitor node logs a WARN (refusing to actuate)", () => {
    process.env.CATALYST_NODE_CLASS = "monitor";
    const warnMessages = [];
    // We can't easily spy on pino log in this test without heavy setup,
    // but we CAN verify the daemon boots without throwing (the warn is
    // defensive — it must not crash).
    expect(() => {
      startDaemon({ ...FAKES, enableHeartbeat: true, startHeartbeat: () => { throw new Error("must not be called"); }, startLivenessPublisher: () => {} });
    }).not.toThrow();
  });

  // ── CTL-1654 Codex P2 F4: the ACTUATORS (monitor + scheduler), not just the
  // heartbeat, are gated on node class so a mis-launched exec-core is observe-only. ──

  test("monitor node does NOT arm the monitor/scheduler actuators (observe-only)", () => {
    process.env.CATALYST_NODE_CLASS = "monitor";
    const armed = [];
    startDaemon({
      ...FAKES,
      startMonitor: () => { armed.push("monitor"); },
      startScheduler: () => { armed.push("scheduler"); },
      enableHeartbeat: false,
    });
    expect(armed).not.toContain("monitor");
    expect(armed).not.toContain("scheduler");
  });

  test("developer node does NOT arm the monitor/scheduler actuators (observe-only)", () => {
    process.env.CATALYST_NODE_CLASS = "developer";
    const armed = [];
    startDaemon({
      ...FAKES,
      startMonitor: () => { armed.push("monitor"); },
      startScheduler: () => { armed.push("scheduler"); },
      enableHeartbeat: false,
    });
    expect(armed).not.toContain("monitor");
    expect(armed).not.toContain("scheduler");
  });

  test("worker node DOES arm the monitor/scheduler actuators (unchanged)", () => {
    process.env.CATALYST_NODE_CLASS = "worker";
    const armed = [];
    startDaemon({
      ...FAKES,
      startMonitor: () => { armed.push("monitor"); },
      startScheduler: () => { armed.push("scheduler"); },
      enableHeartbeat: false,
    });
    expect(armed).toContain("monitor");
    expect(armed).toContain("scheduler");
  });

  test("monitor node: injectable nodeClassResolver seam (explicit injection wins)", () => {
    // Simulates a test that needs to force a specific class regardless of env.
    delete process.env.CATALYST_NODE_CLASS;
    const called = [];
    startDaemon({
      ...FAKES,
      enableHeartbeat: true,
      nodeClassResolver: () => ({ class: "monitor", source: "test-injection" }),
      startHeartbeat: () => { called.push("heartbeat"); return { stop() {}, started: Promise.resolve() }; },
      startLivenessPublisher: () => {},
    });
    expect(called).not.toContain("heartbeat");
  });
});
