// Unit tests for the execution-core unified worker-signal reader (CTL-533).
// Run: cd plugins/dev/scripts/execution-core && bun test signal-reader.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkerSignals, listDispatchedPhases, byActivePhase } from "./signal-reader.mjs";

let orchDir;

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "exec-core-sigreader-"));
});

afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

// --- helpers --------------------------------------------------------------

function workersDir() {
  const dir = join(orchDir, "workers");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Write a flat legacy signal: workers/<T>.json
function writeFlat(ticket, body) {
  writeFileSync(
    join(workersDir(), `${ticket}.json`),
    JSON.stringify({ ticket, ...body }),
  );
}

// Write a nested phase signal: workers/<T>/phase-<p>.json
function writeNested(ticket, phase, body) {
  const dir = join(workersDir(), ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `phase-${phase}.json`),
    JSON.stringify({ ticket, phase, ...body }),
  );
}

function byTicket(signals) {
  const m = new Map();
  for (const s of signals) m.set(s.ticket, s);
  return m;
}

// --- tests ----------------------------------------------------------------

describe("readWorkerSignals", () => {
  test("reads a flat legacy signal and tags layout='flat'", () => {
    writeFlat("CTL-1", { phase: 3, pid: 123, status: "implementing" });
    const sigs = readWorkerSignals(orchDir);
    expect(sigs).toHaveLength(1);
    const s = sigs[0];
    expect(s.ticket).toBe("CTL-1");
    expect(s.layout).toBe("flat");
    expect(s.phase).toBe(3);
    expect(s.liveness).toEqual({ kind: "pid", value: 123 });
    expect(s.status).toBe("implementing");
  });

  test("reads a nested phase signal and tags layout='nested'", () => {
    writeNested("CTL-2", "research", {
      bg_job_id: "ab12",
      status: "running",
    });
    const sigs = readWorkerSignals(orchDir);
    expect(sigs).toHaveLength(1);
    const s = sigs[0];
    expect(s.ticket).toBe("CTL-2");
    expect(s.layout).toBe("nested");
    expect(s.phase).toBe("research");
    expect(s.liveness).toEqual({ kind: "bg", value: "ab12" });
  });

  test("returns both layouts from one orch dir in a single call", () => {
    writeFlat("CTL-1", { phase: 3, pid: 123, status: "implementing" });
    writeNested("CTL-2", "research", { bg_job_id: "ab12", status: "running" });
    const sigs = readWorkerSignals(orchDir);
    expect(sigs).toHaveLength(2);
    const m = byTicket(sigs);
    expect(m.get("CTL-1").layout).toBe("flat");
    expect(m.get("CTL-2").layout).toBe("nested");
  });

  test("ignores broker shadow projections (*.json.projected)", () => {
    writeFlat("CTL-1", { phase: 1, pid: 1, status: "running" });
    writeFileSync(
      join(workersDir(), "CTL-1.json.projected"),
      JSON.stringify({ ticket: "CTL-1", shadow: true }),
    );
    const sigs = readWorkerSignals(orchDir);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].signalPath.endsWith(".json")).toBe(true);
    expect(sigs[0].signalPath.endsWith(".projected")).toBe(false);
  });

  test("ignores phase-output artifacts (triage/verify/review) (CTL-701)", () => {
    writeNested("CTL-3", "implement", { status: "running" });
    const dir = join(workersDir(), "CTL-3");
    for (const name of ["triage.json", "verify.json", "review.json"]) {
      writeFileSync(join(dir, name), JSON.stringify({ artifact: true }));
    }
    const sigs = readWorkerSignals(orchDir);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].phase).toBe("implement");
  });

  test("phase-monitor-deploy.json IS a phase signal (CTL-701)", () => {
    const dir = join(workersDir(), "CTL-MD");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-monitor-deploy.json"),
      JSON.stringify({
        ticket: "CTL-MD",
        phase: "monitor-deploy",
        status: "running",
        bg_job_id: "abc123",
        updatedAt: "2026-05-28T16:00:00Z",
        worktreePath: "/tmp/wt/CTL-MD",
      }),
    );
    const sigs = readWorkerSignals(orchDir);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].ticket).toBe("CTL-MD");
    expect(sigs[0].phase).toBe("monitor-deploy");
    expect(sigs[0].status).toBe("running");
    expect(sigs[0].liveness).toEqual({ kind: "bg", value: "abc123" });
  });

  test("ignores the workers/output/ directory", () => {
    writeFlat("CTL-1", { phase: 1, pid: 1, status: "running" });
    const outDir = join(workersDir(), "output");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "CTL-1-stream.jsonl"), "{}");
    const sigs = readWorkerSignals(orchDir);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].ticket).toBe("CTL-1");
  });

  test("when a ticket has multiple nested phase-*.json, picks the active (latest non-terminal) one", () => {
    const dir = join(workersDir(), "CTL-4");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-research.json"),
      JSON.stringify({
        ticket: "CTL-4",
        phase: "research",
        status: "done",
        updatedAt: "2026-05-21T01:00:00Z",
      }),
    );
    writeFileSync(
      join(dir, "phase-implement.json"),
      JSON.stringify({
        ticket: "CTL-4",
        phase: "implement",
        status: "running",
        updatedAt: "2026-05-21T02:00:00Z",
      }),
    );
    const sigs = readWorkerSignals(orchDir);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].phase).toBe("implement");
    expect(sigs[0].status).toBe("running");
  });

  test("byActivePhase ranks status='skipped' as terminal (CTL-512)", () => {
    // A worker dir with one in-flight phase and a later skipped monitor-deploy
    // must report the in-flight phase as active, not the skipped terminal —
    // the same ranking as for status='done'. Smoke test for the TERMINAL
    // set including 'skipped'.
    const dir = join(workersDir(), "CTL-512");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-research.json"),
      JSON.stringify({
        ticket: "CTL-512",
        phase: "research",
        status: "running",
        updatedAt: "2026-05-21T01:00:00Z",
      }),
    );
    writeFileSync(
      join(dir, "phase-monitor-deploy.json"),
      JSON.stringify({
        ticket: "CTL-512",
        phase: "monitor-deploy",
        status: "skipped",
        updatedAt: "2026-05-21T02:00:00Z",
      }),
    );
    // CTL-701: phase-monitor-deploy.json is now a real signal (not an artifact).
    // CTL-512 dir exercises byActivePhase with monitor-deploy/skipped; CTL-512B
    // uses a different phase name to provide a parallel smoke scenario.
    const dir2 = join(workersDir(), "CTL-512B");
    mkdirSync(dir2, { recursive: true });
    writeFileSync(
      join(dir2, "phase-research.json"),
      JSON.stringify({
        ticket: "CTL-512B",
        phase: "research",
        status: "running",
        updatedAt: "2026-05-21T01:00:00Z",
      }),
    );
    writeFileSync(
      join(dir2, "phase-pr.json"),
      JSON.stringify({
        ticket: "CTL-512B",
        phase: "pr",
        status: "skipped",
        updatedAt: "2026-05-21T02:00:00Z",
      }),
    );
    const sigs = readWorkerSignals(orchDir);
    const m = byTicket(sigs);
    expect(m.get("CTL-512B").phase).toBe("research");
    expect(m.get("CTL-512B").status).toBe("running");
  });

  test("tolerates malformed JSON — skips the file, does not throw", () => {
    writeFlat("CTL-1", { phase: 1, pid: 1, status: "running" });
    writeFileSync(join(workersDir(), "CTL-bad.json"), "{ not json");
    let sigs;
    expect(() => {
      sigs = readWorkerSignals(orchDir);
    }).not.toThrow();
    expect(sigs).toHaveLength(1);
    expect(sigs[0].ticket).toBe("CTL-1");
  });

  test("returns [] for an orch dir with no workers/ directory", () => {
    const empty = mkdtempSync(join(tmpdir(), "exec-core-empty-"));
    try {
      expect(readWorkerSignals(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("normalizes status/updatedAt/pr fields onto the canonical shape", () => {
    writeFlat("CTL-5", {
      phase: 4,
      pid: 99,
      status: "merging",
      updatedAt: "2026-05-21T03:00:00Z",
      pr: { number: 42, url: "https://github.com/o/r/pull/42" },
    });
    const sigs = readWorkerSignals(orchDir);
    expect(sigs).toHaveLength(1);
    const s = sigs[0];
    expect(s.status).toBe("merging");
    expect(s.updatedAt).toBe("2026-05-21T03:00:00Z");
    expect(s.pr).toEqual({ number: 42, url: "https://github.com/o/r/pull/42" });
    expect(s.raw.ticket).toBe("CTL-5");
  });

  test("a nested dir with only artifacts (no phase-*.json) yields no signal", () => {
    const dir = join(workersDir(), "CTL-6");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "triage.json"), JSON.stringify({ artifact: true }));
    const sigs = readWorkerSignals(orchDir);
    expect(sigs).toEqual([]);
  });
});

// --- CTL-606: listDispatchedPhases ----------------------------------------

describe("listDispatchedPhases", () => {
  test("returns every dispatched phase name under workers/<ticket>/", () => {
    writeNested("CTL-9", "triage", { status: "done" });
    writeNested("CTL-9", "research", { status: "done" });
    writeNested("CTL-9", "plan", { status: "running" });
    expect(listDispatchedPhases(orchDir, "CTL-9").sort()).toEqual([
      "plan",
      "research",
      "triage",
    ]);
  });

  test("ignores phase-output artifacts (triage/verify/review) (CTL-701)", () => {
    writeNested("CTL-9", "implement", { status: "running" });
    const dir = join(workersDir(), "CTL-9");
    for (const name of ["triage.json", "verify.json", "review.json"]) {
      writeFileSync(join(dir, name), JSON.stringify({ artifact: true }));
    }
    expect(listDispatchedPhases(orchDir, "CTL-9")).toEqual(["implement"]);
  });

  test("monitor-deploy appears in dispatched phases (CTL-701)", () => {
    writeNested("CTL-9", "implement", { status: "done" });
    writeNested("CTL-9", "monitor-deploy", { status: "running" });
    const phases = listDispatchedPhases(orchDir, "CTL-9").sort();
    expect(phases).toContain("monitor-deploy");
    expect(phases).toContain("implement");
  });

  test("returns [] when the worker dir does not exist", () => {
    expect(listDispatchedPhases(orchDir, "NOPE")).toEqual([]);
  });
});

// CTL-701 Phase 2: byActivePhase — turn-cap-exhausted is NOT terminal
describe("byActivePhase — turn-cap-exhausted (CTL-701)", () => {
  test("turn-cap-exhausted sorts before done regardless of updatedAt", () => {
    const tce = {
      phase: "implement",
      status: "turn-cap-exhausted",
      updatedAt: "2026-05-28T10:00:00Z",
    };
    const done = {
      phase: "monitor-deploy",
      status: "done",
      updatedAt: "2026-05-28T12:00:00Z",
    };
    const sorted = [tce, done].sort(byActivePhase);
    expect(sorted[0].status).toBe("turn-cap-exhausted");
    expect(sorted[1].status).toBe("done");
  });
});
