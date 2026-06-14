// CTL-884 (BFF2): the read-model assembles a node-aware CLUSTER VIEW — every
// ticket grouped by the owner_host the broker projects into the durable cache
// (BFF11), the GitHub PR-state join layered on per ticket, and a per-host
// live/degraded/offline liveness overlay sourced from readClusterHeartbeats.
//
// The single-host case (hosts.json absent or length 1) MUST be an exact identity
// no-op: the same tickets, one node, zero added latency, no live attachment or
// heartbeat-transport hop.
//
// assembleClusterView is pure + fully injectable (board, ownerHostById, hosts,
// heartbeats, now) so these scenarios are unit-testable without a real DB, event
// log, or subprocess.

import { describe, it, expect, mock } from "bun:test";
import { assembleClusterView, createClusterEntity } from "../lib/cluster-view.mjs";
import { createReadModel } from "../lib/read-model.mjs";
import type { BoardPayload, BoardTicket } from "../lib/board-data.mjs";
import type { ClusterView } from "../lib/cluster-view.mjs";

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
    // CTL-901 (HOME3): per-row duration anchors — null in this fixture (the
    // cluster view does not read them).
    heldSince: null,
    currentPhaseSince: null,
    attention: null,
    attentionSince: null,
    // BFF10 stamps host:{name,id} + generation on every BoardTicket. The cluster
    // view groups off ownerHostById (the durable fence projection), not this per-
    // entity host, so these default null (single-host identity no-op) and tests
    // override ownerHostById directly.
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

describe("assembleClusterView — Scenario: groups cluster work by owning node", () => {
  it("groups tickets by owner_host read from the durable cache (not a live fetch)", () => {
    const b = board([ticket("CTL-1", { pr: 101 }), ticket("CTL-2"), ticket("CTL-3", { pr: 103 })]);
    const ownerHostById = {
      "CTL-1": "mini",
      "CTL-2": "studio",
      "CTL-3": "mini",
    };
    const view = assembleClusterView({
      board: b,
      ownerHostById,
      hosts: ["mini", "studio"],
      heartbeats: { mini: at(1_000), studio: at(2_000) },
      now,
    });
    // one group per node, each carrying its owned tickets
    const mini = view.nodes.find((n) => n.host === "mini");
    const studio = view.nodes.find((n) => n.host === "studio");
    expect(mini?.tickets.map((t) => t.id)).toEqual(["CTL-1", "CTL-3"]);
    expect(studio?.tickets.map((t) => t.id)).toEqual(["CTL-2"]);
  });

  it("layers the GitHub PR-state join on per ticket (the board pr number carries through)", () => {
    const b = board([ticket("CTL-1", { pr: 101 }), ticket("CTL-2", { pr: null })]);
    const view = assembleClusterView({
      board: b,
      ownerHostById: { "CTL-1": "mini", "CTL-2": "mini" },
      hosts: ["mini"],
      heartbeats: { mini: at(1_000) },
      now,
    });
    const tickets = view.nodes[0].tickets;
    expect(tickets.find((t) => t.id === "CTL-1")?.pr).toBe(101);
    expect(tickets.find((t) => t.id === "CTL-2")?.pr).toBeNull();
  });

  it("a ticket with no fence owner_host falls into the 'unassigned' group, never dropped", () => {
    // multi-host roster: an un-fenced ticket has a real "other" owner it could
    // belong to, so it lands in the synthetic unassigned bucket (the single-host
    // identity no-op attributes everything to the one host instead).
    const b = board([ticket("CTL-1"), ticket("CTL-9")]);
    const view = assembleClusterView({
      board: b,
      ownerHostById: { "CTL-1": "mini" }, // CTL-9 has no fence
      hosts: ["mini", "studio"],
      heartbeats: { mini: at(1_000), studio: at(1_000) },
      now,
    });
    const unassigned = view.nodes.find((n) => n.host === null);
    expect(unassigned?.tickets.map((t) => t.id)).toEqual(["CTL-9"]);
    // every input ticket is represented exactly once across all groups
    const allIds = view.nodes.flatMap((n) => n.tickets.map((t) => t.id)).sort();
    expect(allIds).toEqual(["CTL-1", "CTL-9"]);
  });

  it("attributes each ticket's ownerHost on the ticket itself for node-aware UI", () => {
    const b = board([ticket("CTL-1")]);
    const view = assembleClusterView({
      board: b,
      ownerHostById: { "CTL-1": "studio" },
      hosts: ["mini", "studio"],
      heartbeats: { mini: at(1_000), studio: at(1_000) },
      now,
    });
    const t = view.nodes.find((n) => n.host === "studio")?.tickets[0];
    expect(t?.ownerHost).toBe("studio");
  });
});

describe("assembleClusterView — Scenario: node liveness overlay (live/degraded/offline)", () => {
  it("marks each host live/degraded/offline against the interval + grace", () => {
    const b = board([ticket("CTL-1"), ticket("CTL-2"), ticket("CTL-3")]);
    const view = assembleClusterView({
      board: b,
      ownerHostById: { "CTL-1": "mini", "CTL-2": "studio", "CTL-3": "laptop" },
      hosts: ["mini", "studio", "laptop"],
      heartbeats: {
        mini: at(5_000), // within interval → live
        studio: at(3 * 60_000), // past interval, inside 5min grace → degraded
        laptop: at(20 * 60_000), // past grace → offline
      },
      now,
    });
    expect(view.nodes.find((n) => n.host === "mini")?.status).toBe("live");
    expect(view.nodes.find((n) => n.host === "studio")?.status).toBe("degraded");
    expect(view.nodes.find((n) => n.host === "laptop")?.status).toBe("offline");
  });

  it("consumes a readClusterHeartbeats-shaped reader when heartbeats are not pre-supplied", () => {
    const b = board([ticket("CTL-1")]);
    const heartbeatReader = mock((_opts: { logPath?: string }) => ({ mini: at(2_000) }));
    const view = assembleClusterView({
      board: b,
      ownerHostById: { "CTL-1": "mini" },
      hosts: ["mini"],
      heartbeatReader, // injected recovery.readClusterHeartbeats stand-in
      logPath: "/tmp/fake-events.jsonl",
      now,
    });
    expect(heartbeatReader).toHaveBeenCalledTimes(1);
    // the reader is called with the local logPath (single-node: ONE local log)
    expect(heartbeatReader.mock.calls[0][0]).toEqual({ logPath: "/tmp/fake-events.jsonl" });
    expect(view.nodes[0].status).toBe("live");
  });

  it("the unassigned bucket carries no liveness (it is not a real host)", () => {
    const b = board([ticket("CTL-9")]);
    const view = assembleClusterView({
      board: b,
      ownerHostById: {},
      hosts: ["mini", "studio"], // multi-host so the unassigned bucket exists
      heartbeats: { mini: at(1_000), studio: at(1_000) },
      now,
    });
    const unassigned = view.nodes.find((n) => n.host === null);
    expect(unassigned?.status).toBeNull();
  });
});

describe("assembleClusterView — Scenario: single-host is an exact identity no-op", () => {
  it("hosts.json length 1 → one node carrying ALL board tickets, in board order", () => {
    const tickets = [ticket("CTL-1", { pr: 101 }), ticket("CTL-2"), ticket("CTL-3", { pr: 103 })];
    const b = board(tickets);
    const view = assembleClusterView({
      board: b,
      // single-node deployment: every ticket the local daemon claimed is owned
      // by the one host (or carries no fence yet, which still belongs to it).
      ownerHostById: { "CTL-1": "mini", "CTL-2": "mini", "CTL-3": "mini" },
      hosts: ["mini"],
      heartbeats: { mini: at(1_000) },
      now,
    });
    expect(view.singleHost).toBe(true);
    expect(view.nodes).toHaveLength(1);
    // identity: the node's ticket list is exactly the board's ticket list in
    // board order (same ids, same order), additively node-attributed.
    expect(view.nodes[0].tickets.map((t) => t.id)).toEqual(b.tickets.map((t) => t.id));
    // every original board field survives untouched (the ADDITIVE-only contract)
    view.nodes[0].tickets.forEach((t, i) => {
      const { ownerHost, ...rest } = t;
      expect(rest).toEqual(b.tickets[i]);
      expect(ownerHost).toBe("mini");
    });
  });

  it("hosts.json absent (roster falls back to [localHost]) is treated as single-host", () => {
    const b = board([ticket("CTL-1"), ticket("CTL-2")]);
    const view = assembleClusterView({
      board: b,
      ownerHostById: {}, // no fences observed yet on a fresh single node
      hosts: ["mini"], // getClusterHosts() returns [getHostName()] when hosts.json absent
      heartbeats: { mini: at(1_000) },
      now,
    });
    expect(view.singleHost).toBe(true);
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0].host).toBe("mini");
    // even un-fenced tickets attribute to the single host (no orphan bucket on a 1-node fleet)
    expect(view.nodes[0].tickets.map((t) => t.id)).toEqual(["CTL-1", "CTL-2"]);
  });

  it("single-host never reads heartbeats for a peer it cannot reach (one local-log read max)", () => {
    const b = board([ticket("CTL-1")]);
    const heartbeatReader = mock(() => ({ mini: at(1_000) }));
    assembleClusterView({
      board: b,
      ownerHostById: { "CTL-1": "mini" },
      hosts: ["mini"],
      heartbeatReader,
      now,
    });
    // exactly one read of the single local event log — no per-peer fan-out
    expect(heartbeatReader).toHaveBeenCalledTimes(1);
  });

  it("the single-host node still carries its own liveness from the local heartbeat", () => {
    const b = board([ticket("CTL-1")]);
    const live = assembleClusterView({
      board: b,
      ownerHostById: { "CTL-1": "mini" },
      hosts: ["mini"],
      heartbeats: { mini: at(2_000) },
      now,
    });
    expect(live.nodes[0].status).toBe("live");
    // a stale local heartbeat surfaces the local daemon as offline (still single-host)
    const stale = assembleClusterView({
      board: b,
      ownerHostById: { "CTL-1": "mini" },
      hosts: ["mini"],
      heartbeats: { mini: at(20 * 60_000) },
      now,
    });
    expect(stale.singleHost).toBe(true);
    expect(stale.nodes[0].status).toBe("offline");
  });
});

describe("createClusterEntity — read-model integration (Scenario: the read-model assembles the cluster view)", () => {
  it("registers as a read-model entity projecting off the SAME board snapshot (no second assemble)", async () => {
    let assembleCalls = 0;
    const snapshot = board([ticket("CTL-1", { pr: 101 }), ticket("CTL-2")]);
    const cluster = createClusterEntity({
      ownerHostProvider: () => Promise.resolve({ "CTL-1": "mini", "CTL-2": "mini" }),
      rosterProvider: () => ["mini"],
      heartbeatReader: () => ({ mini: new Date(now - 1000).toISOString() }),
      now: () => now,
    });
    const m = createReadModel({
      assemble: () => {
        assembleCalls++;
        return Promise.resolve(snapshot);
      },
      onDemandTtlMs: 5000,
      entities: {
        board: { project: (s) => s },
        cluster,
      },
    });
    const view = (await m.getEntity("cluster")) as ClusterView;
    expect(view.singleHost).toBe(true);
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0].host).toBe("mini");
    expect(view.nodes[0].status).toBe("live");
    expect(view.nodes[0].tickets.map((t) => t.id)).toEqual(["CTL-1", "CTL-2"]);
    // the cluster entity projected off the ONE board assemble — no re-assemble
    expect(assembleCalls).toBe(1);
    m.stop();
  });

  it("groups by owner_host on a multi-host roster via injected deps", async () => {
    const snapshot = board([ticket("CTL-1"), ticket("CTL-2")]);
    const cluster = createClusterEntity({
      ownerHostProvider: () => Promise.resolve({ "CTL-1": "mini", "CTL-2": "studio" }),
      rosterProvider: () => ["mini", "studio"],
      heartbeatReader: () => ({
        mini: new Date(now - 1000).toISOString(),
        studio: new Date(now - 3 * 60_000).toISOString(),
      }),
      now: () => now,
    });
    const m = createReadModel({
      assemble: () => Promise.resolve(snapshot),
      onDemandTtlMs: 5000,
      entities: { board: { project: (s) => s }, cluster },
    });
    const view = (await m.getEntity("cluster")) as ClusterView;
    expect(view.singleHost).toBe(false);
    expect(view.nodes.find((n) => n.host === "mini")?.status).toBe("live");
    expect(view.nodes.find((n) => n.host === "studio")?.status).toBe("degraded");
    m.stop();
  });

  it("degrades to a single-host no-op when the execution-core deps are unavailable (no throw)", async () => {
    // No injected deps → the entity lazily imports config/recovery; in the test
    // sandbox those may resolve to empty (roster []) which is the safe no-op. The
    // contract: it never throws and yields a coherent single-host view.
    const snapshot = board([ticket("CTL-1")]);
    const cluster = createClusterEntity({
      // override the heartbeat reader so we don't hit the real event log, but let
      // the roster fall back to the lazy import (which is fine if it yields []).
      heartbeatReader: () => ({}),
      rosterProvider: () => [],
      now: () => now,
    });
    const m = createReadModel({
      assemble: () => Promise.resolve(snapshot),
      onDemandTtlMs: 5000,
      entities: { board: { project: (s) => s }, cluster },
    });
    const view = (await m.getEntity("cluster")) as ClusterView;
    expect(view.singleHost).toBe(true);
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0].host).toBeNull();
    expect(view.nodes[0].tickets.map((t) => t.id)).toEqual(["CTL-1"]);
    m.stop();
  });
});
