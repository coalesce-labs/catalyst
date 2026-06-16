// project-glyph-set.ts — curated Phosphor fill-weight glyph set for project icons (CTL-1208).
// Static imports and GLYPH_COMPONENTS removed in CTL-1226; resolution delegates to
// the universal resolver in phosphor-icons.ts which covers the full icon set.
import { resolvePhosphorIcon } from "./phosphor-icons";

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
 * Parse a set reference string. Returns null if not a valid glyph ref
 * (i.e. no real Phosphor component exists for the given name).
 */
export function parseGlyphRef(
  s: string | null | undefined,
): { set: "phosphor"; name: string } | null {
  if (!s) return null;
  const prefix = `${GLYPH_SET_PREFIX}:`;
  if (!s.startsWith(prefix)) return null;
  const name = s.slice(prefix.length);
  if (!name) return null;
  if (resolvePhosphorIcon(name) === null) return null;
  return { set: "phosphor", name };
}

/** True iff `s` is a valid glyph reference (phosphor:<name> with a real Phosphor component). */
export function isGlyphRef(s: string | null | undefined): boolean {
  return parseGlyphRef(s) !== null;
}
