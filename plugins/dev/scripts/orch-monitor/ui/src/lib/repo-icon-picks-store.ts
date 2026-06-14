// repo-icon-picks-store.ts — atom + pure selector for per-repo icon picks (CTL-997).
import { atomWithStorage } from "jotai/utils";
import type { IconCandidate } from "./repo-icons";

/** repoKey → selected candidate path. Persisted browser-local (CTL-997). */
export const REPO_ICON_PICKS_KEY = "catalyst.repoIconPicks";
export const repoIconPicksAtom = atomWithStorage<Record<string, string>>(REPO_ICON_PICKS_KEY, {});

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
