import { describe, it, expect } from "bun:test";
import { filterSessions } from "../ui/src/lib/session-filters";
import type { SessionState } from "../ui/src/lib/types";

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
