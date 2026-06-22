// use-repo-scope.ts — the React adapter over the shared workspace-scope atom
// (CTL-897 / SHELL7). The active scope lives in the FND store (`repoScopeAtom`,
// persisted to localStorage) so the two switcher placements — the sidebar header
// and the top strip — and every data surface read the SAME value: a selection in
// one switcher instantly reflects in the other.
//
// This hook resolves the active scope against the live repo set via the pure
// `resolveScope` (a scope pointing at a repo no longer configured, or any scope
// when there is genuinely nothing to scope between, falls back to "All") so the
// surfaces never go inexplicably empty after a config change.
//
// CTL-1311: the reconciliation list is the configured PROJECT ROSTER (what the
// left nav offers as scopes — `useProjects`), unioned with any observed repos the
// caller passes. It previously reconciled ONLY against the caller's observed
// `BoardPayload.repos`; when the roster has many projects but only one has
// observed work (single-host mode → `repos === ["catalyst"]`), resolveScope's
// single-repo rule collapsed EVERY nav scope (adva, otl, even catalyst) to "all".
//
// CTL-1311: this hook NO LONGER writes the resolved value back to the atom. Per
// CTL-989 the atom is a one-way URL mirror (app-shell is its single writer,
// synced from `?scope`). A self-heal write here was a SECOND writer that fought
// the mirror: when the URL scope collapsed to "all", app-shell re-forced the URL
// value while this effect re-forced "all", oscillating until React error #185
// (max update depth) crashed every `?scope=` view. Reads get the reconciled
// `resolved`; the URL/atom remain the operator's selection.
import { useMemo } from "react";
import { useAtom } from "jotai";

import { repoScopeAtom } from "@/board/nav-store";
import { resolveScope, type RepoScope } from "@/lib/repo-scope";
import { useProjects } from "./use-projects";

export interface RepoScopeControl {
  /** The live, reconciled active scope (never a stale/dangling repo). */
  scope: RepoScope;
  /** Set the active scope (shared across every switcher placement + surface). */
  setScope: (scope: RepoScope) => void;
}

/**
 * Read the shared workspace scope, reconciled against the configured roster (the
 * nav's scopes) unioned with the caller's observed `repos`. An empty list (config
 * not yet loaded) forces a real scope to "all" only once there is genuinely
 * nothing to scope between, never clobbering a once-valid selection.
 */
export function useRepoScope(repos: readonly string[]): RepoScopeControl {
  const [raw, setRaw] = useAtom(repoScopeAtom);
  const { projects } = useProjects();

  // Reconcile against the configured roster ∪ the caller's observed repos, so a
  // configured-but-idle project (no observed work yet) stays a valid scope.
  const reconcileRepos = useMemo(
    () => Array.from(new Set([...projects.map((p) => p.repo), ...repos])),
    [projects, repos],
  );
  const resolved = resolveScope(raw, reconcileRepos);

  return { scope: resolved, setScope: setRaw };
}
