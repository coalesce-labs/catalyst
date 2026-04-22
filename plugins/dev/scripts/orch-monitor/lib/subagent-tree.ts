/**
 * Parse a worker's full stream.jsonl and build a nested subagent tree with
 * TodoWrite payloads attributed to the worker and each subagent.
 *
 * Separate entry point from `stream-reader.ts` — the existing 32 KB-tail live
 * view (`readWorkerActivity`, `readRecentStreamEvents`) stays untouched so
 * stream ingestion performance does not regress.
 *
 * The linking key between a subagent and its spawning Task/Agent call is
 * `parent_tool_use_id`. Verified against real fixtures
 * (`~/catalyst/runs/ctl-123-126/workers/output/CTL-125-stream.jsonl`): subagent
 * messages share the parent worker's `session_id`; only the tool_use id links
 * them. No `~/.claude/tasks/` lookup needed.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface TodoItem {
  content: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
}

export interface SubagentNode {
  /** tool_use id that spawned this node; null for the top-level worker root. */
  toolUseId: string | null;
  /** parent node's toolUseId; null for root. */
  parentToolUseId: string | null;
  /** Agent/Task input.description; null for root. */
  description: string | null;
  /** Agent/Task input.subagent_type; null for root. */
  subagentType: string | null;
  /** Latest TodoWrite payload owned by this node. Empty array if never written. */
  todos: TodoItem[];
  /** Total number of stream messages attributed to this node. */
  messageCount: number;
  /** Direct child subagents, in first-seen order. */
  children: SubagentNode[];
}

export interface FlattenedTodoBase extends TodoItem {
  /** Descriptions of every ancestor from root's direct child → owning node (empty for root). */
  ownerPath: string[];
  /** toolUseId of the owning node ("" for root). */
  ownerToolUseId: string;
}

export interface FlattenedTodo extends FlattenedTodoBase {
  /** Worker ticket that produced the todo (for cross-worker rollups). */
  ticket: string;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function asString(x: unknown): string | undefined {
  return typeof x === "string" ? x : undefined;
}

function normalizeStatus(raw: unknown): TodoItem["status"] {
  return raw === "in_progress" || raw === "completed" ? raw : "pending";
}

function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const result: TodoItem[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const content = asString(item.content);
    if (typeof content !== "string") continue;
    result.push({
      content,
      activeForm: asString(item.activeForm),
      status: normalizeStatus(item.status),
    });
  }
  return result;
}

function makeNode(
  toolUseId: string | null,
  parentToolUseId: string | null,
): SubagentNode {
  return {
    toolUseId,
    parentToolUseId,
    description: null,
    subagentType: null,
    todos: [],
    messageCount: 0,
    children: [],
  };
}

/**
 * Returns the canonical stream-file path for a worker inside an orchestrator directory.
 */
export function streamFilePath(orchDir: string, ticket: string): string {
  return join(orchDir, "workers", `${ticket}-stream.jsonl`);
}

/**
 * Parse a worker's stream.jsonl into a subagent tree with TodoWrite payloads
 * attached to each node. Returns a root node (toolUseId=null) even when the
 * stream file is missing or empty.
 */
export function parseStreamForSubagents(streamPath: string): SubagentNode {
  const root = makeNode(null, null);
  if (!existsSync(streamPath)) return root;

  let raw: string;
  try {
    raw = readFileSync(streamPath, "utf8");
  } catch {
    return root;
  }

  // Key a map by tool_use id → node. Root is not in the map (its id is null).
  const nodeById = new Map<string, SubagentNode>();

  const getOwner = (parentToolUseId: string | null | undefined): SubagentNode => {
    if (!parentToolUseId) return root;
    let node = nodeById.get(parentToolUseId);
    if (!node) {
      node = makeNode(parentToolUseId, null);
      nodeById.set(parentToolUseId, node);
      // Parent structure is unknown until we see the spawning tool_use;
      // attach to root as a placeholder so it's reachable.
      root.children.push(node);
    }
    return node;
  };

  const getOrCreateChild = (
    owner: SubagentNode,
    childToolUseId: string,
    description: string | null,
    subagentType: string | null,
  ): void => {
    let node = nodeById.get(childToolUseId);
    if (!node) {
      node = makeNode(childToolUseId, owner.toolUseId);
      nodeById.set(childToolUseId, node);
      owner.children.push(node);
    } else {
      // Existing placeholder — reparent from root if needed, and fill metadata.
      if (node.parentToolUseId !== owner.toolUseId) {
        // Detach from wherever it currently sits (root placeholder case).
        const prevParent =
          node.parentToolUseId === null
            ? root
            : (nodeById.get(node.parentToolUseId) ?? root);
        const idx = prevParent.children.indexOf(node);
        if (idx >= 0) prevParent.children.splice(idx, 1);
        node.parentToolUseId = owner.toolUseId;
        owner.children.push(node);
      }
    }
    if (description !== null && node.description === null) {
      node.description = description;
    }
    if (subagentType !== null && node.subagentType === null) {
      node.subagentType = subagentType;
    }
  };

  const lines = raw.split("\n");
  for (const line of lines) {
    if (line.trim().length === 0) continue;

    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(obj)) continue;

    const msgType = obj.type;
    if (msgType !== "assistant" && msgType !== "user") continue;

    const parentToolUseId = asString(obj.parent_tool_use_id) ?? null;
    const owner = getOwner(parentToolUseId);
    owner.messageCount += 1;

    const message = isRecord(obj.message) ? obj.message : null;
    const content = message && Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_use") continue;
      const name = asString(block.name);
      if (!name) continue;

      if (name === "TodoWrite") {
        const input = isRecord(block.input) ? block.input : {};
        owner.todos = normalizeTodos(input.todos);
        continue;
      }

      if (name === "Task" || name === "Agent") {
        const toolUseId = asString(block.id);
        if (!toolUseId) continue;
        const input = isRecord(block.input) ? block.input : {};
        getOrCreateChild(
          owner,
          toolUseId,
          asString(input.description) ?? null,
          asString(input.subagent_type) ?? null,
        );
      }
    }
  }

  return root;
}

/**
 * Depth-first flatten of todos across the tree. `ownerPath` lists the chain
 * of subagent `description`s from root's direct child → the owning node.
 * Root todos have `ownerPath: []` and `ownerToolUseId: ""`.
 */
export function flattenTodos(root: SubagentNode): FlattenedTodoBase[] {
  const out: FlattenedTodoBase[] = [];
  const walk = (node: SubagentNode, path: string[]): void => {
    const ownerToolUseId = node.toolUseId ?? "";
    for (const todo of node.todos) {
      out.push({
        content: todo.content,
        activeForm: todo.activeForm,
        status: todo.status,
        ownerPath: path.slice(),
        ownerToolUseId,
      });
    }
    for (const child of node.children) {
      walk(child, [...path, child.description ?? ""]);
    }
  };
  walk(root, []);
  return out;
}

/**
 * Same as `flattenTodos` but stamps every item with the provided ticket so
 * cross-worker rollups can identify the source.
 */
export function flattenTodosForWorker(
  root: SubagentNode,
  ticket: string,
): FlattenedTodo[] {
  return flattenTodos(root).map((t) => ({ ...t, ticket }));
}
