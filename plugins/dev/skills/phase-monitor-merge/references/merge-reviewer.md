# Merge: Stale-ref Guard and Reviewer-arrival Window

Once `mergeable_state == "clean"` (and the PR isn't already merged):

```bash
# CTL-864: cross-host fence — bow out if a takeover superseded us. No-op single-host.
"${PLUGIN_ROOT}/scripts/lib/cluster-fence-guard.sh" --phase "$PHASE" --ticket "$TICKET" || exit 10
# CTL-1051: never merge a stale ref. Compare the PR head to the worktree HEAD;
# on mismatch, re-push with lease and re-verify before merging.
if [[ -r "${PLUGIN_ROOT}/scripts/lib/draft-pr.sh" ]]; then
  source "${PLUGIN_ROOT}/scripts/lib/draft-pr.sh"
  PR_HEAD_OID="$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.head.sha' 2>/dev/null || true)"
  LOCAL_HEAD="$(git rev-parse HEAD 2>/dev/null || true)"
  if [[ -n "$PR_HEAD_OID" && -n "$LOCAL_HEAD" && "$PR_HEAD_OID" != "$LOCAL_HEAD" ]]; then
    echo "phase-monitor-merge: PR head ${PR_HEAD_OID} != worktree HEAD ${LOCAL_HEAD}; re-pushing" >&2
    if ! draft_pr_push_verify >/dev/null; then
      echo "phase-monitor-merge: could not reconcile stale ref before merge" >&2
      exit 1
    fi
  fi
fi
# CTL-1680: reviewer-arrival window. mergeable_state == "clean" reflects only
# CURRENTLY-POSTED reviews; an automated reviewer (Codex) that posts minutes after
# PR-open never shows up in mergeable_state until it posts. Before merging a fresh
# CLEAN PR, give an in-flight reviewer a bounded window to land its verdict.
PHASE_REVIEWER_ARRIVAL_WAIT_SEC="${PHASE_REVIEWER_ARRIVAL_WAIT_SEC:-300}"
# CTL-1680 (Codex #3079 P2): resolve REVIEWED_HEAD FRESH from REST, never from the
# CTL-1051 PR_HEAD_OID above — that variable holds the PRE-push remote SHA (the
# stale-ref reconcile redirected draft_pr_push_verify's verified SHA to /dev/null),
# so reusing it would age/scope the OLD commit after a reconcile re-push. REST
# `.head.sha` is authoritative and reflects the just-pushed head.
REVIEWED_HEAD="$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.head.sha' 2>/dev/null || true)"
GH_OWNER="${REPO%/*}"; GH_NAME="${REPO#*/}"
# CTL-1680 (Codex #3079 re-review P1): anchor the window to when this head became
# REVIEWABLE ON THE PR (its push time), NOT when the commit was authored. A commit
# created during a long verify phase can predate PR exposure by hours; anchoring to
# the author/committer date would make HEAD_AGE_SEC already exceed the window and
# merge with zero reviewer window. GraphQL `pushedDate` is the push time; fall back
# to `committedDate`, then to the REST committer date.
# CTL-1680 (Codex #3079 round-2 P1): a PR opened DRAFT by phase-implement and only
# promoted to ready-for-review by phase-pr later (`gh pr ready`, no new commits) is
# not actually reviewable until that promotion — the automated reviewer does not see
# a draft. Anchoring solely to the commit's pushedDate would let HEAD_AGE_SEC already
# exceed the window at promotion time, merging with zero window. Take the LATER of
# pushedDate and the most recent READY_FOR_REVIEW_EVENT timelineItem (a PR never
# drafted has no such event, so pushedDate wins unchanged).
# CTL-1680 (Codex #3079 round-3 P1): a TRANSIENT failure of this lookup must not be
# treated as "no ready-for-review event". The old form swallowed every error with
# `|| true`, so a network/API blip produced an empty result, fell through to the REST
# committer date (which for a long-drafted PR is far older than its promotion), made
# HEAD_AGE_SEC already exceed the window, and merged with ZERO reviewer wait — the
# exact hole the window exists to close. Retry, then distinguish the two outcomes:
#   * query SUCCEEDED but returned nothing  → genuinely no timestamp; the REST
#     committer-date fallback below is correct.
#   * query FAILED every attempt            → exposure time is UNKNOWN; fail SAFE by
#     treating HEAD as freshly exposed (age 0) so the FULL window is waited out.
HEAD_EXPOSED_AT=""
HEAD_EXPOSED_LOOKUP_OK=false
for _attempt in 1 2 3; do
  if HEAD_EXPOSED_AT="$(gh api graphql -f query='
  query($owner:String!,$name:String!,$pr:Int!){
    repository(owner:$owner,name:$name){ pullRequest(number:$pr){
      commits(last:1){ nodes { commit { oid pushedDate committedDate } } }
      timelineItems(itemTypes:[READY_FOR_REVIEW_EVENT], last:1){ nodes { ... on ReadyForReviewEvent { createdAt } } } } } }' \
  -f owner="$GH_OWNER" -f name="$GH_NAME" -F pr="$PR_NUMBER" \
  --jq '.data.repository.pullRequest as $pr
    | (($pr.commits.nodes[0].commit | (.pushedDate // .committedDate)) // "") as $pushed
    | (($pr.timelineItems.nodes[0].createdAt) // "") as $ready
    | (if ($ready != "" and $ready > $pushed) then $ready else $pushed end)
    | select(. != "")' 2>/dev/null)"; then
    HEAD_EXPOSED_LOOKUP_OK=true
    break
  fi
  HEAD_EXPOSED_AT=""
  [[ "$_attempt" -lt 3 ]] && sleep $(( _attempt * 5 ))
done
# Only fall back to the REST committer date when the lookup actually SUCCEEDED and
# simply had no timestamp to give (never to paper over a failed lookup).
if [[ "$HEAD_EXPOSED_LOOKUP_OK" == true && -z "$HEAD_EXPOSED_AT" ]]; then
  HEAD_EXPOSED_AT="$(gh api "repos/${REPO}/commits/${REVIEWED_HEAD}" --jq '.commit.committer.date' 2>/dev/null || true)"
fi
# CTL-1680 (Codex #3079 P1 portability): HEAD age via jq `fromdateiso8601`, NOT the
# BSD/macOS-only `date -j` timestamp parser. On a Linux worker the BSD form fails,
# falls to `echo 0`, HEAD_AGE_SEC becomes ~the current epoch, the window check is
# always false, and every fresh CLEAN PR merges immediately with no reviewer window.
# jq is a hard dependency of this skill and its parse is portable (needs the trailing
# Z, which the timestamp carries) — same approach the End-block mirror already uses.
HEAD_AGE_SEC=""
if [[ -n "$HEAD_EXPOSED_AT" ]]; then
  HEAD_AGE_SEC="$(jq -n --arg a "$HEAD_EXPOSED_AT" '(now - ($a|fromdateiso8601)) | floor' 2>/dev/null || echo "")"
elif [[ "$HEAD_EXPOSED_LOOKUP_OK" != true ]]; then
  # Exposure time unknown after retries → assume the head was JUST exposed so the
  # reviewer-arrival wait below runs its full length. An empty HEAD_AGE_SEC would
  # skip that block entirely and merge unreviewed, so 0 (not "") is the safe value.
  HEAD_AGE_SEC=0
fi
```

The REVIEWER_VERDICT_PRESENT detection and UNRESOLVED thread count continue in
[merge-threads.md](merge-threads.md). The merge execution is in [merge-execute.md](merge-execute.md).
