// cluster-signal.test.ts — CTL-898 / SHELL8 server-side projection guards.
//
// SHELL8 generalizes the footer's single daemon-health dot into a PER-NODE
// cluster-health indicator + a node filter. The footer only needs each node's
// {host, status} + the single-host flag — NOT the heavy per-node ticket lists the
// full ClusterView (BFF2) carries. `deriveClusterSignal` is the tiny projection
// that strips the ClusterView down to that footer/filter wire shape so the SSE
// frame stays small (the same "derived projection off the read-model" discipline
// nav-signal.mjs follows for the daemon dot).
//
// SINGLE-HOST IDENTITY NO-OP: a single-host ClusterView (roster absent or length
// 1) projects to exactly one node with `singleHost: true` — the footer collapses
// to today's single dot and the node filter is absent.
import { describe, it, expect } from "bun:test";
import { deriveClusterSignal } from "../lib/cluster-signal.mjs";
import { assembleClusterView } from "../lib/cluster-view.mjs";
import type { ClusterView } from "../lib/cluster-view.mjs";
import type { BoardPayload, BoardTicket } from "../lib/board-data.mjs";

function ticket(id: string, overrides: Partial<BoardTicket> = {}): BoardTicket {
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
    updatedAt: "2026-06-08T11:00:00.000Z",
    held: null,
    blockers: [],
    heldSince: null,
    currentPhaseSince: null,
    attention: null,
    attentionSince: null,
    host: null,
    generation: null,
    ...overrides,
  };
}

function board(tickets: BoardTicket[]): BoardPayload {
  return {
    generatedAt: "2026-06-08T12:00:00.000Z",
    config: { maxParallel: 6, inFlight: 0, freeSlots: 6, active: 0, working: 0, stuck: 0 },
    repos: ["catalyst"],
    workers: [],
    tickets,
    queue: [],
  };
}

const now = Date.parse("2026-06-08T12:00:00.000Z");
const at = (msAgo: number) => new Date(now - msAgo).toISOString();

describe("deriveClusterSignal — Scenario: Single node is an exact no-op", () => {
  it("projects a single-host ClusterView to one node with singleHost:true", () => {
    const view = assembleClusterView({
      board: board([ticket("CTL-1"), ticket("CTL-2")]),
      ownerHostById: { "CTL-1": "mini", "CTL-2": "mini" },
      hosts: ["mini"],
      heartbeats: { mini: at(2_000) },
      now,
    });
    const signal = deriveClusterSignal(view);
    expect(signal.singleHost).toBe(true);
    expect(signal.nodes).toHaveLength(1);
    expect(signal.nodes[0]).toMatchObject({ host: "mini", status: "live" });
    // CTL-1092: nodes now carry capacity fields (maxParallel/inFlightCount/freeSlots)
    // in addition to host + status; no ticket lists (footer/filter wire shape stays slim)
    expect(signal.nodes[0]).not.toHaveProperty("tickets");
    expect(signal.generatedAt).toBe(view.generatedAt);
  });

  it("an offline local daemon still projects single-host (the dot just goes red)", () => {
    const view = assembleClusterView({
      board: board([ticket("CTL-1")]),
      ownerHostById: { "CTL-1": "mini" },
      hosts: ["mini"],
      heartbeats: { mini: at(20 * 60_000) },
      now,
    });
    const signal = deriveClusterSignal(view);
    expect(signal.singleHost).toBe(true);
    expect(signal.nodes[0].status).toBe("offline");
  });
});

describe("deriveClusterSignal — Scenario: Multiple nodes show per-node health", () => {
  it("projects each roster host with its live/degraded/offline status + hostName", () => {
    const view = assembleClusterView({
      board: board([ticket("CTL-1"), ticket("CTL-2"), ticket("CTL-3")]),
      ownerHostById: { "CTL-1": "mini", "CTL-2": "studio", "CTL-3": "laptop" },
      hosts: ["mini", "studio", "laptop"],
      heartbeats: {
        mini: at(5_000), // live
        studio: at(3 * 60_000), // degraded
        laptop: at(20 * 60_000), // offline
      },
      now,
    });
    const signal = deriveClusterSignal(view);
    expect(signal.singleHost).toBe(false);
    // CTL-1092: nodes now carry capacity fields; use toMatchObject to check the
    // status-per-host contract without requiring an exact shape snapshot.
    expect(signal.nodes).toMatchObject([
      { host: "mini", status: "live" },
      { host: "studio", status: "degraded" },
      { host: "laptop", status: "offline" },
    ]);
  });

  it("drops the synthetic unassigned bucket (host:null) — not a real node to show", () => {
    const view = assembleClusterView({
      board: board([ticket("CTL-1"), ticket("CTL-9")]),
      ownerHostById: { "CTL-1": "mini" }, // CTL-9 unfenced → unassigned bucket
      hosts: ["mini", "studio"],
      heartbeats: { mini: at(1_000), studio: at(1_000) },
      now,
    });
    const signal = deriveClusterSignal(view);
    // mini + studio are real roster hosts; the host:null bucket is omitted
    expect(signal.nodes.map((n) => n.host)).toEqual(["mini", "studio"]);
  });
});

describe("deriveClusterSignal — defensive", () => {
  it("degrades a malformed/empty view to a coherent empty single-host signal", () => {
    const signal = deriveClusterSignal(null as unknown as ClusterView);
    expect(signal.singleHost).toBe(true);
    expect(signal.nodes).toEqual([]);
    expect(typeof signal.generatedAt).toBe("string");
  });
});
