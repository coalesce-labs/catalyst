// subagent-data.ts — PURE logic for the worker-detail v2 subworker tree/count
// (CTL-925 / WORKER-DETAIL v2 Pass B §5C). React-/DOM-free (the same discipline as
// worker-burn-data.ts / worker-now-data.ts) so the count + flatten + orchId
// derivation unit-test directly under `bun test` without an HTTP round-trip.
//
// The server's /api/worker/<orchId>/<ticket>/subagents endpoint returns a nested
// SubagentNode tree (lib/subagent-tree.ts buildSubagentTree). This module mirrors
// that wire shape (a UI subset — we read only the fields the compact tree renders),
// counts total descendant nodes via DFS, and flattens the tree to depth-stamped
// rows the renderer indents.
//
// ORCHID DERIVATION (the §5C honest-degraded caveat, GROUND-TRUTH verified): the
// server matches basename(orchDir) === orchId against scanned orchestrators. For
// execution-core workers the route id is "<TICKET> <phase>" and orch === ticket
// (parseAgentName board-data.mjs:274), but EC workers live under
// ~/catalyst/execution-core/workers/<TICKET>/ — NOT a per-orch run dir — so the
// scan finds no match and the endpoint 404s. Confirmed live on mini 2026-06-10:
// /api/worker/CTL-925/CTL-925/subagents → HTTP 404. We resolve the orchId the same
// way the page resolves worker identity (legacy o-<orch>:… → the orch; EC → the
// ticket) and handle the 404 as an honest "no orchestrator stream for this run"
// state — NEVER a fabricated zero count.

/** The subagent tree node — a UI subset of the server's SubagentNode
 *  (lib/subagent-tree.ts). We read only the fields the compact tree renders. */
export interface SubagentNode {
  toolUseId: string | null;
  parentToolUseId: string | null;
  description: string | null;
  subagentType: string | null;
  /** Total stream messages attributed to this node (a dim suffix in the tree). */
  messageCount: number;
  /** Todo count for the node (a dim suffix when > 0). The server attaches the
   *  full todo payloads; we only need the count for the compact line. */
  todos?: { status: string }[];
  children: SubagentNode[];
}

/** The /api/worker/<orchId>/<ticket>/subagents response shape. */
export interface SubagentsResponse {
  orchId: string;
  ticket: string;
  tree: SubagentNode;
}

/**
 * Resolve the orchId the page uses to address the subagents endpoint, the SAME
 * way the page resolves worker identity (mirrors parseAgentName board-data.mjs):
 *   • legacy `o-<orch>:<ticket>:<phase>:<cont>` → the `<orch>` segment.
 *   • execution-core `"<TICKET> <phase>"` → the ticket (orch === ticket).
 * Falls back to the resident `ticket` when the name matches neither pattern (the
 * endpoint will then 404 honestly rather than us guessing). Returns null when no
 * ticket is available either (no row to address — the panel dims).
 */
export function resolveSubagentOrchId(
  workerName: string | undefined,
  ticket: string | undefined,
): string | null {
  if (workerName) {
    const legacy = /^o-([^:]+):([^:]+):([^:]+):(\d+)$/.exec(workerName);
    if (legacy) return legacy[1];
    const ec = /^([A-Z]+-\d+)\s+([a-z-]+)$/.exec(workerName);
    if (ec) return ec[1];
  }
  return ticket ?? null;
}

/** Total DESCENDANT node count (every node below the root, via DFS of children).
 *  The root is the worker itself, so it is excluded — the count answers "how many
 *  subworkers did this worker spawn". 0 for a worker that spawned none (honest
 *  empty, never an error). */
export function countSubagents(root: SubagentNode | null | undefined): number {
  if (!root) return 0;
  let n = 0;
  const walk = (node: SubagentNode): void => {
    for (const child of node.children ?? []) {
      n += 1;
      walk(child);
    }
  };
  walk(root);
  return n;
}

/** One flattened tree row — a node plus its indent depth (root's direct children
 *  are depth 0). The renderer indents by `depth` and shows subagentType +
 *  description + the dim messageCount / todo suffix. */
export interface SubagentRow {
  toolUseId: string | null;
  depth: number;
  subagentType: string | null;
  description: string | null;
  messageCount: number;
  todoCount: number;
}

/** Max characters of a subagent description shown in the compact tree (§5C ~60). */
export const SUBAGENT_DESC_MAX = 60;

/** Truncate a description to `max` chars with an ellipsis, collapsing whitespace
 *  so a multi-line Task description reads as one line. null/empty → null. */
export function shortenDescription(
  desc: string | null | undefined,
  max: number = SUBAGENT_DESC_MAX,
): string | null {
  if (desc == null) return null;
  const oneLine = desc.replace(/\s+/g, " ").trim();
  if (oneLine === "") return null;
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/**
 * Flatten the subagent tree to depth-stamped rows (DFS, first-seen order — the
 * order the server built children in). The root (the worker itself) is NOT a row;
 * its direct children are depth 0. A `cap` bounds the row count (a "show more"
 * affordance in the renderer); the default keeps the tree from overwhelming the
 * panel (Principle: ≤ a sensible element count). Returns [] for a childless root.
 */
export function flattenSubagentRows(
  root: SubagentNode | null | undefined,
  cap = 40,
): { rows: SubagentRow[]; total: number; truncated: boolean } {
  const rows: SubagentRow[] = [];
  if (!root) return { rows, total: 0, truncated: false };
  const walk = (node: SubagentNode, depth: number): void => {
    for (const child of node.children ?? []) {
      rows.push({
        toolUseId: child.toolUseId,
        depth,
        subagentType: child.subagentType,
        description: child.description,
        messageCount: child.messageCount ?? 0,
        todoCount: child.todos?.length ?? 0,
      });
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  const total = rows.length;
  return {
    rows: rows.slice(0, cap),
    total,
    truncated: total > cap,
  };
}
