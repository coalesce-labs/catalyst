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

/** CSS variable string for stratum id (1–6). Wraps --chart-N tokens.
 *  CTL-1103 remediate: use a non-negative modulo so the helper is total — the
 *  bare `(id - 1) % length` returned `undefined` for id <= 0 (JS yields a
 *  negative index), breaking the "always a token" contract for defensive
 *  callers. Real strata are 1–6; this just keeps unexpected ids from producing
 *  `undefined`. */
export function strataTone(id: number): string {
  const n = STRATA_VAR.length;
  return STRATA_VAR[(((id - 1) % n) + n) % n];
}

/** CSS variable string for the live-indicator badge. Distinct from strata + severity. */
export function liveIndicatorTone(firing: boolean): string {
  return firing ? "var(--color-live)" : "transparent";
}
