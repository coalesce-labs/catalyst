// pr-status-fold.mjs — CTL-2008. Derive a PR's lifecycle status from a `github.pr.*`
// event, so `pr_status_cache` stays current with NO webhook receiver in the path.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
// `pr_status_cache` was written in exactly ONE place: orch-monitor's HTTP webhook
// handler (`orch-monitor/lib/pr-cache.ts`, called from `lib/webhook-handler.ts`).
// CTL-1929 retired the GitHub smee tunnel on 2026-08-18, so that handler stopped
// being reached and the table FROZE — measured by A/B at 14:02 CT with one variable
// (the tunnel) and the same merge (`catalyst-cloud#882`): `mini` (tunnel open)
// recorded it `merged` at 18:59:42Z; `mini-2` (tunnel closed) still read `open` from
// 18:42:27Z, with ZERO rows written to the table after its flip.
//
// ⛔ A FROZEN MAP IS WORSE THAN AN EMPTY ONE, which is why this is a fold and not a
// staleness check. `board-health.mjs`'s `checkPhantomMergedPr` and
// `checkOrphanedOpenPr` both guard on `map.size === 0 -> observable:false` — the safe
// degradation. A frozen NON-EMPTY map defeats that guard: it looks observable and
// answers wrong, and it rots monotonically. A PR merging after the freeze stays
// `open`, so phantom-merged goes blind (the exact detector CTL-1606 exists to serve)
// while orphaned-open-PR accumulates false positives.
//
// ── WHY THE BROKER, AND NOT THE PRODUCER ───────────────────────────────────
// The broker's tail sees EVERY event this fleet appends, from either source. Folding
// here means the table is maintained identically at `enforce` (cloud feed) and after
// a rollback to smee (webhook events carry the same names and the same payload
// fields), so the rollback lever in `docs/runbooks/cloud-feed-cutover.md` does not
// have to also un-break this. A producer-side write would only work in one mode.
//
// ⚠️ THE CALLER MUST FOLD ABOVE THE `if (!interests.size) return` GATE. This is not
// a style note: on an execution-core host the interest table is permanently EMPTY
// (the daemon runs no `filter.register` producer), so anything below that gate never
// runs at all. `router.mjs`'s CTL-822 Linear-descriptor fold sits above it for this
// same reason and its comment records that a verify panel caught the mistake once
// already. `pr-status-fold-wiring.test.mjs` asserts the placement rather than the
// value, because a correct classifier wired below the gate is a silent no-op.

/** The three `github.pr.*` names that carry a PR's lifecycle state. */
export const PR_LIFECYCLE_EVENT_NAMES = Object.freeze([
  "github.pr.opened",
  "github.pr.closed",
  "github.pr.merged",
]);

/**
 * The status values `board-health.mjs` expects. Kept as a frozen set so a typo in a
 * future branch fails a test rather than writing an unrecognised status that
 * `PR_MERGED_RE` silently declines to match.
 */
export const PR_STATUSES = Object.freeze(["open", "closed", "merged"]);

/**
 * classifyPrStatusEvent — pure. `(name, detail, scope) -> {repo, prNumber, status}`
 * or `null` when the event is not a PR-lifecycle edge or is missing an identity.
 *
 * ⛔ THE ONE RULE: NOTHING MAY WALK A MERGED PR BACK TO `open`. That is the
 * phantom-orphan bug CTL-1606 fixed — under `getAllPrStatuses`'s newest-wins, one
 * later `open` row hides a merged PR from `checkPhantomMergedPr` and then presents it
 * to `checkOrphanedOpenPr` as an orphan. `webhook-handler.ts` states the same rule and
 * satisfies it by reading the PR's STATE (`merged`) rather than the webhook ACTION,
 * because a raw `pull_request` webhook fires `labeled` / `edited` on already-merged
 * PRs and an action-keyed derivation would flip them.
 *
 * ⭐ THIS FUNCTION SEES ALREADY-CLASSIFIED NAMES, so it reads BOTH and takes the union:
 * `merged` when the state says so OR when the event is literally `github.pr.merged`.
 * State alone is not enough here — a `github.pr.merged` whose payload lost its
 * `merged` field would classify `open`, which is exactly the walk-back. Name alone is
 * not enough either — `github.pr.closed` with `merged: true` is a merge. Taking the
 * union means the only route to `open` is `github.pr.opened` on a PR that is not
 * merged, so a walk-back is not constructible from any single event.
 *
 * ⚠️ The `putPrStatus` writer ALSO refuses to overwrite a `merged` row. The two guards
 * are deliberate belt-and-braces at different altitudes and neither is redundant: this
 * one stops a wrong value being derived, the latch stops a correct-but-stale value
 * being applied out of order (events are not delivered in commit order).
 *
 * ⛔ IDENTITY IS (repo, pr_number) AND BOTH ARE REQUIRED. `getAllPrStatuses` buckets
 * a null repo under the `""` repoKey, which `lookupPrStatus` treats as the
 * "single UNATTRIBUTED row" legacy case and will hand to a ticket in ANY repo. One
 * repo-less row therefore does not degrade to "less data" — it can attach a wrong
 * repo's status to a ticket. Declining is the only safe answer.
 */
export function classifyPrStatusEvent(name, detail, scope) {
  if (typeof name !== "string" || !PR_LIFECYCLE_EVENT_NAMES.includes(name)) return null;

  const d = detail && typeof detail === "object" ? detail : {};
  const s = scope && typeof scope === "object" ? scope : {};

  const repo = typeof s.repo === "string" && s.repo.length > 0 ? s.repo : null;
  if (repo === null) return null;

  // Number(), not a truthiness check: PR #0 does not exist, but a string "3585" off a
  // legacy envelope does, and dropping it would make the rollback path lossy.
  const prNumber = Number(s.pr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) return null;

  const status =
    d.merged === true || name === "github.pr.merged"
      ? "merged"
      : name === "github.pr.closed"
        ? "closed"
        : "open";
  return { repo, prNumber, status };
}
