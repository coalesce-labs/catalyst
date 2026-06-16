// repo-color-picks-store.ts — atom + pure selector for per-project color picks (CTL-1027).
import { atomWithStorage } from "jotai/utils";
import { NAMED_COLORS } from "./color-palette";

/** repoKey → chosen hue name. Persisted browser-local (mirrors CTL-997 icon picks). */
export const REPO_COLOR_PICKS_KEY = "catalyst.repoColorPicks";
/**
 * @deprecated CTL-1153 (M2): reads are back-compat only. Writes now go through
 * PUT /api/projects/:key; the server-persisted defaultColor in useProjects() is
 * authoritative. This atom will be removed once the settings pane ships.
 */
export const repoColorPicksAtom = atomWithStorage<Record<string, string>>(REPO_COLOR_PICKS_KEY, {});

/** The palette names, in canonical order — the picker's option list. */
export const NAMED_COLOR_NAMES = Object.keys(NAMED_COLORS);

/**
 * Resolve a project's effective hue NAME from the server default and the operator's
 * optional pick. A pick wins only if it names a known hue; an unknown/stale pick
 * (or none) falls back to the server default; an unknown server value resolves null.
 */
export function resolveEffectiveColor(
  serverName: string | undefined,
  pick: string | undefined,
): string | null {
  if (pick && NAMED_COLORS[pick]) return pick;
  if (serverName && NAMED_COLORS[serverName]) return serverName;
  return null;
}

/** Apply a picker selection: a hue name sets it, "auto" clears it (inherit server),
 *  empty is a deselect no-op (returns the same reference). */
export function applyColorPick(
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
