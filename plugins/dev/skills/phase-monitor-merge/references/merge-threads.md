# Merge: Reviewer Verdict and Unresolved Thread Count

Continuing from [merge-reviewer.md](merge-reviewer.md) — HEAD_AGE_SEC is already set.

```bash
# Automated-reviewer CLEAN-PASS present ON THIS HEAD? (Codex #3079 P1) Every check is
# scoped to REVIEWED_HEAD — a PR-wide match would let a STALE-head verdict (from
# before a fix-up/rebase/force-push) suppress the window and merge the new commit
# unreviewed. And it must be a genuine CLEAN PASS, not a bare review object: Codex
# posts a review whether or not it has findings, so mere review presence is NOT a
# verdict (Codex #3079 re-review P1) — the "no major issues"/👍 signal is. Note the
# findings-review body ALSO contains "Reviewed commit", so that phrase is NOT a
# clean-pass discriminator; only "no (major) issues"/"didn't find" is. Three shapes:
#   (a) a REVIEW on this head whose body is a clean pass (commit_id-scoped),
#   (b) a clean-pass issue comment on this head (embedded short SHA or timestamp),
#   (c) a 👍 reaction posted at/after this head was exposed (reactions carry no
#       commit, so head-scoping is temporal).
CLEAN_PASS_RE='no (major )?issues|did ?n.?.?t find|did not find'
REVIEWER_VERDICT_PRESENT=false
# (a) clean-pass REVIEW, commit_id-scoped (REST carries commit_id; `gh pr view
#     --json reviews` does not). A review WITH findings does not match CLEAN_PASS_RE.
if gh api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" 2>/dev/null \
   | jq -e --arg h "$REVIEWED_HEAD" --arg re "$CLEAN_PASS_RE" \
       'any(.[]; (.user.login|test("codex";"i")) and (.commit_id == $h) and (.body|test($re;"i")))' >/dev/null 2>&1; then
  REVIEWER_VERDICT_PRESENT=true
fi
# (b) clean-pass issue comment, scoped to this head by embedded short SHA or timestamp.
# CTL-1680 (Codex #3079 round-4 P1): a comment that NAMES a head must be judged by that
# name, never by when it arrived. Codex begins reviewing head A, head B is pushed, then
# A's clean-pass lands — the `created_at >= $at` fallback would accept that A-verdict as
# B's and merge B unreviewed. Codex stamps its verdict with "Reviewed commit: <sha>", so
# reviewed_heads extracts exactly the head(s) a comment claims to have reviewed and a
# mismatch is rejected OUTRIGHT, regardless of arrival time. The timestamp branch now
# only rescues a comment that names NO commit at all (reviewed_heads empty) — its
# original purpose. The prefix test is bidirectional because the stamp may be a short
# SHA while $h is full-length, or vice versa.
if [[ "$REVIEWER_VERDICT_PRESENT" != true ]] && \
   gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" 2>/dev/null \
   | jq -e --arg h "$REVIEWED_HEAD" --arg at "$HEAD_EXPOSED_AT" --arg re "$CLEAN_PASS_RE" \
       'def reviewed_heads:
          [ .body | scan("(?i)reviewed commit[^0-9a-f]*([0-9a-f]{7,40})") | .[0] ];
        any(.[];
          (.user.login|test("codex";"i"))
          and (.body|test($re;"i"))
          and ( (reviewed_heads | length) == 0
                or (reviewed_heads
                    | any(. as $t | ($h|startswith($t)) or ($t|startswith($h)))) )
          and ( ((($h|length) >= 10) and (.body|test($h[0:10])))
                or (($at != "") and (.created_at >= $at)) ))' >/dev/null 2>&1; then
  REVIEWER_VERDICT_PRESENT=true
fi
# (c) 👍 reaction clean-pass posted at/after this head was exposed.
if [[ "$REVIEWER_VERDICT_PRESENT" != true && -n "${HEAD_EXPOSED_AT}" ]] && \
   gh api "repos/${REPO}/issues/${PR_NUMBER}/reactions" \
     -H "Accept: application/vnd.github.squirrel-girl-preview+json" 2>/dev/null \
   | jq -e --arg at "$HEAD_EXPOSED_AT" \
       'any(.[]; (.content=="+1") and (.user.login|test("codex";"i")) and (.created_at >= $at))' >/dev/null 2>&1; then
  REVIEWER_VERDICT_PRESENT=true
fi
# CTL-1680 (Codex #3079 re-review P1): unresolved automated-review findings MUST block
# the merge even when they do NOT flip mergeable_state to "blocked" — a bot is not a
# required reviewer in every repo, and "require conversation resolution" is not
# universally on. This enforces the AGENTS.md absolute rule (every review thread
# resolved before merge) independent of mergeable_state, so a Codex review WITH open
# findings can never be merged past — regardless of the arrival window (fail-CLOSED).
# CTL-1680 (Codex #3079 P2): PAGINATED — mirrors pr-block-probe.mjs's REVIEW_THREADS_QUERY
# (capped at 25 pages of 100, same as the probe's MAX_THREAD_PAGES) so a PR with more than
# 100 review threads never silently drops an unresolved finding beyond the first page.
# CTL-1680 (Codex #3079 P1): FAIL CLOSED on any query failure — a transient GraphQL/auth
# error must NOT be reported as "0 unresolved" (the old `|| echo 0` fallback let a lookup
# failure merge straight past an actually-unresolved finding). UNRESOLVED_THREAD_QUERY_FAILED
# tracks that distinctly from a genuine zero count.
# CTL-1680 (Codex #3079 round-4 P1): count HUMAN unresolved threads as well as bot ones.
# The author filter below used to drop every human thread, so a human who left an
# unresolved COMMENTED/APPROVED thread (neither of which flips mergeable_state, and
# neither of which the CHANGES_REQUESTED check catches) left this gate reading zero and
# the skill merged past an open conversation. GitHub's ruleset also enforces thread
# resolution on this repo, so this is defence-in-depth rather than an open merge hole —
# but the skill's own gate must not be the weaker of the two. Routing differs by author
# and mirrors the existing policy: bot threads are auto-remediated via
# /catalyst-dev:review-comments; human threads are NEVER addressed programmatically
# (same rule as human CHANGES_REQUESTED) and terminate the phase for the operator.
UNRESOLVED_BOT_THREADS=0
UNRESOLVED_HUMAN_THREADS=0
UNRESOLVED_HUMAN_AUTHORS=""
UNRESOLVED_THREAD_QUERY_FAILED=false
THREAD_AFTER=""
THREAD_PAGE=0
THREAD_MAX_PAGES=25
while :; do
  THREAD_PAGE=$((THREAD_PAGE + 1))
  if [[ "$THREAD_PAGE" -gt "$THREAD_MAX_PAGES" ]]; then
    echo "phase-monitor-merge: review-threads exceeded ${THREAD_MAX_PAGES} pages; failing closed" >&2
    UNRESOLVED_THREAD_QUERY_FAILED=true
    break
  fi
  THREAD_ARGS=(api graphql -f query='
    query($owner:String!,$name:String!,$pr:Int!,$after:String){
      repository(owner:$owner,name:$name){ pullRequest(number:$pr){
        reviewThreads(first:100, after:$after){
          pageInfo { hasNextPage endCursor }
          nodes { isResolved comments(first:1){ nodes { author{login} } } } } } } }' \
    -f owner="$GH_OWNER" -f name="$GH_NAME" -F pr="$PR_NUMBER")
  # First page leaves $after unbound (nullable → null → from the beginning).
  [[ -n "$THREAD_AFTER" ]] && THREAD_ARGS+=(-f "after=$THREAD_AFTER")
  THREAD_PAGE_JSON="$(gh "${THREAD_ARGS[@]}" 2>/dev/null)"
  if [[ -z "$THREAD_PAGE_JSON" ]] || ! jq -e '.data.repository.pullRequest.reviewThreads' >/dev/null 2>&1 <<<"$THREAD_PAGE_JSON"; then
    echo "phase-monitor-merge: review-threads GraphQL query failed; failing closed" >&2
    UNRESOLVED_THREAD_QUERY_FAILED=true
    break
  fi
  PAGE_COUNT="$(jq '[.data.repository.pullRequest.reviewThreads.nodes[]
          | select(.isResolved==false)
          | select((.comments.nodes[0].author.login // "")|test("codex|bot";"i"))] | length' <<<"$THREAD_PAGE_JSON")"
  UNRESOLVED_BOT_THREADS=$(( UNRESOLVED_BOT_THREADS + PAGE_COUNT ))
  PAGE_HUMAN_COUNT="$(jq '[.data.repository.pullRequest.reviewThreads.nodes[]
          | select(.isResolved==false)
          | select(((.comments.nodes[0].author.login // "")|test("codex|bot";"i")) | not)] | length' <<<"$THREAD_PAGE_JSON")"
  UNRESOLVED_HUMAN_THREADS=$(( UNRESOLVED_HUMAN_THREADS + PAGE_HUMAN_COUNT ))
  if [[ "$PAGE_HUMAN_COUNT" -gt 0 ]]; then
    PAGE_HUMAN_AUTHORS="$(jq -r '[.data.repository.pullRequest.reviewThreads.nodes[]
            | select(.isResolved==false)
            | select(((.comments.nodes[0].author.login // "")|test("codex|bot";"i")) | not)
            | .comments.nodes[0].author.login // "unknown"] | unique | join(", ")' <<<"$THREAD_PAGE_JSON")"
    UNRESOLVED_HUMAN_AUTHORS="${UNRESOLVED_HUMAN_AUTHORS:+${UNRESOLVED_HUMAN_AUTHORS}, }${PAGE_HUMAN_AUTHORS}"
  fi
  HAS_NEXT="$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage' <<<"$THREAD_PAGE_JSON")"
  [[ "$HAS_NEXT" == "true" ]] || break
  THREAD_AFTER="$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor' <<<"$THREAD_PAGE_JSON")"
done
```

The check results and merge execution continue in [merge-execute.md](merge-execute.md).
