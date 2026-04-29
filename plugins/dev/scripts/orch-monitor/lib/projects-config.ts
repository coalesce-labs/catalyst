import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { detectProjectKey } from "./project-key";

export const PALETTE_COLORS = [
  "amber",
  "rose",
  "violet",
  "emerald",
  "teal",
  "sky",
  "coral",
  "indigo",
] as const;
export type PaletteColor = (typeof PALETTE_COLORS)[number];

// Hex values kept in a single place so both the test harness and any
// server-side contrast report draw from the same source as the CSS tokens.
// Sync with `--palette-*` declarations in `ui/src/app.css`.
export const PALETTE_HEX: Record<PaletteColor, string> = {
  amber: "#c07a1e",
  rose: "#d04050",
  violet: "#9470d4",
  emerald: "#359963",
  teal: "#369999",
  sky: "#3e85d0",
  coral: "#cc6a54",
  indigo: "#6b7ecb",
};

export interface ProjectEntry {
  label: string;
  color: PaletteColor;
  iconPath?: string | null;
}

export interface ProjectsConfig {
  projects: Record<string, ProjectEntry>;
}

export interface ProjectIdentity {
  key: string;
  label: string;
  color: PaletteColor;
  iconPath?: string | null;
}

const PALETTE_SET: ReadonlySet<string> = new Set<string>(PALETTE_COLORS);

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isPaletteColor(x: unknown): x is PaletteColor {
  return typeof x === "string" && PALETTE_SET.has(x);
}

/** Resolve the path of the projects config file, honoring the CATALYST_PROJECTS_CONFIG env var. */
export function projectsConfigPath(override?: string | null): string {
  if (override) return override;
  const env = process.env.CATALYST_PROJECTS_CONFIG;
  if (env) return env;
  return join(homedir(), "catalyst", "projects.json");
}

/**
 * Best-effort load: missing or malformed files produce an empty config rather
 * than throwing, so the monitor remains usable without opt-in configuration.
 */
export function loadProjectsConfig(path: string): ProjectsConfig {
  if (!existsSync(path)) return { projects: {} };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { projects: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { projects: {} };
  }
  if (!isRecord(parsed) || !isRecord(parsed.projects)) return { projects: {} };
  const projects: Record<string, ProjectEntry> = {};
  for (const [slug, entryRaw] of Object.entries(parsed.projects)) {
    if (!isRecord(entryRaw)) continue;
    const label = entryRaw.label;
    const color = entryRaw.color;
    if (typeof label !== "string" || label.length === 0) continue;
    if (!isPaletteColor(color)) continue;
    const iconPath =
      typeof entryRaw.iconPath === "string" ? entryRaw.iconPath : null;
    projects[slug] = { label, color, iconPath };
  }
  return { projects };
}

/**
 * Resolve an orchestrator (keyed by `workspace` + optional worker worktree) to
 * a concrete identity. When `workspace === "default"` (the flat-layout case),
 * we fall back to reading `.catalyst/config.json` from a worker worktree to
 * derive a slug, matching the convention used elsewhere in the codebase.
 */
export function resolveProjectIdentity(
  workspace: string,
  worktreePath: string | null,
  config: ProjectsConfig,
): ProjectIdentity | null {
  let slug: string | null = null;
  if (workspace && workspace !== "default") {
    slug = workspace;
  } else if (worktreePath) {
    slug = detectProjectKey(worktreePath);
  }
  if (!slug) return null;
  const entry = config.projects[slug];
  if (!entry) return null;
  return {
    key: slug,
    label: entry.label,
    color: entry.color,
    iconPath: entry.iconPath ?? null,
  };
}

// ----- Contrast utilities (used by the palette test harness) -----

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, "");
  const expanded =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(expanded, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/** WCAG contrast ratio between two hex colors. */
export function computeContrast(hexA: string, hexB: string): number {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const light = Math.max(a, b);
  const dark = Math.min(a, b);
  return (light + 0.05) / (dark + 0.05);
}

/** Look up the hex for a palette color. */
export function paletteHex(color: PaletteColor): string {
  return PALETTE_HEX[color];
}
