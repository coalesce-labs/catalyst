// github-feed-names.mjs — CTL-1929: WHICH `github.*` names the orchestrator
// consumes, which of them this producer can faithfully replace, and the derivation
// between the two.
//
// ── WHY IT IS A LEAF, AND WHY THE DATA MOVED HERE ──────────────────────────
// These lists were born in `execution-core/github-feed-event.mjs` and
// `github-feed-source.mjs`, next to the code that uses them, which was right while
// the only consumers were the producer and the gate. `catalyst doctor` is now a
// consumer too — it grades the GitHub ingestion route and must say WHICH names a
// declared-cloud node cannot see — and doctor runs under **bare Node**, which
// cannot load either of those files: both reach `bun:sqlite` through
// `github-feed-source.mjs`'s Database import.
//
// ⭐ MEASURED, NOT ASSUMED (because the neighbouring claim about config.mjs turned
// out to be stale — see lib/github-feed-mode.mjs's header):
//   node -e "import('.../execution-core/config.mjs')"            → LOADS
//   node -e "import('.../execution-core/github-feed-gate.mjs')"   → REJECTS
//   node -e "import('.../execution-core/github-feed-source.mjs')" → REJECTS
// So this leaf is load-bearing and its sibling is a consistency choice.
//
// ⛔ THE ALTERNATIVE WAS A SECOND, HAND-MAINTAINED COPY IN DOCTOR, AND THAT IS THE
// FAILURE THIS WHOLE FEATURE KEEPS DESIGNING AGAINST. A doctor that carried its own
// list would keep reporting three uncovered names after CTC-691/CTC-667/CTC-704
// close — telling an operator the route is broken when it is whole, or (worse, on
// the other edge) whole when it is broken. The producer, the dispatch gate and
// doctor now read ONE source.
//
// Zero-import leaf (no imports at all — this is pure data plus one pure function),
// the same constraint `lib/deployment-mode.mjs` and `lib/github-feed-mode.mjs`
// document for the same bare-Node reason.

/**
 * The `github.*` names the BROKER ROUTER acts on — the gate's universe.
 *
 * ⛔ NOT "the names the producer emits". `github.pr.merged` and
 * `github.check_suite.completed` are consumed here (`broker/router.mjs:1497`,
 * `:1513`, `:1856`, `:1871`, `:1941`) and cannot yet be emitted, which is exactly
 * why they must be IN this list: a gate whose universe is the producer's emit-list
 * answers "not-dispatch-class" for the most dangerous name in the feature.
 */
export const GITHUB_CONSUMED_NAMES = Object.freeze([
  "github.pr.opened",
  "github.pr.closed",
  "github.pr.merged",
  "github.pr_review.submitted",
  "github.pr_review_comment.created",
  "github.pr_review_thread.resolved",
  "github.check_suite.completed",
  "github.deployment.created",
  "github.deployment_status.success",
  "github.deployment_status.failure",
  "github.deployment_status.error",
  "github.push",
]);

/**
 * Consumed names with NO replica stream behind them at all.
 *
 * `github.pr.merged` — `pull_requests` has no `merge_commit_sha` column, and
 * `body.payload.mergeCommitSha` is a JOIN KEY: `router.mjs:1513` writes it via
 * `setFilterStateMerged` and `github.deployment.created` later matches
 * `WHERE merge_commit_sha = ?`. A twin without it routes and wakes `monitor-merge`
 * normally while `monitor-deploy` stops firing fleet-wide. → CTC-691
 *
 * `github.check_suite.completed` — the mirror stores no suite row. `check_runs`
 * cannot stand in: one head sha carried 10 distinct `check_suite_id`s on mini-2,
 * several incomplete, so "every run I can see finished" fires EARLY and GREEN on
 * the merge gate. → CTC-667 item 4
 */
export const GITHUB_UNCOVERED_NAMES = Object.freeze([
  "github.pr.merged",
  "github.check_suite.completed",
]);

/**
 * Consumed names that CAN be emitted but not faithfully, so smee must keep carrying
 * them even at `enforce`.
 *
 * `github.push` — `pushes` is keyed `(repo_id, ref)`, so pushes to one ref between
 * ticks collapse to one row. ⛔ The collapse loses an ARRIVAL, not a value:
 * `router.mjs:1582` reads `scope.ref` and nothing else and sets no `wakeStateKey`,
 * so `suppress_identical_wakes` never applies and every arriving push is its own
 * wake. Under enforce with smee suppressed, a collapsed edge is a wake that never
 * happens. Measured: 101 of 138 unmatched smee events (CTL-48). → CTC-704
 */
export const GITHUB_LOSSY_NAMES = Object.freeze(["github.push"]);

/**
 * computeSuppressible — the derivation, as a pure function of its three inputs.
 *
 * ⚠️ TAKES ITS INPUTS AS ARGUMENTS SO THE DERIVATION IS OBSERVABLE. Applied to
 * today's real constants it returns exactly what a hand-written literal would, so a
 * test comparing only the exported constant asserts a tautology and would keep
 * passing after a gap closes and the list is supposed to GROW. Driving it with
 * different inputs is the only way to test that it derives rather than restates.
 */
export function computeSuppressible({ consumed, uncovered, lossy }) {
  const excluded = new Set([...uncovered, ...lossy]);
  return Object.freeze(consumed.filter((n) => !excluded.has(n)));
}

/** The names `enforce` may suppress smee for today: consumed − uncovered − lossy. */
export const GITHUB_SUPPRESSIBLE_NAMES = computeSuppressible({
  consumed: GITHUB_CONSUMED_NAMES,
  uncovered: GITHUB_UNCOVERED_NAMES,
  lossy: GITHUB_LOSSY_NAMES,
});

/** Why an excluded name is excluded — for capture records and doctor output. */
export const EXCLUSION_REASONS = Object.freeze({
  "github.pr.merged": "no-replacement:no-merge-commit-sha:CTC-691",
  "github.check_suite.completed": "no-replacement:no-suite-row:CTC-667-item-4",
  "github.push": "lossy-replacement:pushes-keyed-per-ref:CTC-704",
});
