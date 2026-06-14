// color-palette.ts — the per-project color palette constants (CTL-1027).
// Pure data — no React, no atoms. Imported by both the hook and the store.

export interface RepoColor {
  bg: string;
  text: string;
}

/** The 8 canonical named hues for per-project color identity. */
export const NAMED_COLORS: Record<string, RepoColor> = {
  blue: { bg: "#1f3a5a", text: "#9ec7f4" },
  green: { bg: "#2a3c1f", text: "#b5d67a" },
  purple: { bg: "#3a2a5a", text: "#c8a8f4" },
  amber: { bg: "#4a3a1f", text: "#f4c88a" },
  red: { bg: "#5a2a2a", text: "#f4a8a8" },
  teal: { bg: "#1a4a3a", text: "#8af4cc" },
  cyan: { bg: "#1a4a4a", text: "#8ae6f4" },
  lime: { bg: "#3a4a1a", text: "#c8f48a" },
};
