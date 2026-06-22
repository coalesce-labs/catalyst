// control-tower-cluster.test.ts — CTL-1092 Phase 4. Source-text structural
// assertions for cluster-mode node filter in ControlTower and SlotDeck.
//
// Run: cd ui && bun test src/components/queue/control-tower-cluster.test.ts

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ctSrc = readFileSync(join(import.meta.dir, "control-tower.tsx"), "utf8");
const sdSrc = readFileSync(join(import.meta.dir, "slot-deck.tsx"), "utf8");

describe("ControlTower cluster-mode (CTL-1092)", () => {
  it("imports isClusterMode for cluster detection", () => {
    expect(ctSrc).toContain("isClusterMode");
  });

  it("renders a NodeFilter tab strip in cluster mode", () => {
    expect(ctSrc).toContain("NodeFilter");
  });

  it("has selectedNode state (default 'all')", () => {
    expect(ctSrc).toContain("selectedNode");
  });
});

describe("SlotDeck cluster-mode (CTL-1092)", () => {
  it("references slot.host for per-host slot labeling", () => {
    expect(sdSrc).toContain("slot.host");
  });

  it("uses assignClusterSlots in cluster-mode path", () => {
    expect(sdSrc).toContain("assignClusterSlots");
  });

  it("uses aggregateClusterCapacity for cluster headline", () => {
    expect(sdSrc).toContain("aggregateClusterCapacity");
  });
});
