// process-surface.ts — CTL-1101 Phase 3. Pure render-seam helpers for the
// ProcessSurface React Flow canvas. No DOM, no @xyflow/react — importable in
// bun test. process-surface.tsx (the React component) imports from here.
import type { Edge, MarkerType } from "@xyflow/react";
import { C, PHASE } from "./board-tokens";
import { edgeGroup, type ProcessEdge, type TaxonomyGroup } from "../lib/process-model";

export type { ProcessEdge };

// ── Geometry ──────────────────────────────────────────────────────────────────

export const PHASE_NODE_GEOMETRY = {
  width: 120,
  height: 44,
  accentWidth: 3,
  radius: 6,
} as const;

// ── Color helpers ─────────────────────────────────────────────────────────────

/** Left-border accent color for a phase node. "done" → green, "stalled" → red,
 *  "queued" → fgDim, pipeline phase → its PHASE color, fallback → fgDim. */
export function nodeBorderColor(phase: string): string {
  if (phase === "done") return C.green;
  if (phase === "stalled") return C.red;
  if (phase === "queued") return C.fgDim;
  return PHASE[phase] ?? C.fgDim;
}

// ── Edge helpers ──────────────────────────────────────────────────────────────

export interface EdgeStyle {
  type: "smoothstep";
  dashed: boolean;
  style: { stroke: string; strokeWidth: number; strokeDasharray?: string };
}

/** Visual style for a given edge kind. Advance = solid; every other taxonomy
 *  group = dashed. Never uses the reserved LIVE cyan (#53cde2). */
export function edgeStyleForKind(kind: string): EdgeStyle {
  const group: TaxonomyGroup = edgeGroup(kind);
  const dashed = group !== "ADVANCE";
  const stroke = kind === "escalation" ? C.red : C.fgDim;
  return {
    type: "smoothstep",
    dashed,
    style: {
      stroke,
      strokeWidth: 1.5,
      ...(dashed ? { strokeDasharray: "5 4" } : {}),
    },
  };
}

/** True when the transition is a revive or turn-cap self-loop (from===to and kind
 *  is in the self-loop set). These become corner glyphs, NOT graph edges. */
export function isGlyphSelfLoop(t: {
  from: string;
  to: string;
  kind: string;
}): boolean {
  return t.from === t.to && (t.kind === "revive" || t.kind === "turn-cap");
}

/** Convert ProcessEdge[] from the model to RF Edge[] for ReactFlow:
 *  1) drop self-loop glyphs (they're already partitioned out in the model but
 *     toFlowEdges is the final gate for the canvas);
 *  2) collapse the escalation family to ONE representative edge into "(stalled)"
 *     and the park family to ONE representative edge into "needs-input" — avoids
 *     per-phase spaghetti (10 identical escalation edges adds zero information);
 *  3) map survivors to RF Edge objects with smoothstep + ArrowClosed marker. */
export function toFlowEdges(edges: ProcessEdge[]): Edge[] {
  // Self-loop guard (belt-and-suspenders).
  const nonSelf = edges.filter((e) => !(isGlyphSelfLoop(e)));

  // Collapse escalation family → one representative.
  let escalationAdded = false;
  let parkAdded = false;
  const result: Edge[] = [];

  for (const e of nonSelf) {
    if (e.kind === "escalation") {
      if (escalationAdded) continue;
      escalationAdded = true;
    }
    if (e.kind === "park") {
      if (parkAdded) continue;
      parkAdded = true;
    }

    const { style, dashed } = edgeStyleForKind(e.kind);
    const group = edgeGroup(e.kind);
    result.push({
      id: e.edgeId,
      source: e.from,
      target: e.to,
      type: "smoothstep",
      animated: false,
      style: { ...style, opacity: dashed ? 0.75 : 0.9 },
      markerEnd: {
        type: "arrowclosed" as typeof MarkerType.ArrowClosed,
        width: 14,
        height: 14,
        color: style.stroke,
      },
      data: {
        kind: e.kind,
        group,
        guardText: e.guardText,
        datalog: e.datalog,
        sourceRef: e.sourceRef,
        classification: e.classification,
      },
    });
  }

  return result;
}
