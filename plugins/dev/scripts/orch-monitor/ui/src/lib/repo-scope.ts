// repo-scope.ts — the PURE, framework-agnostic core of the config-driven
// workspace switcher (CTL-897 / SHELL7).
//
// Catalyst runs across N repos (CTL, ADV, OTEL, …) and operators scope the
// monitor to one repo or see all. SHELL7 lands the switcher that scales 1..N:
//   - a single-repo config → just a label (no dropdown),
//   - a multi-repo config → "All" + one entry per repo, each with a colored
//     scope dot and a checkmark on the active scope.
// The active scope ALSO filters the surfaces' data — selecting a repo restricts
// Home / Board / Workers / Queue to that repo, and "All" restores everything.
//
// This module is the React-free decision layer (the same pattern surface.ts /
// surface-content.ts / list-order.ts follow): the option list the switcher
// renders, the stale-scope reconciliation, and the payload scope filter all live
// here so the four CTL-897 Gherkin scenarios are unit-testable without a DOM.
//
// `repos` is sourced from the read-model `BoardPayload.repos` (the BFF already
// exposes the repo list — it is genuinely config-driven, NOT a hardcoded array
// like the prototype's `REPOS`). Per-repo data filtering is done client-side over
// the resident snapshot's `repo` field on each entity: with a single host this is
// the spec-mandated identity no-op (single repo → "all" is a pass-through), so no
// new BFF endpoint is required for the single-node MVP.
import type {
  BoardPayload,
  BoardTicket,
  BoardWorker,
  BoardQueueItem,
} from "../board/types";

/** The sentinel scope meaning "every repo" (the unfiltered view). Kept distinct
 *  from any real repo name so it can never collide with a config repo key. */
export const REPO_SCOPE_ALL = "all" as const;

/** The active workspace scope: either the all-repos sentinel or a real repo key
 *  (`BoardPayload.repos[n]`). A plain string union — persisted as-is. */
export type RepoScope = typeof REPO_SCOPE_ALL | string;

/** One option in the switcher: the scope value, its human label, whether it is a
 *  real repo (so the UI shows a scope dot) and the resolved dot color (when the
 *  repo-colors config names one — undefined falls back to a neutral dot). */
export interface ScopeOption {
  scope: RepoScope;
  label: string;
  /** True for a real repo entry; false for the synthetic "All" entry. */
  isRepo: boolean;
  /** The scope-dot color for a repo entry, when the config assigns one. */
  dotColor?: string;
}

/**
 * True when the switcher should render as a SCOPING DROPDOWN (two or more repos)
 * rather than a bare label (zero or one repo). Single-repo (or an empty/unloaded
 * config) is the identity case: there is nothing to scope between, so the
 * switcher is just a label and the data filter is a pass-through.
 *
 * Gherkin: "Single-repo config shows just a label" / "Multi-repo config shows a
 * scoping dropdown".
 */
export function isMultiRepo(repos: readonly string[]): boolean {
  return repos.length >= 2;
}

/**
 * The single repo's label for the bare-label (non-dropdown) case. Returns null
 * when there is no single repo to label (zero repos — config not yet loaded, or
 * genuinely repo-less), so the caller can render nothing rather than an empty
 * pill. With exactly one repo this is that repo's name.
 */
export function singleRepoLabel(repos: readonly string[]): string | null {
  return repos.length === 1 ? repos[0] : null;
}

/**
 * Build the dropdown option list for a multi-repo config: the synthetic "All"
 * entry first, then one entry per repo (in config order) carrying its scope-dot
 * color from `repoColors` when assigned. The dot-color discipline (violet / sky /
 * orange …, cyan RESERVED for the live signal) is enforced by the CALLER's color
 * map — this layer only threads whatever color the config resolved through, never
 * inventing one.
 *
 * Gherkin: "the switcher is a dropdown listing All plus each repo, each with a
 * colored scope dot".
 */
export function scopeOptions(
  repos: readonly string[],
  repoColors: Readonly<Record<string, { text: string }>> = {},
): ScopeOption[] {
  const all: ScopeOption = { scope: REPO_SCOPE_ALL, label: "All", isRepo: false };
  const perRepo = repos.map<ScopeOption>((repo) => ({
    scope: repo,
    label: repo,
    isRepo: true,
    // The scope dot uses the repo's `text` swatch (the legible foreground tone)
    // — undefined when the config names no color, so the caller renders a neutral
    // dot rather than fabricating one.
    dotColor: repoColors[repo]?.text,
  }));
  return [all, ...perRepo];
}

/**
 * Reconcile a (possibly stale) persisted scope against the live repo list: a
 * scope pointing at a repo that is no longer in the config (renamed/removed, or a
 * scope persisted under a different fleet) silently falls back to "All" so the
 * surfaces never go inexplicably empty. "all" is always valid. With a single repo
 * the scope is forced to "all" too (there is nothing to scope between — the
 * identity case), so the bare-label config can never carry a dangling repo scope.
 */
export function resolveScope(scope: RepoScope, repos: readonly string[]): RepoScope {
  if (scope === REPO_SCOPE_ALL) return REPO_SCOPE_ALL;
  if (!isMultiRepo(repos)) return REPO_SCOPE_ALL;
  return repos.includes(scope) ? scope : REPO_SCOPE_ALL;
}

/** True when the given scope is the active one (drives the dropdown checkmark). */
export function isActiveScope(option: ScopeOption, active: RepoScope): boolean {
  return option.scope === active;
}

/**
 * Filter a read-model `BoardPayload` down to a single repo scope, used by the
 * Home / Queue surfaces (and mirrored by the Board's own repo filter) so a scope
 * selection actually restricts the data, not just the chrome. "all" returns the
 * payload UNCHANGED (referential identity — the single-node / unfiltered no-op,
 * zero added work). A real repo scope keeps only the workers / tickets / queue
 * rows whose `repo` matches; `config` and `repos` are preserved verbatim so the
 * capacity strip and the switcher's own option list never collapse to the scoped
 * subset.
 *
 * Gherkin: "Scope actually filters the data" — Home/Board/Workers/Queue show only
 * that repo's tickets and workers, and selecting All restores the unfiltered view.
 */
export function filterPayloadByScope(
  payload: BoardPayload,
  scope: RepoScope,
): BoardPayload {
  if (scope === REPO_SCOPE_ALL) return payload;
  const byRepo = <T extends { repo: string }>(rows: readonly T[]): T[] =>
    rows.filter((row) => row.repo === scope);
  return {
    ...payload,
    workers: byRepo<BoardWorker>(payload.workers),
    tickets: byRepo<BoardTicket>(payload.tickets),
    queue: byRepo<BoardQueueItem>(payload.queue),
  };
}
