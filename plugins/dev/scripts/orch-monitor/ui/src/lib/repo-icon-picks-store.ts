// repo-icon-picks-store.ts — atom + pure selector for per-repo icon picks (CTL-997).
import { atomWithStorage } from "jotai/utils";
import type { IconCandidate } from "./repo-icons";
import { parseGlyphRef } from "./project-glyph-set";
import type { ProjectMark } from "./project-mark";

/** repoKey → selected candidate path. Persisted browser-local (CTL-997). */
export const REPO_ICON_PICKS_KEY = "catalyst.repoIconPicks";
/**
 * @deprecated CTL-1153 (M2): reads are back-compat only. Writes now go through
 * PUT /api/projects/:key; the server-persisted icon in useProjects() is
 * authoritative. This atom will be removed once the settings pane ships.
 */
export const repoIconPicksAtom = atomWithStorage<Record<string, string>>(REPO_ICON_PICKS_KEY, {});

/** Apply a picker selection: a candidate path sets it, "auto" clears it (inherit
 *  server/default), empty is a deselect no-op (returns the same reference). */
export function applyIconPick(
  prev: Record<string, string>,
  repo: string,
  value: string,
): Record<string, string> {
  if (!value) return prev;
  const next = { ...prev };
  if (value === "auto") delete next[repo];
  else next[repo] = value;
  return next;
}

/**
 * Derive the effective icon for a repo from the candidate list, the server's
 * default selected path, and the operator's optional pick.
 * A stale pick (path not in candidates) falls back to the default.
 */
export function resolveEffectiveIcon(
  candidates: readonly IconCandidate[],
  defaultSelectedPath: string | null,
  pick: string | undefined,
): { autoDataUrl: string | null; selectedPath: string | null } {
  if (candidates.length === 0) return { autoDataUrl: null, selectedPath: null };
  const picked = pick ? candidates.find((c) => c.path === pick) : undefined;
  const chosen =
    picked ??
    candidates.find((c) => c.path === defaultSelectedPath) ??
    candidates[0];
  return { autoDataUrl: chosen.dataUrl, selectedPath: chosen.path };
}

/**
 * Resolve the canonical `ProjectMark` for a repo — the discriminated union that
 * render sites branch on (CTL-1208).
 *
 * Precedence (first match wins):
 *  1. A glyph ref in the local `pick` (operator browser-local override)
 *  2. A glyph ref in `serverIcon` (server-persisted glyph choice)
 *  3. A favicon path in `pick` matching a candidate
 *  4. A favicon path in `serverIcon` matching a candidate
 *  5. The first candidate (auto best)
 *  6. `{kind:"none"}` (no candidates, no glyph)
 */
export function resolveProjectMark(opts: {
  serverIcon: string | null | undefined;
  pick: string | undefined;
  candidates: readonly IconCandidate[];
  defaultSelectedPath: string | null;
}): ProjectMark {
  const { serverIcon, pick, candidates, defaultSelectedPath } = opts;

  // 1. Glyph ref in local pick beats everything.
  if (pick) {
    const glyphPick = parseGlyphRef(pick);
    if (glyphPick) return { kind: "glyph", name: glyphPick.name };
  }

  // 2. Glyph ref in server icon.
  if (serverIcon) {
    const glyphServer = parseGlyphRef(serverIcon);
    if (glyphServer) return { kind: "glyph", name: glyphServer.name };
  }

  // 3–5. Favicon path resolution via existing logic (only if candidates present).
  if (candidates.length > 0) {
    // favicon pick: local pick as path > serverIcon as path > defaultSelectedPath > candidates[0]
    const effectiveDefault = serverIcon && !parseGlyphRef(serverIcon)
      ? serverIcon
      : defaultSelectedPath;
    const { autoDataUrl, selectedPath } = resolveEffectiveIcon(candidates, effectiveDefault, pick);
    if (autoDataUrl && selectedPath) {
      return { kind: "favicon", dataUrl: autoDataUrl, selectedPath };
    }
    // candidate exists but dataUrl is null — still a favicon with null dataUrl; emit none
    if (selectedPath) {
      return { kind: "none" };
    }
  }

  return { kind: "none" };
}
