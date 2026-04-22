import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseStreamForSubagents,
  flattenTodos,
  flattenTodosForWorker,
  type SubagentNode,
} from "../lib/subagent-tree";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "subagent-tree-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeJsonl(name: string, lines: unknown[]): string {
  const path = join(tmpRoot, `${name}.jsonl`);
  writeFileSync(
    path,
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  return path;
}

interface TodoInput {
  content: string;
  activeForm?: string;
  status: string;
}

function todoWriteMsg(
  parentToolUseId: string | null,
  todos: TodoInput[],
  toolUseId = "toolu_tw_" + Math.random().toString(36).slice(2, 10),
): Record<string, unknown> {
  return {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "TodoWrite",
          input: { todos },
        },
      ],
    },
    parent_tool_use_id: parentToolUseId,
    session_id: "sess-1",
  };
}

function spawnAgentMsg(
  parentToolUseId: string | null,
  childToolUseId: string,
  description: string,
  subagentType: string,
): Record<string, unknown> {
  return {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: childToolUseId,
          name: "Agent",
          input: {
            description,
            subagent_type: subagentType,
            prompt: "go",
          },
        },
      ],
    },
    parent_tool_use_id: parentToolUseId,
    session_id: "sess-1",
  };
}

function userMsg(parentToolUseId: string | null): Record<string, unknown> {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
    parent_tool_use_id: parentToolUseId,
    session_id: "sess-1",
  };
}

describe("parseStreamForSubagents", () => {
  it("extracts a single TodoWrite at the worker root", () => {
    const path = writeJsonl("t1", [
      todoWriteMsg(null, [
        { content: "A", activeForm: "Doing A", status: "in_progress" },
        { content: "B", activeForm: "Doing B", status: "pending" },
      ]),
    ]);

    const root = parseStreamForSubagents(path);
    expect(root.toolUseId).toBeNull();
    expect(root.parentToolUseId).toBeNull();
    expect(root.children).toHaveLength(0);
    expect(root.todos).toEqual([
      { content: "A", activeForm: "Doing A", status: "in_progress" },
      { content: "B", activeForm: "Doing B", status: "pending" },
    ]);
  });

  it("replaces the todo list on each subsequent TodoWrite (last write wins)", () => {
    const path = writeJsonl("t2", [
      todoWriteMsg(null, [{ content: "A", status: "in_progress" }]),
      todoWriteMsg(null, [
        { content: "X", status: "completed" },
        { content: "Y", status: "in_progress" },
      ]),
    ]);
    const root = parseStreamForSubagents(path);
    expect(root.todos).toHaveLength(2);
    expect(root.todos[0].content).toBe("X");
    expect(root.todos[1].content).toBe("Y");
  });

  it("builds a single-level subagent with its own TodoWrite", () => {
    const child = "toolu_child_1";
    const path = writeJsonl("t3", [
      todoWriteMsg(null, [{ content: "worker-todo", status: "in_progress" }]),
      spawnAgentMsg(null, child, "do child work", "catalyst-dev:codebase-locator"),
      userMsg(child),
      todoWriteMsg(child, [{ content: "child-todo", status: "completed" }]),
    ]);

    const root = parseStreamForSubagents(path);
    expect(root.todos).toEqual([
      { content: "worker-todo", activeForm: undefined, status: "in_progress" },
    ]);
    expect(root.children).toHaveLength(1);
    const subagent: SubagentNode = root.children[0];
    expect(subagent.toolUseId).toBe(child);
    expect(subagent.parentToolUseId).toBeNull();
    expect(subagent.description).toBe("do child work");
    expect(subagent.subagentType).toBe("catalyst-dev:codebase-locator");
    expect(subagent.todos).toEqual([
      { content: "child-todo", activeForm: undefined, status: "completed" },
    ]);
  });

  it("builds a nested subagent tree (at least 2 levels deep)", () => {
    const child = "toolu_child_1";
    const grand = "toolu_grand_1";
    const path = writeJsonl("t4", [
      spawnAgentMsg(null, child, "child desc", "agent-a"),
      spawnAgentMsg(child, grand, "grand desc", "agent-b"),
      todoWriteMsg(grand, [{ content: "deep", status: "in_progress" }]),
    ]);

    const root = parseStreamForSubagents(path);
    expect(root.children).toHaveLength(1);
    const childNode = root.children[0];
    expect(childNode.description).toBe("child desc");
    expect(childNode.children).toHaveLength(1);
    const grandNode = childNode.children[0];
    expect(grandNode.description).toBe("grand desc");
    expect(grandNode.todos).toEqual([
      { content: "deep", activeForm: undefined, status: "in_progress" },
    ]);
  });

  it("skips malformed JSON lines without crashing", () => {
    const path = join(tmpRoot, "malformed.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify(todoWriteMsg(null, [{ content: "A", status: "pending" }])),
        "{this is not valid json",
        "",
        JSON.stringify(todoWriteMsg(null, [{ content: "B", status: "completed" }])),
      ].join("\n"),
    );

    const root = parseStreamForSubagents(path);
    expect(root.todos).toEqual([
      { content: "B", activeForm: undefined, status: "completed" },
    ]);
  });

  it("normalizes unknown status values to 'pending'", () => {
    const path = writeJsonl("status", [
      todoWriteMsg(null, [
        { content: "A", status: "blocked" },
        { content: "B", status: "in_progress" },
        { content: "C", status: "cancelled" },
      ]),
    ]);
    const root = parseStreamForSubagents(path);
    expect(root.todos.map((t) => t.status)).toEqual([
      "pending",
      "in_progress",
      "pending",
    ]);
  });

  it("returns an empty root when the stream file does not exist", () => {
    const root = parseStreamForSubagents(join(tmpRoot, "nope.jsonl"));
    expect(root.toolUseId).toBeNull();
    expect(root.todos).toEqual([]);
    expect(root.children).toEqual([]);
    expect(root.messageCount).toBe(0);
  });

  it("handles out-of-order: subagent's user-message arrives before the spawning Agent tool_use", () => {
    const child = "toolu_ooo_1";
    const path = writeJsonl("ooo", [
      userMsg(child),
      todoWriteMsg(child, [{ content: "subtask", status: "in_progress" }]),
      spawnAgentMsg(null, child, "late desc", "late-type"),
    ]);
    const root = parseStreamForSubagents(path);
    expect(root.children).toHaveLength(1);
    const sub = root.children[0];
    expect(sub.toolUseId).toBe(child);
    expect(sub.description).toBe("late desc");
    expect(sub.subagentType).toBe("late-type");
    expect(sub.todos).toEqual([
      { content: "subtask", activeForm: undefined, status: "in_progress" },
    ]);
  });

  it("counts messages attributed to each node", () => {
    const child = "toolu_mc_1";
    const path = writeJsonl("mc", [
      spawnAgentMsg(null, child, "c", "t"),
      userMsg(child),
      userMsg(child),
      userMsg(null),
    ]);
    const root = parseStreamForSubagents(path);
    expect(root.messageCount).toBe(2); // spawn + root user
    expect(root.children[0].messageCount).toBe(2); // two user msgs
  });

  it("ignores tool_use blocks with no id", () => {
    const path = join(tmpRoot, "noid.jsonl");
    writeFileSync(
      path,
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Agent", input: { description: "x", subagent_type: "y" } },
          ],
        },
        parent_tool_use_id: null,
      }) + "\n",
    );
    const root = parseStreamForSubagents(path);
    expect(root.children).toHaveLength(0);
  });
});

describe("flattenTodos", () => {
  it("returns empty list when tree has no todos anywhere", () => {
    const path = writeJsonl("empty", [spawnAgentMsg(null, "t", "d", "s")]);
    const root = parseStreamForSubagents(path);
    expect(flattenTodos(root)).toEqual([]);
  });

  it("flattens todos from root + nested subagents with ownerPath", () => {
    const child = "toolu_flat_c";
    const grand = "toolu_flat_g";
    const path = writeJsonl("flat", [
      todoWriteMsg(null, [{ content: "r1", status: "in_progress" }]),
      spawnAgentMsg(null, child, "child desc", "agent-a"),
      todoWriteMsg(child, [{ content: "c1", status: "completed" }]),
      spawnAgentMsg(child, grand, "grand desc", "agent-b"),
      todoWriteMsg(grand, [{ content: "g1", status: "pending" }]),
    ]);
    const root = parseStreamForSubagents(path);
    const flat = flattenTodos(root);
    expect(flat).toHaveLength(3);

    const rootTodo = flat.find((t) => t.content === "r1")!;
    expect(rootTodo.ownerPath).toEqual([]);
    expect(rootTodo.ownerToolUseId).toBe("");

    const childTodo = flat.find((t) => t.content === "c1")!;
    expect(childTodo.ownerPath).toEqual(["child desc"]);
    expect(childTodo.ownerToolUseId).toBe(child);

    const grandTodo = flat.find((t) => t.content === "g1")!;
    expect(grandTodo.ownerPath).toEqual(["child desc", "grand desc"]);
    expect(grandTodo.ownerToolUseId).toBe(grand);
  });
});

describe("flattenTodosForWorker", () => {
  it("stamps every todo with the provided ticket", () => {
    const path = writeJsonl("stamp", [
      todoWriteMsg(null, [{ content: "r1", status: "in_progress" }]),
    ]);
    const root = parseStreamForSubagents(path);
    const flat = flattenTodosForWorker(root, "CTL-143");
    expect(flat).toHaveLength(1);
    expect(flat[0].ticket).toBe("CTL-143");
  });
});

describe("integration: parse real CTL-125 stream fixture", () => {
  const fixturePath = join(
    __dirname,
    "..",
    "fixtures",
    "subagent-tree",
    "CTL-125-stream.jsonl",
  );

  it("parses a real stream without error and returns a populated tree", () => {
    const root = parseStreamForSubagents(fixturePath);
    // Real stream has a TodoWrite at the worker root.
    expect(root.todos.length).toBeGreaterThan(0);
    // Plus multiple Agent subagents.
    expect(root.children.length).toBeGreaterThan(0);
  });

  it("captures real subagent descriptions and subagent_types", () => {
    const root = parseStreamForSubagents(fixturePath);
    const descriptions = root.children
      .map((c) => c.description)
      .filter((d): d is string => typeof d === "string" && d.length > 0);
    expect(descriptions.length).toBeGreaterThan(0);
    // Real Agent calls in this fixture all target catalyst-dev:* subagents.
    const types = root.children
      .map((c) => c.subagentType)
      .filter((t): t is string => typeof t === "string" && t.length > 0);
    expect(types.some((t) => t.startsWith("catalyst-dev:"))).toBe(true);
  });

  it("every todo produced by flattenTodos has a normalized status", () => {
    const root = parseStreamForSubagents(fixturePath);
    const flat = flattenTodos(root);
    expect(flat.length).toBeGreaterThan(0);
    const allowed = new Set(["pending", "in_progress", "completed"]);
    for (const todo of flat) {
      expect(allowed.has(todo.status)).toBe(true);
    }
  });
});
