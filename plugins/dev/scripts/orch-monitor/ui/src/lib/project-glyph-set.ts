// project-glyph-set.ts — curated Phosphor fill-weight glyph set for project icons (CTL-1208).
// Pure data + pure functions — no React, no DOM. Tree-shakes cleanly (individual imports).
import type { Icon } from "@phosphor-icons/react";
import {
  GitFork,
  Rocket,
  Cube,
  Stack,
  Cpu,
  TerminalWindow,
  Lightning,
  Globe,
  Database,
  HardDrives,
  Shield,
  Sparkle,
  Star,
  Flame,
  Leaf,
  ChartBar,
  Flask,
  Bug,
  Package,
  Cloud,
  Gear,
  Compass,
  Target,
  Tree,
  Boat,
  Mountains,
  Flower,
  Hexagon,
  Diamond,
  Crown,
  Robot,
  Alien,
  Cat,
  Dog,
  Bird,
  Fish,
} from "@phosphor-icons/react";

/** Prefix for all curated glyph references stored in the server icon field. */
export const GLYPH_SET_PREFIX = "phosphor";

/** Curated subset of Phosphor icon names (fill weight) legible at 14–16px. */
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

/** Map from curated glyph name to the corresponding Phosphor React component. */
export const GLYPH_COMPONENTS: Record<string, Icon> = {
  "git-fork": GitFork,
  "rocket": Rocket,
  "cube": Cube,
  "stack": Stack,
  "cpu": Cpu,
  "terminal-window": TerminalWindow,
  "lightning": Lightning,
  "globe": Globe,
  "database": Database,
  "hard-drives": HardDrives,
  "shield": Shield,
  "sparkle": Sparkle,
  "star": Star,
  "flame": Flame,
  "leaf": Leaf,
  "chart-bar": ChartBar,
  "flask": Flask,
  "bug": Bug,
  "package": Package,
  "cloud": Cloud,
  "gear": Gear,
  "compass": Compass,
  "target": Target,
  "tree": Tree,
  "boat": Boat,
  "mountains": Mountains,
  "flower": Flower,
  "hexagon": Hexagon,
  "diamond": Diamond,
  "crown": Crown,
  "robot": Robot,
  "alien": Alien,
  "cat": Cat,
  "dog": Dog,
  "bird": Bird,
  "fish": Fish,
};

/** Format a glyph name into a set reference string (e.g. "git-fork" → "phosphor:git-fork"). */
export function formatGlyphRef(name: string): string {
  return `${GLYPH_SET_PREFIX}:${name}`;
}

/** Parse a set reference string. Returns null if not a curated glyph ref. */
export function parseGlyphRef(
  s: string | null | undefined,
): { set: "phosphor"; name: string } | null {
  if (!s) return null;
  const prefix = `${GLYPH_SET_PREFIX}:`;
  if (!s.startsWith(prefix)) return null;
  const name = s.slice(prefix.length);
  if (!name) return null;
  if (!(PHOSPHOR_GLYPH_NAMES as readonly string[]).includes(name)) return null;
  return { set: "phosphor", name };
}

/** True iff `s` is a valid curated glyph reference (phosphor:<name> with a known name). */
export function isGlyphRef(s: string | null | undefined): boolean {
  return parseGlyphRef(s) !== null;
}
