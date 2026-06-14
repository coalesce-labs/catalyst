// process-model.ts — CTL-1101 Phase 2. Pure model: takes a FsmDescriptor and
// returns nodes/edges/glyphs/facts. No DOM, no @xyflow/react. The render-from-
// descriptor invariant is the spine of the feature — no phase names are hard-
// coded; everything flows from the descriptor argument.
import { C, PHASE } from "../board/board-tokens";

// ── Types ─────────────────────────────────────────────────────────────────────

export type EdgeKind =
  | "advance"
  | "revive"
  | "escalation"
  | "park"
  | "turn-cap"
  | "resume"
  | "remediate-cycle";

export type TaxonomyGroup = "ADVANCE" | "DETOUR" | "RESILIENCE" | "PARK";

export type NodeKind = "phase" | "remediate" | "siding" | "terminal" | "queued";
export type NodeLane = "entry" | "pipeline" | "remediate" | "siding" | "terminal";

export interface ProcessNode {
  id: string;
  type: NodeKind;
  lane: NodeLane;
  position: { x: number; y: number };
  data: {
    label: string;
    phase: string;
    phaseColor: string;
    sub?: string | null;
    glyphs?: string[];
    cycleCap?: number;
    [key: string]: unknown;
  };
}

export interface ProcessEdge {
  edgeId: string;
  from: string;
  to: string;
  kind: string;
  group: TaxonomyGroup;
  guardText: string | null;
  datalog: string | null;
  sourceRef: string | null;
  classification: string;
}

export interface ProcessGlyph {
  nodeId: string;
  kind: string;
}

export interface MachineFacts {
  entryPhase: string;
  terminalPhase: string;
  remediateCycleCap: number;
  reviveBudget: number;
  nonPreemptable: string[];
  cycleId: string;
  cycleMembers: string[];
  effortRulesProse: string;
  descriptorSha: string | null;
  rulesSha: string | null;
}

export interface ProcessModel {
  nodes: ProcessNode[];
  edges: ProcessEdge[];
  glyphs: ProcessGlyph[];
  facts: MachineFacts;
}

export interface EdgeObject {
  edgeId: string;
  from: string;
  to: string;
  kind: string;
  guardText: string | null;
  datalog: string | null;
  sourceRef: string | null;
  classification: string;
}

export interface FsmDescriptor {
  phases: string[];
  nextPhase: Record<string, string>;
  stageRank: Record<string, number>;
  terminalPhase: string;
  entryPhase: string;
  nonPreemptable: string[];
  ancillaryPhases: string[];
  remediateCycleCap: number;
  reviveBudget: number;
  cycles: Array<{ id: string; members: string[]; cap: number }>;
  transitions: EdgeObject[];
  descriptorSha: string | null;
  rulesSha: string | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const EDGE_TAXONOMY: Record<EdgeKind, TaxonomyGroup> = {
  advance: "ADVANCE",
  revive: "DETOUR",
  escalation: "DETOUR",
  "turn-cap": "DETOUR",
  "remediate-cycle": "RESILIENCE",
  resume: "RESILIENCE",
  park: "PARK",
};

export const TAXONOMY_COLOR: Record<TaxonomyGroup, string> = {
  ADVANCE: C.fgDim,
  DETOUR: C.red,
  RESILIENCE: PHASE.remediate,
  PARK: C.fgMuted,
};

export const EFFORT_RULES_PROSE =
  "estimate < 3 → medium · ≥ 3 → high · ≥ 8 → xhigh + decompose";

const SELF_LOOP_KINDS = new Set<string>(["revive", "turn-cap"]);

/** Falls back to DETOUR for unknown kinds (never throws). */
export function edgeGroup(kind: string): TaxonomyGroup {
  return EDGE_TAXONOMY[kind as EdgeKind] ?? "DETOUR";
}

// ── Layout constants ──────────────────────────────────────────────────────────

const STEP_X = 180;
const PIPELINE_X_ORIGIN = 200;
const PIPELINE_Y = 200;
const REMEDIATE_Y = 70;
const SIDING_Y = 340;
const TERMINAL_Y_DONE = 170;
const TERMINAL_Y_STALLED = 230;

function xForRank(rank: number): number {
  return PIPELINE_X_ORIGIN + rank * STEP_X;
}

// ── buildProcessModel ─────────────────────────────────────────────────────────

export function buildProcessModel(d: FsmDescriptor): ProcessModel {
  const ancillarySet = new Set(d.ancillaryPhases);
  const pipelinePhases = d.phases.filter((p) => !ancillarySet.has(p));

  // ── Nodes ────────────────────────────────────────────────────────────────

  const nodes: ProcessNode[] = [];

  // (queued) synthetic entry node — before rank 0
  const minRank = Math.min(...pipelinePhases.map((p) => d.stageRank[p] ?? 0));
  nodes.push({
    id: "(queued)",
    type: "queued",
    lane: "entry",
    position: { x: xForRank(minRank) - STEP_X, y: PIPELINE_Y },
    data: { label: "queued", phase: "(queued)", phaseColor: C.fgDim },
  });

  // Pipeline phases (derived from descriptor order)
  for (const phase of pipelinePhases) {
    const rank = d.stageRank[phase] ?? 0;
    nodes.push({
      id: phase,
      type: "phase",
      lane: "pipeline",
      position: { x: xForRank(rank), y: PIPELINE_Y },
      data: {
        label: phase,
        phase,
        phaseColor: PHASE[phase] ?? C.fgDim,
      },
    });
  }

  // Ancillary phases (remediate) — floating above pipeline, at their stageRank x
  for (const phase of d.ancillaryPhases) {
    const rank = d.stageRank[phase] ?? 4;
    nodes.push({
      id: phase,
      type: "remediate",
      lane: "remediate",
      position: { x: xForRank(rank), y: REMEDIATE_Y },
      data: {
        label: phase,
        phase,
        phaseColor: PHASE[phase] ?? C.fgDim,
        cycleCap: d.remediateCycleCap,
      },
    });
  }

  // needs-input siding — below pipeline, at the mid-pipeline x
  const midRank = Math.floor((minRank + Math.max(...pipelinePhases.map((p) => d.stageRank[p] ?? 0))) / 2);
  nodes.push({
    id: "needs-input",
    type: "siding",
    lane: "siding",
    position: { x: xForRank(midRank), y: SIDING_Y },
    data: { label: "needs-input", phase: "needs-input", phaseColor: C.fgMuted },
  });

  // Terminal sinks — far right of the pipeline
  const maxRank = Math.max(...pipelinePhases.map((p) => d.stageRank[p] ?? 0));
  const terminalX = xForRank(maxRank) + STEP_X;
  nodes.push({
    id: "(done)",
    type: "terminal",
    lane: "terminal",
    position: { x: terminalX, y: TERMINAL_Y_DONE },
    data: { label: "done", phase: "(done)", phaseColor: C.green },
  });
  nodes.push({
    id: "(stalled)",
    type: "terminal",
    lane: "terminal",
    position: { x: terminalX, y: TERMINAL_Y_STALLED },
    data: { label: "stalled", phase: "(stalled)", phaseColor: C.red },
  });

  // ── Edges + Glyphs ────────────────────────────────────────────────────────

  const edges: ProcessEdge[] = [];
  const glyphs: ProcessGlyph[] = [];

  for (const t of d.transitions) {
    if (SELF_LOOP_KINDS.has(t.kind) && t.from === t.to) {
      // Self-loop → glyph on the node, not an edge
      glyphs.push({ nodeId: t.from, kind: t.kind });
    } else {
      edges.push({
        edgeId: t.edgeId,
        from: t.from,
        to: t.to,
        kind: t.kind,
        group: edgeGroup(t.kind),
        guardText: t.guardText,
        datalog: t.datalog,
        sourceRef: t.sourceRef,
        classification: t.classification,
      });
    }
  }

  // ── Facts ─────────────────────────────────────────────────────────────────

  const firstCycle = d.cycles[0] ?? { id: "", members: [] };
  const facts: MachineFacts = {
    entryPhase: d.entryPhase,
    terminalPhase: d.terminalPhase,
    remediateCycleCap: d.remediateCycleCap,
    reviveBudget: d.reviveBudget,
    nonPreemptable: d.nonPreemptable,
    cycleId: firstCycle.id,
    cycleMembers: firstCycle.members,
    effortRulesProse: EFFORT_RULES_PROSE,
    descriptorSha: d.descriptorSha,
    rulesSha: d.rulesSha,
  };

  return { nodes, edges, glyphs, facts };
}
