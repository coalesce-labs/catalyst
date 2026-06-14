// board-tokens.ts — the ONE board color/token palette (orch-monitor DESIGN.md).
// CTL-930 Phase 4: raised dark ramp, muted-pop accents, canonical PHASE map.
// This is the ONLY file that types palette hexes — all consumers import from here.
//
// INVARIANT: `LIVE` (#53cde2) is the reserved live signal and nothing else — it is
// deliberately not green/phase, used only where a worker is live (the live ring/dot
// and the "N active" header). Decorative chrome must never reach for it.

export const C = {
  // CTL-1033 elevation ladder (dark): surfaces stack UPWARD, darkest → lightest.
  // CTL-1099: the base `.dark` theme is now WARM-DARK (the textbook charcoal ramp),
  // so this ladder carries the warm-charcoal hexes — byte-identical to the base
  // `.dark` semantic vars in app.css (surface-contract.test.ts asserts the two
  // stay in sync — kills drift). Monotonic ascending luminance verified:
  //   s0 0.00521 < s1 0.00754 < subtle 0.01034 < s2 0.01229 < s3 0.01623 < s4 0.02529.
  // s0 = chrome (anchor, textbook --sidebar-bg). s1 = content canvas. subtle =
  // lane bands/zebra/column-header chips. s2 = cards. s3 = elevated (popovers/
  // palette). s4 = hover/tracks (interaction, top — NOT an elevation level).
  s0: "#11100e", // chrome (anchor) — textbook --sidebar-bg (was #0e1116)
  s1: "#161513", // content canvas — textbook --canvas (was #181d24)
  subtle: "#1b1a17", // lane bands / zebra / inset wells — textbook --panel (was #20262f)
  s2: "#1e1d1a", // cards — textbook --surface (was #2b333d)
  s3: "#242220", // elevated: popover / palette — textbook --surface-2 (was #39424f)
  s4: "#2e2c27", // hover / tracks — textbook --border (was #434d5b)
  // CTL-1033: alpha-white borders, scaled inversely with surface lightness (the
  // embossing cure's garnish). Drop straight into `1px solid ${C.border}` templates.
  borderSubtle: "rgba(255,255,255,0.07)", // card edges, in-card hairlines — UNCHANGED
  border: "rgba(255,255,255,0.11)", // inputs, interactive outlines, strong separators — UNCHANGED
  fg: "#e9e5dc", // textbook --ink (was #edf1f7)
  fgMuted: "#a39d91", // textbook --ink-dim (was #9ba6b5)
  fgDim: "#6f6a5f", // textbook --ink-faint (was #6e7a8a)
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

/** CTL-1033 card-lift box-shadows for dark inline-styled board code (mirror the
 *  --shadow-card / --shadow-elevated CSS vars in app.css's .dark block). The inset
 *  top-edge highlight + soft ambient shadow is the embossing cure: cards FLOAT off
 *  the canvas instead of being pressed into it. Canonical card recipe (dark):
 *    background: C.s2; border: 1px solid C.borderSubtle; box-shadow: CARD_LIFT;
 *  Use ELEVATED_LIFT (with C.s3 bg) for the command palette / popovers. */
export const CARD_LIFT =
  "inset 0 1px 0 rgba(255,255,255,0.07), 0 1px 4px rgba(0,0,0,0.35)";
export const ELEVATED_LIFT =
  "inset 0 1px 0 rgba(255,255,255,0.06), 0 8px 24px rgba(0,0,0,0.45)";
/** CTL-1132: softer tray shadow — trays float off the canvas but sit clearly
 *  BELOW cards (CARD_LIFT). Halved ambient opacity, no inset highlight. */
export const TRAY_LIFT = "0 1px 3px rgba(0,0,0,0.28)";


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
