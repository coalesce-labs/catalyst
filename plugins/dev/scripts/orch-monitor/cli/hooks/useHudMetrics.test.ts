// useHudMetrics.test.ts — verifies the pure metric-computation logic for
// CTL-435 status-line chips. The hook itself wraps node:fs reads and a 5s
// setInterval; we test the pure function it delegates to.

import { describe, test, expect } from "bun:test";
import { computePollMetrics } from "./useHudMetrics.ts";
import type { WorkerSignal } from "../lib/worker-signals-reader.ts";
import type { OrchState } from "../lib/orch-state-reader.ts";

function worker(overrides: Partial<WorkerSignal>): WorkerSignal {
  return {
    ticket: "X-1",
    orchestrator: "o-1",
    wave: 1,
    workerName: "o-1-X-1",
    label: null,
    status: "researching",
    stalledReason: null,
    phase: 1,
    phaseName: null,
    phaseTimestamps: {},
    lastHeartbeat: null,
    startedAt: null,
    updatedAt: null,
    completedAt: null,
    worktreePath: null,
    pr: null,
    linearState: null,
    definitionOfDone: null,
    raw: null,
    ...overrides,
  };
}

function orch(active: number, total: number = active): OrchState {
  return {
    id: "o-1",
    orchestrator: "o-1",
    currentWave: 1,
    totalWaves: 1,
    queueLength: 0,
    maxParallel: 3,
    baseBranch: "main",
    startedAt: null,
    workersCount: { active, total },
    raw: null,
  };
}

describe("computePollMetrics", () => {
  test("empty inputs → all zeros", () => {
    expect(computePollMetrics([], [])).toEqual({
      activeWorkers: 0,
      activeOrchestrators: 0,
      openPRs: 0,
    });
  });

  test("counts only non-terminal workers as active", () => {
    const workers = [
      worker({ status: "researching" }),
      worker({ status: "implementing" }),
      worker({ status: "pr-created" }),
      worker({ status: "done" }),
      worker({ status: "failed" }),
      worker({ status: "stalled" }),
      worker({ status: "deploy-failed" }),
    ];
    const m = computePollMetrics(workers, []);
    expect(m.activeWorkers).toBe(3);
  });

  test("counts only orchestrators with active workers > 0", () => {
    const orchs = [orch(0, 5), orch(2, 4), orch(1, 1), orch(0, 0)];
    const m = computePollMetrics([], orchs);
    expect(m.activeOrchestrators).toBe(2);
  });

  test("counts open PRs as those with pr set and mergedAt falsy", () => {
    const workers = [
      worker({ status: "pr-created", pr: { number: 1, url: "u", mergedAt: null } }),
      worker({ status: "pr-created", pr: { number: 2, url: "u" } }), // mergedAt absent → open
      worker({ status: "done", pr: { number: 3, url: "u", mergedAt: "2026-05-15T00:00:00Z" } }),
      worker({ status: "researching", pr: null }),
    ];
    const m = computePollMetrics(workers, []);
    expect(m.openPRs).toBe(2);
  });

  test("realistic mix produces correct totals", () => {
    const workers = [
      worker({ status: "researching", pr: null }),
      worker({ status: "implementing", pr: null }),
      worker({ status: "pr-created", pr: { number: 9, url: "u", mergedAt: null } }),
      worker({ status: "done", pr: { number: 8, url: "u", mergedAt: "2026-05-14T00:00:00Z" } }),
    ];
    const orchs = [orch(3, 4), orch(0, 2)];
    expect(computePollMetrics(workers, orchs)).toEqual({
      activeWorkers: 3,
      activeOrchestrators: 1,
      openPRs: 1,
    });
  });
});
