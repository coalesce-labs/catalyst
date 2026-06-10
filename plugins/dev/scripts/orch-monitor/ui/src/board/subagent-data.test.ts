// subagent-data.test.ts — units for the worker-detail v2 subworker tree/count
// derivations (CTL-925 / WORKER-DETAIL v2 Pass B §5C). Pure module — no DOM
// (mirrors worker-burn-data.test.ts). Run from ui:
//   cd ui && bun test src/board/subagent-data.test.ts
import { describe, it, expect } from "bun:test";
import {
  resolveSubagentOrchId,
  countSubagents,
  flattenSubagentRows,
  shortenDescription,
  SUBAGENT_DESC_MAX,
  type SubagentNode,
} from "./subagent-data";

function node(over: Partial<SubagentNode>): SubagentNode {
  return {
    toolUseId: null,
    parentToolUseId: null,
    description: null,
    subagentType: null,
    messageCount: 0,
    children: [],
    ...over,
  };
}

// root → child a (→ grandchild a1) + child b
const tree: SubagentNode = node({
  children: [
    node({
      toolUseId: "a",
      subagentType: "research-codebase",
      description: "find the burn endpoint",
      messageCount: 12,
      children: [
        node({ toolUseId: "a1", subagentType: "general", description: "grep", messageCount: 4 }),
      ],
    }),
    node({ toolUseId: "b", subagentType: "review", description: "review diff", messageCount: 7 }),
  ],
});

describe("resolveSubagentOrchId — mirrors parseAgentName identity", () => {
  it("legacy o-<orch>:<ticket>:<phase>:<cont> → the orch segment", () => {
    expect(resolveSubagentOrchId("o-ctl729:CTL-845:implement:2", "CTL-845")).toBe("ctl729");
  });

  it("execution-core '<TICKET> <phase>' → the ticket (orch === ticket)", () => {
    expect(resolveSubagentOrchId("CTL-925 implement", "CTL-925")).toBe("CTL-925");
  });

  it("falls back to the resident ticket when the name matches neither pattern", () => {
    expect(resolveSubagentOrchId("weird-name", "CTL-925")).toBe("CTL-925");
    expect(resolveSubagentOrchId(undefined, "CTL-925")).toBe("CTL-925");
  });

  it("returns null when no name AND no ticket (no row to address — panel dims)", () => {
    expect(resolveSubagentOrchId(undefined, undefined)).toBeNull();
  });
});

describe("countSubagents — total descendant nodes (root excluded)", () => {
  it("counts every node below the root via DFS", () => {
    expect(countSubagents(tree)).toBe(3); // a, a1, b
  });

  it("a worker that spawned none → 0 (honest empty, never an error)", () => {
    expect(countSubagents(node({ children: [] }))).toBe(0);
  });

  it("null/undefined root → 0", () => {
    expect(countSubagents(null)).toBe(0);
    expect(countSubagents(undefined)).toBe(0);
  });
});

describe("flattenSubagentRows — depth-stamped DFS rows", () => {
  it("stamps depth (root's direct children depth 0) and carries the metadata", () => {
    const { rows, total, truncated } = flattenSubagentRows(tree);
    expect(total).toBe(3);
    expect(truncated).toBe(false);
    expect(rows.map((r) => [r.subagentType, r.depth])).toEqual([
      ["research-codebase", 0],
      ["general", 1],
      ["review", 0],
    ]);
    expect(rows[0].messageCount).toBe(12);
  });

  it("caps the row count and flags truncated, preserving the total", () => {
    const many = node({
      children: Array.from({ length: 10 }, (_, i) =>
        node({ toolUseId: `s${i}`, subagentType: "t", messageCount: i }),
      ),
    });
    const { rows, total, truncated } = flattenSubagentRows(many, 3);
    expect(rows).toHaveLength(3);
    expect(total).toBe(10);
    expect(truncated).toBe(true);
  });

  it("a childless root → [] (no rows, not an error)", () => {
    expect(flattenSubagentRows(node({ children: [] })).rows).toEqual([]);
    expect(flattenSubagentRows(null).rows).toEqual([]);
  });

  it("counts todos when present", () => {
    const withTodos = node({
      children: [
        node({
          toolUseId: "x",
          subagentType: "t",
          todos: [{ status: "completed" }, { status: "pending" }],
        }),
      ],
    });
    expect(flattenSubagentRows(withTodos).rows[0].todoCount).toBe(2);
  });
});

describe("shortenDescription", () => {
  it("collapses whitespace and trims to the max with an ellipsis", () => {
    expect(shortenDescription("find  the\nburn\tendpoint")).toBe("find the burn endpoint");
    const long = "x".repeat(SUBAGENT_DESC_MAX + 20);
    const out = shortenDescription(long);
    expect(out!.length).toBe(SUBAGENT_DESC_MAX);
    expect(out!.endsWith("…")).toBe(true);
  });

  it("null/empty → null (never a fabricated description)", () => {
    expect(shortenDescription(null)).toBeNull();
    expect(shortenDescription("   ")).toBeNull();
  });
});
