// board-accent.ts — pure accent-color helpers extracted from Board.tsx (CTL-1153).
//
// Extracted so the board-phase-drift guard and unit tests can import PHASE_C /
// accentFor without pulling in React. Board.tsx re-exports both.
//
// PHASE_C is an inline literal so board-phase-drift.test.ts can text-extract its
// keys (it reads this file as raw text, never imports it). Keep this const a
// plain object literal — no spreads, no variable references in the value.
import { C, LIVE, TYPE as TYPE_MAP } from "./board-tokens";
import type { BoardActiveState as ActiveState } from "./types";

export type ColorBy = "phase" | "status" | "repo" | "type";

export const PHASE_C: Record<string, string> = {
  triage: "#8492a4", research: "#5e9ee8", plan: "#a98ee3", implement: "#45c08a",
  verify: "#dba14f", remediate: "#d98ab2", review: "#cdb84e", pr: "#45bcab",
  "monitor-merge": "#5e9ee8", "monitor-deploy": "#41bd7d", teardown: "#788596",
  merge: "#5e9ee8", deploy: "#41bd7d", done: "#788596",
};

const TYPE_C: Record<string, string> = TYPE_MAP;

/**
 * Resolve the accent color for a ticket card.
 *
 * CTL-1153 (M2): `repoAccents` (repo → hex, built from the server's per-project
 * resolved color `.text` swatch) lets repo-lane cards show the operator-configured
 * color. Omitting the 3rd arg (list-columns.tsx's `accentFor(t, "phase")`) is safe —
 * the default behavior is unchanged.
 */
export function accentFor(
  t: { phase: string; repo: string; type: string; activeState: ActiveState; status: string },
  by: ColorBy,
  repoAccents?: Record<string, string>,
): string {
  if (by === "phase") return PHASE_C[t.phase] || C.blue;
  if (by === "repo") return repoAccents?.[t.repo] ?? C.blue;
  if (by === "type") return TYPE_C[t.type] || C.fgMuted;
  if (t.activeState === "active") return LIVE;
  if (t.activeState === "stuck" || t.status === "failed") return C.red;
  return C.fgDim;
}
