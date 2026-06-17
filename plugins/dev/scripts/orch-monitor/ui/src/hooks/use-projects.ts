// use-projects.ts — CTL-1152/CTL-1234: shared project roster hook.
//
// Backed by a single jotai atom (projects-store.ts) so one fetch and one refetch
// are observed by every consumer. The public contract { projects, loaded, refetch }
// is unchanged — no consumer file needs editing.
import { useEffect, useCallback } from "react";
import { useAtomValue } from "jotai";
import {
  projectsStateAtom,
  ensureProjectsLoaded,
  loadProjects,
} from "./projects-store";

export type { ProjectDescriptor } from "./projects-store";

/**
 * The live project roster + a `loaded` flag + a `refetch` callback (CTL-1153).
 * `loaded` distinguishes "the fetch hasn't resolved yet" from "genuinely empty".
 * `refetch` re-fetches the roster (called by settings pane after a PUT).
 */
export interface UseProjectsResult {
  projects: import("./projects-store").ProjectDescriptor[];
  loaded: boolean;
  refetch: () => void;
}

export function useProjects(): UseProjectsResult {
  const { projects, loaded } = useAtomValue(projectsStateAtom);

  useEffect(() => {
    void ensureProjectsLoaded();
  }, []);

  const refetch = useCallback(() => { void loadProjects(); }, []);

  return { projects, loaded, refetch };
}
