// use-repo-scope.ts — the React adapter over the shared workspace-scope atom
// (CTL-897 / SHELL7). The active scope lives in the FND store (`repoScopeAtom`,
// persisted to localStorage) so the two switcher placements — the sidebar header
// and the top strip — and every data surface read the SAME value: a selection in
// one switcher instantly reflects in the other.
//
// This hook owns the stale-scope reconciliation: it resolves the persisted scope
// against the live `repos` list via the pure `resolveScope` (a scope pointing at
// a repo no longer in the config, or any scope when the config has collapsed to a
// single repo, falls back to "All") so the surfaces never go inexplicably empty
// after a config change. The reconciliation is applied on READ (the returned
// `scope`) AND written back to the atom when it drifts, so the persisted value
// self-heals without a manual reset.
import { useEffect } from "react";
import { useAtom } from "jotai";

import { repoScopeAtom } from "@/board/nav-store";
import { resolveScope, type RepoScope } from "@/lib/repo-scope";

export interface RepoScopeControl {
  /** The live, reconciled active scope (never a stale/dangling repo). */
  scope: RepoScope;
  /** Set the active scope (shared across every switcher placement + surface). */
  setScope: (scope: RepoScope) => void;
}

/**
 * Read + write the shared workspace scope, reconciled against the live repo list.
 * Pass the repos from the resident `BoardPayload.repos`; an empty list (config not
 * yet loaded) leaves a persisted "all" untouched and forces any real scope to
 * "all" (nothing to scope between yet) without clobbering a once-valid selection
 * before the snapshot lands.
 */
export function useRepoScope(repos: readonly string[]): RepoScopeControl {
  const [raw, setRaw] = useAtom(repoScopeAtom);
  const resolved = resolveScope(raw, repos);

  // Self-heal the persisted value when it drifts (e.g. a repo was removed from the
  // config) — but only once the repo list has actually loaded, so we don't reset a
  // valid persisted scope to "all" on the first paint before `repos` arrives.
  useEffect(() => {
    if (repos.length > 0 && resolved !== raw) {
      setRaw(resolved);
    }
  }, [repos.length, resolved, raw, setRaw]);

  return { scope: resolved, setScope: setRaw };
}
