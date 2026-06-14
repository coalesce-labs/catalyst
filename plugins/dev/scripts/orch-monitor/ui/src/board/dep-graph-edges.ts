// dep-graph-edges.ts — PURE edge-derivation for the dependency graph (CTL-1020).
//
// Extracted from dependency-graph.tsx so the relation→edge mapping is unit-testable
// WITHOUT pulling in @xyflow/react (which needs a browser env). The component
// decorates these plain descriptors with React Flow styling via makeEdge().
//
// Contract:
//   - One directed edge per (blocker, blocked) pair, source=blocker, target=blocked
//     (the arrow reads blocker → blocked, i.e. execution order left→right).
//   - Node/edge ids are STRINGS; numeric-looking ids are stringified so they match
//     React Flow's nodeLookup Map keys (a number/string mismatch silently drops the
//     edge — checklist step 3).
//   - Missing-node tolerance: an edge whose endpoint is NOT a participating node is
//     reported as a `terminal` id so the caller can add a dimmed anchor node — the
//     edge is never dropped and never crashes (CTL-959 / CTL-1020).

/** A bare directed edge descriptor: blocker → blocked. */
export interface DepEdge {
  id: string;
  /** the blocker ticket id (executes first) */
  source: string;
  /** the blocked ticket id (depends on the blocker) */
  target: string;
}

/** Minimal shape this module needs off a BoardTicket. */
export interface DepNode {
  id: string;
  blockers?: string[] | null;
}

export interface BuildBacklogEdgesResult {
  edges: DepEdge[];
  /** ids referenced by an edge but absent from the participating set (Done/excluded). */
  terminals: string[];
}

/** Coerce any id to the string form React Flow uses for node lookups. */
function asId(id: unknown): string {
  return String(id);
}

/**
 * Build the directed edge list for the backlog dep graph.
 *
 * @param participatingIds the ticket ids that are rendered as primary nodes.
 * @param ticketsById       lookup from id → ticket (for reading blockers[]).
 *
 * For each participating ticket, draws an edge from every blocker → the ticket.
 * A blocker that is NOT in `participatingIds` is recorded as a terminal (the
 * caller renders it as a dimmed anchor node so the edge has both endpoints).
 * An edge referencing a blocker that is itself absent from the tickets map is
 * STILL emitted (with the blocker reported as terminal) — never dropped, never
 * throws.
 */
export function buildBacklogEdges(
  participatingIds: Iterable<string>,
  ticketsById: Map<string, DepNode>,
): BuildBacklogEdgesResult {
  const participating = new Set<string>();
  for (const id of participatingIds) participating.add(asId(id));

  const edges: DepEdge[] = [];
  const terminals = new Set<string>();
  const seen = new Set<string>();

  for (const ticketId of participating) {
    const t = ticketsById.get(ticketId);
    for (const rawBlocker of t?.blockers ?? []) {
      const blockerId = asId(rawBlocker);
      if (!blockerId) continue; // tolerate empty/nullish blocker entries
      if (!participating.has(blockerId)) terminals.add(blockerId);
      const id = `${blockerId}->${ticketId}`;
      if (seen.has(id)) continue; // dedupe identical relations
      seen.add(id);
      edges.push({ id, source: blockerId, target: ticketId });
    }
  }

  return { edges, terminals: [...terminals] };
}
