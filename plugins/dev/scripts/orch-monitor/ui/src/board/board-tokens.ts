// board-tokens.ts — the ONE board color/token palette (orch-monitor DESIGN.md).
// CTL-930 Phase 4: raised dark ramp, muted-pop accents, canonical PHASE map.
// This is the ONLY file that types palette hexes — all consumers import from here.
//
// INVARIANT: `LIVE` (#53cde2) is the reserved live signal and nothing else — it is
// deliberately not green/phase, used only where a worker is live (the live ring/dot
// and the "N active" header). Decorative chrome must never reach for it.

export const C = {
  s0: "#0e1116",
  s1: "#151a21",
  s2: "#1b212a",
  s3: "#242c37",
  s4: "#2e3845",
  borderSubtle: "#273039",
  border: "#333e4d",
  fg: "#edf1f7",
  fgMuted: "#9ba6b5",
  fgDim: "#6e7a8a",
  green: "#41bd7d",
  blue: "#5e9ee8",
  red: "#e36b6b",
  yellow: "#d9a843",
  purple: "#a98ee3",
  orange: "#e0824f",
  redSoft: "#f0a8a8",
  yellowSoft: "#e9d08e",
  greenSoft: "#9ce3bd",
  blueSoft: "#aecdf2",
  purpleSoft: "#cdb4f0",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

/** The reserved "in-loop" live signal (~25% chroma cut from original #5be0ff).
 *  Still unmistakably cyan; LIVE ONLY — never use for decorative chrome. */
export const LIVE = "#53cde2";

/** CSS rgba triplet for LIVE (for use in rgba() / box-shadow alpha calcs). */
export const LIVE_RGB = "83, 205, 226";

/** Canonical PHASE color map — the SINGLE definition; board-display.ts, formatters.ts,
 *  Board.tsx all import from here. Legacy verb aliases (in_progress, shipping, etc.)
 *  are handled in formatters.ts PHASE_COLORS spread on top of this map. */
export const PHASE: Record<string, string> = {
  todo: "#97a3b4",
  triage: "#8492a4",
  research: "#5e9ee8",   // = C.blue
  plan: "#a98ee3",       // = C.purple
  implement: "#45c08a",
  verify: "#dba14f",
  remediate: "#d98ab2",
  review: "#cdb84e",
  pr: "#45bcab",
  "monitor-merge": "#5e9ee8", // = C.blue
  "monitor-deploy": "#41bd7d", // = C.green
  teardown: "#788596",
  done: "#788596",
  failed: "#e36b6b",     // = C.red
  stalled: "#d9a843",    // = C.yellow
  dispatched: "#5b6878",
};

/** Type accent map (feature/bug/refactor/chore/docs/test) */
export const TYPE: Record<string, string> = {
  feature: "#5e9ee8",    // C.blue
  bug: "#e36b6b",        // C.red
  refactor: "#a98ee3",   // C.purple
  chore: "#9ba6b5",      // C.fgMuted
  docs: "#41bd7d",       // C.green
  test: "#d9a843",       // C.yellow
};

/** Node/repo accent palette — copper replaces the old cyan slot.
 *  Hash-stable: length stays 7, distribution unchanged. */
export const NODE_ACCENTS = [
  "#5e9ee8", // C.blue
  "#41bd7d", // C.green
  "#a98ee3", // C.purple
  "#d9a843", // C.yellow
  "#d98ab2", // pink
  "#c98f63", // copper (was #5be0ff — cyan reserved for LIVE only)
  "#e0824f", // C.orange
] as const;
