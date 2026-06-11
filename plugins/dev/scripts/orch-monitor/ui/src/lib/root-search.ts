// root-search.ts — the typed ROOT search-param contract for the unified router
// (CTL-989). The rootRoute's `validateSearch` makes `?scope=` a typed param
// inherited by every child route, so the repo scope (was the source-of-truth
// `repoScopeAtom`) becomes URL-backed: a scoped surface or detail page is
// shareable/bookmarkable and survives a refresh.
//
// PURE module — deliberately React-/router-free (the same pattern as
// route-search.ts) so it unit-tests under `bun test` directly. Total +
// non-throwing: any input yields a valid `{ scope?: string }`; an absent or
// malformed value drops to `undefined` (the unscoped "all" view) rather than
// raising, so a pasted/hand-edited URL can never crash the route resolver.

/** The typed root search params shared by every route via the rootRoute. */
export interface RootSearch {
  /** The active repo scope (a `BoardPayload.repos[n]` key, or "all"). Absent =
   *  the unscoped All view. */
  scope?: string;
}

/**
 * Validate raw URL search into the typed `RootSearch`. Keeps only a non-empty
 * string `scope`; everything else (including the "all" sentinel, which is the
 * implicit default) is dropped to `undefined` so the URL stays clean for the
 * common unscoped case. The clamp to a *known* repo key is applied at READ time
 * against the live `BoardPayload.repos` (lib/repo-scope.ts#resolveScope) — this
 * layer only guarantees the param parses to a safe shape.
 */
export function validateRootSearch(raw: unknown): RootSearch {
  const record: Record<string, unknown> =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};

  const out: RootSearch = {};
  if (
    typeof record.scope === "string" &&
    record.scope !== "" &&
    record.scope !== "all"
  ) {
    out.scope = record.scope;
  }
  return out;
}
