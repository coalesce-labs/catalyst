// dependency-graph.test.mjs — readiness filter + cycle detector tests (CTL-530).
// Run: bun test plugins/dev/scripts/lib/dependency-graph.test.mjs

import { describe, test, expect } from "bun:test";

import {
  buildDependencyEdges,
  computeReadySet,
  detectCycles,
  analyzeDependencyGraph,
  referencedBlockerIds,
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
    {
      // CTL-878: a child's blocks edge from its own parent epic is hierarchy, not
      // a dependency — dropped so a never-worked tracking epic can't deadlock it.
      name: "CTL-878: a `blocks` edge from the target's parent epic is dropped",
      issues: [
        {
          identifier: "CTL-863",
          state: { name: "Todo" },
          parent: "CTL-859",
          relations: { nodes: [] },
          inverseRelations: { nodes: [inv("blocks", "CTL-859")] },
        },
        issue("CTL-859", "Backlog"),
      ],
      expected: [],
    },
    {
      // CTL-878: only the PARENT edge is dropped — a real sibling dependency on the
      // same child survives (mirrors CTL-866: parent CTL-859 + sibling CTL-863).
      name: "CTL-878: parent edge dropped, sibling dependency edge kept",
      issues: [
        {
          identifier: "CTL-866",
          state: { name: "Todo" },
          parent: "CTL-859",
          relations: { nodes: [] },
          inverseRelations: { nodes: [inv("blocks", "CTL-859"), inv("blocks", "CTL-863")] },
        },
        issue("CTL-863", "Todo"),
        issue("CTL-859", "Backlog"),
      ],
      expected: [{ from: "CTL-863", to: "CTL-866" }],
    },
    {
      // CTL-878: the drop must also fire when the parent epic is genuinely a child
      // of a sibling (forward `blocks` direction, parent declared on the child).
      name: "CTL-878: parent edge dropped via forward `blocks` from the parent node",
      issues: [
        {
          identifier: "CTL-859",
          state: { name: "Backlog" },
          relations: { nodes: [rel("blocks", "CTL-863")] },
          inverseRelations: { nodes: [] },
        },
        { identifier: "CTL-863", state: { name: "Todo" }, parent: "CTL-859" },
      ],
      expected: [],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(sortEdges(buildDependencyEdges(c.issues))).toEqual(sortEdges(c.expected));
    });
  }

  // CTL-878: the deadlock case is an OUT-OF-SET parent epic — the child is in the
  // eligible/admission pool but the epic (Backlog, never dispatched) is hydrated
  // only as an externalId. Without the parent guard the externalId rule keeps the
  // edge; with it the edge is dropped because the child carries parent === epic.
  test("CTL-878: parent-epic edge dropped even when the parent is an out-of-set externalId", () => {
    const issues = [
      {
        identifier: "CTL-722",
        state: { name: "Todo" },
        parent: "CTL-718",
        relations: { nodes: [] },
        inverseRelations: { nodes: [inv("blocks", "CTL-718")] },
      },
    ];
    // CTL-718 is out-of-set but declared as an external blocker (D5 hydration).
    expect(buildDependencyEdges(issues, { externalIds: ["CTL-718"] })).toEqual([]);
  });

  test("CTL-878: an issue with no parent field is unaffected (backward compat)", () => {
    const issues = [
      issue("CTL-1", "Backlog", [rel("blocks", "CTL-2")]),
      issue("CTL-2", "Todo"),
    ];
    expect(buildDependencyEdges(issues)).toEqual([{ from: "CTL-1", to: "CTL-2" }]);
  });
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

// CTL-565 D5 — out-of-set blocker-state awareness. A Ready ticket blocked by a
// ticket outside the eligible set must be held back unless the blocker's live
// Linear state is terminal. The blocker is passed as a { id: stateName } map,
// never injected into the issue list (that would make blockers dispatchable).
describe("D5 — out-of-set blocker-state hydration", () => {
  test("a Ready ticket blocked by a non-terminal out-of-set blocker is held back", () => {
    // CTL-1 is eligible with an inverse `blocks` edge from out-of-set CTL-99.
    const issues = [issue("CTL-1", "Backlog", [], [inv("blocks", "CTL-99")])];
    const r = analyzeDependencyGraph(issues, { blockerStates: { "CTL-99": "Backlog" } });
    expect(r.ready).toEqual([]);
    expect(r.blocked).toEqual(["CTL-1"]);
  });

  test("a Ready ticket blocked by a Done out-of-set blocker is ready", () => {
    const issues = [issue("CTL-1", "Backlog", [], [inv("blocks", "CTL-99")])];
    const r = analyzeDependencyGraph(issues, { blockerStates: { "CTL-99": "Done" } });
    expect(r.ready).toEqual(["CTL-1"]);
  });

  test("with no blockerStates supplied, an out-of-set blocker still does not block (legacy)", () => {
    const issues = [issue("CTL-1", "Backlog", [], [inv("blocks", "CTL-99")])];
    expect(analyzeDependencyGraph(issues).ready).toEqual(["CTL-1"]);
  });

  test("an out-of-set blocker is never itself classified as ready/blocked", () => {
    const issues = [issue("CTL-1", "Backlog", [], [inv("blocks", "CTL-99")])];
    const r = analyzeDependencyGraph(issues, { blockerStates: { "CTL-99": "Backlog" } });
    expect(r.ready).not.toContain("CTL-99");
    expect(r.blocked).not.toContain("CTL-99");
  });

  test("a Canceled out-of-set blocker does not block (terminal)", () => {
    const issues = [issue("CTL-1", "Backlog", [], [inv("blocks", "CTL-99")])];
    expect(analyzeDependencyGraph(issues, { blockerStates: { "CTL-99": "Canceled" } }).ready)
      .toEqual(["CTL-1"]);
  });

  test("referencedBlockerIds returns every blocked-by peer regardless of membership", () => {
    const issues = [
      issue("CTL-1", "Backlog", [], [inv("blocks", "CTL-99")]),
      issue("CTL-2", "Backlog", [rel("blocked_by", "CTL-88")]),
    ];
    expect(referencedBlockerIds(issues).sort()).toEqual(["CTL-88", "CTL-99"]);
  });
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

  // CTL-878 end-to-end: a Todo child whose ONLY blocker is its Backlog parent epic
  // (an out-of-set, non-terminal blocker) must be READY, not blocked. This is the
  // exact production deadlock (CTL-859→863, CTL-718→722) the parent guard fixes.
  test("CTL-878: a child blocked only by its non-terminal parent epic is ready, not blocked", () => {
    const issues = [
      {
        identifier: "CTL-863",
        state: { name: "Todo" },
        parent: "CTL-859",
        relations: { nodes: [] },
        inverseRelations: { nodes: [inv("blocks", "CTL-859")] },
      },
    ];
    const result = analyzeDependencyGraph(issues, { blockerStates: { "CTL-859": "Backlog" } });
    expect(result.ready).toEqual(["CTL-863"]);
    expect(result.blocked).toEqual([]);
    expect(result.anomalies).toEqual([]);
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
