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
