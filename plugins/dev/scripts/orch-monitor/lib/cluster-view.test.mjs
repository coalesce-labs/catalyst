// cluster-view.test.mjs — CTL-1095. assembleClusterView drain display.
//
// Run: cd plugins/dev/scripts/orch-monitor && bun test lib/cluster-view.test.mjs

import { describe, test, expect } from "bun:test";
import { assembleClusterView } from "./cluster-view.mjs";

const board = { generatedAt: "2026-06-13T00:00:00Z", tickets: [] };
const fakeHeartbeats = { mini: "2026-06-13T00:00:00Z", laptop: "2026-06-13T00:00:00Z" };
const ROSTER = ["mini", "laptop"];
const NOW = new Date("2026-06-13T00:00:10Z").getTime();

describe("assembleClusterView — drain display (CTL-1095)", () => {
  test("cluster view marks a host draining with inFlightCount", () => {
    const view = assembleClusterView({
      board,
      hosts: ROSTER,
      heartbeats: fakeHeartbeats,
      now: NOW,
      drainReader: (host) =>
        host === "laptop"
          ? { draining: true, inFlightCount: 2 }
          : { draining: false, inFlightCount: 0 },
    });
    const laptop = view.nodes.find((n) => n.host === "laptop");
    expect(laptop.draining).toBe(true);
    expect(laptop.inFlightCount).toBe(2);
  });

  test("non-draining host has draining:false and inFlightCount:0", () => {
    const view = assembleClusterView({
      board,
      hosts: ROSTER,
      heartbeats: fakeHeartbeats,
      now: NOW,
      drainReader: (host) =>
        host === "laptop"
          ? { draining: true, inFlightCount: 2 }
          : { draining: false, inFlightCount: 0 },
    });
    const mini = view.nodes.find((n) => n.host === "mini");
    expect(mini.draining).toBe(false);
    expect(mini.inFlightCount).toBe(0);
  });

  test("no drainReader → draining:false, inFlightCount:0 (fail-open)", () => {
    const view = assembleClusterView({
      board,
      hosts: ["mini"],
      heartbeats: { mini: "2026-06-13T00:00:00Z" },
      now: NOW,
    });
    const node = view.nodes[0];
    expect(node.draining).toBe(false);
    expect(node.inFlightCount).toBe(0);
  });

  test("single-host: drain state surfaced on the one node", () => {
    const view = assembleClusterView({
      board,
      hosts: ["mini"],
      heartbeats: { mini: "2026-06-13T00:00:00Z" },
      now: NOW,
      drainReader: () => ({ draining: true, inFlightCount: 3 }),
    });
    expect(view.singleHost).toBe(true);
    expect(view.nodes[0].draining).toBe(true);
    expect(view.nodes[0].inFlightCount).toBe(3);
  });

  test("drainReader throws → draining:false, inFlightCount:0 (fail-open)", () => {
    const view = assembleClusterView({
      board,
      hosts: ["mini"],
      heartbeats: { mini: "2026-06-13T00:00:00Z" },
      now: NOW,
      drainReader: () => { throw new Error("read failed"); },
    });
    const node = view.nodes[0];
    expect(node.draining).toBe(false);
    expect(node.inFlightCount).toBe(0);
  });
});

describe("assembleClusterView — cross-host anchor peers / shadow nodes (CTL-1251)", () => {
  test("a live anchor peer NOT in the roster is surfaced as a shadow node (0 tickets)", () => {
    const view = assembleClusterView({
      board: { generatedAt: "2026-06-13T00:00:00Z", tickets: [{ id: "T1" }] },
      ownerHostById: { T1: "mini" }, // T1 fenced to mini → no unassigned bucket
      hosts: ["mini"], // committed roster is single-host
      heartbeats: { mini: "2026-06-13T00:00:00Z", "mini-2": "2026-06-13T00:00:05Z" },
      now: NOW,
    });
    // roster ∪ live anchor peers = {mini, mini-2} → multi-host view
    expect(view.singleHost).toBe(false);
    const hosts = view.nodes.map((n) => n.host).sort();
    expect(hosts).toEqual(["mini", "mini-2"]);
    const shadow = view.nodes.find((n) => n.host === "mini-2");
    expect(shadow.status).toBe("live");
    expect(shadow.tickets).toEqual([]); // owns zero tickets — pure liveness
    expect(view.nodes.find((n) => n.host === "mini").tickets).toHaveLength(1);
  });

  test("a stale anchor attachment (offline, not in roster) is DROPPED", () => {
    const view = assembleClusterView({
      board,
      hosts: ["mini"],
      heartbeats: {
        mini: "2026-06-13T00:00:00Z",
        "decommissioned": "2026-06-12T00:00:00Z", // >24h stale → offline
      },
      now: NOW,
    });
    expect(view.singleHost).toBe(true);
    expect(view.nodes.map((n) => n.host)).toEqual(["mini"]);
  });

  test("a roster host that is offline is STILL shown (roster always displayed)", () => {
    const view = assembleClusterView({
      board,
      hosts: ["mini", "laptop"],
      heartbeats: { mini: "2026-06-13T00:00:00Z" }, // laptop never heard → offline
      now: NOW,
    });
    expect(view.singleHost).toBe(false);
    const laptop = view.nodes.find((n) => n.host === "laptop");
    expect(laptop.status).toBe("offline");
  });

  test("single-host identity no-op preserved when no other host publishes", () => {
    const view = assembleClusterView({
      board: { generatedAt: "2026-06-13T00:00:00Z", tickets: [{ id: "T1" }, { id: "T2" }] },
      hosts: ["mini"],
      heartbeats: { mini: "2026-06-13T00:00:00Z" },
      now: NOW,
    });
    expect(view.singleHost).toBe(true);
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0].tickets).toHaveLength(2); // all board tickets on the one host
  });
});
