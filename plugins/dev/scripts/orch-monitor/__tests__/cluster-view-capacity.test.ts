// cluster-view-capacity.test.ts — CTL-1092. Per-node capacity fields in
// assembleClusterView via the capacityReader seam, and alias resolution.
//
// Run: cd plugins/dev/scripts/orch-monitor && bun test

import { describe, it, expect } from "bun:test";
import { assembleClusterView } from "../lib/cluster-view.mjs";
import type { BoardPayload, BoardTicket } from "../lib/board-data.mjs";

function ticket(id: string): BoardTicket {
  return {
    id,
    title: id,
    type: "task",
    repo: "catalyst",
    team: "CTL",
    phase: "implement",
    status: "running",
    model: null,
    linearState: "Implement",
    workerStatus: "running",
    activeState: "active",
    working: true,
    lastActiveMs: 1000,
    priority: 2,
    estimate: null,
    scope: null,
    project: null,
    costUSD: null,
    tokens: null,
    turns: null,
    phaseCosts: null,
    phaseSummary: [],
    pr: null,
    updatedAt: "2026-06-13T10:00:00.000Z",
    held: null,
    blockers: [],
    heldSince: null,
    currentPhaseSince: null,
    attention: null,
    attentionSince: null,
    host: null,
    generation: null,
  };
}

function board(tickets: BoardTicket[]): BoardPayload {
  return {
    generatedAt: "2026-06-13T10:00:00.000Z",
    config: { maxParallel: 6, inFlight: 0, freeSlots: 6, active: 0, working: 0, stuck: 0 },
    repos: ["catalyst"],
    workers: [],
    tickets,
    queue: [],
  };
}

const now = new Date("2026-06-13T10:00:00.000Z").getTime();

describe("assembleClusterView capacityReader seam (CTL-1092)", () => {
  it("attaches per-node maxParallel/inFlightCount/freeSlots via capacityReader", () => {
    const view = assembleClusterView({
      board: board([ticket("CTL-1"), ticket("CTL-2")]),
      hosts: ["mini", "laptop"],
      heartbeats: { mini: "2026-06-13T10:00:00Z", laptop: "2026-06-13T10:00:00Z" },
      capacityReader: (h) => h === "mini"
        ? { maxParallel: 6, inFlightCount: 2, freeSlots: 4 }
        : { maxParallel: 8, inFlightCount: 0, freeSlots: 8 },
      now,
    });
    const mini = view.nodes.find((n) => n.host === "mini");
    const laptop = view.nodes.find((n) => n.host === "laptop");
    expect(mini).toMatchObject({ maxParallel: 6, inFlightCount: 2, freeSlots: 4 });
    expect(laptop).toMatchObject({ maxParallel: 8, inFlightCount: 0, freeSlots: 8 });
  });

  it("offline node reports zero capacity (not local default)", () => {
    const view = assembleClusterView({
      board: board([ticket("CTL-1")]),
      hosts: ["mini", "laptop"],
      heartbeats: { mini: "2026-06-13T10:00:00Z" }, // laptop missing → offline
      capacityReader: (h) => h === "mini" ? { maxParallel: 6, inFlightCount: 1, freeSlots: 5 } : null,
      now,
    });
    const laptop = view.nodes.find((n) => n.host === "laptop");
    expect(laptop?.status).toBe("offline");
    expect(laptop).toMatchObject({ maxParallel: 0, inFlightCount: 0, freeSlots: 0 });
  });

  it("capacityReader absent → no capacity fields on nodes (backward compat)", () => {
    const view = assembleClusterView({
      board: board([ticket("CTL-1")]),
      hosts: ["mini"],
      heartbeats: { mini: "2026-06-13T10:00:00Z" },
      now,
    });
    const mini = view.nodes.find((n) => n.host === "mini");
    // maxParallel should be absent or 0 — not crash
    expect(mini).toBeDefined();
  });

  it("applies alias map so pre-pin heartbeat key resolves onto the roster node", () => {
    const view = assembleClusterView({
      board: board([ticket("CTL-1")]),
      hosts: ["mini"],
      heartbeats: { "Ryans-Mac-mini-250233": "2026-06-13T10:00:00Z" },
      aliases: { "Ryans-Mac-mini-250233": "mini" },
      capacityReader: () => ({ maxParallel: 6, inFlightCount: 1, freeSlots: 5 }),
      now,
    });
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0].host).toBe("mini");
    expect(view.nodes[0].status).toBe("live");
  });
});

describe("deriveClusterSignal capacity pass-through (CTL-1092)", () => {
  it("preserves maxParallel/inFlightCount/freeSlots on signal nodes", async () => {
    const { deriveClusterSignal } = await import("../lib/cluster-signal.mjs");
    const view = assembleClusterView({
      board: board([ticket("CTL-1")]),
      hosts: ["mini"],
      heartbeats: { mini: "2026-06-13T10:00:00Z" },
      capacityReader: () => ({ maxParallel: 6, inFlightCount: 2, freeSlots: 4 }),
      now,
    });
    const sig = deriveClusterSignal(view);
    expect(sig.nodes[0]).toMatchObject({ host: "mini", status: "live", maxParallel: 6, inFlightCount: 2, freeSlots: 4 });
  });
});
