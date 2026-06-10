// repo-icons.ts — pure logic for per-project icons (CTL-961).
//
// Two-tier system:
//   1. AUTO-DETECTED: the server probes GitHub for the repo's favicon and
//      returns it as a data URL via /api/repo-icon/:repoKey.
//   2. MANUAL OVERRIDE / FALLBACK: a per-project lucide icon name + color,
//      persisted in localStorage (prefix REPO_ICON_KEY_PREFIX).
//
// The UI renders the auto-detected icon when available; if not found,
// it falls back to the manual override, then to no icon (just the color dot).
//
// This module is pure (no React, no side effects) so it can be unit-tested.

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
  path?: string;
  downloadUrl?: string;
  dataUrl?: string | null;
}

/** Resolved icon data for a single repo. */
export interface ResolvedRepoIcon {
  /** data URL from the auto-detected favicon (when found). */
  autoDataUrl: string | null;
  /** Manual override (from localStorage). */
  override: RepoIconOverride | null;
}

export const REPO_ICON_KEY_PREFIX = "catalyst.repoIcon.";

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
