// CTL-919 / HUD1: the terminal HUD's typed door onto the shared read-model
// contract. Proves the HUD groups the cluster picture through the SAME contract
// the web client uses — single-host is an identity no-op (one group), and the
// HUD never re-invents the grouping vocabulary.
import { describe, it, expect } from "bun:test";
import { clusterViewForHud } from "../cli/lib/read-model-cluster";
import type { ReadModelPayload, HostRef } from "../lib/read-model-client";

function payload(overrides: Partial<ReadModelPayload> = {}): ReadModelPayload {
  return {
    generatedAt: "2026-06-08T00:00:00.000Z",
    config: { maxParallel: 6, inFlight: 0, freeSlots: 6, active: 0, working: 0, stuck: 0 },
    repos: [],
    workers: [],
    tickets: [],
    queue: [],
    ...overrides,
  };
}

const LOCAL: HostRef = { name: "mac-mini", id: "0123456789abcdef" };

describe("read-model-cluster (HUD door, CTL-919)", () => {
  it("single-host: one group attributed to the local node (identity no-op)", () => {
    const view = clusterViewForHud(payload(), LOCAL);
    expect(view.hosts.length).toBe(1);
    expect(view.hosts[0].host).toEqual(LOCAL);
  });

  it("a payload carrying its own host is attributed to THAT host, not the local fallback", () => {
    const view = clusterViewForHud(
      payload({ host: { name: "mac-studio", id: "ffffffffffffffff" } }),
      LOCAL,
    );
    expect(view.hosts.length).toBe(1);
    expect(view.hosts[0].host.name).toBe("mac-studio");
  });

  it("the HUD view is the SAME ClusterReadModel shape the web client renders", () => {
    const view = clusterViewForHud(payload(), LOCAL);
    // { generatedAt, hosts: [{ host:{name,id}, payload }] } — one contract shape.
    expect(typeof view.generatedAt).toBe("string");
    expect(Array.isArray(view.hosts)).toBe(true);
    expect(Array.isArray(view.hosts[0].payload.tickets)).toBe(true);
  });
});
