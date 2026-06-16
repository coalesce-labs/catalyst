// repo-icons.ts — pure logic for per-project icons (CTL-961, CTL-997, CTL-1208).
//
// Three-tier system:
//   1. AUTO-DETECTED (picked): the server probes GitHub for all icon candidates
//      and returns them via /api/repo-icon/:repoKey; the operator can pick one.
//   2. AUTO-DETECTED (default best): highest-ranked by format (SVG > PNG > ICO).
//   3. MANUAL OVERRIDE / FALLBACK: a per-project lucide icon name + color,
//      persisted in localStorage (prefix REPO_ICON_KEY_PREFIX).
//
// This module is pure (no React, no side effects) so it can be unit-tested.

export type IconFormat = "svg" | "png" | "ico";

export interface IconCandidate {
  path: string;
  format: IconFormat;
  downloadUrl: string;
  dataUrl: string | null;
}

/** Names from the lucide-react set used as manual override icons. */
export type LucideIconName =
  | "box"
  | "layers"
  | "cpu"
  | "code-2"
  | "terminal"
  | "zap"
  | "globe"
  | "database"
  | "server"
  | "shield"
  | "sparkles"
  | "star"
  | "flame"
  | "leaf"
  | "rocket";

export const LUCIDE_ICON_OPTIONS: LucideIconName[] = [
  "box", "layers", "cpu", "code-2", "terminal", "zap", "globe",
  "database", "server", "shield", "sparkles", "star", "flame", "leaf", "rocket",
];

export interface RepoIconOverride {
  icon: LucideIconName;
  color: string; // CSS color string
}

/** Response shape from /api/repo-icon/:repo */
export interface RepoIconApiResponse {
  found: boolean;
  // CTL-997 multi-candidate fields
  candidates?: IconCandidate[];
  selectedPath?: string;
  // legacy single-candidate fields (still emitted, mirror the best candidate)
  path?: string;
  downloadUrl?: string;
  dataUrl?: string | null;
}

/** Resolved icon data for a single repo. */
export interface ResolvedRepoIcon {
  /** EFFECTIVE auto icon data URL (the picked candidate, else the default best). */
  autoDataUrl: string | null;
  /** All detected candidates, for the picker. */
  candidates: IconCandidate[];
  /** Which candidate path is currently active (pick or default), null if none. */
  selectedPath: string | null;
  /** Manual lucide override (from localStorage), unchanged. */
  override: RepoIconOverride | null;
  /** CTL-1208: the resolved project mark (glyph | favicon | none). Optional for back-compat
   *  with existing test fixtures that construct ResolvedRepoIcon without this field. */
  mark?: import("./project-mark").ProjectMark;
}

export const REPO_ICON_KEY_PREFIX = "catalyst.repoIcon.";
/**
 * Per-repo pick key prefix for low-level / non-React access.
 * The reactive runtime uses repoIconPicksAtom (key: "catalyst.repoIconPicks") instead —
 * these helpers write to separate per-repo keys. Use the atom for UI; these helpers
 * for server-side or imperative contexts outside the React tree.
 */
export const REPO_ICON_PICK_KEY_PREFIX = "catalyst.repoIconPick.";

/**
 * Extract all candidates from an API response.
 * Synthesizes a single candidate from legacy fields when candidates[] is absent.
 */
export function parseIconCandidates(resp: RepoIconApiResponse): IconCandidate[] {
  if (!resp.found) return [];
  if (resp.candidates && resp.candidates.length > 0) return resp.candidates;
  if (resp.path && resp.downloadUrl !== undefined) {
    const lower = resp.path.toLowerCase();
    const format: IconFormat = lower.endsWith(".svg") ? "svg"
      : lower.endsWith(".ico") ? "ico" : "png";
    return [{ path: resp.path, format, downloadUrl: resp.downloadUrl, dataUrl: resp.dataUrl ?? null }];
  }
  return [];
}

export function readIconPick(repoKey: string, storage?: Storage): string | null {
  try { return (storage ?? localStorage).getItem(`${REPO_ICON_PICK_KEY_PREFIX}${repoKey}`); }
  catch { return null; }
}

export function writeIconPick(repoKey: string, path: string, storage?: Storage): void {
  try { (storage ?? localStorage).setItem(`${REPO_ICON_PICK_KEY_PREFIX}${repoKey}`, path); }
  catch { /* quota / SSR */ }
}

export function clearIconPick(repoKey: string, storage?: Storage): void {
  try { (storage ?? localStorage).removeItem(`${REPO_ICON_PICK_KEY_PREFIX}${repoKey}`); }
  catch { /* ignore */ }
}

/**
 * Read manual icon override for a repo from localStorage.
 * Returns null when not set or when parsing fails.
 */
export function readIconOverride(
  repoKey: string,
  storage?: Storage,
): RepoIconOverride | null {
  try {
    const s = (storage ?? localStorage).getItem(`${REPO_ICON_KEY_PREFIX}${repoKey}`);
    if (!s) return null;
    const parsed = JSON.parse(s) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "icon" in parsed &&
      "color" in parsed &&
      typeof (parsed as { icon: unknown }).icon === "string" &&
      typeof (parsed as { color: unknown }).color === "string"
    ) {
      return {
        icon: (parsed as { icon: string }).icon as LucideIconName,
        color: (parsed as { color: string }).color,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist a manual icon override for a repo in localStorage.
 */
export function writeIconOverride(
  repoKey: string,
  override: RepoIconOverride,
  storage?: Storage,
): void {
  try {
    (storage ?? localStorage).setItem(
      `${REPO_ICON_KEY_PREFIX}${repoKey}`,
      JSON.stringify(override),
    );
  } catch {
    // quota exceeded or SSR — silently ignore
  }
}

/**
 * Remove manual icon override for a repo from localStorage.
 */
export function clearIconOverride(repoKey: string, storage?: Storage): void {
  try {
    (storage ?? localStorage).removeItem(`${REPO_ICON_KEY_PREFIX}${repoKey}`);
  } catch {
    // silently ignore
  }
}

/**
 * Parse the /api/repo-icon/:repo response.
 * Returns the data URL when found, null otherwise.
 */
export function parseIconResponse(resp: RepoIconApiResponse): string | null {
  if (!resp.found) return null;
  return resp.dataUrl ?? null;
}
