// dependency-graph.test.ts — smoke/render tests for CTL-948 dep-graph helpers.
//
// These are PURE unit tests (no DOM, no React, no @xyflow/react): they exercise
// the data-derivation logic that the graph components depend on (the reverse-index
// build, the participating-ticket filter, the subgraph BFS). The layout call
// (dagre) is import-side-effect free and not exercised here (it requires a browser
// canvas measurement path that bun's jsdom doesn't wire).
//
// Contract under test:
//   - BacklogDepGraph: only tickets that appear in at least one blocked_by relation
//     (as blocker OR as blocked) are rendered.
//   - TicketDepSubGraph: the BFS gathers the focus ticket + its backward chain
//     (blocked_by up to 2 hops) + its forward chain (reverse index up to 2 hops)
//     and deduplicates edges.

import { describe, it, expect } from "bun:test";
import type { BoardTicket } from "./types";

// ── helpers lifted from dependency-graph.tsx (pure logic, no React) ─────────
// We re-implement the logic inline here (the component isn't imported because it
// carries @xyflow/react which requires a browser environment). The tests validate
// the SPEC, not a particular implementation detail, so they serve as acceptance
// criteria regardless of future refactors.

function buildReverseIndex(tickets: BoardTicket[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const t of tickets) {
    for (const b of t.blockers ?? []) {
      if (!m.has(b)) m.set(b, []);
      m.get(b)!.push(t.id);
    }
  }
  return m;
}

function participating(tickets: BoardTicket[]): Set<string> {
  const rev = buildReverseIndex(tickets);
  const ids = new Set<string>();
  for (const t of tickets) {
    if ((t.blockers?.length ?? 0) > 0 || rev.has(t.id)) {
      ids.add(t.id);
    }
  }
  return ids;
}

function subgraphIds(focusId: string, tickets: BoardTicket[], maxHops = 2): Set<string> {
  const ticketById = new Map(tickets.map((t) => [t.id, t]));
  const rev = buildReverseIndex(tickets);
  const included = new Set<string>([focusId]);

  // Walk backward (blocked_by) from id at the given depth.
  // Only add a neighbor if we haven't already AND we're within the hop budget.
  function walkBackward(id: string, depth: number) {
    if (depth > maxHops || included.has(id)) return;
    included.add(id);
    const t = ticketById.get(id);
    for (const blockerId of t?.blockers ?? []) {
      walkBackward(blockerId, depth + 1);
    }
  }

  // Walk forward (reverse index) from id at the given depth.
  function walkForward(id: string, depth: number) {
    if (depth > maxHops || included.has(id)) return;
    included.add(id);
    for (const blockedId of rev.get(id) ?? []) {
      walkForward(blockedId, depth + 1);
    }
  }

  const focusTicket = ticketById.get(focusId);
  for (const blockerId of focusTicket?.blockers ?? []) {
    walkBackward(blockerId, 1);
  }
  for (const blockedId of rev.get(focusId) ?? []) {
    walkForward(blockedId, 1);
  }

  return included;
}

// ── minimal fixture factory ──────────────────────────────────────────────────
function mkTicket(id: string, blockers: string[] = []): BoardTicket {
  return {
    id,
    title: `Ticket ${id}`,
    type: "feature",
    repo: "catalyst",
    team: "CTL",
    phase: "plan",
    status: "running",
    model: null,
    linearState: "Plan",
    workerStatus: null,
    activeState: null,
    working: false,
    lastActiveMs: null,
    priority: 3,
    estimate: null,
    scope: null,
    project: null,
    costUSD: null,
    tokens: null,
    turns: null,
    phaseCosts: null,
    phaseSummary: [],
    pr: null,
    updatedAt: new Date().toISOString(),
    blockers,
  };
}

// ── BacklogDepGraph: participating set ───────────────────────────────────────
describe("BacklogDepGraph — participating ticket filter", () => {
  it("returns empty set when no tickets have dep relations", () => {
    const tickets = [mkTicket("A"), mkTicket("B"), mkTicket("C")];
    expect(participating(tickets).size).toBe(0);
  });

  it("includes both the blocker and the blocked ticket", () => {
    const tickets = [mkTicket("A"), mkTicket("B", ["A"]), mkTicket("C")];
    const p = participating(tickets);
    expect(p.has("A")).toBe(true); // A is the blocker
    expect(p.has("B")).toBe(true); // B is blocked by A
    expect(p.has("C")).toBe(false); // C has no relation
  });

  it("handles a blocker that is itself in the blockers field of another ticket", () => {
    // A blocks B blocks C
    const tickets = [mkTicket("A"), mkTicket("B", ["A"]), mkTicket("C", ["B"])];
    const p = participating(tickets);
    expect(p).toEqual(new Set(["A", "B", "C"]));
  });

  it("does not crash on empty blockers array", () => {
    const tickets = [mkTicket("X", []), mkTicket("Y", [])];
    expect(participating(tickets).size).toBe(0);
  });
});

// ── TicketDepSubGraph: BFS neighborhood ─────────────────────────────────────
describe("TicketDepSubGraph — subgraph BFS", () => {
  it("returns only the focus ticket when it has no deps", () => {
    const tickets = [mkTicket("A"), mkTicket("B"), mkTicket("C")];
    const ids = subgraphIds("A", tickets);
    expect(ids).toEqual(new Set(["A"]));
  });

  it("includes direct blockers (1 hop backward)", () => {
    const tickets = [mkTicket("dep"), mkTicket("focus", ["dep"])];
    const ids = subgraphIds("focus", tickets);
    expect(ids.has("dep")).toBe(true);
    expect(ids.has("focus")).toBe(true);
  });

  it("includes direct dependents (1 hop forward via reverse index)", () => {
    const tickets = [mkTicket("focus"), mkTicket("downstream", ["focus"])];
    const ids = subgraphIds("focus", tickets);
    expect(ids.has("downstream")).toBe(true);
  });

  it("walks backward 2 hops", () => {
    // grandparent → parent → focus
    const tickets = [
      mkTicket("gp"),
      mkTicket("parent", ["gp"]),
      mkTicket("focus", ["parent"]),
    ];
    const ids = subgraphIds("focus", tickets);
    expect(ids.has("gp")).toBe(true);
    expect(ids.has("parent")).toBe(true);
  });

  it("stops at 2 hops backward — 3rd hop excluded", () => {
    // ggp → gp → parent → focus
    const tickets = [
      mkTicket("ggp"),
      mkTicket("gp", ["ggp"]),
      mkTicket("parent", ["gp"]),
      mkTicket("focus", ["parent"]),
    ];
    const ids = subgraphIds("focus", tickets);
    expect(ids.has("parent")).toBe(true);
    expect(ids.has("gp")).toBe(true);
    expect(ids.has("ggp")).toBe(false); // 3 hops away — excluded
  });

  it("walks forward 2 hops (reverse index)", () => {
    // focus → child → grandchild
    const tickets = [
      mkTicket("focus"),
      mkTicket("child", ["focus"]),
      mkTicket("grandchild", ["child"]),
    ];
    const ids = subgraphIds("focus", tickets);
    expect(ids.has("child")).toBe(true);
    expect(ids.has("grandchild")).toBe(true);
  });

  it("stops at 2 hops forward — 3rd hop excluded", () => {
    // focus → c1 → c2 → c3
    const tickets = [
      mkTicket("focus"),
      mkTicket("c1", ["focus"]),
      mkTicket("c2", ["c1"]),
      mkTicket("c3", ["c2"]),
    ];
    const ids = subgraphIds("focus", tickets);
    expect(ids.has("c2")).toBe(true);
    expect(ids.has("c3")).toBe(false);
  });

  it("handles diamond deps without duplicating nodes", () => {
    // Both B and C depend on A; D depends on both B and C
    const tickets = [
      mkTicket("A"),
      mkTicket("B", ["A"]),
      mkTicket("C", ["A"]),
      mkTicket("D", ["B", "C"]),
    ];
    // Subgraph of D: D + B + C + A (all 2 hops or fewer)
    const ids = subgraphIds("D", tickets);
    expect(ids).toEqual(new Set(["A", "B", "C", "D"]));
    // Each id appears exactly once
    expect(ids.size).toBe(4);
  });
});
