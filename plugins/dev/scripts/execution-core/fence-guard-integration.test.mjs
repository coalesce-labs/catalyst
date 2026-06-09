// fence-guard-integration.test.mjs — per-site coverage: each guarded write is
// suppressed when fenceGuard returns false (CTL-863 Phase 4).
//
// Tests via public functions that contain the guards, injecting stale-fence
// conditions (no signal file → readSignalGeneration returns null → fail-closed).
// Run: cd plugins/dev/scripts/execution-core && bun test fence-guard-integration.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const d = mkdtempSync(join(tmpdir(), "ctl863-fg-"));
  return d;
}

// Write a phase signal file with a given generation so readSignalGeneration returns it.
function writeSignal(orchDir, ticket, phase, generation) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify({
    status: "running",
    generation,
    updatedAt: new Date().toISOString(),
  }));
}

// Build a fakeWriteStatus that records calls.
function makeWriteStatus() {
  const calls = [];
  return {
    applyTerminalDone: (args) => { calls.push({ fn: "applyTerminalDone", ...args }); return { applied: true }; },
    applyEstimate: (args) => { calls.push({ fn: "applyEstimate", ...args }); return { applied: true }; },
    applyBlockedByRelation: (args) => { calls.push({ fn: "applyBlockedByRelation", ...args }); return { applied: true }; },
    applyLabel: (args) => { calls.push({ fn: "applyLabel", ...args }); return { applied: true }; },
    applyPhaseStatus: (args) => { calls.push({ fn: "applyPhaseStatus", ...args }); return { applied: true }; },
    calls,
  };
}

// ── Site 1: terminalDoneOnce ─────────────────────────────────────────────────

import { readSignalGeneration } from "./fence-guard.mjs";

describe("readSignalGeneration (CTL-863)", () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("returns generation from a running signal file", () => {
    writeSignal(dir, "CTL-1", "implement", 7);
    expect(readSignalGeneration(dir, "CTL-1")).toBe(7);
  });

  test("returns null when worker dir is absent", () => {
    expect(readSignalGeneration(dir, "CTL-MISSING")).toBeNull();
  });

  test("returns null when no phase-*.json files present", () => {
    mkdirSync(join(dir, "workers", "CTL-1"), { recursive: true });
    expect(readSignalGeneration(dir, "CTL-1")).toBeNull();
  });

  test("returns null for non-finite generation", () => {
    const workerDir = join(dir, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "phase-implement.json"), JSON.stringify({ status: "running", generation: "not-a-number" }));
    expect(readSignalGeneration(dir, "CTL-1")).toBeNull();
  });

  test("prefers running signal over older completed signal", () => {
    const workerDir = join(dir, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "phase-research.json"), JSON.stringify({
      status: "done", generation: 2, updatedAt: new Date(Date.now() - 10000).toISOString(),
    }));
    writeFileSync(join(workerDir, "phase-implement.json"), JSON.stringify({
      status: "running", generation: 5, updatedAt: new Date(Date.now() - 1000).toISOString(),
    }));
    expect(readSignalGeneration(dir, "CTL-1")).toBe(5);
  });
});

// ── Site 1: terminalDoneOnce in schedulerTick suppressed by stale fence ─────────
//
// schedulerTick accepts `hosts` as an injection seam (CTL-850) so we can force
// multiHost=true without touching the filesystem hosts.json. No signal-file
// generation → readSignalGeneration returns null → fenceGuard returns false
// (fail-closed) → applyTerminalDone is NOT called.

import { schedulerTick } from "./scheduler.mjs";

describe("schedulerTick terminalDoneOnce fence guard (site 1, CTL-863)", () => {
  let orchDir;
  let catalystDir;
  let prevCatalystDir;

  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "ctl863-s1-"));
    prevCatalystDir = process.env.CATALYST_DIR;
    catalystDir = mkdtempSync(join(tmpdir(), "ctl863-s1-cat-"));
    process.env.CATALYST_DIR = catalystDir;
  });
  afterEach(() => {
    rmSync(orchDir, { recursive: true, force: true });
    rmSync(catalystDir, { recursive: true, force: true });
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
  });

  test("single-host: monitor-deploy done → applyTerminalDone called", () => {
    const workerDir = join(orchDir, "workers", "CTL-S1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "phase-monitor-deploy.json"),
      JSON.stringify({ ticket: "CTL-S1", phase: "monitor-deploy", status: "done" }));
    const doneCalls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0, stdout: "" }),
      writeStatus: {
        applyTerminalDone: (a) => { doneCalls.push(a.ticket); return { applied: true }; },
        applyPhaseStatus: () => {},
        applyLabel: () => ({ applied: true }),
      },
      liveBackgroundCount: () => 0,
      teardownWorktree: () => true,
      hosts: ["single-host"],
    });
    expect(doneCalls).toContain("CTL-S1");
  });

  test("multi-host + stale fence (no generation in signal) → applyTerminalDone suppressed", () => {
    const workerDir = join(orchDir, "workers", "CTL-S1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "phase-monitor-deploy.json"),
      JSON.stringify({ ticket: "CTL-S1", phase: "monitor-deploy", status: "done" }));
    const doneCalls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0, stdout: "" }),
      writeStatus: {
        applyTerminalDone: (a) => { doneCalls.push(a.ticket); return { applied: true }; },
        applyPhaseStatus: () => {},
        applyLabel: () => ({ applied: true }),
      },
      liveBackgroundCount: () => 0,
      teardownWorktree: () => true,
      hosts: ["host-A", "host-B"],
    });
    expect(doneCalls).not.toContain("CTL-S1");
  });
});

// ── Site 10: defaultEscalate (stale-pr-rescue-timer) suppressed by stale fence ─

import { defaultEscalate } from "./stale-pr-rescue-timer.mjs";

describe("defaultEscalate fence guard (site 10, CTL-863)", () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("single-host (multiHost:false) skips fence check and applies label", () => {
    let labelApplied = false;
    mkdirSync(join(dir, "workers", "CTL-10"), { recursive: true });
    const linearWrite = { applyLabel: () => { labelApplied = true; return { applied: true }; } };
    defaultEscalate("CTL-10", {}, { orchDir: dir, linearWrite, multiHost: false });
    expect(labelApplied).toBe(true);
  });

  test("multi-host + stale fence (no signal file) → label NOT applied", () => {
    let labelApplied = false;
    mkdirSync(join(dir, "workers", "CTL-10"), { recursive: true });
    const linearWrite = { applyLabel: () => { labelApplied = true; return { applied: true }; } };
    defaultEscalate("CTL-10", {}, { orchDir: dir, linearWrite, multiHost: true });
    expect(labelApplied).toBe(false);
  });

});

// ── Site 9: defaultPostReclaimMirror suppressed by stale fence ───────────────

import { defaultPostReclaimMirror } from "./recovery.mjs";

describe("defaultPostReclaimMirror fence guard (site 9, CTL-863)", () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("single-host (multiHost:false) skips the fence check and posts", () => {
    let posted = false;
    writeSignal(dir, "CTL-99", "implement", 1);
    mkdirSync(join(dir, "workers", "CTL-99"), { recursive: true });
    defaultPostReclaimMirror(
      { orchDir: dir, ticket: "CTL-99", phase: "implement", deathSignal: "failed", probeChecked: "commits", reclaimedBgJobId: "abc" },
      {
        existsSync: () => false,
        writeMarker: () => {},
        runCommentPost: () => { posted = true; return { status: 0 }; },
        multiHost: false,
      },
    );
    expect(posted).toBe(true);
  });

  test("multi-host + stale fence (check returns false) → comment NOT posted", () => {
    let posted = false;
    // No signal file → generation null → fenceGuard returns false
    mkdirSync(join(dir, "workers", "CTL-99"), { recursive: true });
    defaultPostReclaimMirror(
      { orchDir: dir, ticket: "CTL-99", phase: "implement", deathSignal: "failed", probeChecked: "commits", reclaimedBgJobId: "abc" },
      {
        existsSync: () => false,
        writeMarker: () => {},
        runCommentPost: () => { posted = true; return { status: 0 }; },
        multiHost: true,
        // No readGen/check override — will use readSignalGeneration which finds null → fail-closed
      },
    );
    expect(posted).toBe(false);
  });
});
