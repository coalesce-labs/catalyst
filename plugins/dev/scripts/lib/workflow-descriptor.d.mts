// Type declarations for workflow-descriptor.mjs — the single source of truth for
// the orchestration pipeline phase-list (derived from workflow.default.json).
// Lets type-checked TS consumers (e.g. the orch-monitor board drift-guard in
// orch-monitor/__tests__/board-phase-drift.test.ts) import PHASES / ANCILLARY_PHASES
// without a TS7016 implicit-any error. Keep in sync with the exports in
// workflow-descriptor.mjs. See docs/workflow-descriptors-design.md.

/** A `{field, op, value}` predicate + the levers it sets when it matches. */
export interface WorkflowRule {
  when: { field: string; op: string; value: unknown };
  set?: Record<string, string>;
  appendPreamble?: string[];
  appendPostamble?: string[];
}

/** A primary pipeline step (triage … monitor-deploy). */
export interface WorkflowStep {
  id: string;
  rank: number;
  preemptable?: boolean;
  linearKey: string | null;
  next: string | null;
  model?: string;
  effort?: string;
  rules?: WorkflowRule[];
}

/** An ancillary (off-mainline) step such as `remediate`. */
export interface WorkflowAncillaryStep {
  id: string;
  rank: number;
  linearKey: string | null;
  cycleWith?: string;
}

/** A bounded loop between steps (e.g. verify ⇄ remediate). */
export interface WorkflowCycle {
  id: string;
  members: string[];
  cap: number;
  countBy?: string;
  reset?: { signals: string[]; releaseClaims?: boolean };
}

/** The parsed workflow.default.json document. */
export interface WorkflowDescriptor {
  $comment?: string;
  schemaVersion: string;
  id: string;
  trigger: { kind: string };
  linearMirror: boolean;
  entryStep: string;
  terminalStep: string;
  steps: WorkflowStep[];
  ancillarySteps: WorkflowAncillaryStep[];
  cycles: WorkflowCycle[];
}

export const DESCRIPTOR_PATH: string;
export const descriptor: WorkflowDescriptor;

/** Ordered primary pipeline phase ids: ["triage", …, "monitor-deploy"]. */
export const PHASES: string[];
/** phase → its successor phase id (terminal phase maps to null). */
export const NEXT_PHASE: Record<string, string | null>;
/** phase → config stateMap key (NOT a human label); null for un-mirrored phases. */
export const PHASE_LINEAR_KEY: Record<string, string | null>;
/** phase → numeric rank (frozen; ancillary remediate is interleaved). */
export const STAGE_RANK: Readonly<Record<string, number>>;
export const TERMINAL_PHASE: string;
export const NEW_WORK_ENTRY_PHASE: string;
export const NON_PREEMPTABLE_PHASES: Set<string>;
/** Ancillary (off-mainline) phase ids, e.g. ["remediate"]. */
export const ANCILLARY_PHASES: string[];
export const REMEDIATE_PHASE: string;
export const REMEDIATE_CYCLE_CAP: number;
