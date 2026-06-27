// Unit tests for the execution-core unified worker-signal reader (CTL-533).
// Run: cd plugins/dev/scripts/execution-core && bun test signal-reader.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readWorkerSignals,
  readAllPhaseSignals,
  listDispatchedPhases,
  byActivePhase,
  countSdkInflight,
  hasFreshClaim,
} from "./signal-reader.mjs";

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

// CTL-830: turn-cap-exhausted is terminal since CTL-748 — it no longer
// shadows in-flight phases, and ties with other terminals break on updatedAt.
describe("byActivePhase — turn-cap-exhausted is terminal (CTL-830)", () => {
  test("a running phase sorts before turn-cap-exhausted", () => {
    const tce = { phase: "implement", status: "turn-cap-exhausted", updatedAt: "2026-05-28T12:00:00Z" };
    const running = { phase: "monitor-deploy", status: "running", updatedAt: "2026-05-28T10:00:00Z" };
    const sorted = [tce, running].sort(byActivePhase);
    expect(sorted[0].status).toBe("running");
  });

  test("turn-cap-exhausted vs done tiebreaks on most-recent updatedAt", () => {
    const tce = { phase: "implement", status: "turn-cap-exhausted", updatedAt: "2026-05-28T10:00:00Z" };
    const done = { phase: "monitor-deploy", status: "done", updatedAt: "2026-05-28T12:00:00Z" };
    const sorted = [tce, done].sort(byActivePhase);
    expect(sorted[0].status).toBe("done"); // newer updatedAt wins among terminals
  });
});

// --- CTL-702: yield-tombstone exclusion -----------------------------------

describe("yield-tombstone exclusion (CTL-702)", () => {
  test("readWorkerSignals ignores phase-*-yield-*.json files", () => {
    const dir = join(workersDir(), "CTL-702A");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-plan.json"),
      JSON.stringify({
        ticket: "CTL-702A",
        phase: "plan",
        status: "done",
        updatedAt: "2026-05-28T00:00:00Z",
      }),
    );
    writeFileSync(
      join(dir, "phase-plan-yield-20260528T050740Z.json"),
      JSON.stringify({
        yieldedAt: "2026-05-28T05:07:40Z",
        ourJob: "abc123",
        canonicalJob: "def456",
      }),
    );
    const sigs = readWorkerSignals(orchDir);
    const forTicket = sigs.filter((s) => s.ticket === "CTL-702A");
    expect(forTicket).toHaveLength(1);
    expect(forTicket[0].phase).toBe("plan");
    expect(forTicket[0].status).toBe("done");
  });

  test("listDispatchedPhases excludes -yield- names", () => {
    const dir = join(workersDir(), "CTL-702B");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "phase-plan.json"), JSON.stringify({ ticket: "CTL-702B", phase: "plan", status: "done" }));
    writeFileSync(join(dir, "phase-plan-yield-20260528T050740Z.json"), JSON.stringify({}));
    writeFileSync(join(dir, "phase-research-yield-20260527T120000Z.json"), JSON.stringify({}));
    const phases = listDispatchedPhases(orchDir, "CTL-702B");
    expect(phases).toEqual(["plan"]);
  });

  test("yield-file-only worker dir returns no signals", () => {
    const dir = join(workersDir(), "CTL-702C");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "phase-plan-yield-20260528T050740Z.json"), JSON.stringify({}));
    const sigs = readWorkerSignals(orchDir);
    expect(sigs.find((s) => s.ticket === "CTL-702C")).toBeUndefined();
  });
});

// CTL-934: readAllPhaseSignals — per-file fan-out (every phase signal, not just
// the active one). The belief rules join obs_signal(T, P, …) per phase, so the
// fact collector needs to observe superseded/terminal sibling phases.
describe("readAllPhaseSignals (CTL-934)", () => {
  test("returns EVERY nested phase signal for a ticket, not just the active one", () => {
    writeNested("CTL-50", "research", {
      bg_job_id: "aaa1",
      status: "done",
      updatedAt: "2026-06-09T01:00:00Z",
    });
    writeNested("CTL-50", "plan", {
      bg_job_id: "bbb2",
      status: "done",
      updatedAt: "2026-06-09T02:00:00Z",
    });
    writeNested("CTL-50", "implement", {
      bg_job_id: "ccc3",
      status: "running",
      updatedAt: "2026-06-09T03:00:00Z",
    });

    // readWorkerSignals collapses to ONE active-phase row…
    const active = readWorkerSignals(orchDir).filter((s) => s.ticket === "CTL-50");
    expect(active).toHaveLength(1);
    expect(active[0].phase).toBe("implement");

    // …readAllPhaseSignals keeps all three (the superseded siblings included).
    const all = readAllPhaseSignals(orchDir).filter((s) => s.ticket === "CTL-50");
    expect(all.map((s) => s.phase).sort()).toEqual(["implement", "plan", "research"]);
    const byPhase = Object.fromEntries(all.map((s) => [s.phase, s]));
    expect(byPhase.research.status).toBe("done");
    expect(byPhase.research.liveness).toEqual({ kind: "bg", value: "aaa1" });
    expect(byPhase.implement.liveness).toEqual({ kind: "bg", value: "ccc3" });
  });

  test("flat (legacy oneshot) signals appear exactly once, like readWorkerSignals", () => {
    writeFlat("CTL-51", { pid: 999, status: "running", phase: 4 });
    const all = readAllPhaseSignals(orchDir).filter((s) => s.ticket === "CTL-51");
    expect(all).toHaveLength(1);
    expect(all[0].layout).toBe("flat");
    expect(all[0].liveness).toEqual({ kind: "pid", value: 999 });
  });

  test("excludes artifacts and yield tombstones, like the active reader", () => {
    const dir = join(workersDir(), "CTL-52");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "phase-plan.json"), JSON.stringify({ ticket: "CTL-52", phase: "plan", status: "done" }));
    writeFileSync(join(dir, "verify.json"), JSON.stringify({ findings: [] }));
    writeFileSync(join(dir, "triage.json"), JSON.stringify({}));
    writeFileSync(join(dir, "phase-plan-yield-20260601T000000Z.json"), JSON.stringify({}));
    const all = readAllPhaseSignals(orchDir).filter((s) => s.ticket === "CTL-52");
    expect(all.map((s) => s.phase)).toEqual(["plan"]);
  });

  test("no workers/ dir → []", () => {
    rmSync(join(orchDir, "workers"), { recursive: true, force: true });
    expect(readAllPhaseSignals(orchDir)).toEqual([]);
  });
});

// CTL-1367 P1: countSdkInflight — the executor=sdk occupancy reader. Counts
// dispatched/running NESTED phase signals with NO bg_job_id (the in-process SDK
// worker shape) so the scheduler slot gate + monitor triage budget can see SDK
// workers that have no `claude --bg` job. Never counts a bg worker (it has a
// bg_job_id) and never counts a flat (legacy oneshot) signal.
describe("countSdkInflight (CTL-1367 P1)", () => {
  test("counts dispatched + running nested signals with no bg_job_id", () => {
    writeNested("CTL-1", "triage", { status: "dispatched", bg_job_id: null });
    writeNested("CTL-2", "research", { status: "running", bg_job_id: null });
    expect(countSdkInflight(orchDir)).toBe(2);
  });

  test("does NOT count a nested signal that carries a bg_job_id (a bg worker)", () => {
    // bg workers are already counted by liveBackgroundCount; counting them here too
    // would double-count and under-dispatch.
    writeNested("CTL-1", "triage", { status: "dispatched", bg_job_id: "job-abc" });
    writeNested("CTL-2", "research", { status: "running", bg_job_id: "job-def" });
    expect(countSdkInflight(orchDir)).toBe(0);
  });

  test("does NOT count terminal statuses (done/failed/stalled/skipped/turn-cap-exhausted)", () => {
    writeNested("CTL-1", "triage", { status: "done", bg_job_id: null });
    writeNested("CTL-2", "research", { status: "failed", bg_job_id: null });
    writeNested("CTL-3", "plan", { status: "stalled", bg_job_id: null });
    writeNested("CTL-4", "implement", { status: "skipped", bg_job_id: null });
    writeNested("CTL-5", "verify", { status: "turn-cap-exhausted", bg_job_id: null });
    expect(countSdkInflight(orchDir)).toBe(0);
  });

  test("does NOT count flat (legacy oneshot) signals", () => {
    writeFlat("CTL-9", { status: "dispatched" });
    expect(countSdkInflight(orchDir)).toBe(0);
  });

  test("counts every in-flight nested phase across multiple tickets", () => {
    writeNested("CTL-1", "triage", { status: "done", bg_job_id: null }); // terminal — not counted
    writeNested("CTL-1", "research", { status: "running", bg_job_id: null }); // counted
    writeNested("CTL-2", "plan", { status: "dispatched", bg_job_id: null }); // counted
    writeNested("CTL-3", "implement", { status: "running", bg_job_id: "job-x" }); // bg — not counted
    expect(countSdkInflight(orchDir)).toBe(2);
  });

  test("no workers/ dir → 0 (never throws)", () => {
    rmSync(join(orchDir, "workers"), { recursive: true, force: true });
    expect(countSdkInflight(orchDir)).toBe(0);
  });
});

// CTL-1367 P2-G: hasFreshClaim — a YOUNG single-flight claim (workers/<T>/<phase>
// .claim.<gen>) makes a missing SDK signal a benign claim-lost (a concurrent
// dispatcher won the O_EXCL claim and is mid-dispatch; the loser writes no signal).
describe("hasFreshClaim (CTL-1367 P2-G)", () => {
  const writeClaim = (ticket, phase, gen = 1) => {
    const dir = join(workersDir(), ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${phase}.claim.${gen}`), JSON.stringify({ generation: gen }));
  };

  test("a fresh claim → true", () => {
    writeClaim("CTL-1", "triage");
    expect(hasFreshClaim(orchDir, "CTL-1", "triage")).toBe(true);
  });

  test("no claim → false", () => {
    mkdirSync(join(workersDir(), "CTL-2"), { recursive: true });
    expect(hasFreshClaim(orchDir, "CTL-2", "triage")).toBe(false);
  });

  test("an OLD claim (mtime older than the grace window) → false", () => {
    writeClaim("CTL-3", "research");
    // Advance `now` past the grace so the just-written claim reads as old.
    expect(hasFreshClaim(orchDir, "CTL-3", "research", { now: () => Date.now() + 10 * 60 * 1000 })).toBe(false);
  });

  test("matches the phase prefix exactly", () => {
    writeClaim("CTL-4", "plan");
    expect(hasFreshClaim(orchDir, "CTL-4", "triage")).toBe(false);
    expect(hasFreshClaim(orchDir, "CTL-4", "plan")).toBe(true);
  });

  test("no worker dir → false (never throws)", () => {
    expect(hasFreshClaim(orchDir, "CTL-NOPE", "triage")).toBe(false);
  });
});
