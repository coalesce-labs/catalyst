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

  test("single-host: terminal phase done → applyTerminalDone called", () => {
    // CTL-703 (taken wholesale at merge): the terminal-Done gate moved from
    // `monitor-deploy` to the descriptor's TERMINAL_PHASE (`teardown`). Drive
    // that phase so the terminalDoneOnce fence path (site 1) is exercised.
    const workerDir = join(orchDir, "workers", "CTL-S1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "phase-teardown.json"),
      JSON.stringify({ ticket: "CTL-S1", phase: "teardown", status: "done" }));
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
    // CTL-703: terminal-Done gate is now the TERMINAL_PHASE (`teardown`). The
    // signal carries no `generation`, so on a multi-host cluster the terminalDoneOnce
    // fence (site 1) reads null → fail-closed → suppresses the terminal Done write.
    const workerDir = join(orchDir, "workers", "CTL-S1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "phase-teardown.json"),
      JSON.stringify({ ticket: "CTL-S1", phase: "teardown", status: "done" }));
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

// ── CTL-1329: stale-fenced stalled dir cooldown-skips the terminal probe ────────
//
// Regression guard for the 2026-06-23 quota-exhaustion incident. A stalled (non-
// terminal) worker dir whose fence fails on a multi-host cluster has its needs-human
// write suppressed — but the per-tick isTicketTerminalOrMerged probe (a Linear
// `issues read` via fetchTicketState → cache.get) and fenceGuard re-run every tick,
// burning quota until the breaker freezes dispatch. After the first suppression we
// stamp a cooldown so subsequent ticks skip the probe+write entirely. The fence is
// still checked at the write site (not reordered), so a mid-probe takeover is caught.
// Single-host never suppresses, so it keeps probing — no regression.

describe("schedulerTick terminal probe fence guard (CTL-1329)", () => {
  let orchDir;
  let catalystDir;
  let prevCatalystDir;

  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "ctl1329-"));
    prevCatalystDir = process.env.CATALYST_DIR;
    catalystDir = mkdtempSync(join(tmpdir(), "ctl1329-cat-"));
    process.env.CATALYST_DIR = catalystDir;
  });
  afterEach(() => {
    rmSync(orchDir, { recursive: true, force: true });
    rmSync(catalystDir, { recursive: true, force: true });
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
  });

  // A started, stalled (non-terminal), generation-less worker dir — the orphan shape.
  function writeStalled(ticket) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "phase-triage.json"),
      JSON.stringify({ ticket, phase: "triage", status: "done" }));
    writeFileSync(join(dir, "phase-implement.json"),
      JSON.stringify({ ticket, phase: "implement", status: "stalled" }));
  }

  // Run the tick with a spy cache (records the probe's fetchTicketState→cache.get)
  // and a spy orphan-event sink. The cache returns a non-terminal state so the
  // probe — when it DOES run — completes without falling through to a live exec.
  function runTick(hosts) {
    const cacheGets = [];
    const orphanEvents = [];
    const cache = {
      get: (id) => { cacheGets.push(id); return "Implement"; },
      set: () => {},
      stats: () => ({ hits: 0, misses: 0, hitRate: 0 }),
    };
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0, stdout: "" }),
      writeStatus: {
        applyTerminalDone: () => ({ applied: true }),
        applyPhaseStatus: () => {},
        applyLabel: () => ({ applied: true }),
      },
      liveBackgroundCount: () => 0,
      teardownWorktree: () => true,
      cache,
      appendOrphanDetectedEvent: (e) => { orphanEvents.push(e); return true; },
      hosts,
    });
    return { cacheGets, orphanEvents };
  }

  test("multi-host + stale fence: probe runs once, then cooldown-skips later ticks", () => {
    writeStalled("CTL-Z");
    // Tick 1: probe runs (fence checked at the write site → fails → suppress + stamp).
    const t1 = runTick(["host-A", "host-B"]);
    expect(t1.cacheGets).toContain("CTL-Z");
    expect(t1.orphanEvents.some((e) => e.ticket === "CTL-Z")).toBe(true);
    // Tick 2: cooldown is fresh → the probe (and fenceGuard) are skipped entirely.
    const t2 = runTick(["host-A", "host-B"]);
    expect(t2.cacheGets).not.toContain("CTL-Z");
  });

  test("single-host: never suppresses, so it keeps probing every tick (no regression)", () => {
    writeStalled("CTL-Z");
    const t1 = runTick(["single-host"]);
    const t2 = runTick(["single-host"]);
    expect(t1.cacheGets).toContain("CTL-Z");
    expect(t2.cacheGets).toContain("CTL-Z");
  });
});
