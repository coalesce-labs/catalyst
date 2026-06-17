// projects-store.ts — CTL-1234: shared jotai atom for the project roster.
// Backs useProjects() so all consumers share one fetch and one refetch.
import { atom, getDefaultStore } from "jotai";

/**
 * One project roster entry — the exact shape GET /api/projects returns (the server's
 * ProjectDescriptor, exported from lib/project-roster.ts). The nav reads repo / name /
 * defaultColor / iconUrl / hasWork; key / vcsRepo / repoRoot ride along for future use
 * (detail pages, settings). CTL-1153 (M2) adds raw-override fields for the editor.
 */
export interface ProjectDescriptor {
  /** Linear team key, UPPERCASE (or repo short-name uppercased for an unconfigured lane). */
  key: string;
  /** EFFECTIVE display name: overlay.name ?? displayCaseName(repo). */
  name: string;
  /** Short repo name, LOWERCASED — the value BoardPayload.repos carries / nav keys on. */
  repo: string;
  /** Full owner/repo from teams[].vcsRepo; null for an unconfigured lane. */
  vcsRepo: string | null;
  /** EFFECTIVE hue NAME resolved server-side; null when none. */
  defaultColor: string | null;
  /** The per-repo favicon endpoint "/api/repo-icon/<repo>". */
  iconUrl: string;
  /** Optional registry.json repoRoot enrichment; null when absent. */
  repoRoot: string | null;
  /** True when this repo has observed work; false for a configured-but-idle team. */
  hasWork: boolean;
  // CTL-1153 (M2): raw-override fields — absent on M1 servers, undefined-safe.
  /** Raw stored name override; null/undefined ⇒ no override. */
  storedName?: string | null;
  /** Raw stored color override; null/undefined ⇒ no override. */
  storedColor?: string | null;
  /** Chosen icon candidate path; null/undefined ⇒ favicon auto-detect. */
  icon?: string | null;
  /** Per-project Linear stateMap partial override; null/undefined ⇒ inherit global. */
  stateMap?: Record<string, string> | null;
  /** Provenance: "overlay" | "config" | "unconfigured". */
  source?: string;
}

export interface ProjectsState {
  projects: ProjectDescriptor[];
  loaded: boolean;
}

export const projectsStateAtom = atom<ProjectsState>({ projects: [], loaded: false });

/**
 * Fetch /api/projects and write the result into projectsStateAtom on `store`.
 * Fail-open: on any error or non-array payload, marks loaded=true and preserves
 * the prior roster rather than wiping it. Both params are injectable for unit tests.
 */
export function loadProjects(
  store = getDefaultStore(),
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  return fetchImpl("/api/projects")
    .then((r) => r.json())
    .then((data: { projects?: unknown }) => {
      const prior = store.get(projectsStateAtom);
      if (Array.isArray(data.projects)) {
        store.set(projectsStateAtom, { projects: data.projects as ProjectDescriptor[], loaded: true });
      } else {
        store.set(projectsStateAtom, { projects: prior.projects, loaded: true });
      }
    })
    .catch(() => {
      const prior = store.get(projectsStateAtom);
      store.set(projectsStateAtom, { projects: prior.projects, loaded: true });
    });
}

// Module-level one-shot guard: the first mount triggers one fetch; subsequent
// mounts in the same module lifetime see it already in flight or done.
let _initialLoadPromise: Promise<void> | null = null;

/**
 * Trigger the initial load exactly once across all consumers in a module lifetime.
 * Tests that need isolation should call loadProjects(store, fetchImpl) directly.
 */
export function ensureProjectsLoaded(
  store = getDefaultStore(),
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!_initialLoadPromise) {
    _initialLoadPromise = loadProjects(store, fetchImpl);
  }
  return _initialLoadPromise;
}
