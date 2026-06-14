// Type declarations for fsm-descriptor.mjs (CTL-1100 Phase 2).

export interface FsmEdge {
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
  transitions: FsmEdge[];
  descriptorSha: string;
  rulesSha: string | null;
}

/**
 * Enumerate all FSM transitions: advance edges (NEXT_PHASE), per-phase
 * non-linear edges (revive/escalation/park/turn-cap), needs-input→resume,
 * and the verify⇄remediate router cycle. Never drops an edge.
 */
export declare function enumerateTransitions(
  guards?: Record<string, unknown>
): FsmEdge[];

/**
 * Build the full /api/fsm/descriptor response object.
 * Async because it reads the raw descriptor file hash + RULES_SHA at request-time.
 */
export declare function buildFsmDescriptor(): Promise<FsmDescriptor>;
