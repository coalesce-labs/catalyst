// phase-model.ts — the ONE phase-model the calm-home StatusIcon glyph + PhaseStrip
// read (CTL-900 / HOME2). It hand-rolls the canonical pipeline view the glyph
// needs: the ordered phase list, the per-phase human labels (full + short), the
// index lookup that drives the StatusIcon fill fraction, and the terminal-status
// set that flips the glyph to the "done disc + check". It deliberately does NOT
// re-declare colors — those live ONCE in ui/src/lib/formatters.ts (PHASE_COLORS),
// the canonical UI color source already drift-guarded against the pipeline. We
// re-export `phaseColor` from there so the glyph never carries a hand-copied
// color map that could silently drift.
//
// DRIFT GUARD (why this is safe to hand-roll)
// ───────────────────────────────────────────
// PHASE_LIST + TERMINAL_STATUSES below are hand-written copies of the single
// source of truth: lib/board-data.mjs PHASE_ORDER / TERMINAL (themselves rooted
// in workflow.default.json via lib/workflow-descriptor.mjs PHASES). The
// board-phase-drift.test.ts guard asserts PHASE_LIST === PHASE_ORDER and
// TERMINAL_STATUSES === TERMINAL exactly, so a renamed/reordered/added phase or a
// new terminal status is a hard CI failure here rather than a silently-stale
// glyph. NEVER edit these two lists to "fix" a failing drift test — fix the copy
// the failure names against workflow.default.json.
//
// "done" is a terminal STATUS, not a pipeline phase. The canonical PHASE_LIST has
// no "done" entry (the prototype's data.ts added a synthetic one); the glyph
// instead reads the ticket's `status` and renders the all-clear disc+check when
// that status is in TERMINAL_STATUSES with a successful outcome.
import { phaseColor } from "@/lib/formatters";

/**
 * The canonical 10-phase pipeline order, early → late. A copy of
 * lib/board-data.mjs PHASE_ORDER (rooted in workflow.default.json); the
 * board-phase-drift guard asserts exact equality, so this never drifts.
 */
export const PHASE_LIST = [
  "triage",
  "research",
  "plan",
  "implement",
  "verify",
  "review",
  "pr",
  "monitor-merge",
  "monitor-deploy",
  "teardown",
] as const;

export type Phase = (typeof PHASE_LIST)[number];

/** Total number of pipeline phases — drives the StatusIcon fill fraction. */
export const PHASE_COUNT = PHASE_LIST.length;

/**
 * Phase statuses that mean a phase is no longer running. A copy of
 * lib/board-data.mjs TERMINAL; the drift guard asserts set-equality. A ticket
 * whose current status is one of these (and not a failure — see `isDoneStatus`)
 * reads as finished, so the glyph shows the all-clear disc + check.
 */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "done",
  "failed",
  "stalled",
  "skipped",
  "signal_corrupt",
  "superseded",
  "canceled",
]);

/** Human-friendly full phase label for the glyph tooltip / pane sub-label. */
export const PHASE_LABEL: Record<Phase, string> = {
  triage: "Triaging",
  research: "Researching",
  plan: "Planning",
  implement: "Implementing",
  verify: "Verifying",
  review: "Reviewing",
  pr: "Opening PR",
  "monitor-merge": "Merging",
  "monitor-deploy": "Deploying",
  teardown: "Tearing down",
};

/** Tighter one/two-word label for the compact phase STRIP dots in the pane. */
export const PHASE_SHORT: Record<Phase, string> = {
  triage: "Triage",
  research: "Research",
  plan: "Plan",
  implement: "Implement",
  verify: "Verify",
  review: "Review",
  pr: "PR",
  "monitor-merge": "Merge",
  "monitor-deploy": "Deploy",
  teardown: "Teardown",
};

/** True when `phase` is a known canonical pipeline phase. */
export function isPhase(phase: string | null | undefined): phase is Phase {
  return phase != null && (PHASE_LIST as readonly string[]).includes(phase);
}

/**
 * 0-based index of `phase` in the canonical pipeline. Returns -1 for an unknown
 * phase (e.g. a pre-pipeline / ancillary value) so callers can clamp safely; the
 * StatusIcon treats -1 as "no progress yet" (empty ring).
 */
export function phaseIndexOf(phase: string | null | undefined): number {
  if (phase == null) return -1;
  return (PHASE_LIST as readonly string[]).indexOf(phase);
}

/**
 * The glyph fill fraction for a phase index: (index + 1) / PHASE_COUNT, counting
 * the CURRENT phase as in-flight (so phase 0 already shows a sliver). Clamped to
 * [0, 1]; an unknown phase (index < 0) yields 0.
 */
export function phaseFraction(phaseIndex: number): number {
  if (phaseIndex < 0) return 0;
  return Math.max(0, Math.min(1, (phaseIndex + 1) / PHASE_COUNT));
}

/**
 * Whether a ticket status reads as SUCCESSFULLY finished — the all-clear the
 * glyph renders as a filled disc + check. `done` is the canonical success
 * terminal; the other TERMINAL_STATUSES are non-success outcomes (failed /
 * stalled / canceled …) that should NOT show the reassuring check.
 */
export function isDoneStatus(status: string | null | undefined): boolean {
  return status === "done";
}

/** Resolve the per-phase color from the canonical UI color source (formatters).
 *  Re-exported so the glyph has ONE color source (never cyan — that stays
 *  reserved for live; formatters.PHASE_COLORS already excludes it). */
export { phaseColor };
