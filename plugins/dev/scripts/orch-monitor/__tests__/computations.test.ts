import { describe, it, expect } from "bun:test";
import {
  isMerged,
  isAbandoned,
  isSettled,
  computeOrchestratorStats,
  waveDoneCount,
} from "../ui/src/lib/computations";
import type {
  OrchestratorState,
  WorkerState,
  Wave,
} from "../ui/src/lib/types";

function makeWorker(overrides: Partial<WorkerState> = {}): WorkerState {
  return {
    ticket: overrides.ticket ?? "T-1",
    status: "dispatched",
    phase: 0,
    wave: null,
    pid: null,
    alive: false,
    pr: null,
    startedAt: "2026-04-20T00:00:00Z",
    updatedAt: "2026-04-20T00:01:00Z",
    timeSinceUpdate: 0,
    lastHeartbeat: null,
    definitionOfDone: {},
    ...overrides,
  };
}

function makeOrch(workers: Record<string, WorkerState>): OrchestratorState {
  return {
    id: "orch-test",
    path: "/tmp/orch-test",
    workspace: "default",
    startedAt: "2026-04-20T00:00:00Z",
    currentWave: 1,
    totalWaves: 1,
    waves: [],
    workers,
    dashboard: null,
    briefings: {},
    attention: [],
  };
}

describe("predicates", () => {
  it("isMerged returns true for done / merged only", () => {
    expect(isMerged("done")).toBe(true);
    expect(isMerged("merged")).toBe(true);
    expect(isMerged("superseded")).toBe(false);
    expect(isMerged("canceled")).toBe(false);
    expect(isMerged("failed")).toBe(false);
    expect(isMerged("stalled")).toBe(false);
    expect(isMerged("dispatched")).toBe(false);
    expect(isMerged("whatever")).toBe(false);
  });

  it("isAbandoned returns true for superseded / canceled only", () => {
    expect(isAbandoned("superseded")).toBe(true);
    expect(isAbandoned("canceled")).toBe(true);
    expect(isAbandoned("done")).toBe(false);
    expect(isAbandoned("merged")).toBe(false);
    expect(isAbandoned("failed")).toBe(false);
    expect(isAbandoned("stalled")).toBe(false);
    expect(isAbandoned("dispatched")).toBe(false);
    expect(isAbandoned("whatever")).toBe(false);
  });

  it("isSettled is the union of merged, abandoned, and failed", () => {
    expect(isSettled("done")).toBe(true);
    expect(isSettled("merged")).toBe(true);
    expect(isSettled("superseded")).toBe(true);
    expect(isSettled("canceled")).toBe(true);
    expect(isSettled("failed")).toBe(true);
    expect(isSettled("stalled")).toBe(false);
    expect(isSettled("dispatched")).toBe(false);
    expect(isSettled("implementing")).toBe(false);
  });
});

describe("computeOrchestratorStats", () => {
  it("all merged → pct=100, abandoned=0", () => {
    const workers: Record<string, WorkerState> = {};
    for (let i = 1; i <= 3; i++) {
      workers[`T-${i}`] = makeWorker({ ticket: `T-${i}`, status: "merged" });
    }
    const s = computeOrchestratorStats(makeOrch(workers), {});
    expect(s.done).toBe(3);
    expect(s.total).toBe(3);
    expect(s.abandoned).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.pct).toBe(100);
  });

  it("14 merged + 1 superseded → 14/14 (100%), abandoned=1", () => {
    const workers: Record<string, WorkerState> = {};
    for (let i = 1; i <= 14; i++) {
      workers[`T-${i}`] = makeWorker({ ticket: `T-${i}`, status: "merged" });
    }
    workers["T-15"] = makeWorker({ ticket: "T-15", status: "superseded" });
    const s = computeOrchestratorStats(makeOrch(workers), {});
    expect(s.done).toBe(14);
    expect(s.total).toBe(14);
    expect(s.abandoned).toBe(1);
    expect(s.failed).toBe(0);
    expect(s.pct).toBe(100);
  });

  it("14 merged + 1 canceled → 14/14 (100%), abandoned=1", () => {
    const workers: Record<string, WorkerState> = {};
    for (let i = 1; i <= 14; i++) {
      workers[`T-${i}`] = makeWorker({ ticket: `T-${i}`, status: "done" });
    }
    workers["T-15"] = makeWorker({ ticket: "T-15", status: "canceled" });
    const s = computeOrchestratorStats(makeOrch(workers), {});
    expect(s.done).toBe(14);
    expect(s.total).toBe(14);
    expect(s.abandoned).toBe(1);
    expect(s.pct).toBe(100);
  });

  it("14 merged + 1 failed → 14/15 (93%) — failed is NOT abandoned", () => {
    const workers: Record<string, WorkerState> = {};
    for (let i = 1; i <= 14; i++) {
      workers[`T-${i}`] = makeWorker({ ticket: `T-${i}`, status: "merged" });
    }
    workers["T-15"] = makeWorker({ ticket: "T-15", status: "failed" });
    const s = computeOrchestratorStats(makeOrch(workers), {});
    expect(s.done).toBe(14);
    expect(s.total).toBe(15);
    expect(s.abandoned).toBe(0);
    expect(s.failed).toBe(1);
    expect(s.pct).toBe(93);
  });

  it("all superseded → total=0, pct=0 (guarded divide)", () => {
    const workers: Record<string, WorkerState> = {
      "T-1": makeWorker({ ticket: "T-1", status: "superseded" }),
      "T-2": makeWorker({ ticket: "T-2", status: "superseded" }),
    };
    const s = computeOrchestratorStats(makeOrch(workers), {});
    expect(s.done).toBe(0);
    expect(s.total).toBe(0);
    expect(s.abandoned).toBe(2);
    expect(s.pct).toBe(0);
  });

  it("0 merged, 3 dispatched → pct=0", () => {
    const workers: Record<string, WorkerState> = {
      "T-1": makeWorker({ ticket: "T-1", status: "dispatched" }),
      "T-2": makeWorker({ ticket: "T-2", status: "researching" }),
      "T-3": makeWorker({ ticket: "T-3", status: "implementing" }),
    };
    const s = computeOrchestratorStats(makeOrch(workers), {});
    expect(s.done).toBe(0);
    expect(s.total).toBe(3);
    expect(s.abandoned).toBe(0);
    expect(s.pct).toBe(0);
  });
});

describe("waveDoneCount", () => {
  it("counts only merged workers, excluding abandoned / in-flight", () => {
    const workers: Record<string, WorkerState> = {
      "T-1": makeWorker({ ticket: "T-1", status: "merged" }),
      "T-2": makeWorker({ ticket: "T-2", status: "done" }),
      "T-3": makeWorker({ ticket: "T-3", status: "superseded" }),
      "T-4": makeWorker({ ticket: "T-4", status: "dispatched" }),
    };
    const wave: Wave = {
      wave: 1,
      status: "in_progress",
      tickets: ["T-1", "T-2", "T-3", "T-4"],
    };
    expect(waveDoneCount(wave, workers)).toBe(2);
  });
});
