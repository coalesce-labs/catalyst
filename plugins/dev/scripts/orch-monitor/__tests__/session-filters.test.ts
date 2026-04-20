import { describe, it, expect } from "bun:test";
import {
  filterSessions,
  filterOrchestrators,
  RECENT_WINDOW_SECONDS,
} from "../ui/src/lib/session-filters";
import type {
  OrchestratorState,
  SessionState,
  WorkerState,
} from "../ui/src/lib/types";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "sess_001",
    workflowId: null,
    ticket: null,
    label: null,
    skillName: null,
    status: "running",
    phase: 1,
    pid: 1234,
    alive: true,
    startedAt: "2026-04-15T00:00:00Z",
    updatedAt: "2026-04-15T00:01:00Z",
    completedAt: null,
    timeSinceUpdate: 60,
    cost: null,
    pr: null,
    cwd: null,
    gitBranch: null,
    ...overrides,
  };
}

describe("filterSessions", () => {
  const aliveSess = makeSession({ sessionId: "alive-1", alive: true, status: "running" });
  const deadRecent = makeSession({
    sessionId: "dead-recent",
    alive: false,
    status: "done",
    timeSinceUpdate: 1800, // 30 min
  });
  const deadOld = makeSession({
    sessionId: "dead-old",
    alive: false,
    status: "done",
    timeSinceUpdate: 7200, // 2 hours
  });
  const deadVeryOld = makeSession({
    sessionId: "dead-very-old",
    alive: false,
    status: "done",
    timeSinceUpdate: 100000, // ~28 hours
  });

  const allSessions = [aliveSess, deadRecent, deadOld, deadVeryOld];

  it("'active' filter returns only alive/running sessions", () => {
    const { active, dead } = filterSessions(allSessions, "active");
    expect(active).toHaveLength(1);
    expect(active[0].sessionId).toBe("alive-1");
    expect(dead).toHaveLength(0);
  });

  it("'1h' filter returns active + dead within 3600s", () => {
    const { active, dead } = filterSessions(allSessions, "1h");
    expect(active).toHaveLength(1);
    expect(dead).toHaveLength(1);
    expect(dead[0].sessionId).toBe("dead-recent");
  });

  it("'24h' filter returns active + dead within 86400s", () => {
    const { active, dead } = filterSessions(allSessions, "24h");
    expect(active).toHaveLength(1);
    expect(dead).toHaveLength(2);
    const deadIds = dead.map((s) => s.sessionId);
    expect(deadIds).toContain("dead-recent");
    expect(deadIds).toContain("dead-old");
  });

  it("'48h' filter returns active + dead within 172800s", () => {
    const { active, dead } = filterSessions(allSessions, "48h");
    expect(active).toHaveLength(1);
    expect(dead).toHaveLength(3);
  });

  it("'all' filter returns all sessions", () => {
    const { active, dead } = filterSessions(allSessions, "all");
    expect(active).toHaveLength(1);
    expect(dead).toHaveLength(3);
  });

  it("alive sessions are always included regardless of filter", () => {
    const oldButAlive = makeSession({
      sessionId: "old-alive",
      alive: true,
      status: "running",
      timeSinceUpdate: 999999,
    });
    const { active } = filterSessions([oldButAlive], "active");
    expect(active).toHaveLength(1);
    expect(active[0].sessionId).toBe("old-alive");
  });

  it("dead session exactly at boundary is excluded", () => {
    const atBoundary = makeSession({
      sessionId: "at-boundary",
      alive: false,
      status: "done",
      timeSinceUpdate: 3600, // exactly 1h — should be excluded from "1h" filter
    });
    const { dead } = filterSessions([atBoundary], "1h");
    expect(dead).toHaveLength(0);
  });

  it("dead session just inside boundary is included", () => {
    const justInside = makeSession({
      sessionId: "just-inside",
      alive: false,
      status: "done",
      timeSinceUpdate: 3599,
    });
    const { dead } = filterSessions([justInside], "1h");
    expect(dead).toHaveLength(1);
  });

  it("returns empty arrays for empty input", () => {
    const { active, dead } = filterSessions([], "all");
    expect(active).toHaveLength(0);
    expect(dead).toHaveLength(0);
  });
});

function makeWorker(overrides: Partial<WorkerState> = {}): WorkerState {
  return {
    ticket: "T-1",
    status: "in_progress",
    phase: 1,
    wave: null,
    pid: 1234,
    alive: true,
    pr: null,
    startedAt: "2026-04-15T00:00:00Z",
    updatedAt: "2026-04-15T00:01:00Z",
    timeSinceUpdate: 60,
    lastHeartbeat: null,
    definitionOfDone: {},
    ...overrides,
  };
}

function makeOrch(
  id: string,
  workers: WorkerState[],
  overrides: Partial<OrchestratorState> = {},
): OrchestratorState {
  const workersMap: Record<string, WorkerState> = {};
  for (const w of workers) workersMap[w.ticket] = w;
  return {
    id,
    path: `/runs/${id}`,
    workspace: "default",
    startedAt: "2026-04-15T00:00:00Z",
    currentWave: 1,
    totalWaves: 1,
    waves: [],
    workers: workersMap,
    dashboard: null,
    briefings: {},
    attention: [],
    ...overrides,
  };
}

describe("filterOrchestrators", () => {
  it("returns empty arrays for empty input", () => {
    const { visible, recent } = filterOrchestrators([], "active");
    expect(visible).toHaveLength(0);
    expect(recent).toHaveLength(0);
  });

  it("orch with zero workers is always visible (bootstrap case)", () => {
    const orch = makeOrch("boot", []);
    const { visible, recent } = filterOrchestrators([orch], "active");
    expect(visible).toHaveLength(1);
    expect(recent).toHaveLength(0);
  });

  it("orch with one in_progress worker is visible under 'active'", () => {
    const orch = makeOrch("o1", [makeWorker({ ticket: "T-1", status: "in_progress" })]);
    const { visible, recent } = filterOrchestrators([orch], "active");
    expect(visible).toHaveLength(1);
    expect(recent).toHaveLength(0);
  });

  it("orch with all workers done+merged within 7d is in 'recent' under 'active'", () => {
    const orch = makeOrch("o1", [
      makeWorker({ ticket: "T-1", status: "done", timeSinceUpdate: 1800, alive: false }),
      makeWorker({ ticket: "T-2", status: "merged", timeSinceUpdate: 3600, alive: false }),
    ]);
    const { visible, recent } = filterOrchestrators([orch], "active");
    expect(visible).toHaveLength(0);
    expect(recent).toHaveLength(1);
    expect(recent[0].id).toBe("o1");
  });

  it("orch with all workers done but older than 7d is hidden under 'active'", () => {
    const orch = makeOrch("o1", [
      makeWorker({
        ticket: "T-1",
        status: "done",
        timeSinceUpdate: RECENT_WINDOW_SECONDS + 100,
        alive: false,
      }),
    ]);
    const { visible, recent } = filterOrchestrators([orch], "active");
    expect(visible).toHaveLength(0);
    expect(recent).toHaveLength(0);
  });

  it("treats failed, stalled, and signal_corrupt as done", () => {
    const orch = makeOrch("o1", [
      makeWorker({ ticket: "T-1", status: "failed", timeSinceUpdate: 60, alive: false }),
      makeWorker({ ticket: "T-2", status: "stalled", timeSinceUpdate: 60, alive: false }),
      makeWorker({ ticket: "T-3", status: "signal_corrupt", timeSinceUpdate: 60, alive: false }),
    ]);
    const { visible, recent } = filterOrchestrators([orch], "active");
    expect(visible).toHaveLength(0);
    expect(recent).toHaveLength(1);
  });

  it("mixed workers (one done, one in_progress) is visible under 'active'", () => {
    const orch = makeOrch("o1", [
      makeWorker({ ticket: "T-1", status: "done", alive: false, timeSinceUpdate: 100 }),
      makeWorker({ ticket: "T-2", status: "in_progress", alive: true, timeSinceUpdate: 30 }),
    ]);
    const { visible, recent } = filterOrchestrators([orch], "active");
    expect(visible).toHaveLength(1);
    expect(recent).toHaveLength(0);
  });

  it("done orch updated within 1h is visible under '1h' filter", () => {
    const orch = makeOrch("o1", [
      makeWorker({ ticket: "T-1", status: "done", alive: false, timeSinceUpdate: 1800 }),
    ]);
    const { visible, recent } = filterOrchestrators([orch], "1h");
    expect(visible).toHaveLength(1);
    expect(recent).toHaveLength(0);
  });

  it("done orch within 24h but not 1h is in 'recent' under '1h' filter", () => {
    const orch = makeOrch("o1", [
      makeWorker({ ticket: "T-1", status: "done", alive: false, timeSinceUpdate: 7200 }),
    ]);
    const { visible, recent } = filterOrchestrators([orch], "1h");
    expect(visible).toHaveLength(0);
    expect(recent).toHaveLength(1);
  });

  it("done orch older than 48h but within 7d is in 'recent' under '48h' filter", () => {
    const orch = makeOrch("o1", [
      makeWorker({
        ticket: "T-1",
        status: "done",
        alive: false,
        timeSinceUpdate: 3 * 86400, // 3 days
      }),
    ]);
    const { visible, recent } = filterOrchestrators([orch], "48h");
    expect(visible).toHaveLength(0);
    expect(recent).toHaveLength(1);
  });

  it("done orch older than 7d is hidden under '48h' filter", () => {
    const orch = makeOrch("o1", [
      makeWorker({
        ticket: "T-1",
        status: "done",
        alive: false,
        timeSinceUpdate: RECENT_WINDOW_SECONDS + 100,
      }),
    ]);
    const { visible, recent } = filterOrchestrators([orch], "48h");
    expect(visible).toHaveLength(0);
    expect(recent).toHaveLength(0);
  });

  it("'all' filter returns every orch in visible, recent empty", () => {
    const active = makeOrch("active", [makeWorker({ ticket: "T-1", status: "in_progress" })]);
    const recentDone = makeOrch("recent", [
      makeWorker({ ticket: "T-2", status: "done", alive: false, timeSinceUpdate: 1800 }),
    ]);
    const oldDone = makeOrch("old", [
      makeWorker({
        ticket: "T-3",
        status: "merged",
        alive: false,
        timeSinceUpdate: 30 * 86400,
      }),
    ]);
    const { visible, recent } = filterOrchestrators([active, recentDone, oldDone], "all");
    expect(visible).toHaveLength(3);
    expect(recent).toHaveLength(0);
  });

  it("worker updated exactly at 7d boundary is NOT in recent (strict <)", () => {
    const orch = makeOrch("o1", [
      makeWorker({
        ticket: "T-1",
        status: "done",
        alive: false,
        timeSinceUpdate: RECENT_WINDOW_SECONDS,
      }),
    ]);
    const { visible, recent } = filterOrchestrators([orch], "active");
    expect(visible).toHaveLength(0);
    expect(recent).toHaveLength(0);
  });

  it("worker updated exactly at 1h cutoff is NOT in visible (strict <)", () => {
    const orch = makeOrch("o1", [
      makeWorker({
        ticket: "T-1",
        status: "done",
        alive: false,
        timeSinceUpdate: 3600,
      }),
    ]);
    const { visible, recent } = filterOrchestrators([orch], "1h");
    expect(visible).toHaveLength(0);
    // Still within 7d so should fall through to recent
    expect(recent).toHaveLength(1);
  });

  it("when multiple workers present, uses the most recent update for bucketing", () => {
    const orch = makeOrch("o1", [
      makeWorker({
        ticket: "T-1",
        status: "done",
        alive: false,
        timeSinceUpdate: RECENT_WINDOW_SECONDS + 100, // very old
      }),
      makeWorker({
        ticket: "T-2",
        status: "done",
        alive: false,
        timeSinceUpdate: 3600, // recent
      }),
    ]);
    const { visible, recent } = filterOrchestrators([orch], "active");
    expect(visible).toHaveLength(0);
    expect(recent).toHaveLength(1);
  });
});
