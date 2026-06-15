// board-tokens.ts — the ONE board color/token palette (orch-monitor DESIGN.md).
// CTL-930 Phase 4: raised dark ramp, muted-pop accents, canonical PHASE map.
// This is the ONLY file that types palette hexes — all consumers import from here.
//
// INVARIANT: `LIVE` (#53cde2) is the reserved live signal and nothing else — it is
// deliberately not green/phase, used only where a worker is live (the live ring/dot
// and the "N active" header). Decorative chrome must never reach for it.
//
// CTL-1147 NOTE: surface/border/fg/shadow members are now var() aliases of the
// per-theme CSS tokens in app.css (:root / .dark). `background: C.s1` in an inline
// style resolves through the CSS cascade and flips with the .dark class, making
// all ~40 board/queue/detail consumers theme-aware with zero call-site edits.
// surface-contract.test.ts Guard 1 asserts the alias mapping.
// SLATE-BRAND CARVE-OUT: C.* follows the MODE axis (warm-dark/warm-light) but NOT
// the BRAND axis (slate-dark/slate-light). Slate-brand parity for the inline path
// is a separate follow-up. See CTL-1147 research Open Question #2.

export const C = {
  // CTL-1147: surface/border/fg are var() aliases of the per-theme CSS tokens
  // (app.css :root / .dark). Inline style={{ background: C.s1 }} now flips
  // with the .dark class — fixing board/queue/detail surfaces in Light mode.
  s0: "var(--surface-chrome)",
  s1: "var(--surface-canvas)",
  subtle: "var(--surface-subtle)",
  s2: "var(--surface-card)",
  s3: "var(--surface-elevated)",
  s4: "var(--surface-hover)",
  borderSubtle: "var(--border-subtle)",
  border: "var(--border-strong)",
  fg: "var(--fg)",
  fgMuted: "var(--fg-muted)",
  fgDim: "var(--fg-dim)",
  // Accents stay LITERAL — theme-invariant status colors (out of scope, CTL-1033 §6).
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

/** CTL-1033/CTL-1147: card-lift box-shadows — now var() aliases of the per-theme
 *  --shadow-* CSS vars so they flip with .dark. Canonical card recipe:
 *    background: C.s2; border: 1px solid C.borderSubtle; box-shadow: CARD_LIFT;
 *  Use ELEVATED_LIFT (with C.s3 bg) for the command palette / popovers. */
export const CARD_LIFT = "var(--shadow-card)";
export const ELEVATED_LIFT = "var(--shadow-elevated)";
export const TRAY_LIFT = "var(--shadow-tray)";


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

/** CTL-1146: the per-project lane tint strength (%). Bumped 6 → 9 so the
 *  project hue is perceptible at a glance while staying Linear-calm. */
export const LANE_TINT_PCT = 9;

/**
 * Compose a project hue over a base surface as a perceptually-even oklab tint.
 * Returns the base unchanged when no hue is supplied, so colorless lanes stay
 * byte-identical to today's `C.subtle`. Inline-style-safe (returns a CSS string).
 */
export function laneTint(
  hueBg: string | null | undefined,
  base: string,
  pct: number = LANE_TINT_PCT,
): string {
  if (!hueBg) return base;
  return `color-mix(in oklab, ${hueBg} ${pct}%, ${base})`;
}
