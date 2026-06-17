// project-glyph-set.ts — curated Phosphor fill-weight glyph set for project icons (CTL-1208).
// Static imports and GLYPH_COMPONENTS removed in CTL-1226; parseGlyphRef made fail-open in CTL-1233
// (shape-valid → accepted; component existence verified lazily at render time).

/** Prefix for all curated glyph references stored in the server icon field. */
export const GLYPH_SET_PREFIX = "phosphor";

/** Curated subset of Phosphor icon names (fill weight) legible at 14–16px. Shown first in the picker. */
export const PHOSPHOR_GLYPH_NAMES: readonly string[] = [
  "git-fork",
  "rocket",
  "cube",
  "stack",
  "cpu",
  "terminal-window",
  "lightning",
  "globe",
  "database",
  "hard-drives",
  "shield",
  "sparkle",
  "star",
  "flame",
  "leaf",
  "chart-bar",
  "flask",
  "bug",
  "package",
  "cloud",
  "gear",
  "compass",
  "target",
  "tree",
  "boat",
  "mountains",
  "flower",
  "hexagon",
  "diamond",
  "crown",
  "robot",
  "alien",
  "cat",
  "dog",
  "bird",
  "fish",
] as const;

/** Format a glyph name into a set reference string (e.g. "git-fork" → "phosphor:git-fork"). */
export function formatGlyphRef(name: string): string {
  return `${GLYPH_SET_PREFIX}:${name}`;
}

/**
 * Parse a set reference string. Returns null only for structural failures
 * (no `phosphor:` prefix, or empty name). Accepts any well-shaped ref — component
 * existence is verified lazily at render time (CTL-1233 fail-open).
 */
export function parseGlyphRef(
  s: string | null | undefined,
): { set: "phosphor"; name: string } | null {
  if (!s) return null;
  const prefix = `${GLYPH_SET_PREFIX}:`;
  if (!s.startsWith(prefix)) return null;
  const name = s.slice(prefix.length);
  if (!name) return null;
  return { set: "phosphor", name }; // shape-valid; component existence verified lazily at render
}

/** True iff `s` is a valid glyph reference (well-shaped `phosphor:<name>`). */
export function isGlyphRef(s: string | null | undefined): boolean {
  return parseGlyphRef(s) !== null;
}
