// boot-resume.test.mjs — CTL-654. Daemon boot-resume: re-dispatch in-flight
// tickets that have no live --bg worker after a cold start.
//
// Phase 1 (this block): pure selection logic — hasLiveBgWorker,
// activePhaseForTicket, selectBootResumeCandidates. No ambient I/O beyond
// mkdtempSync signal fixtures (mirrors recovery.test.mjs idiom).
// Phase 2 (below): reconcileBootResume orchestration with injected
// dispatch/agents/appendEvent/report.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasLiveBgWorker,
  activePhaseForTicket,
  selectBootResumeCandidates,
} from "./boot-resume.mjs";

let orchDir;

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "exec-core-boot-"));
});

afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

// writeSignal — write workers/<ticket>/phase-<phase>.json with the canonical
// fields. Defaults model a running, freshly-dispatched phase worker.
function writeSignal(dir, ticket, phase, overrides = {}) {
  const wdir = join(dir, "workers", ticket);
  mkdirSync(wdir, { recursive: true });
  const sig = {
    ticket,
    phase,
    status: "running",
    bg_job_id: "deadbeef",
    worktreePath: `/wt/${ticket}`,
    updatedAt: "2026-05-27T02:00:00Z",
    ...overrides,
  };
  writeFileSync(join(wdir, `phase-${phase}.json`), JSON.stringify(sig, null, 2));
  return sig;
}

// writeMaxParallel — minimal state.json so readMaxParallel resolves a known cap.
function writeMaxParallel(dir, n) {
  writeFileSync(join(dir, "state.json"), JSON.stringify({ maxParallel: n }));
}

describe("hasLiveBgWorker", () => {
  test("true for a background agent whose cwd matches the worktree", () => {
    expect(hasLiveBgWorker([{ kind: "background", cwd: "/wt/A" }], "/wt/A")).toBe(true);
  });

  test("false when the only matching-cwd entry is interactive (human session)", () => {
    expect(hasLiveBgWorker([{ kind: "interactive", cwd: "/wt/A" }], "/wt/A")).toBe(false);
  });

  test("false when no entry's cwd equals the worktree", () => {
    expect(hasLiveBgWorker([{ kind: "background", cwd: "/wt/B" }], "/wt/A")).toBe(false);
  });

  test("false for an empty or undefined agents array (defensive)", () => {
    expect(hasLiveBgWorker([], "/wt/A")).toBe(false);
    expect(hasLiveBgWorker(undefined, "/wt/A")).toBe(false);
  });

  test("requires exact-string cwd equality — no trailing-slash normalization", () => {
    expect(hasLiveBgWorker([{ kind: "background", cwd: "/wt/A/" }], "/wt/A")).toBe(false);
  });
});

describe("activePhaseForTicket", () => {
  test("returns the single non-terminal phase, ignoring terminal siblings", () => {
    const sigs = [
      { phase: "plan", status: "done", updatedAt: "2026-05-27T01:00:00Z" },
      { phase: "implement", status: "running", updatedAt: "2026-05-27T02:00:00Z" },
    ];
    expect(activePhaseForTicket(sigs)?.phase).toBe("implement");
  });

  test("returns the most-recently-updated when more than one is non-terminal", () => {
    const sigs = [
      { phase: "implement", status: "running", updatedAt: "2026-05-27T01:00:00Z" },
      { phase: "verify", status: "dispatched", updatedAt: "2026-05-27T03:00:00Z" },
    ];
    expect(activePhaseForTicket(sigs)?.phase).toBe("verify");
  });

  test("returns null when every phase is terminal (nothing to resume)", () => {
    const sigs = [
      { phase: "plan", status: "done", updatedAt: "2026-05-27T01:00:00Z" },
      { phase: "implement", status: "failed", updatedAt: "2026-05-27T02:00:00Z" },
    ];
    expect(activePhaseForTicket(sigs)).toBeNull();
  });

  test("returns null for an empty list", () => {
    expect(activePhaseForTicket([])).toBeNull();
  });
});

describe("selectBootResumeCandidates", () => {
  test("returns [] when there are no in-flight tickets", () => {
    // A fully-completed ticket: monitor-deploy done is terminal-not-in-flight.
    writeSignal(orchDir, "CTL-1", "monitor-deploy", { status: "done" });
    expect(selectBootResumeCandidates({ orchDir, agents: [], maxParallel: 3 })).toEqual([]);
  });

  test("returns only the in-flight ticket WITHOUT a live bg worker", () => {
    // CTL-A has a live bg worker; CTL-B does not.
    writeSignal(orchDir, "CTL-A", "implement", { worktreePath: "/wt/CTL-A" });
    writeSignal(orchDir, "CTL-B", "verify", { worktreePath: "/wt/CTL-B" });
    const agents = [{ kind: "background", cwd: "/wt/CTL-A" }];
    const out = selectBootResumeCandidates({ orchDir, agents, maxParallel: 3 });
    expect(out).toEqual([{ ticket: "CTL-B", phase: "verify", worktreePath: "/wt/CTL-B" }]);
  });

  test("excludes an in-flight ticket whose active signal lacks a worktreePath, recording a warn", () => {
    writeSignal(orchDir, "CTL-NOWT", "implement", { worktreePath: null });
    const warns = [];
    const logger = { warn: (obj, msg) => warns.push({ obj, msg }), info: () => {} };
    const out = selectBootResumeCandidates({ orchDir, agents: [], maxParallel: 3, logger });
    expect(out).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0].obj.ticket).toBe("CTL-NOWT");
  });

  test("slot bound: maxParallel=2 with 3 no-live-worker tickets returns exactly 2", () => {
    writeSignal(orchDir, "CTL-1", "implement", { worktreePath: "/wt/CTL-1" });
    writeSignal(orchDir, "CTL-2", "implement", { worktreePath: "/wt/CTL-2" });
    writeSignal(orchDir, "CTL-3", "implement", { worktreePath: "/wt/CTL-3" });
    const out = selectBootResumeCandidates({ orchDir, agents: [], maxParallel: 2 });
    expect(out).toHaveLength(2);
  });

  test("slot bound subtracts in-flight tickets that DO have a live worker", () => {
    // maxParallel=3; CTL-LIVE has a live worker, 3 others do not → free = 3-1 = 2.
    writeSignal(orchDir, "CTL-LIVE", "implement", { worktreePath: "/wt/CTL-LIVE" });
    writeSignal(orchDir, "CTL-1", "implement", { worktreePath: "/wt/CTL-1" });
    writeSignal(orchDir, "CTL-2", "implement", { worktreePath: "/wt/CTL-2" });
    writeSignal(orchDir, "CTL-3", "implement", { worktreePath: "/wt/CTL-3" });
    const agents = [{ kind: "background", cwd: "/wt/CTL-LIVE" }];
    const out = selectBootResumeCandidates({ orchDir, agents, maxParallel: 3 });
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.ticket !== "CTL-LIVE")).toBe(true);
  });

  test("slices deterministically by ticket id so the cap is reproducible", () => {
    writeSignal(orchDir, "CTL-3", "implement", { worktreePath: "/wt/CTL-3" });
    writeSignal(orchDir, "CTL-1", "implement", { worktreePath: "/wt/CTL-1" });
    writeSignal(orchDir, "CTL-2", "implement", { worktreePath: "/wt/CTL-2" });
    const out = selectBootResumeCandidates({ orchDir, agents: [], maxParallel: 2 });
    expect(out.map((c) => c.ticket)).toEqual(["CTL-1", "CTL-2"]);
  });

  test("defaults maxParallel from state.json when not passed", () => {
    writeMaxParallel(orchDir, 1);
    writeSignal(orchDir, "CTL-1", "implement", { worktreePath: "/wt/CTL-1" });
    writeSignal(orchDir, "CTL-2", "implement", { worktreePath: "/wt/CTL-2" });
    const out = selectBootResumeCandidates({ orchDir, agents: [] });
    expect(out).toHaveLength(1);
  });
});
