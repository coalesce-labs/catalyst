// cluster-capacity.test.ts — CTL-1092 Phase 3. Pure cluster aggregation + host-labeled
// slot model. Run: cd ui && bun test src/components/queue/cluster-capacity.test.ts

import { describe, it, expect } from "bun:test";
import type { BoardWorker } from "../../board/types";
import {
  aggregateClusterCapacity,
  assignClusterSlots,
  filterSlotsByNode,
  nodeCapacity,
  isClusterMode,
} from "./cluster-capacity";

type SignalNode = { host: string; status: string; maxParallel?: number; inFlightCount?: number; freeSlots?: number; tickets?: string[] };

function liveNode(host: string, maxParallel: number, inFlight: number, tickets?: string[]): SignalNode {
  return { host, status: "live", maxParallel, inFlightCount: inFlight, freeSlots: maxParallel - inFlight, tickets };
}

function offlineNode(host: string): SignalNode {
  return { host, status: "offline", maxParallel: 0, inFlightCount: 0, freeSlots: 0 };
}

function worker(name: string, hostName: string, ticket: string, startedAt = 1000): BoardWorker {
  return {
    name,
    ticket,
    tickets: [ticket],
    phase: "implement",
    status: "running",
    activeState: "active",
    working: true,
    lastActiveMs: 100,
    repo: "catalyst",
    team: "CTL",
    runtimeMs: 1000,
    costUSD: null,
    host: { name: hostName, id: "abc" },
    startedAt,
  };
}

// ─── aggregateClusterCapacity ────────────────────────────────────────────────

describe("aggregateClusterCapacity (CTL-1092)", () => {
  it("sums maxParallel/inFlight/freeSlots across live nodes (ticket example: 2 of 14, 12 open)", () => {
    const nodes = [liveNode("mini", 6, 2), liveNode("laptop", 8, 0)];
    expect(aggregateClusterCapacity(nodes)).toEqual({ maxParallel: 14, inFlight: 2, freeSlots: 12 });
  });

  it("excludes offline nodes' capacity from the cluster total", () => {
    const nodes = [liveNode("mini", 6, 2), offlineNode("laptop")];
    expect(aggregateClusterCapacity(nodes)).toEqual({ maxParallel: 6, inFlight: 2, freeSlots: 4 });
  });

  it("returns zeros for an empty node list", () => {
    expect(aggregateClusterCapacity([])).toEqual({ maxParallel: 0, inFlight: 0, freeSlots: 0 });
  });

  it("returns zeros when all nodes are offline", () => {
    expect(aggregateClusterCapacity([offlineNode("mini"), offlineNode("laptop")])).toEqual({
      maxParallel: 0, inFlight: 0, freeSlots: 0,
    });
  });
});

// ─── assignClusterSlots ──────────────────────────────────────────────────────

describe("assignClusterSlots (CTL-1092)", () => {
  it("labels each occupied slot with its host; local workers get full refs, remote get ticket-only", () => {
    const localW = worker("w1", "mini", "CTL-1");
    const out = assignClusterSlots({
      nodes: [
        liveNode("mini", 6, 1),
        liveNode("laptop", 8, 1, ["CTL-9"]),
      ],
      localHost: "mini",
      localWorkers: [localW],
    });
    const miniOccupied = out.find((s) => s.host === "mini" && s.occupied);
    const laptopOccupied = out.find((s) => s.host === "laptop" && s.occupied);
    expect(miniOccupied?.worker?.tickets?.[0]).toBe("CTL-1");
    expect(laptopOccupied?.ticket).toBe("CTL-9");
    expect(out.filter((s) => s.occupied).length).toBe(2);
  });

  it("empty nodes produce no occupied slots", () => {
    const out = assignClusterSlots({
      nodes: [liveNode("mini", 3, 0), liveNode("laptop", 3, 0)],
      localHost: "mini",
      localWorkers: [],
    });
    expect(out.filter((s) => s.occupied).length).toBe(0);
    expect(out.length).toBe(6); // 3 + 3 empty slots
  });

  it("unions self-host heartbeat tickets the worker list cannot see (CTL-1588: SDK executors)", () => {
    // SDK/codex-exec executor children carry no bg-job id, so localWorkers can be
    // EMPTY while the node's own heartbeat reports genuinely running tickets.
    const out = assignClusterSlots({
      nodes: [liveNode("mini-2", 4, 2, ["CTL-1417", "CTL-1557"])],
      localHost: "mini-2",
      localWorkers: [],
    });
    const occupied = out.filter((s) => s.occupied);
    expect(occupied.map((s) => s.ticket)).toEqual(["CTL-1417", "CTL-1557"]);
    expect(out.length).toBe(4); // 2 occupied + 2 empty — deck agrees with the pill
  });

  it("dedupes heartbeat tickets already covered by a rich local worker (CTL-1588)", () => {
    const out = assignClusterSlots({
      nodes: [liveNode("mini", 4, 2, ["CTL-1", "CTL-2"])],
      localHost: "mini",
      localWorkers: [worker("w1", "mini", "CTL-1")],
    });
    const occupied = out.filter((s) => s.occupied);
    expect(occupied.length).toBe(2);
    expect(occupied[0]?.worker?.ticket).toBe("CTL-1");
    expect(occupied[1]?.ticket).toBe("CTL-2");
    expect(out.length).toBe(4);
  });

  it("marks unioned heartbeat tickets beyond capacity as over (CTL-1588)", () => {
    const out = assignClusterSlots({
      nodes: [liveNode("mini", 1, 2, ["CTL-1", "CTL-2"])],
      localHost: "mini",
      localWorkers: [worker("w1", "mini", "CTL-1")],
    });
    const over = out.filter((s) => s.over);
    expect(over.length).toBe(1);
    expect(over[0]?.ticket).toBe("CTL-2");
  });

  it("caps heartbeat-only additions by activeCount so worker turnover never double-counts (CTL-1588)", () => {
    // Stale cached heartbeat still names CTL-OLD; a fresh local worker already
    // replaced it with CTL-NEW. activeCount (1) is authoritative — no phantom
    // second slot, no phantom OVER card.
    const out = assignClusterSlots({
      nodes: [{ host: "mini", status: "live", maxParallel: 4, inFlightCount: 1, activeCount: 1, freeSlots: 3, tickets: ["CTL-OLD"] }],
      localHost: "mini",
      localWorkers: [worker("w1", "mini", "CTL-NEW")],
    });
    const occupied = out.filter((s) => s.occupied);
    expect(occupied.length).toBe(1);
    expect(occupied[0]?.worker?.ticket).toBe("CTL-NEW");
    expect(out.filter((s) => s.over).length).toBe(0);
  });

  it("offline node produces no slot cards", () => {
    const out = assignClusterSlots({
      nodes: [liveNode("mini", 3, 1), offlineNode("laptop")],
      localHost: "mini",
      localWorkers: [worker("w1", "mini", "CTL-1")],
    });
    expect(out.filter((s) => s.host === "laptop").length).toBe(0);
    expect(out.filter((s) => s.host === "mini").length).toBe(3);
  });
});

// ─── filterSlotsByNode ───────────────────────────────────────────────────────

describe("filterSlotsByNode (CTL-1092)", () => {
  it("returns only slots for the given host", () => {
    const out = assignClusterSlots({
      nodes: [liveNode("mini", 2, 1), liveNode("laptop", 2, 0)],
      localHost: "mini",
      localWorkers: [worker("w1", "mini", "CTL-1")],
    });
    const miniSlots = filterSlotsByNode(out, "mini");
    expect(miniSlots.every((s) => s.host === "mini")).toBe(true);
    expect(miniSlots.length).toBe(2);
  });

  it("returns empty array for a host not in the slots", () => {
    const out = assignClusterSlots({
      nodes: [liveNode("mini", 2, 0)],
      localHost: "mini",
      localWorkers: [],
    });
    expect(filterSlotsByNode(out, "laptop")).toEqual([]);
  });

  it("offline node tab shows zero slots (not dead workers)", () => {
    const out = assignClusterSlots({
      nodes: [liveNode("mini", 2, 0), offlineNode("laptop")],
      localHost: "mini",
      localWorkers: [],
    });
    expect(filterSlotsByNode(out, "laptop")).toEqual([]);
  });
});

// ─── nodeCapacity ────────────────────────────────────────────────────────────

describe("nodeCapacity (CTL-1092)", () => {
  it("returns capacity for a live node", () => {
    const nodes = [liveNode("mini", 6, 2), liveNode("laptop", 8, 0)];
    expect(nodeCapacity(nodes, "mini")).toEqual({ maxParallel: 6, inFlight: 2, freeSlots: 4 });
  });

  it("returns zero capacity for an offline node", () => {
    expect(nodeCapacity([offlineNode("laptop")], "laptop")).toEqual({
      maxParallel: 0, inFlight: 0, freeSlots: 0,
    });
  });

  it("returns zero capacity for a host not in the list", () => {
    expect(nodeCapacity([liveNode("mini", 6, 0)], "laptop")).toEqual({
      maxParallel: 0, inFlight: 0, freeSlots: 0,
    });
  });
});

// ─── isClusterMode ───────────────────────────────────────────────────────────

describe("isClusterMode (CTL-1092)", () => {
  it("is false for a single-host signal", () => {
    expect(isClusterMode({ singleHost: true, nodes: [{ host: "mini", status: "live" }] })).toBe(false);
  });

  it("is true when singleHost is false and roster > 1 host", () => {
    expect(isClusterMode({ singleHost: false, nodes: [{ host: "mini" }, { host: "laptop" }] })).toBe(true);
  });

  it("is false when singleHost is false but only 1 node", () => {
    expect(isClusterMode({ singleHost: false, nodes: [{ host: "mini" }] })).toBe(false);
  });

  it("is false for null/undefined signal", () => {
    expect(isClusterMode(null)).toBe(false);
    expect(isClusterMode(undefined)).toBe(false);
  });
});
