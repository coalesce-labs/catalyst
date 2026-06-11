// dependency-graph.tsx — React Flow dependency graph for the orch-monitor board.
// CTL-948 (DEP-GRAPH): renders the backlog as a directed graph (ticket nodes linked
// by blocked_by edges) and a per-ticket subgraph (±2-hop neighborhood).
//
// TWO entry points:
//
//   <BacklogDepGraph tickets payload />
//     Full backlog as a DAG. Auto-layout via dagre (LR, dependency→execution
//     order left to right). Click a node → navigate to /ticket/$id.
//     Mounted as a new route at /dep-graph (and a "Graph" toggle in the Board
//     subhead when layout === "graph").
//
//   <TicketDepSubGraph ticket payload />
//     Per-ticket neighborhood: the focused ticket at center, up to 2 hops of
//     blocked_by (what this depends on) and up to 2 hops of the reverse index
//     (what this blocks). Honest empty-state when there are no deps.
//     Mounted inside ticket-detail-page.tsx below the PIPELINE rail.
//
// Theme: C tokens from board-tokens.ts (dark + warm-light palette). LIVE (#53cde2)
// is reserved for in-loop workers — it never appears as a graph accent here.
//
// Auto-layout: @dagrejs/dagre positions nodes LR with rankdir="LR" so the flow
// reads left (blockers) → right (dependents). Applied synchronously before first
// render so there is never a layout-jump frame.

import { useCallback, useMemo, type MouseEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  type Node,
  type Edge,
  type NodeTypes,
  useNodesState,
  useEdgesState,
  Position,
} from "@xyflow/react";
// `NodeMouseHandler` is not exported from @xyflow/react public API; inline the type.
type NodeClickHandler = (event: MouseEvent, node: Node) => void;
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import { C, PHASE } from "./board-tokens";
import { Badge } from "@/components/ui/badge";
import type { BoardTicket } from "./types";

// ── dagre layout constants ───────────────────────────────────────────────────
const NODE_WIDTH = 180;
const NODE_HEIGHT = 60;
const SUBGRAPH_NODE_HEIGHT = 68;

/**
 * Run dagre LR layout over nodes + edges (in-place mutation on node.position).
 * Returns the laid-out nodes with updated x/y.
 */
function applyDagreLayout(
  nodes: Node[],
  edges: Edge[],
  nodeHeight = NODE_HEIGHT,
): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 60, marginx: 24, marginy: 24 });

  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: nodeHeight });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  return nodes.map((n) => {
    const { x, y } = g.node(n.id);
    return {
      ...n,
      position: { x: x - NODE_WIDTH / 2, y: y - nodeHeight / 2 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    };
  });
}

// ── scope label helpers ──────────────────────────────────────────────────────
// Maps the raw scope string stored on BoardTicket to the 2-letter display abbr
// used everywhere else in the board (e.g. Board.tsx SCOPE_ABBR). Raw values
// come from Linear's estimate field as lowercase size names.
const SCOPE_ABBR: Record<string, string> = {
  xs: "XS",
  small: "S",
  medium: "M",
  large: "L",
  xl: "XL",
};

// ── shared node color helpers ────────────────────────────────────────────────
function phaseColor(phase: string): string {
  return PHASE[phase] ?? C.fgDim;
}

// ── TicketNode custom React Flow node ────────────────────────────────────────
// A compact card: ID monospace chip · title truncated · scope/estimate badge.
// Colored left-border uses the phase color. Used in both graph variants.
// `terminal` = true for Done/excluded tickets included only to anchor an edge.
interface TicketNodeData {
  id: string;
  title: string;
  phase: string;
  estimate: number | null;
  scope: string | null;
  focused?: boolean;
  terminal?: boolean; // Done/excluded node — dimmed, exists only to draw edges
  [key: string]: unknown;
}

function TicketNode({ data }: { data: TicketNodeData }) {
  const pc = data.terminal ? C.fgDim : phaseColor(data.phase);
  const scopeLabel = data.estimate != null
    ? `${data.estimate}pt`
    : data.scope
    ? (SCOPE_ABBR[data.scope.toLowerCase()] ?? data.scope.toUpperCase().slice(0, 2))
    : null;

  return (
    <div
      style={{
        background: data.terminal ? C.s1 : data.focused ? C.s3 : C.s2,
        border: `1px solid ${data.focused ? pc : C.border}`,
        borderLeft: `3px solid ${pc}`,
        opacity: data.terminal ? 0.55 : 1,
        borderRadius: 7,
        padding: "7px 10px",
        width: NODE_WIDTH,
        minHeight: NODE_HEIGHT,
        display: "flex",
        flexDirection: "column",
        gap: 3,
        cursor: "pointer",
        boxShadow: data.focused ? `0 0 0 2px ${pc}44` : "none",
        userSelect: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
        <span
          style={{
            fontFamily: C.mono,
            fontSize: 10.5,
            fontWeight: 700,
            color: pc,
            whiteSpace: "nowrap",
          }}
        >
          {data.id}
        </span>
        {scopeLabel && (
          <Badge
            variant="outline"
            style={{ fontFamily: C.mono, fontSize: 9, padding: "0 5px", height: 16, lineHeight: "16px" }}
          >
            {scopeLabel}
          </Badge>
        )}
      </div>
      <div
        style={{
          fontSize: 11,
          color: C.fg,
          lineHeight: 1.35,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {data.title}
      </div>
    </div>
  );
}

const NODE_TYPES: NodeTypes = { ticket: TicketNode };

// ── shared edge style ────────────────────────────────────────────────────────
function makeEdge(source: string, target: string, label?: string): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    // source is the blocker, target is the blocked ticket — LR so the arrow
    // points toward the dependent (execution order).
    animated: false,
    style: { stroke: C.fgDim, strokeWidth: 1.5, opacity: 0.7 },
    labelStyle: { fontSize: 10, fill: C.fgDim },
    label,
  };
}

// ── BacklogDepGraph ──────────────────────────────────────────────────────────
// The full backlog DAG. All tickets that have at least one blocker or block at
// least one other ticket are included; isolated tickets are filtered out to keep
// the graph readable (the board list already covers them).

export interface BacklogDepGraphProps {
  tickets: BoardTicket[];
  /** Optional: pre-filter to only these ticket ids (repo/team filter upstream). */
  visibleIds?: Set<string>;
}

export function BacklogDepGraph({ tickets, visibleIds }: BacklogDepGraphProps) {
  const navigate = useNavigate();

  // Build a reverse index: id → ids that list it in their blockers[]
  const blockedByMap = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of tickets) {
      for (const b of t.blockers ?? []) {
        if (!m.has(b)) m.set(b, []);
        m.get(b)!.push(t.id);
      }
    }
    return m;
  }, [tickets]);

  // Tickets that participate in at least one dep relation AND are in the visible set
  const participating = useMemo(() => {
    const ids = new Set<string>();
    for (const t of tickets) {
      if ((t.blockers?.length ?? 0) > 0 || blockedByMap.has(t.id)) {
        if (!visibleIds || visibleIds.has(t.id)) ids.add(t.id);
      }
    }
    return ids;
  }, [tickets, visibleIds, blockedByMap]);

  const ticketById = useMemo(() => new Map(tickets.map((t) => [t.id, t])), [tickets]);

  const { nodes: rawNodes, edges: rawEdges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const addedNodeIds = new Set<string>();

    // Helper: add a node (idempotent by addedNodeIds)
    function addNode(id: string, terminal: boolean) {
      if (addedNodeIds.has(id)) return;
      addedNodeIds.add(id);
      const t = ticketById.get(id);
      nodes.push({
        id,
        type: "ticket",
        position: { x: 0, y: 0 }, // dagre fills this
        data: {
          id,
          title: t?.title ?? id, // fallback to id for completely unknown tickets
          phase: t?.phase ?? "done",
          estimate: t?.estimate ?? null,
          scope: t?.scope ?? null,
          terminal,
        } satisfies TicketNodeData,
      });
    }

    for (const id of participating) {
      addNode(id, false);
      const t = ticketById.get(id);

      // Edge from each blocker → this ticket (blocker must execute first → left of target)
      for (const blockerId of t?.blockers ?? []) {
        if (!addedNodeIds.has(blockerId)) {
          // Blocker is not in participating set (Done/excluded) — add as terminal node
          // so the edge has both endpoints and actually renders.
          if (!participating.has(blockerId)) {
            addNode(blockerId, true);
          }
        }
        edges.push(makeEdge(blockerId, id));
      }
    }

    const laid = applyDagreLayout(nodes, edges, NODE_HEIGHT);
    return { nodes: laid, edges };
  }, [participating, ticketById]);

  const [nodes, , onNodesChange] = useNodesState(rawNodes);
  const [flowEdges, , onEdgesChange] = useEdgesState(rawEdges);

  const onNodeClick: NodeClickHandler = useCallback(
    (_evt, node) => {
      void navigate({ to: "/ticket/$id", params: { id: node.id }, search: { from: "board" } });
    },
    [navigate],
  );

  if (participating.size === 0) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          gap: 8,
          color: C.fgMuted,
          fontSize: 13,
        }}
      >
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={C.fgDim} strokeWidth="1.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M8 12h8M12 8v8" />
        </svg>
        <span>No dependency links found in the current backlog.</span>
        <span style={{ fontSize: 11, color: C.fgDim }}>
          Tickets with blocked_by relations appear here.
        </span>
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={flowEdges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={onNodeClick}
      nodeTypes={NODE_TYPES}
      fitView
      fitViewOptions={{ padding: 0.15 }}
      minZoom={0.2}
      maxZoom={2}
      colorMode="dark"
      style={{ background: C.s0 }}
      proOptions={{ hideAttribution: false }}
    >
      <Background color={C.borderSubtle} variant={BackgroundVariant.Dots} gap={20} size={1} />
      <Controls style={{ background: C.s2, border: `1px solid ${C.border}` }} />
    </ReactFlow>
  );
}

// ── TicketDepSubGraph ────────────────────────────────────────────────────────
// Per-ticket neighborhood: centered on `focusId`, up to 2 hops backward
// (blocked_by chain — what this depends on) and up to 2 hops forward via
// the reverse index (what this ticket blocks).

export interface TicketDepSubGraphProps {
  focusId: string;
  tickets: BoardTicket[];
  /** If provided, cap the rendered height. Defaults to 340px. */
  height?: number;
}

export function TicketDepSubGraph({ focusId, tickets, height = 340 }: TicketDepSubGraphProps) {
  const navigate = useNavigate();

  const ticketById = useMemo(() => new Map(tickets.map((t) => [t.id, t])), [tickets]);

  // Reverse index: id → ids that list it as a blocker
  const reverseIndex = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of tickets) {
      for (const b of t.blockers ?? []) {
        if (!m.has(b)) m.set(b, []);
        m.get(b)!.push(t.id);
      }
    }
    return m;
  }, [tickets]);

  const { nodes: rawNodes, edges: rawEdges, hasDeps } = useMemo(() => {
    const included = new Set<string>();
    const edges: Edge[] = [];

    // BFS backward (what this ticket depends on — its blockers up to 2 hops).
    // Adds `id` to `included`, then recurses into each of its blockers.
    // Edges are only pushed when the neighbor is already/about-to-be included.
    function walkBackward(id: string, depth: number) {
      if (depth > 2 || included.has(id)) return;
      included.add(id);
      const t = ticketById.get(id);
      for (const blockerId of t?.blockers ?? []) {
        walkBackward(blockerId, depth + 1);
        // Only draw the edge if the blocker made it into the graph
        if (included.has(blockerId)) {
          edges.push(makeEdge(blockerId, id));
        }
      }
    }

    // BFS forward (what this ticket blocks — reverse index up to 2 hops).
    function walkForward(id: string, depth: number) {
      if (depth > 2 || included.has(id)) return;
      included.add(id);
      for (const blockedId of reverseIndex.get(id) ?? []) {
        walkForward(blockedId, depth + 1);
        if (included.has(blockedId)) {
          edges.push(makeEdge(id, blockedId));
        }
      }
    }

    // Start with the focused ticket itself
    included.add(focusId);
    const focusTicket = ticketById.get(focusId);
    for (const blockerId of focusTicket?.blockers ?? []) {
      walkBackward(blockerId, 1);
      // Edge from focus's direct blocker → focus (drawn only if blocker included)
      if (included.has(blockerId)) {
        edges.push(makeEdge(blockerId, focusId));
      }
    }
    for (const blockedId of reverseIndex.get(focusId) ?? []) {
      walkForward(blockedId, 1);
      if (included.has(blockedId)) {
        edges.push(makeEdge(focusId, blockedId));
      }
    }

    // Deduplicate edges (walkBackward + walkForward can both add the focus→neighbor edge)
    const seen = new Set<string>();
    const dedupedEdges = edges.filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });

    const hasDeps = included.size > 1;

    const nodes: Node[] = [];
    for (const id of included) {
      const t = ticketById.get(id);
      nodes.push({
        id,
        type: "ticket",
        position: { x: 0, y: 0 },
        data: {
          id,
          title: t?.title ?? id,
          phase: t?.phase ?? "todo",
          estimate: t?.estimate ?? null,
          scope: t?.scope ?? null,
          focused: id === focusId,
        } satisfies TicketNodeData,
      });
    }

    const laid = applyDagreLayout(nodes, dedupedEdges, SUBGRAPH_NODE_HEIGHT);
    return { nodes: laid, edges: dedupedEdges, hasDeps };
  }, [focusId, ticketById, reverseIndex]);

  const [nodes, , onNodesChange] = useNodesState(rawNodes);
  const [flowEdges, , onEdgesChange] = useEdgesState(rawEdges);

  const onNodeClick: NodeClickHandler = useCallback(
    (_evt, node) => {
      if (node.id === focusId) return; // clicking the focus node is a no-op
      void navigate({ to: "/ticket/$id", params: { id: node.id }, search: { from: "board" } });
    },
    [navigate, focusId],
  );

  if (!hasDeps) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 0",
          color: C.fgDim,
          fontSize: 12,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v4l3 3" />
        </svg>
        No dependency links — this ticket has no blockers and is not blocking any other ticket.
      </div>
    );
  }

  return (
    <div style={{ height, borderRadius: 8, overflow: "hidden", border: `1px solid ${C.borderSubtle}` }}>
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={2}
        colorMode="dark"
        style={{ background: C.s1 }}
        proOptions={{ hideAttribution: false }}
      >
        <Background color={C.borderSubtle} variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls style={{ background: C.s2, border: `1px solid ${C.border}` }} />
      </ReactFlow>
    </div>
  );
}
