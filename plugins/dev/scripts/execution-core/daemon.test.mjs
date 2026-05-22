// Unit tests for the execution-core composing daemon (CTL-554 Phase 3).
// Run: cd plugins/dev/scripts/execution-core && bun test daemon.test.mjs
//
// startDaemon takes dependency-injected recover/monitor/scheduler/reconcile
// functions so no real timers, Linear polls, or child processes run — the
// composition logic is exercised deterministically.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { startDaemon, stopDaemon } from "./daemon.mjs";
import { upsertProjectEntry } from "./registry.mjs";

// CATALYST_DIR temp-dir harness — identical shape to enrollment.test.mjs:14-19.
let catalystDir;
let prevCatalystDir;

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "exec-core-daemon-"));
  process.env.CATALYST_DIR = catalystDir;
  mkdirSync(join(catalystDir, "execution-core"), { recursive: true });
});

afterEach(() => {
  try {
    stopDaemon();
  } catch {
    /* nothing running */
  }
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

describe("startDaemon", () => {
  test("calls recover, startMonitor, startScheduler exactly once each", () => {
    const calls = [];
    startDaemon({
      recover: (o) => calls.push(["recover", o.orchDir]),
      startMonitor: () => calls.push(["monitor"]),
      startScheduler: (o) => calls.push(["scheduler", o.orchDir]),
      watchRegistry: false,
    });
    expect(calls.map((c) => c[0])).toEqual(["recover", "monitor", "scheduler"]);
    // recover + scheduler both got the machine-level orchDir
    expect(calls[0][1]).toBe(calls[2][1]);
  });

  test("ensures a machine-level state.json with a default maxParallel", () => {
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
    });
    const statePath = join(process.env.CATALYST_DIR, "execution-core", "state.json");
    expect(existsSync(statePath)).toBe(true);
    expect(JSON.parse(readFileSync(statePath, "utf8")).maxParallel).toBeGreaterThan(0);
  });

  test("does not overwrite an existing state.json", () => {
    const statePath = join(process.env.CATALYST_DIR, "execution-core", "state.json");
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ maxParallel: 9 }));
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
    });
    expect(JSON.parse(readFileSync(statePath, "utf8")).maxParallel).toBe(9);
  });

  test("writes its PID to the given pidFile", () => {
    const pidFile = join(process.env.CATALYST_DIR, "daemon.pid");
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
      pidFile,
    });
    expect(Number(readFileSync(pidFile, "utf8").trim())).toBe(process.pid);
  });

  test("reconciles when the registry changes (debounced)", async () => {
    let reconciled = 0;
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      reconcile: () => {
        reconciled++;
      },
      watchRegistry: true,
      debounceMs: 20,
    });
    upsertProjectEntry({ team: "DEMO", repoRoot: "/r/d", eligibleQuery: { status: "Ready" } });
    // Poll up to 2s rather than a fixed wait — fs.watch delivery latency plus
    // the debounce timer varies under concurrent full-suite load, so a fixed
    // 60ms wait is flaky. The reconcile only has to fire once.
    const deadline = Date.now() + 2000;
    while (reconciled === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(reconciled).toBeGreaterThan(0);
  });
});

describe("stopDaemon", () => {
  test("stops monitor + scheduler and removes the pidFile", () => {
    const pidFile = join(process.env.CATALYST_DIR, "daemon.pid");
    const stopped = [];
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      stopMonitor: () => stopped.push("monitor"),
      stopScheduler: () => stopped.push("scheduler"),
      watchRegistry: false,
      pidFile,
    });
    stopDaemon();
    expect(stopped.sort()).toEqual(["monitor", "scheduler"]);
    expect(existsSync(pidFile)).toBe(false);
  });
});
