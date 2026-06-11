// phase-outcome-data.ts — PURE logic for the worker-detail v2 phase-aware
// "What it (is) doing / did" section (CTL-925 / WORKER-DETAIL v2 Pass B §6).
// React-/DOM-free (the discipline of worker-burn-data.ts / subagent-data.ts) so
// the phase→section mapping unit-tests directly under `bun test`. The renderer
// (phase-outcome.tsx) is a thin switch over the descriptor this module returns.
//
// GROUND-TRUTH (verified against live /api/ec-worker/<t>/<phase> on mini,
// 2026-06-10): the live phase SIGNAL carries only the lifecycle envelope
// (status / model / bg_job_id / startedAt / completedAt / failureReason / an
// `artifact` POINTER) — it does NOT inline the verify findings, the PR shape, the
// triage classification, or the estimate. Those richer fields are written to
// separate files (verify.json / phase-pr.json) or posted to Linear, and they are
// resident on the BoardTicket (estimate/estimateDisplay/scope/type/pr). So this
// module reads what is PRESENT (the verbatim signal's extra keys when a future
// signal does carry them, defensively, PLUS the resident ticket fields PLUS the
// artifacts list) and marks everything absent as honestly DIM — it NEVER
// fabricates a verdict, a PR number, or a classification.

import type { BoardTicket } from "./types";

// ── defensive accessors (mirror sigStr/sigNum in worker-detail-data.ts) ──────
export function sigStr(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export function sigNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function sigRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Normalize a dependencies field (string[] | [{id}] | string) to a string[] —
 *  mirrors board-data.mjs's blocker normalization. Empty/absent → []. */
export function normalizeDependencies(v: unknown): string[] {
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) {
      const s = sigStr(item);
      if (s) {
        out.push(s);
        continue;
      }
      const rec = sigRecord(item);
      const id = rec ? sigStr(rec["id"]) : null;
      if (id) out.push(id);
    }
    return out;
  }
  const single = sigStr(v);
  return single ? [single] : [];
}

// ── the PR chip (mirrors prFromSignal ticket-runs.mjs:88) ────────────────────
export interface PrChip {
  number: number;
  url: string | null;
  isDraft: boolean;
  /** monitor-merge fields when present (else null → honest dim). */
  ciStatus: string | null;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

/** Read a PR shape off the verbatim signal the SAME way prFromSignal does:
 *  `sig.pr.{number,url,...}` wins, else `sig.draftPr.{number,url,isDraft}`.
 *  null when the signal carries neither (most phases don't — the chip is hidden,
 *  never an empty stub). */
export function prFromSignal(
  signal: Record<string, unknown> | null,
): PrChip | null {
  if (!signal) return null;
  const read = (raw: unknown, draftDefault: boolean): PrChip | null => {
    const rec = sigRecord(raw);
    if (!rec) return null;
    const number = sigNum(rec["number"]);
    if (number == null) return null;
    return {
      number,
      url: sigStr(rec["url"]),
      isDraft: typeof rec["isDraft"] === "boolean" ? rec["isDraft"] : draftDefault,
      ciStatus: sigStr(rec["ciStatus"]),
      mergedAt: sigStr(rec["mergedAt"]),
      mergeCommitSha: sigStr(rec["mergeCommitSha"]),
    };
  };
  return read(signal["pr"], false) ?? read(signal["draftPr"], true);
}

// ── verdict (verify / review) ────────────────────────────────────────────────
export interface VerdictSummary {
  /** "pass" | "fail" | null (absent → honest dim). */
  verdict: "pass" | "fail" | null;
  /** count of HIGH-severity findings, or null when no findings array present. */
  highFindings: number | null;
  /** the regression_risk driver string, or null. */
  regressionRisk: string | null;
  /** whether a remediation commit was made (review), or null. */
  remediated: boolean | null;
}

/** Read a verify/review verdict off the verbatim signal. The live signal does NOT
 *  inline these today (it carries an `artifact` pointer to verify.json) — so this
 *  returns all-null in practice, and the renderer dims honestly + links the raw
 *  signal's artifact pointer. When a FUTURE signal DOES inline the verdict, the
 *  defensive reads below surface it without a code change. */
export function verdictFromSignal(
  signal: Record<string, unknown> | null,
): VerdictSummary {
  const s = signal ?? {};
  // verdict may be a top-level string, or boolean reviewPassed/verifyPassed.
  let verdict: "pass" | "fail" | null = null;
  const vStr = sigStr(s["verdict"]);
  if (vStr === "pass" || vStr === "fail") verdict = vStr;
  else {
    const passed =
      typeof s["reviewPassed"] === "boolean"
        ? (s["reviewPassed"] as boolean)
        : typeof s["verifyPassed"] === "boolean"
          ? (s["verifyPassed"] as boolean)
          : typeof s["passed"] === "boolean"
            ? (s["passed"] as boolean)
            : null;
    if (passed != null) verdict = passed ? "pass" : "fail";
  }
  let highFindings: number | null = null;
  if (Array.isArray(s["findings"])) {
    highFindings = (s["findings"] as unknown[]).filter((f) => {
      const rec = sigRecord(f);
      return rec ? sigStr(rec["severity"]) === "high" : false;
    }).length;
  }
  return {
    verdict,
    highFindings,
    regressionRisk: sigStr(s["regression_risk"]) ?? sigStr(s["regressionRisk"]),
    remediated:
      typeof s["remediated"] === "boolean" ? (s["remediated"] as boolean) : null,
  };
}

// ── the phase→section descriptor ─────────────────────────────────────────────
// The renderer switches on `kind` and shows only the panels that phase's
// available data supports. Each kind names the data slots the renderer reads; a
// slot resolving to null/empty renders an honest dim, never a fabricated value.

export type PhaseSectionKind =
  | "triage"
  | "implement"
  | "research"
  | "plan"
  | "verify"
  | "review"
  | "monitor-merge"
  | "monitor-deploy"
  | "remediate"
  | "teardown"
  | "default";

/** Map a worker.phase string to its section kind. Unknown/absent → "default"
 *  (the verbatim SIGNAL panel, so the page is never empty). PURE + total — the
 *  exhaustive switch is the tested contract the renderer relies on. */
export function phaseToSectionKind(
  phase: string | null | undefined,
): PhaseSectionKind {
  switch (phase) {
    case "triage":
      return "triage";
    case "implement":
      return "implement";
    case "research":
      return "research";
    case "plan":
      return "plan";
    case "verify":
      return "verify";
    case "review":
      return "review";
    case "monitor-merge":
      return "monitor-merge";
    case "monitor-deploy":
      return "monitor-deploy";
    case "remediate":
      return "remediate";
    case "teardown":
      return "teardown";
    default:
      return "default";
  }
}

/** Which artifact kind a phase's section previews (research → research doc, plan →
 *  plan doc; null for phases with no artifact preview). Drives the §6 artifacts
 *  filter so a research worker previews research.md and a plan worker plan.md. */
export function artifactKindForPhase(
  kind: PhaseSectionKind,
): "research" | "plan" | null {
  if (kind === "research") return "research";
  if (kind === "plan") return "plan";
  return null;
}

// ── triage outcome (classification + estimate + blockers) ────────────────────
export interface TriageOutcome {
  /** classification (feature/bug/docs/refactor/chore) — from the signal's
   *  classification/type, else the resident BoardTicket.type. null → dim. */
  classification: string | null;
  /** estimated scope (xs/s/m/l/xl) — signal estimated_scope, else ticket.scope. */
  scope: string | null;
  /** the estimate the ticket was pointed (method-aware display), else raw points. */
  estimateDisplay: string | null;
  /** the estimation method (fibonacci/tShirt/...), or null. */
  estimateMethod: string | null;
  /** blockers/dependencies identified, normalized to ids. */
  blockers: string[];
}

/** Derive the triage outcome from the verbatim signal + the resident ticket. The
 *  triage analysis PROSE lives on Linear (link out via the ticket), but the
 *  structured fields resolve here: classification/scope prefer the signal's own
 *  keys (a future signal may inline them) and fall back to the resident
 *  BoardTicket — every field is real or honestly null, never fabricated. */
export function deriveTriageOutcome(
  signal: Record<string, unknown> | null,
  ticket: BoardTicket | undefined,
): TriageOutcome {
  const s = signal ?? {};
  return {
    classification:
      sigStr(s["classification"]) ?? sigStr(s["type"]) ?? ticket?.type ?? null,
    scope: sigStr(s["estimated_scope"]) ?? ticket?.scope ?? null,
    estimateDisplay:
      ticket?.estimateDisplay ??
      (ticket?.estimate != null ? String(ticket.estimate) : null),
    estimateMethod:
      ticket?.estimateMethod && ticket.estimateMethod !== "None"
        ? ticket.estimateMethod
        : null,
    blockers: normalizeDependencies(s["dependencies"] ?? s["blockers"]),
  };
}
