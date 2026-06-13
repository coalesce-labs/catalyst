// governance-strip-kit.test.ts — CTL-1104 Phase 3: pure logic for GovernanceModesStrip.
// All functions are pure (no React); mirrors service-health-kit.test.ts pattern.

import { describe, it, expect } from "bun:test";
import {
  buildGovernanceRows,
  type GovernanceRow,
} from "./governance-strip-kit";
import type { ClusterGovernanceNode } from "@/lib/governance-model";

const MODES = {
  beliefsShadow: true,
  diagnostician: false,
  intentsEnforce: false,
  advanceShadowSummary: false,
  stallJanitor: { mode: "enforce" },
  watchdog: { mode: "shadow" },
  unstuckSweep: { mode: "off" },
};

function node(partial: Partial<ClusterGovernanceNode> & { host: string }): ClusterGovernanceNode {
  return {
    governance: MODES,
    reportedAt: "2026-06-13T12:00:00.000Z",
    ageMs: 5_000,
    status: "live",
    ...partial,
  };
}

describe("buildGovernanceRows — basic projection", () => {
  it("returns one row per node in roster order", () => {
    const nodes = [node({ host: "host-A" }), node({ host: "host-B" })];
    const rows = buildGovernanceRows(nodes);
    expect(rows).toHaveLength(2);
    expect(rows[0].host).toBe("host-A");
    expect(rows[1].host).toBe("host-B");
  });

  it("single-host signal → one row", () => {
    const rows = buildGovernanceRows([node({ host: "host-A" })]);
    expect(rows).toHaveLength(1);
  });

  it("computes ageLabel via governanceAgeLabel for a live node", () => {
    const rows = buildGovernanceRows([node({ host: "host-A", ageMs: 5_000 })]);
    expect(rows[0].ageLabel).toBe("5s ago");
  });

  it("uses '—' ageLabel when ageMs is null", () => {
    const rows = buildGovernanceRows([node({ host: "host-A", ageMs: null })]);
    expect(rows[0].ageLabel).toBe("—");
  });
});

describe("buildGovernanceRows — stale flag", () => {
  it("live node → stale false", () => {
    const rows = buildGovernanceRows([node({ host: "h", status: "live" })]);
    expect(rows[0].stale).toBe(false);
  });

  it("degraded node → stale true", () => {
    const rows = buildGovernanceRows([node({ host: "h", status: "degraded" })]);
    expect(rows[0].stale).toBe(true);
  });

  it("offline node → stale true", () => {
    const rows = buildGovernanceRows([node({ host: "h", status: "offline" })]);
    expect(rows[0].stale).toBe(true);
  });
});

describe("buildGovernanceRows — null/missing governance", () => {
  it("node with null governance → modes is null", () => {
    const rows = buildGovernanceRows([node({ host: "h", governance: null })]);
    expect(rows[0].modes).toBeNull();
  });
});
