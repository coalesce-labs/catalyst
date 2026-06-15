// use-projects.ts — CTL-1152: the config-driven project roster hook.
//
// Fetches GET /api/projects (the server's config-driven roster: one descriptor per
// CONFIGURED catalyst.monitor.linear.teams[] entry, plus a self-identifying lane for
// every observed-work repo with no config). Mirrors the fetch idiom in
// use-repo-colors.ts EXACTLY — fail-open to [] so an old server (or any fetch error)
// degrades the sidebar to its first-class empty state rather than throwing, and the
// caller can fall back to payload.repos for one release.
import { useEffect, useState, useCallback } from "react";

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

/**
 * The live project roster + a `loaded` flag + a `refetch` callback (CTL-1153).
 * `loaded` distinguishes "the fetch hasn't resolved yet" from "genuinely empty".
 * `refetch` re-fetches the roster (called by settings pane after a PUT).
 */
export interface UseProjectsResult {
  projects: ProjectDescriptor[];
  loaded: boolean;
  refetch: () => void;
}

export function useProjects(): UseProjectsResult {
  const [projects, setProjects] = useState<ProjectDescriptor[]>([]);
  const [loaded, setLoaded] = useState(false);

  const fetchProjects = useCallback(() => {
    let alive = true;
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data: { projects?: unknown }) => {
        if (!alive) return;
        if (Array.isArray(data.projects)) {
          setProjects(data.projects as ProjectDescriptor[]);
        }
        setLoaded(true);
      })
      .catch(() => {
        if (!alive) return;
        // Fail-open: an old server without /api/projects (or any error) → empty
        // roster, marked loaded so the sidebar falls back to its empty state /
        // payload.repos rather than spinning.
        setLoaded(true);
      });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    return fetchProjects();
  }, [fetchProjects]);

  return { projects, loaded, refetch: fetchProjects };
}
