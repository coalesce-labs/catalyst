// board-tokens.ts — the ONE board color/token palette (orch-monitor DESIGN.md).
// Extracted from Board.tsx (BOARD3 / CTL-907 §8.5 step 3) so the board view and the
// hand-rolled domain chrome split out of it (Swimlane.tsx, …) import the SAME object
// rather than re-declaring the hexes. No new colors — a verbatim lift of the inline
// `C` / `LIVE` that lived at the top of Board.tsx.
//
// INVARIANT: `LIVE` (#5be0ff) is the reserved live signal and nothing else — it is
// deliberately not green/phase, used only where a worker is live (the live ring/dot
// and the "N active" header). Decorative chrome must never reach for it.

export const C = {
  s0: "#0b0d10",
  s1: "#111318",
  s2: "#16191f",
  s3: "#1c2028",
  border: "#262d36",
  borderSubtle: "#1e242c",
  fg: "#e6e9ef",
  fgMuted: "#8b93a1",
  fgDim: "#5b626f",
  green: "#39d07a",
  blue: "#4ea1ff",
  red: "#ef5d5d",
  yellow: "#eabc3b",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

/** The reserved "in-loop" live signal — deliberately not green/phase. LIVE ONLY. */
export const LIVE = "#5be0ff";
