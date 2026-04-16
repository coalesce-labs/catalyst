import { describe, it, expect } from "bun:test";
import { repoKey, groupSidebarItems } from "../ui/src/lib/grouping";
import type { OrchestratorState, SessionState } from "../ui/src/lib/types";

function makeOrch(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    id: "orch-test",
    path: "/home/user/wt/myrepo/orch-test",
    workspace: "myrepo",
    startedAt: "2026-04-15T00:00:00Z",
    currentWave: 1,
    totalWaves: 2,
    waves: [],
    workers: {},
    dashboard: null,
    briefings: {},
    attention: [],
    ...overrides,
  };
}

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
    cwd: "/home/user/wt/myrepo/orch-test-CTL-1",
    gitBranch: null,
    ...overrides,
  };
}

describe("repoKey", () => {
  it("extracts last two path segments", () => {
    expect(repoKey("/home/user/wt/myrepo/orch-test")).toBe("myrepo/orch-test");
  });

  it("handles trailing slash", () => {
    expect(repoKey("/home/user/wt/myrepo/orch-test/")).toBe("myrepo/orch-test");
  });

  it("returns 'other' for null", () => {
    expect(repoKey(null)).toBe("other");
  });

  it("returns 'other' for empty string", () => {
    expect(repoKey("")).toBe("other");
  });

  it("handles single segment", () => {
    expect(repoKey("myrepo")).toBe("myrepo");
  });

  it("handles two segments", () => {
    expect(repoKey("myrepo/orch-test")).toBe("myrepo/orch-test");
  });
});

describe("groupSidebarItems", () => {
  it("returns single group in flat mode", () => {
    const orchs = [makeOrch()];
    const active = [makeSession()];
    const dead: SessionState[] = [];

    const groups = groupSidebarItems(orchs, active, dead, "flat");

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("__flat__");
    expect(groups[0].orchestrators).toEqual(orchs);
    expect(groups[0].activeSessions).toEqual(active);
  });

  it("groups by workspace in repo mode", () => {
    const orch1 = makeOrch({ id: "orch-a", workspace: "catalyst", path: "/wt/catalyst/orch-a" });
    const orch2 = makeOrch({ id: "orch-b", workspace: "bravo", path: "/wt/bravo/orch-b" });
    const sess1 = makeSession({ sessionId: "s1", cwd: "/wt/catalyst/orch-a-CTL-1" });
    const sess2 = makeSession({ sessionId: "s2", cwd: "/wt/bravo/orch-b-CTL-2" });

    const groups = groupSidebarItems([orch1, orch2], [sess1, sess2], [], "repo");

    expect(groups).toHaveLength(2);
    const keys = groups.map((g) => g.key);
    expect(keys).toContain("bravo");
    expect(keys).toContain("catalyst");

    const catalystGroup = groups.find((g) => g.key === "catalyst")!;
    expect(catalystGroup.orchestrators).toHaveLength(1);
    expect(catalystGroup.orchestrators[0].id).toBe("orch-a");
    expect(catalystGroup.activeSessions).toHaveLength(1);
  });

  it("puts null-cwd sessions in 'other' group", () => {
    const sess = makeSession({ cwd: null });
    const groups = groupSidebarItems([], [sess], [], "repo");

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("other");
    expect(groups[0].activeSessions).toHaveLength(1);
  });

  it("sorts groups alphabetically with 'other' last", () => {
    const sess1 = makeSession({ sessionId: "s1", cwd: "/wt/zeta/worker" });
    const sess2 = makeSession({ sessionId: "s2", cwd: "/wt/alpha/worker" });
    const sess3 = makeSession({ sessionId: "s3", cwd: null });

    const groups = groupSidebarItems([], [sess1, sess2, sess3], [], "repo");

    expect(groups.map((g) => g.key)).toEqual(["alpha/worker", "zeta/worker", "other"]);
  });

  it("uses path-based key for default workspace orchestrators", () => {
    const orch = makeOrch({
      workspace: "default",
      path: "/home/user/wt/standalone/orch-test",
    });

    const groups = groupSidebarItems([orch], [], [], "repo");

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("standalone/orch-test");
  });

  it("includes recentDead sessions in their groups", () => {
    const dead = makeSession({
      sessionId: "dead1",
      alive: false,
      status: "done",
      cwd: "/wt/myrepo/orch-test",
    });

    const groups = groupSidebarItems([], [], [dead], "repo");

    expect(groups).toHaveLength(1);
    expect(groups[0].recentDead).toHaveLength(1);
  });
});
