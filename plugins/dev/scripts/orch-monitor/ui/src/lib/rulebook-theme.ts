// rulebook-theme.ts — CTL-1103 Phase 5: single source of truth for the three
// distinct visual channels in the Rulebook surface.
//  1. strataTone(id)           — one of 6 distinct chart-* CSS tokens.
//  2. severityTone(severity)   — semantic severity token (re-exported from rulebook-model).
//  3. liveIndicatorTone(firing) — the reserved LIVE color token when firing.
// Contract: all three channels are mutually distinct (pinned by rulebook-theme.test.ts).

export { severityTone } from "./rulebook-model";

const STRATA_VAR = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
] as const;

/** CSS variable string for stratum id (1–6). Wraps --chart-N tokens. */
export function strataTone(id: number): string {
  return STRATA_VAR[(id - 1) % STRATA_VAR.length];
}

/** CSS variable string for the live-indicator badge. Distinct from strata + severity. */
export function liveIndicatorTone(firing: boolean): string {
  return firing ? "var(--color-live)" : "transparent";
}
