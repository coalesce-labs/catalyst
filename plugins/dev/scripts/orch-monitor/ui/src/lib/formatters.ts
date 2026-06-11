// CTL-1033: PHASE is the SINGLE source of truth (board-tokens.ts). PHASE_COLORS
// below = legacy verb aliases spread UNDER the canonical PHASE map (Linear-calm
// muted palette) — zero hex literals remain in the canonical block.
import { PHASE } from "../board/board-tokens";

export function fmtSince(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}

export function fmtDuration(ms: number): string {
  if (!ms || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}

// CTL-901 (HOME3): a QUIET, single-coarsest-unit relative duration for the calm
// inbox rows — "2h", "4m", "30s", "3d" — never the compound "2h 5m" the dense
// board uses (fmtDuration). One unit keeps the row unalarming and matches the
// Gherkin "a quiet relative duration like '2h'". A null/negative input (no honest
// backing timestamp) yields null so the caller OMITS the cell rather than
// rendering a fabricated "0s" — the "honest, never fabricated" acceptance line.
export function fmtRelativeDuration(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  const d = Math.floor(h / 24);
  return d + "d";
}

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 10_000) return Math.round(n / 1000) + "k";
  if (n >= 1_000) return (n / 1000).toFixed(1) + "k";
  return String(Math.round(n));
}

export function fmtClock(d: Date): string {
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0")
  );
}

export function fmtCost(n: number): string {
  if (!n || n <= 0) return "—";
  return "$" + n.toFixed(2);
}

// CTL-915 (DETAIL4): the per-phase model label, shared by the lifecycle spine
// node and the compact gantt so they render the SAME value off the SAME function
// (the Gherkin "the compact gantt shows the same per-phase model"). A null model
// (the phase signal carried none — BFF6 leaves it null, never fabricated) renders
// a dimmed em-dash; a present model gets the ◆ marker the spine already uses.
export function phaseModelLabel(model: string | null | undefined): string {
  return model ? "◆" + model : "—";
}

export type StatusSemantic = "success" | "info" | "danger" | "warning" | "neutral";

const STATUS_SEMANTIC: Record<string, StatusSemantic> = {
  done: "success",
  merged: "success",
  complete: "success",
  in_progress: "info",
  running: "info",
  implementing: "info",
  active: "info",
  provisioning: "info",
  shipping: "info",
  "pr-open": "info",
  dispatched: "neutral",
  pending: "neutral",
  unknown: "neutral",
  superseded: "neutral",
  canceled: "neutral",
  signal_corrupt: "danger",
  failed: "danger",
  error: "danger",
  stalled: "warning",
  blocked: "warning",
};

export function statusSemantic(status: string): StatusSemantic {
  return STATUS_SEMANTIC[status] || "neutral";
}

export const SEMANTIC_BADGE_CLASSES: Record<StatusSemantic, string> = {
  success: "bg-green/18 text-green",
  info: "bg-blue/18 text-blue",
  danger: "bg-red/18 text-red",
  warning: "bg-yellow/18 text-yellow",
  neutral: "bg-surface-3 text-muted",
};

export const SEMANTIC_PILL_CLASSES: Record<StatusSemantic, string> = {
  success: "bg-[#1a4a3a] text-[#8af4cc]",
  info: "bg-[#1f3a5a] text-[#9ec7f4]",
  danger: "bg-[#5a2a2a] text-[#f4a8a8]",
  warning: "bg-[#5a4a1a] text-[#f4dc8a]",
  neutral: "bg-surface-3 text-fg border border-border",
};

export const PHASE_COLORS: Record<string, string> = {
  // CTL-1033: legacy verb-form aliases (legacy orchestrator path:
  // worker.phaseTimestamps lookups) mapped onto the canonical PHASE map, then the
  // canonical PHASE map spread ON TOP so every canonical key resolves the single
  // board-tokens definition (no Tailwind-default hex literals remain here).
  researching: PHASE.research,
  planning: PHASE.plan,
  implementing: PHASE.implement,
  in_progress: PHASE.implement,
  validating: PHASE.verify,
  shipping: PHASE.pr,
  "pr-open": PHASE.pr,
  pr_open: PHASE.pr,
  merging: PHASE.done,
  merged: PHASE.done,
  ...PHASE,
};

const FALLBACK_PHASE_COLOR = PHASE.research;

export function phaseColor(phase: string | undefined): string {
  if (!phase) return FALLBACK_PHASE_COLOR;
  return PHASE_COLORS[phase] || FALLBACK_PHASE_COLOR;
}

export const PHASE_ORDER = [
  "dispatched",
  "researching",
  "planning",
  "implementing",
  "validating",
  "shipping",
  "done",
];
