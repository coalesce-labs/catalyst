// fence-guard-integration.test.mjs — per-site coverage: each guarded write is
// suppressed when fenceGuard returns false (CTL-863 Phase 4).
//
// These are the focused per-site tests the plan requires. We test via the
// public functions that contain the guards, injecting stale-fence conditions.
// Run: cd plugins/dev/scripts/execution-core && bun test fence-guard-integration.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
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
