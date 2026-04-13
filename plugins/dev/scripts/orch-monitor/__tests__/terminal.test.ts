import { describe, it, expect } from "bun:test";
import { renderSnapshot } from "../lib/terminal";
import type {
  MonitorSnapshot,
  OrchestratorState,
  WorkerState,
} from "../lib/state-reader";

function makeWorker(overrides: Partial<WorkerState> = {}): WorkerState {
  return {
    ticket: "TEST-1",
    status: "in_progress",
    phase: 2,
    wave: null,
    pid: 12345,
    alive: true,
    pr: null,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
    timeSinceUpdate: 12,
    lastHeartbeat: null,
    definitionOfDone: {},
    ...overrides,
  };
}

function makeOrchestrator(
  overrides: Partial<OrchestratorState> = {}
): OrchestratorState {
  return {
    id: "orch-abc123",
    path: "/tmp/orch-abc123",
    startedAt: new Date().toISOString(),
    currentWave: 2,
    totalWaves: 5,
    waves: [],
    workers: {},
    dashboard: null,
    briefings: {},
    attention: [],
    ...overrides,
  };
}

function makeSnapshot(orchestrators: OrchestratorState[]): MonitorSnapshot {
  return {
    timestamp: new Date().toISOString(),
    orchestrators,
  };
}

describe("renderSnapshot", () => {
  it("returns a string", () => {
    const snapshot = makeSnapshot([makeOrchestrator()]);
    const out = renderSnapshot(snapshot);
    expect(typeof out).toBe("string");
  });

  it("contains the orchestrator id in the header", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({ id: "orch-xyz789" }),
    ]);
    const out = renderSnapshot(snapshot);
    expect(out).toContain("orch-xyz789");
  });

  it("shows wave progress like 'Wave 2/5'", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({ currentWave: 2, totalWaves: 5 }),
    ]);
    const out = renderSnapshot(snapshot);
    expect(out).toContain("2/5");
    expect(out.toLowerCase()).toContain("wave");
  });

  it("includes each worker's ticket", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "PROJ-1": makeWorker({ ticket: "PROJ-1" }),
          "PROJ-2": makeWorker({ ticket: "PROJ-2", status: "done" }),
          "PROJ-3": makeWorker({ ticket: "PROJ-3", status: "failed" }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot);
    expect(out).toContain("PROJ-1");
    expect(out).toContain("PROJ-2");
    expect(out).toContain("PROJ-3");
  });

  it("renders table header columns", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: { "T-1": makeWorker({ ticket: "T-1" }) },
      }),
    ]);
    const out = renderSnapshot(snapshot);
    expect(out).toContain("TICKET");
    expect(out).toContain("STATUS");
    expect(out).toContain("PHASE");
    expect(out).toContain("PID");
    expect(out).toContain("AGE");
    expect(out).toContain("PR");
  });

  it("includes ANSI color codes when status is a known non-default status", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "T-1": makeWorker({ ticket: "T-1", status: "done" }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot);
    // GREEN = \x1b[32m, RESET = \x1b[0m
    expect(out).toContain("\x1b[32m");
    expect(out).toContain("\x1b[0m");
  });

  it("renders PR number when present", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "T-1": makeWorker({
            ticket: "T-1",
            pr: { number: 4242, url: "https://github.com/x/y/pull/4242" },
          }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot);
    expect(out).toContain("4242");
  });

  it("handles empty orchestrator list without throwing", () => {
    const snapshot = makeSnapshot([]);
    const out = renderSnapshot(snapshot);
    expect(typeof out).toBe("string");
  });

  it("keeps visible line width <= 80 columns (excluding ANSI codes)", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        id: "orch-abc123",
        currentWave: 2,
        totalWaves: 5,
        workers: {
          "PROJ-123": makeWorker({
            ticket: "PROJ-123",
            status: "in_progress",
            pr: { number: 9999, url: "https://github.com/x/y/pull/9999" },
          }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot);
    // Strip ANSI escape sequences to measure visible width
    // eslint-disable-next-line no-control-regex
    const ansi = /\x1b\[[0-9;]*m/g;
    for (const line of out.split("\n")) {
      const stripped = line.replace(ansi, "");
      expect(stripped.length).toBeLessThanOrEqual(80);
    }
  });
});
