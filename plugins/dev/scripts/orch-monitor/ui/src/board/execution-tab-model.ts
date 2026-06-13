// execution-tab-model.ts — pure, DOM-free derivations for the Execution tab.
// CTL-1102. All functions take already-loaded data and return plain objects;
// no fetch, no React, no DOM.
import type { Journey, JourneyHop } from "../lib/journey-model";
import { journeyPhaseStatus } from "../lib/journey-model";
import type { BoardTicket, BoardPhaseTiming, BoardAttention } from "./types";

// ── public interfaces ─────────────────────────────────────────────────────────

export interface NowCard {
  phaseLabel: string;
  status: "done" | "current" | "pending" | "failed" | "unknown";
  nextLabel: string | null;
  attention: BoardAttention | null;
}

export interface IdleGap {
  afterPhase: string;
  beforePhase: string;
  ms: number;
}

export type ExceptionKind =
  | "failure"
  | "held"
  | "operator-note"
  | "auto-unstuck"
  | "remediate-cycles"
  | "verify-failure"
  | "decision-ahead";

export interface ExceptionRow {
  kind: ExceptionKind;
  phase: string | null;
  detail: string;
  ts?: string;
}

export interface ArtifactRow {
  phase: string;
  research?: { path: string; peek: string | null } | null;
  plan?: { path: string; peek: string | null } | null;
  branch?: string | null;
  pr?: number | null;
  verifyVerdict?: string | null;
}

// ── internal helpers ──────────────────────────────────────────────────────────

/** Sort hops ascending by ts (ISO strings sort lexicographically). */
function sortHops(hops: JourneyHop[]): JourneyHop[] {
  return [...hops].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/** Find the longest idle gap in a sorted hop list by looking at complete→started pairs. */
function longestIdleGapMs(sorted: JourneyHop[]): { ms: number; phase: string } | null {
  let best: { ms: number; phase: string } | null = null;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a.eventType !== "complete" || b.eventType !== "started") continue;
    const ms = Date.parse(b.ts) - Date.parse(a.ts);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    if (best === null || ms > best.ms) best = { ms, phase: a.phase };
  }
  return best;
}

// ── buildNowCard ──────────────────────────────────────────────────────────────

/** Derive the NOW card from the resident ticket + journey. Returns null when
 *  ticket is undefined (off-board with no resident data). */
export function buildNowCard(
  ticket: BoardTicket | undefined,
  journey: Journey | null,
): NowCard | null {
  if (!ticket) return null;

  let status: NowCard["status"] = "unknown";
  if (journey) {
    const ps = journeyPhaseStatus(journey, ticket.phase);
    status = ps;
  }

  return {
    phaseLabel: ticket.phase,
    status,
    nextLabel: journey?.gates.nextPhase ?? null,
    attention: ticket.attention ?? null,
  };
}

// ── buildNarrativeSummary ─────────────────────────────────────────────────────

/** Produce a plain-language summary of the ticket's execution history. Pure;
 *  never returns undefined or NaN in the output string. */
export function buildNarrativeSummary(journey: Journey | null): string {
  if (!journey) return "No execution history recorded.";

  const sorted = sortHops(journey.hops);

  // First failed hop
  const firstFailed = sorted.find(
    (h) => h.eventType === "failed" || h.eventType === "stalled",
  );

  // Remediate cycles
  const cycles = journey.remediateCycles;

  // Longest idle gap
  const idleGap = longestIdleGapMs(sorted);

  const parts: string[] = [];

  if (sorted.length === 0) {
    parts.push("No activity recorded yet.");
  } else if (firstFailed) {
    const reason = firstFailed.reason ? ` (${firstFailed.reason})` : "";
    parts.push(`Failed during ${firstFailed.phase}${reason}.`);
  } else {
    const phases = [...new Set(sorted.filter((h) => h.eventType === "complete").map((h) => h.phase))];
    if (phases.length > 0) {
      parts.push(`Completed phases: ${phases.join(", ")}.`);
    }
  }

  if (cycles > 0) {
    parts.push(`Went through ${cycles} remediate ${cycles === 1 ? "cycle" : "cycles"}.`);
  }

  if (idleGap && idleGap.ms > 5_000) {
    const secs = Math.round(idleGap.ms / 1000);
    const display = secs >= 60 ? `${Math.round(secs / 60)}m` : `${secs}s`;
    parts.push(`Longest idle gap: ${display} after ${idleGap.phase}.`);
  }

  if (journey.gates.nextPhase) {
    parts.push(`Next: ${journey.gates.nextPhase}.`);
  }

  return parts.length > 0 ? parts.join(" ") : "Execution in progress.";
}

// ── buildIdleGaps ─────────────────────────────────────────────────────────────

/** Compute idle gaps (completedAt[N] → startedAt[N+1]) from phaseSummary.
 *  Skips any pair where either timestamp is missing or unparseable (no NaN). */
export function buildIdleGaps(phaseSummary: BoardPhaseTiming[]): IdleGap[] {
  const gaps: IdleGap[] = [];
  for (let i = 0; i < phaseSummary.length - 1; i++) {
    const curr = phaseSummary[i];
    const next = phaseSummary[i + 1];
    if (!curr.completedAt || !next.startedAt) continue;
    const ms = Date.parse(next.startedAt) - Date.parse(curr.completedAt);
    if (!Number.isFinite(ms)) continue;
    gaps.push({ afterPhase: curr.phase, beforePhase: next.phase, ms });
  }
  return gaps;
}

// ── buildExceptionsList ───────────────────────────────────────────────────────

/** Union all exceptions from the journey into a flat list. Returns [] when
 *  journey is null or nothing unusual happened. */
export function buildExceptionsList(
  journey: Journey | null,
  _ticket: BoardTicket | undefined,
): ExceptionRow[] {
  if (!journey) return [];

  const rows: ExceptionRow[] = [];
  const sorted = sortHops(journey.hops);

  // Failed / stalled hops
  for (const h of sorted) {
    if (h.eventType === "failed" || h.eventType === "stalled") {
      const detail = h.reason ? `${h.eventType}: ${h.reason}` : h.eventType;
      rows.push({ kind: "failure", phase: h.phase, detail, ts: h.ts });
    }
    // Held hops (advance phase with held eventType)
    if (h.phase === "advance" && h.eventType === "held") {
      const blockers = h.blockers ? ` blockers: ${JSON.stringify(h.blockers)}` : "";
      rows.push({ kind: "held", phase: h.phase, detail: `held${blockers}`, ts: h.ts });
    }
  }

  // unblockHints → operator-note / auto-unstuck
  for (const hint of journey.unblockHints) {
    if (hint.kind === "operator-note") {
      rows.push({ kind: "operator-note", phase: null, detail: hint.note ?? "operator note" });
    } else if (hint.kind === "auto-unstuck") {
      rows.push({ kind: "auto-unstuck", phase: null, detail: hint.reason ?? "auto-unstuck" });
    }
  }

  // remediate cycles
  if (journey.remediateCycles > 0) {
    rows.push({
      kind: "remediate-cycles",
      phase: "verify",
      detail: `${journey.remediateCycles} remediate ${journey.remediateCycles === 1 ? "cycle" : "cycles"}`,
    });
  }

  // verify verdict failure
  if (journey.verifyVerdict.verdict === "fail") {
    const hf = journey.verifyVerdict.highFindings ?? 0;
    const rr = journey.verifyVerdict.regressionRisk ?? 0;
    rows.push({
      kind: "verify-failure",
      phase: "verify",
      detail: `verify failed — ${hf} high findings, regression risk: ${rr}`,
    });
  }

  // decision-ahead from nextPhase
  if (journey.gates.nextPhase) {
    rows.push({
      kind: "decision-ahead",
      phase: journey.gates.nextPhase,
      detail: `next phase: ${journey.gates.nextPhase}`,
    });
  }

  return rows;
}

// ── buildArtifactsRows ────────────────────────────────────────────────────────

/** Join artifact docs, branch/PR, and verify verdict into per-phase rows.
 *  Returns [] when nothing is available. Missing fields are absent (null),
 *  never fabricated. */
export function buildArtifactsRows(
  artifacts: Array<{ kind: string; path: string; peek: string | null }>,
  ticket: BoardTicket | undefined,
  journey: Journey | null,
): ArtifactRow[] {
  const rows: ArtifactRow[] = [];

  // Research artifacts
  const research = artifacts.filter((a) => a.kind === "research");
  for (const a of research) {
    rows.push({ phase: "research", research: { path: a.path, peek: a.peek } });
  }

  // Plan artifacts
  const plans = artifacts.filter((a) => a.kind === "plan");
  for (const a of plans) {
    rows.push({ phase: "plan", plan: { path: a.path, peek: a.peek } });
  }

  // PR from ticket
  if (ticket?.pr != null) {
    rows.push({ phase: "pr", pr: ticket.pr });
  }

  // Verify verdict from journey
  if (journey?.verifyVerdict.verdict != null) {
    rows.push({ phase: "verify", verifyVerdict: journey.verifyVerdict.verdict });
  }

  return rows;
}
