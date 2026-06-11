// dep-graph-edges.test.ts — unit tests for the relation→edge derivation (CTL-1020).
//
// The dependency graph rendered nodes but NO edges: React Flow v12 silently dropped
// every edge because the custom node had no <Handle> (handleBounds undefined). The
// rendering fix lives in dependency-graph.tsx; THIS suite locks the data contract
// for the edge-builder that feeds React Flow — the half the unit harness CAN cover:
//
//   - one directed edge per blocker→blocked relation, source=blocker target=blocked
//   - ids are stringified (so they match React Flow's nodeLookup string keys)
//   - missing-node tolerance: a blocker absent from the participating set is reported
//     as a terminal (so the caller anchors it) — the edge is emitted, never dropped,
//     never throws.

import { describe, it, expect } from "bun:test";
import { buildBacklogEdges, type DepNode } from "./dep-graph-edges";

function mapOf(...nodes: DepNode[]): Map<string, DepNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

describe("buildBacklogEdges — relation → edge mapping (CTL-1020)", () => {
  it("draws one directed edge per blocker, source=blocker target=blocked", () => {
    const tickets = mapOf({ id: "A" }, { id: "B", blockers: ["A"] });
    const { edges } = buildBacklogEdges(["A", "B"], tickets);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ id: "A->B", source: "A", target: "B" });
  });

  it("fans out multiple blockers into multiple edges into the same node", () => {
    const tickets = mapOf({ id: "A" }, { id: "B" }, { id: "C", blockers: ["A", "B"] });
    const { edges } = buildBacklogEdges(["A", "B", "C"], tickets);
    const ids = edges.map((e) => e.id).sort();
    expect(ids).toEqual(["A->C", "B->C"]);
  });

  it("produces no edges when no ticket has blockers", () => {
    const tickets = mapOf({ id: "A" }, { id: "B" });
    const { edges, terminals } = buildBacklogEdges(["A", "B"], tickets);
    expect(edges).toHaveLength(0);
    expect(terminals).toHaveLength(0);
  });

  it("stringifies numeric-looking ids so they match React Flow's string node keys", () => {
    // A blocker stored as a number must coerce to a string edge endpoint, else
    // React Flow's nodeLookup Map miss silently drops the edge (checklist step 3).
    const tickets = new Map<string, DepNode>([
      ["1", { id: "1" }],
      ["2", { id: "2", blockers: [1 as unknown as string] }],
    ]);
    const { edges } = buildBacklogEdges(["1", "2"], tickets);
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe("1");
    expect(typeof edges[0].source).toBe("string");
    expect(edges[0].id).toBe("1->2");
  });
});

describe("buildBacklogEdges — missing-node tolerance (drop-not-crash, CTL-959/1020)", () => {
  it("reports a blocker absent from the participating set as a terminal", () => {
    // B is blocked by A, but A is Done/excluded — not in the participating set.
    const tickets = mapOf({ id: "B", blockers: ["A"] });
    const { edges, terminals } = buildBacklogEdges(["B"], tickets);
    // the edge is still emitted (so it renders once A is anchored), not dropped
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: "A", target: "B" });
    expect(terminals).toContain("A");
  });

  it("does not flag a present blocker as terminal", () => {
    const tickets = mapOf({ id: "A" }, { id: "B", blockers: ["A"] });
    const { terminals } = buildBacklogEdges(["A", "B"], tickets);
    expect(terminals).toHaveLength(0);
  });

  it("does not throw when a blocker references a ticket missing from the map entirely", () => {
    const tickets = mapOf({ id: "C", blockers: ["A", "GONE"] });
    expect(() => buildBacklogEdges(["C"], tickets)).not.toThrow();
    const { edges, terminals } = buildBacklogEdges(["C"], tickets);
    expect(edges.map((e) => e.id).sort()).toEqual(["A->C", "GONE->C"]);
    expect(terminals.sort()).toEqual(["A", "GONE"]);
  });

  it("tolerates empty / nullish blocker entries without producing junk edges", () => {
    const tickets = mapOf({ id: "B", blockers: ["", "A"] as string[] });
    const { edges } = buildBacklogEdges(["B"], tickets);
    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe("A->B");
  });

  it("dedupes identical relations into a single edge", () => {
    const tickets = mapOf({ id: "A" }, { id: "B", blockers: ["A", "A"] });
    const { edges } = buildBacklogEdges(["A", "B"], tickets);
    expect(edges).toHaveLength(1);
  });
});
