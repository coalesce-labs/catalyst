// journey-model.ts — CTL-1100 Phase 6: /api/journey/:ticket model.
// Pure; no DOM dependency.

import { PHASE_LIST } from "../board/phase-model";

export interface JourneyHop {
  phase: string;
  eventType: string;
  ts: string;
  host: string;
  bg_job_id?: string;
  reason?: string;
  targetPhase?: string;
  blockers?: unknown[];
}

export interface JourneyGate {
  phase: string;
  signalStatus: string | null;
  satisfied: boolean;
}

export interface Journey {
  ticket: string;
  hops: JourneyHop[];
  gates: { checklist: JourneyGate[]; nextPhase: string | null };
  verifyVerdict: { verdict: string | null; regressionRisk?: number | null; highFindings?: number };
  remediateCycles: number;
  unblockHints: Array<{ kind: string; note?: string; reason?: string; blockers?: unknown[] }>;
  hosts: string[];
}

export function isJourney(v: unknown): v is Journey {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.ticket === "string" &&
    Array.isArray(r.hops) &&
    r.gates !== null && typeof r.gates === "object" &&
    Array.isArray((r.gates as Record<string, unknown>).checklist) &&
    Array.isArray(r.unblockHints) &&
    Array.isArray(r.hosts) &&
    typeof r.remediateCycles === "number"
  );
}

export type PhaseStatus = "done" | "current" | "pending" | "failed";

/** Derive the display status for a given phase in the 10-phase strip. */
export function journeyPhaseStatus(journey: Journey, phase: string): PhaseStatus {
  const gate = journey.gates.checklist.find((g) => g.phase === phase);
  if (!gate) return "pending";
  if (gate.satisfied) return "done";
  if (gate.signalStatus === "failed" || gate.signalStatus === "stalled") return "failed";
  // Verify in a fail cycle → show "failed" visually
  if (phase === "verify" && journey.verifyVerdict.verdict === "fail") return "failed";
  // Current = this is the nextPhase, or has a running signal
  if (phase === journey.gates.nextPhase) return "current";
  if (gate.signalStatus === "running" || gate.signalStatus === "stalled") return "current";
  if (gate.signalStatus !== null && gate.signalStatus !== "pending") return "current";
  return "pending";
}

export { PHASE_LIST };
