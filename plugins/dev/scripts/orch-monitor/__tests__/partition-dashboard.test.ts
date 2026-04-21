import { describe, it, expect } from "bun:test";
import { partitionDashboard } from "../ui/src/lib/partition-dashboard";
import { RECENT_WINDOW_SECONDS } from "../ui/src/lib/session-filters";
import type {
  CollectedAttention,
  OrchestratorState,
  WorkerState,
} from "../ui/src/lib/types";

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

describe("partitionDashboard", () => {
  it("returns empty zones for empty input", () => {
    const { needsMe, shipping, recent } = partitionDashboard({
      orchestrators: [],
      attention: [],
      timeFilter: "active",
    });
    expect(needsMe).toHaveLength(0);
    expect(shipping).toHaveLength(0);
    expect(recent).toHaveLength(0);
  });

  it("passes attention through to needsMe preserving order", () => {
    const attention: CollectedAttention[] = [
      { orchId: "o1", ticket: "T-1", reason: "Worker died", severity: "error" },
      {
        orchId: "o2",
        ticket: "T-2",
        reason: "PR #5 BLOCKED",
        severity: "warning",
      },
    ];
    const { needsMe } = partitionDashboard({
      orchestrators: [],
      attention,
      timeFilter: "active",
    });
    expect(needsMe).toHaveLength(2);
    expect(needsMe[0].ticket).toBe("T-1");
    expect(needsMe[1].ticket).toBe("T-2");
  });

  it("splits active orchs into shipping and recent-done into recent under 'active'", () => {
    const active = makeOrch("active", [
      makeWorker({ ticket: "T-1", status: "in_progress", alive: true }),
    ]);
    const recentDone = makeOrch("recent", [
      makeWorker({
        ticket: "T-2",
        status: "done",
        alive: false,
        timeSinceUpdate: 1800,
      }),
    ]);
    const { shipping, recent } = partitionDashboard({
      orchestrators: [active, recentDone],
      attention: [],
      timeFilter: "active",
    });
    expect(shipping.map((o) => o.id)).toEqual(["active"]);
    expect(recent.map((o) => o.id)).toEqual(["recent"]);
  });

  it("orch with all workers done older than 7d is excluded from both shipping and recent", () => {
    const stale = makeOrch("stale", [
      makeWorker({
        ticket: "T-1",
        status: "done",
        alive: false,
        timeSinceUpdate: RECENT_WINDOW_SECONDS + 100,
      }),
    ]);
    const { shipping, recent } = partitionDashboard({
      orchestrators: [stale],
      attention: [],
      timeFilter: "active",
    });
    expect(shipping).toHaveLength(0);
    expect(recent).toHaveLength(0);
  });

  it("same orch with mixed failed+active workers lands in shipping (active wins)", () => {
    const mixed = makeOrch("mixed", [
      makeWorker({
        ticket: "T-1",
        status: "failed",
        alive: false,
        timeSinceUpdate: 60,
      }),
      makeWorker({
        ticket: "T-2",
        status: "in_progress",
        alive: true,
        timeSinceUpdate: 10,
      }),
    ]);
    const { shipping, recent } = partitionDashboard({
      orchestrators: [mixed],
      attention: [],
      timeFilter: "active",
    });
    expect(shipping).toHaveLength(1);
    expect(shipping[0].id).toBe("mixed");
    expect(recent).toHaveLength(0);
  });

  it("'all' filter puts every orch in shipping and recent empty", () => {
    const active = makeOrch("a", [
      makeWorker({ ticket: "T-1", status: "in_progress" }),
    ]);
    const done = makeOrch("b", [
      makeWorker({
        ticket: "T-2",
        status: "merged",
        alive: false,
        timeSinceUpdate: 1800,
      }),
    ]);
    const very_old = makeOrch("c", [
      makeWorker({
        ticket: "T-3",
        status: "done",
        alive: false,
        timeSinceUpdate: 30 * 86400,
      }),
    ]);
    const { shipping, recent } = partitionDashboard({
      orchestrators: [active, done, very_old],
      attention: [],
      timeFilter: "all",
    });
    expect(shipping).toHaveLength(3);
    expect(recent).toHaveLength(0);
  });

  it("filter change reshuffles zones (24h → 1h moves a 2h-old orch from shipping to recent)", () => {
    const orch = makeOrch("o1", [
      makeWorker({
        ticket: "T-1",
        status: "done",
        alive: false,
        timeSinceUpdate: 7200, // 2 hours
      }),
    ]);
    const under24h = partitionDashboard({
      orchestrators: [orch],
      attention: [],
      timeFilter: "24h",
    });
    expect(under24h.shipping).toHaveLength(1);
    expect(under24h.recent).toHaveLength(0);

    const under1h = partitionDashboard({
      orchestrators: [orch],
      attention: [],
      timeFilter: "1h",
    });
    expect(under1h.shipping).toHaveLength(0);
    expect(under1h.recent).toHaveLength(1);
  });

  it("acceptance-test scenario: 1 attention + 2 active + 3 recent-done under 'active' filter", () => {
    const orchs: OrchestratorState[] = [
      makeOrch("shipping-1", [
        makeWorker({ ticket: "T-a", status: "in_progress", alive: true }),
      ]),
      makeOrch("shipping-2", [
        makeWorker({ ticket: "T-b", status: "in_progress", alive: true }),
      ]),
      makeOrch("recent-1", [
        makeWorker({
          ticket: "T-c",
          status: "merged",
          alive: false,
          timeSinceUpdate: 3600,
        }),
      ]),
      makeOrch("recent-2", [
        makeWorker({
          ticket: "T-d",
          status: "merged",
          alive: false,
          timeSinceUpdate: 7200,
        }),
      ]),
      makeOrch("recent-3", [
        makeWorker({
          ticket: "T-e",
          status: "done",
          alive: false,
          timeSinceUpdate: 10800,
        }),
      ]),
    ];
    const attention: CollectedAttention[] = [
      {
        orchId: "shipping-1",
        ticket: "T-a",
        reason: "Worker died",
        severity: "error",
      },
    ];
    const { needsMe, shipping, recent } = partitionDashboard({
      orchestrators: orchs,
      attention,
      timeFilter: "active",
    });
    expect(needsMe).toHaveLength(1);
    expect(shipping).toHaveLength(2);
    expect(recent).toHaveLength(3);
  });
});
