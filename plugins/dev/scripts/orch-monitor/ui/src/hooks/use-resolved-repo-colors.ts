// use-resolved-repo-colors.ts — CTL-1153 (M2): re-sourced from useProjects().
//
// M1 sourced the server color default from GET /api/config (owner/repo keyed),
// which caused a latent bug: the hook keyed by owner/repo but consumers looked
// up by SHORT repo name — so the server default never tinted a board lane.
// M2 sources from useProjects() (already short-name keyed via ProjectDescriptor.repo),
// both fixing that bug and making the server-persisted projects[] color authoritative.
//
// Precedence: legacy localStorage pick (back-compat, CTL-1153 Decision D)
//             > server defaultColor from useProjects() roster
//             > null.
//
// The localStorage atom is READ-ONLY after M2 — the settings pane writes the
// server via PUT /api/projects/:key; the atom is no longer written from the UI.
import { useMemo } from "react";
import { useAtomValue } from "jotai";
import type { RepoColor } from "@/lib/color-palette";
import { repoColorPicksAtom } from "@/lib/repo-color-picks-store";
import { useProjects } from "./use-projects";
// CTL-1153: pure helper extracted to lib/repo-color-map.ts so it can be unit-tested
// without React. Imported here for use in useResolvedRepoColors + re-exported for
// callers that import it from this hooks file.
import { resolveRepoColorMap } from "@/lib/repo-color-map";
export { resolveRepoColorMap };

/** repo short-name → resolved {bg,text}, server roster layered over legacy picks. */
export function useResolvedRepoColors(): Record<string, RepoColor> {
  const { projects } = useProjects();
  const picks = useAtomValue(repoColorPicksAtom);
  return useMemo(() => resolveRepoColorMap(projects, picks), [projects, picks]);
}
