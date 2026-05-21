// dependency-graph.test.mjs — readiness filter + cycle detector tests (CTL-530).
// Run: bun test plugins/dev/scripts/lib/dependency-graph.test.mjs

import { describe, test, expect } from "bun:test";

import {
  buildDependencyEdges,
  computeReadySet,
  detectCycles,
  analyzeDependencyGraph,
} from "./dependency-graph.mjs";

// issue(id, state, relations[], inverseRelations[]) — terse fixture builder.
// A relation tuple is [type, peerId]; rel nests peer under relatedIssue,
// inv nests it under issue.
const rel = (type, id) => ({ id: `r-${type}-${id}`, type, relatedIssue: { identifier: id } });
const inv = (type, id) => ({ id: `i-${type}-${id}`, type, issue: { identifier: id } });
const issue = (identifier, stateName = "Backlog", relations = [], inverseRelations = []) => ({
  identifier,
  state: { name: stateName },
  relations: { nodes: relations },
  inverseRelations: { nodes: inverseRelations },
});
const sortEdges = (edges) =>
  [...edges].sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`));

describe("buildDependencyEdges", () => {
  const cases = [
    {
      name: "empty input → no edges",
      issues: [],
      expected: [],
    },
    {
      name: "single issue, no relations → no edges",
      issues: [issue("CTL-1")],
      expected: [],
    },
    {
      name: "forward `blocks` relation → from blocks to",
      issues: [issue("CTL-1", "Backlog", [rel("blocks", "CTL-2")]), issue("CTL-2")],
      expected: [{ from: "CTL-1", to: "CTL-2" }],
    },
    {
      name: "inverse `blocks` relation → peer blocks self",
      issues: [issue("CTL-1"), issue("CTL-2", "Backlog", [], [inv("blocks", "CTL-1")])],
      expected: [{ from: "CTL-1", to: "CTL-2" }],
    },
    {
      name: "same edge from both relations + inverseRelations → deduped once",
      issues: [
        issue("CTL-1", "Backlog", [rel("blocks", "CTL-2")]),
        issue("CTL-2", "Backlog", [], [inv("blocks", "CTL-1")]),
      ],
      expected: [{ from: "CTL-1", to: "CTL-2" }],
    },
    {
      name: "forward-compat `blocked_by` on relations → reversed edge",
      issues: [issue("CTL-1", "Backlog", [rel("blocked_by", "CTL-2")]), issue("CTL-2")],
      expected: [{ from: "CTL-2", to: "CTL-1" }],
    },
    {
      name: "`related` / `duplicate` types are ignored",
      issues: [
        issue("CTL-1", "Backlog", [rel("related", "CTL-2"), rel("duplicate", "CTL-2")]),
        issue("CTL-2"),
      ],
      expected: [],
    },
    {
      name: "edge to an out-of-set issue is dropped",
      issues: [issue("CTL-1", "Backlog", [rel("blocks", "CTL-999")])],
      expected: [],
    },
    {
      name: "self-loop (issue blocks itself) is kept",
      issues: [issue("CTL-1", "Backlog", [rel("blocks", "CTL-1")])],
      expected: [{ from: "CTL-1", to: "CTL-1" }],
    },
    {
      name: "malformed relation node (missing peer identifier) is skipped",
      issues: [issue("CTL-1", "Backlog", [{ id: "r-x", type: "blocks", relatedIssue: {} }])],
      expected: [],
    },
    {
      name: "forward-compat `blocked_by` on inverseRelations → reversed edge",
      issues: [issue("CTL-1"), issue("CTL-2", "Backlog", [], [inv("blocked_by", "CTL-1")])],
      expected: [{ from: "CTL-2", to: "CTL-1" }],
    },
    {
      name: "malformed inverse relation node (missing peer identifier) is skipped",
      issues: [issue("CTL-1", "Backlog", [], [{ id: "i-x", type: "blocks", issue: {} }])],
      expected: [],
    },
    {
      name: "missing relations / inverseRelations containers do not throw",
      issues: [{ identifier: "CTL-1", state: { name: "Backlog" } }],
      expected: [],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(sortEdges(buildDependencyEdges(c.issues))).toEqual(sortEdges(c.expected));
    });
  }
});

describe("computeReadySet", () => {
  const cases = [
    {
      name: "empty input → empty ready and blocked",
      issues: [],
      edges: [],
      expected: { ready: [], blocked: [] },
    },
    {
      name: "single eligible issue, no edges → ready",
      issues: [issue("CTL-1", "Backlog")],
      edges: [],
      expected: { ready: ["CTL-1"], blocked: [] },
    },
    {
      name: "terminal issue appears in neither list",
      issues: [issue("CTL-1", "Done")],
      edges: [],
      expected: { ready: [], blocked: [] },
    },
    {
      name: "A blocks B, both eligible → A ready, B blocked",
      issues: [issue("CTL-1", "Backlog"), issue("CTL-2", "Backlog")],
      edges: [{ from: "CTL-1", to: "CTL-2" }],
      expected: { ready: ["CTL-1"], blocked: ["CTL-2"] },
    },
    {
      name: "blocker is Done → dependent becomes ready",
      issues: [issue("CTL-1", "Done"), issue("CTL-2", "Backlog")],
      edges: [{ from: "CTL-1", to: "CTL-2" }],
      expected: { ready: ["CTL-2"], blocked: [] },
    },
    {
      name: "blocker is Canceled → dependent becomes ready",
      issues: [issue("CTL-1", "Canceled"), issue("CTL-2", "Backlog")],
      edges: [{ from: "CTL-1", to: "CTL-2" }],
      expected: { ready: ["CTL-2"], blocked: [] },
    },
    {
      name: "unknown / out-of-set blocker does not block",
      issues: [issue("CTL-2", "Backlog")],
      edges: [{ from: "CTL-999", to: "CTL-2" }],
      expected: { ready: ["CTL-2"], blocked: [] },
    },
    {
      name: "diamond — only the root is ready",
      issues: ["CTL-1", "CTL-2", "CTL-3", "CTL-4"].map((id) => issue(id, "Backlog")),
      edges: [
        { from: "CTL-1", to: "CTL-2" },
        { from: "CTL-1", to: "CTL-3" },
        { from: "CTL-2", to: "CTL-4" },
        { from: "CTL-3", to: "CTL-4" },
      ],
      expected: { ready: ["CTL-1"], blocked: ["CTL-2", "CTL-3", "CTL-4"] },
    },
    {
      name: "custom terminalStatuses option is honored",
      issues: [issue("CTL-1", "Shipped"), issue("CTL-2", "Backlog")],
      edges: [{ from: "CTL-1", to: "CTL-2" }],
      options: { terminalStatuses: ["Shipped"] },
      expected: { ready: ["CTL-2"], blocked: [] },
    },
    {
      name: "issue with missing state object → treated as eligible, ready",
      issues: [{ identifier: "CTL-1", relations: { nodes: [] }, inverseRelations: { nodes: [] } }],
      edges: [],
      expected: { ready: ["CTL-1"], blocked: [] },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(computeReadySet(c.issues, c.edges, c.options)).toEqual(c.expected);
    });
  }
});

describe("detectCycles", () => {
  // edge tuple [from,to]; nodes inferred from the case's `nodes` list.
  const cases = [
    { name: "empty graph → no anomalies", nodes: [], edges: [], expected: [] },
    {
      name: "single node, no edges → no anomalies",
      nodes: ["CTL-1"],
      edges: [],
      expected: [],
    },
    {
      name: "linear chain A→B→C → no anomalies",
      nodes: ["CTL-1", "CTL-2", "CTL-3"],
      edges: [
        ["CTL-1", "CTL-2"],
        ["CTL-2", "CTL-3"],
      ],
      expected: [],
    },
    {
      name: "diamond → no anomalies",
      nodes: ["CTL-1", "CTL-2", "CTL-3", "CTL-4"],
      edges: [
        ["CTL-1", "CTL-2"],
        ["CTL-1", "CTL-3"],
        ["CTL-2", "CTL-4"],
        ["CTL-3", "CTL-4"],
      ],
      expected: [],
    },
    {
      name: "two-node cycle A→B→A → one anomaly with both members",
      nodes: ["CTL-1", "CTL-2"],
      edges: [
        ["CTL-1", "CTL-2"],
        ["CTL-2", "CTL-1"],
      ],
      expected: [
        {
          type: "dependency_cycle",
          severity: "error",
          members: ["CTL-1", "CTL-2"],
          reason: "Circular dependency among 2 issues: CTL-1, CTL-2.",
        },
      ],
    },
    {
      name: "self-loop A→A → one anomaly with a single member",
      nodes: ["CTL-1"],
      edges: [["CTL-1", "CTL-1"]],
      expected: [
        {
          type: "dependency_cycle",
          severity: "error",
          members: ["CTL-1"],
          reason: "Issue CTL-1 depends on itself.",
        },
      ],
    },
    {
      name: "cycle with a downstream descendant → descendant excluded",
      nodes: ["CTL-1", "CTL-2", "CTL-3"],
      edges: [
        ["CTL-1", "CTL-2"],
        ["CTL-2", "CTL-1"],
        ["CTL-2", "CTL-3"],
      ],
      expected: [
        {
          type: "dependency_cycle",
          severity: "error",
          members: ["CTL-1", "CTL-2"],
          reason: "Circular dependency among 2 issues: CTL-1, CTL-2.",
        },
      ],
    },
    {
      name: "cycle with an upstream predecessor → predecessor excluded",
      nodes: ["CTL-1", "CTL-2", "CTL-3"],
      edges: [
        ["CTL-1", "CTL-2"],
        ["CTL-2", "CTL-3"],
        ["CTL-3", "CTL-2"],
      ],
      expected: [
        {
          type: "dependency_cycle",
          severity: "error",
          members: ["CTL-2", "CTL-3"],
          reason: "Circular dependency among 2 issues: CTL-2, CTL-3.",
        },
      ],
    },
    {
      name: "two disjoint cycles → two anomalies",
      nodes: ["CTL-1", "CTL-2", "CTL-3", "CTL-4"],
      edges: [
        ["CTL-1", "CTL-2"],
        ["CTL-2", "CTL-1"],
        ["CTL-3", "CTL-4"],
        ["CTL-4", "CTL-3"],
      ],
      expected: [
        {
          type: "dependency_cycle",
          severity: "error",
          members: ["CTL-1", "CTL-2"],
          reason: "Circular dependency among 2 issues: CTL-1, CTL-2.",
        },
        {
          type: "dependency_cycle",
          severity: "error",
          members: ["CTL-3", "CTL-4"],
          reason: "Circular dependency among 2 issues: CTL-3, CTL-4.",
        },
      ],
    },
    {
      name: "three-node cycle A→B→C→A → one anomaly with all three members",
      nodes: ["CTL-1", "CTL-2", "CTL-3"],
      edges: [
        ["CTL-1", "CTL-2"],
        ["CTL-2", "CTL-3"],
        ["CTL-3", "CTL-1"],
      ],
      expected: [
        {
          type: "dependency_cycle",
          severity: "error",
          members: ["CTL-1", "CTL-2", "CTL-3"],
          reason: "Circular dependency among 3 issues: CTL-1, CTL-2, CTL-3.",
        },
      ],
    },
    {
      name: "two cycles sharing a node → merged into one anomaly",
      nodes: ["CTL-1", "CTL-2", "CTL-3"],
      edges: [
        ["CTL-1", "CTL-2"],
        ["CTL-2", "CTL-1"],
        ["CTL-2", "CTL-3"],
        ["CTL-3", "CTL-2"],
      ],
      expected: [
        {
          type: "dependency_cycle",
          severity: "error",
          members: ["CTL-1", "CTL-2", "CTL-3"],
          reason: "Circular dependency among 3 issues: CTL-1, CTL-2, CTL-3.",
        },
      ],
    },
    {
      // Regression for the SCC upgrade: two DISTINCT cycles joined only by a
      // one-way path stay separate anomalies, and the bridge node (CTL-3 —
      // indegree 1, outdegree 1, on no cycle) is excluded from both.
      name: "two cycles joined by a one-way bridge → two anomalies, bridge node excluded",
      nodes: ["CTL-1", "CTL-2", "CTL-3", "CTL-4", "CTL-5"],
      edges: [
        ["CTL-1", "CTL-2"],
        ["CTL-2", "CTL-1"],
        ["CTL-2", "CTL-3"],
        ["CTL-3", "CTL-4"],
        ["CTL-4", "CTL-5"],
        ["CTL-5", "CTL-4"],
      ],
      expected: [
        {
          type: "dependency_cycle",
          severity: "error",
          members: ["CTL-1", "CTL-2"],
          reason: "Circular dependency among 2 issues: CTL-1, CTL-2.",
        },
        {
          type: "dependency_cycle",
          severity: "error",
          members: ["CTL-4", "CTL-5"],
          reason: "Circular dependency among 2 issues: CTL-4, CTL-5.",
        },
      ],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const edges = c.edges.map(([from, to]) => ({ from, to }));
      expect(detectCycles(c.nodes, edges)).toEqual(c.expected);
    });
  }
});

describe("analyzeDependencyGraph", () => {
  test("realistic mixed graph — ready, blocked and a cycle", () => {
    // CTL-1 Done; CTL-2 ready; CTL-3 blocked by CTL-2; CTL-4<->CTL-5 cycle.
    const issues = [
      issue("CTL-1", "Done", [rel("blocks", "CTL-2")]),
      issue("CTL-2", "Backlog", [rel("blocks", "CTL-3")]),
      issue("CTL-3", "Backlog"),
      issue("CTL-4", "Backlog", [rel("blocks", "CTL-5")]),
      issue("CTL-5", "Backlog", [rel("blocks", "CTL-4")]),
    ];
    const result = analyzeDependencyGraph(issues);
    expect(result.ready).toEqual(["CTL-2"]);
    expect(result.blocked).toEqual(["CTL-3", "CTL-4", "CTL-5"]);
    expect(result.anomalies).toEqual([
      {
        type: "dependency_cycle",
        severity: "error",
        members: ["CTL-4", "CTL-5"],
        reason: "Circular dependency among 2 issues: CTL-4, CTL-5.",
      },
    ]);
  });

  test("empty input → empty result", () => {
    expect(analyzeDependencyGraph([])).toEqual({ ready: [], blocked: [], anomalies: [] });
  });

  test("acyclic graph → no anomalies", () => {
    const issues = [issue("CTL-1", "Backlog", [rel("blocks", "CTL-2")]), issue("CTL-2", "Backlog")];
    expect(analyzeDependencyGraph(issues).anomalies).toEqual([]);
  });
});

// CTL-530 verify phase: null/undefined inputs must degrade gracefully rather
// than throw — every export guards with `?? []`, so assert that contract.
describe("null / undefined inputs degrade gracefully", () => {
  test("buildDependencyEdges(null | undefined) → []", () => {
    expect(buildDependencyEdges(undefined)).toEqual([]);
    expect(buildDependencyEdges(null)).toEqual([]);
  });

  test("computeReadySet(undefined, undefined) → empty partition", () => {
    expect(computeReadySet(undefined, undefined)).toEqual({ ready: [], blocked: [] });
  });

  test("detectCycles(undefined, undefined) → []", () => {
    expect(detectCycles(undefined, undefined)).toEqual([]);
  });

  test("analyzeDependencyGraph(undefined) → empty result", () => {
    expect(analyzeDependencyGraph(undefined)).toEqual({ ready: [], blocked: [], anomalies: [] });
  });
});
