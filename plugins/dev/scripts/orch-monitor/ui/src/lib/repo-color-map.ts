// repo-color-map.ts — CTL-1153 (M2): pure helper for resolving repo → RepoColor.
//
// Extracted from use-resolved-repo-colors.ts so this function is unit-testable
// without pulling in React / jotai. The hook imports and re-exports it.
// No jotai dependency — resolveEffectiveColor logic is inlined.
import { NAMED_COLORS, type RepoColor } from "./color-palette";
import type { ProjectDescriptor } from "../hooks/use-projects";

/** Inline: pick > serverName > null (same logic as repo-color-picks-store.ts). */
function resolveHueName(serverName: string | undefined, pick: string | undefined): string | null {
  if (pick && NAMED_COLORS[pick]) return pick;
  if (serverName && NAMED_COLORS[serverName]) return serverName;
  return null;
}

/**
 * PURE helper: build a repo-short-name → RepoColor map from the roster and
 * the operator's legacy localStorage picks. Extracted for unit-testability.
 *
 * Precedence: localStorage pick > server defaultColor > null (entry omitted).
 */
export function resolveRepoColorMap(
  projects: readonly Pick<ProjectDescriptor, "repo" | "defaultColor">[],
  picks: Record<string, string>,
): Record<string, RepoColor> {
  const out: Record<string, RepoColor> = {};
  for (const p of projects) {
    const name = resolveHueName(p.defaultColor ?? undefined, picks[p.repo]);
    if (name) out[p.repo] = NAMED_COLORS[name];
  }
  return out;
}
