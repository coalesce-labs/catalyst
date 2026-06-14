// use-scoped-board-snapshot.ts — the workspace-scoped read-model snapshot
// (CTL-897 / SHELL7). Wraps `useBoardSnapshot` and applies the active workspace
// scope (the FND `repoScopeAtom`, shared with the switcher placements) to the
// resident `BoardPayload` via the pure `filterPayloadByScope`.
//
// This is the seam that makes the switcher's selection ACTUALLY filter the
// surfaces' data (the prototype left this as a `// TODO` no-op): the Home and
// Queue surfaces consume THIS instead of the raw `useBoardSnapshot` so a scope
// selection restricts their tickets / workers / queue to one repo, and "All"
// restores the unfiltered view (the identity no-op — `filterPayloadByScope`
// returns the same payload reference, so the single-node case adds zero work).
//
// The scope is reconciled against the live `payload.repos` by `useRepoScope` (a
// stale repo → "All"), so a surface never goes inexplicably empty after a config
// change.
import { useMemo } from "react";

import { useBoardSnapshot, type BoardSnapshot } from "./use-board-snapshot";
import { useRepoScope } from "./use-repo-scope";
import { filterPayloadByScope } from "@/lib/repo-scope";

/**
 * The board snapshot with the active workspace scope applied to its payload.
 * `status` passes through untouched (transport health is repo-agnostic). When no
 * payload has landed yet, `payload` stays null exactly as the unscoped hook does.
 */
export function useScopedBoardSnapshot(): BoardSnapshot {
  const { payload, status } = useBoardSnapshot();
  const repos = payload?.repos ?? [];
  const { scope } = useRepoScope(repos);

  const scoped = useMemo(
    () => (payload ? filterPayloadByScope(payload, scope) : null),
    [payload, scope],
  );

  return { payload: scoped, status };
}
