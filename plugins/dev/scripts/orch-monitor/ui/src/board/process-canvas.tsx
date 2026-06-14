// process-canvas.tsx — CTL-1101 Phase 3. React Flow canvas for the FSM
// machine map. Node types + ProcessSurface component. Render-seam helpers
// (edgeStyleForKind, toFlowEdges, etc.) live in process-surface.ts (tested);
// this file carries the DOM-bound React portions — not imported in bun test.
// Named process-canvas (not process-surface) to avoid bun's .tsx-before-.ts
// resolution ordering shadowing process-surface.ts in the test runner.
import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  type Node,
  type NodeTypes,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { C } from "./board-tokens";
import { toFlowEdges, nodeBorderColor, PHASE_NODE_GEOMETRY } from "./process-surface";
import type { ProcessModel } from "../lib/process-model";

const CANVAS_HEIGHT = 400;

// ── CTL-1020 invisible Handle stanza ─────────────────────────────────────────
// RF v12 gates isNodeInitialized on handleBounds — a node without mounted
// Handles causes every outgoing/incoming edge to be silently dropped. Handles
// are opacity:0 / width:1 / isConnectable:false (read-only canvas).
const HANDLE_STYLE = {
  opacity: 0,
  border: "none",
  background: "transparent",
  width: 1,
  height: 1,
};

function LRHandles() {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Right} isConnectable={false} style={HANDLE_STYLE} />
    </>
  );
}

// RemediateNode (above pipeline) and SidingNode (below) receive vertical edges
// (verify⇄remediate cycle / park / resume) so they ALSO need Top+Bottom handles.
function AllHandles() {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Right} isConnectable={false} style={HANDLE_STYLE} />
      <Handle type="target" position={Position.Top} isConnectable={false} style={HANDLE_STYLE} id="top" />
      <Handle type="source" position={Position.Bottom} isConnectable={false} style={HANDLE_STYLE} id="bottom" />
    </>
  );
}

// ── Node data shape ───────────────────────────────────────────────────────────

interface PhaseNodeData {
  label: string;
  phase: string;
  phaseColor: string;
  sub?: string | null;
  glyphs?: string[];
  cycleCap?: number;
  [key: string]: unknown;
}

const GLYPH_SYMBOL: Record<string, string> = { revive: "↺", "turn-cap": "⏱" };

// ── Custom node components ────────────────────────────────────────────────────

function PhaseNode({ data }: { data: PhaseNodeData }) {
  const { width, height, accentWidth, radius } = PHASE_NODE_GEOMETRY;
  const accent = nodeBorderColor(data.phase);
  return (
    <div
      style={{
        width,
        height,
        background: C.s2,
        border: `1px solid ${C.borderSubtle}`,
        borderLeft: `${accentWidth}px solid ${accent}`,
        borderRadius: radius,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 8px 0 10px",
        boxSizing: "border-box",
        position: "relative",
        userSelect: "none",
      }}
    >
      <LRHandles />
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: C.fg,
          overflow: "hidden",
          whiteSpace: "nowrap",
          textOverflow: "ellipsis",
          flex: 1,
        }}
      >
        {data.label}
      </span>
      {data.glyphs && data.glyphs.length > 0 && (
        <span style={{ fontSize: 9, color: C.fgDim, display: "flex", gap: 2, flexShrink: 0, marginLeft: 4 }}>
          {data.glyphs.map((g) => (
            <span key={g} title={g}>
              {GLYPH_SYMBOL[g] ?? g}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

function RemediateNode({ data }: { data: PhaseNodeData }) {
  const { width, height, accentWidth, radius } = PHASE_NODE_GEOMETRY;
  return (
    <div
      style={{
        width,
        height,
        background: C.s2,
        border: `1px solid ${C.borderSubtle}`,
        borderLeft: `${accentWidth}px solid ${data.phaseColor}`,
        borderRadius: radius,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 8px 0 10px",
        boxSizing: "border-box",
        userSelect: "none",
        opacity: 0.9,
      }}
    >
      <AllHandles />
      <span style={{ fontSize: 12, fontWeight: 600, color: C.fg, flex: 1 }}>{data.label}</span>
      {data.cycleCap != null && (
        <span style={{ fontSize: 9, color: C.fgDim, fontFamily: C.mono, flexShrink: 0 }}>
          cap {data.cycleCap}
        </span>
      )}
    </div>
  );
}

function SidingNode({ data }: { data: PhaseNodeData }) {
  const { width, height, radius } = PHASE_NODE_GEOMETRY;
  return (
    <div
      style={{
        width,
        height,
        background: C.subtle,
        border: `1px dashed ${C.border}`,
        borderRadius: radius,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
        userSelect: "none",
        opacity: 0.85,
      }}
    >
      <AllHandles />
      <span style={{ fontSize: 11, color: C.fgMuted, fontStyle: "italic" }}>{data.label}</span>
    </div>
  );
}

function TerminalNode({ data }: { data: PhaseNodeData }) {
  const { width, height, accentWidth, radius } = PHASE_NODE_GEOMETRY;
  return (
    <div
      style={{
        width,
        height,
        background: C.s2,
        border: `1px solid ${data.phaseColor}44`,
        borderLeft: `${accentWidth}px solid ${data.phaseColor}`,
        borderRadius: radius,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
        userSelect: "none",
      }}
    >
      <LRHandles />
      <span style={{ fontSize: 12, fontWeight: 600, color: data.phaseColor }}>{data.label}</span>
    </div>
  );
}

function QueuedNode({ data }: { data: PhaseNodeData }) {
  const { width, height, radius } = PHASE_NODE_GEOMETRY;
  return (
    <div
      style={{
        width,
        height,
        background: C.subtle,
        border: `1px solid ${C.borderSubtle}`,
        borderRadius: radius,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
        userSelect: "none",
        opacity: 0.7,
      }}
    >
      <LRHandles />
      <span style={{ fontSize: 11, color: C.fgDim, fontStyle: "italic" }}>{data.label}</span>
    </div>
  );
}

// NODE_TYPES must be defined outside the component (RF invariant — object ref
// stability prevents node unmount/remount on every parent render).
const NODE_TYPES: NodeTypes = {
  phase: PhaseNode as never,
  remediate: RemediateNode as never,
  siding: SidingNode as never,
  terminal: TerminalNode as never,
  queued: QueuedNode as never,
};

// ── ProcessSurface ────────────────────────────────────────────────────────────

export interface ProcessSurfaceProps {
  model: ProcessModel;
  children?: React.ReactNode;
}

export function ProcessSurface({ model, children }: ProcessSurfaceProps) {
  const rfNodes = useMemo<Node[]>(
    () =>
      model.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: n.data,
      })),
    [model.nodes],
  );

  const rfEdges = useMemo(() => toFlowEdges(model.edges), [model.edges]);

  const [nodes, , onNodesChange] = useNodesState(rfNodes);
  const [edges, , onEdgesChange] = useEdgesState(rfEdges);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1, width: "100%" }}>
      <div
        style={{
          height: CANVAS_HEIGHT,
          width: "100%",
          flex: "0 0 auto",
          borderBottom: `1px solid ${C.borderSubtle}`,
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.2}
          maxZoom={2}
          colorMode="dark"
          style={{ background: C.s1 }}
          proOptions={{ hideAttribution: false }}
        >
          <Background color={C.borderSubtle} variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls style={{ background: C.s2, border: `1px solid ${C.border}` }} />
        </ReactFlow>
      </div>
      {/* Phase 4 rail + mirror + footer mount via children */}
      {children}
    </div>
  );
}
