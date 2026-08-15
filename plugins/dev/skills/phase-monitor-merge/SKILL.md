---
name: phase-monitor-merge
description: |
  Phase-agent that watches the open PR through to merge (CTL-449 Initiative 1
  Phase 3). Lifts the active listen loop from the legacy `oneshot` Phase 5
  body: event-driven wait on `catalyst-events wait-for`, inline resolution of
  CI fix-ups, bot review threads, and BEHIND rebases, then `gh pr merge
  --squash` (worktree-safe, CTL-56) when the PR reaches CLEAN. Linear Done transition
  and worktree teardown are owned by phase-teardown (CTL-703). Dispatched as
  a `claude --bg` job by `phase-agent-dispatch`, which invokes it via slash
  command — hence `user-invocable: true`.
user-invocable: true
disable-model-invocation: false # invocable by model (Skill tool) AND user (slash command)
allowed-tools:
  - Bash
  - Read
  - Grep
  - Task
---

# phase-monitor-merge

The reactive half of the worker lifecycle. The PR exists (opened by [[phase-pr]]); this phase agent
drives it to MERGED. Linear Done transition and worktree teardown are owned by [[phase-teardown]]
(CTL-703). Implementation lifts the loop from `plugins/dev/skills/oneshot/SKILL.md` §"Step 2: Active
PR Listen Loop" — same event names, same `mergeable_state` state machine, same inline fix-up cap —
wrapped in the phase-agent envelope (signal file, comms channel, terminal event emission).

## Prerequisites

- `CATALYST_ORCHESTRATOR_DIR`, `CATALYST_ORCHESTRATOR_ID`, `CATALYST_PHASE=monitor-merge`,
  `CATALYST_TICKET` set by [[phase-agent-dispatch]].
- The prior phase's signal file `${ORCH_DIR}/workers/<TICKET>/phase-pr.json` exists with
  `status=done` AND `.pr.number` populated by [[phase-pr]].
- `gh` CLI authenticated; broker daemon optionally running (the loop falls back to direct
  `catalyst-events wait-for` filtering when it is not — see [[wait-for-github]]).

## Prelude

```bash
set -euo pipefail

: "${CATALYST_ORCHESTRATOR_DIR:?required}"
: "${CATALYST_ORCHESTRATOR_ID:?required}"
: "${CATALYST_PHASE:?required}"
: "${CATALYST_TICKET:?required}"

ORCH_DIR="$CATALYST_ORCHESTRATOR_DIR"
ORCH_ID="$CATALYST_ORCHESTRATOR_ID"
PHASE="$CATALYST_PHASE"
TICKET="$CATALYST_TICKET"
CHANNEL="${ORCH_ID}"

SIGNAL_FILE="${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json"
[[ -f "$SIGNAL_FILE" ]] || { echo "phase-${PHASE}: signal file missing" >&2; exit 1; }

PR_SIGNAL="${ORCH_DIR}/workers/${TICKET}/phase-pr.json"
PR_NUMBER=$(jq -r '.pr.number // empty' "$PR_SIGNAL" 2>/dev/null || echo "")
[[ -n "$PR_NUMBER" ]] || { echo "phase-monitor-merge: no PR number in $PR_SIGNAL" >&2; exit 1; }

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[[ -n "$PLUGIN_ROOT" ]] || PLUGIN_ROOT="$(dirname "$(dirname "$(dirname "$(realpath "${BASH_SOURCE[0]:-$0}" 2>/dev/null || echo .)")")")"

COMMS="${PLUGIN_ROOT}/scripts/catalyst-comms"
[[ -x "$COMMS" ]] || COMMS="$(command -v catalyst-comms 2>/dev/null || true)"
if [[ -n "$COMMS" && -x "$COMMS" ]]; then
  "$COMMS" join "$CHANNEL" --as "$TICKET" \
    --capabilities "phase-monitor-merge: ${TICKET} pr#${PR_NUMBER}" \
    --orch "$ORCH_ID" --parent orchestrator --ttl 86400 >/dev/null 2>&1 || true
  "$COMMS" send "$CHANNEL" "phase-monitor-merge watching pr#${PR_NUMBER}" \
    --as "$TICKET" --type info --orch "$ORCH_ID" >/dev/null 2>&1 || true
fi

SESSION_SCRIPT="${PLUGIN_ROOT}/scripts/catalyst-session.sh"
if [[ -x "$SESSION_SCRIPT" ]]; then
  CATALYST_SESSION_ID=$("$SESSION_SCRIPT" start \
    --skill "phase-monitor-merge" --ticket "$TICKET" \
    --workflow "${CATALYST_SESSION_ID:-}")
  export CATALYST_SESSION_ID
fi

REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo "")
[[ -n "$REPO" ]] || { echo "phase-monitor-merge: cannot resolve repo" >&2; exit 1; }

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP="${SIGNAL_FILE}.tmp.$$"
# CTL-496: persist catalystSessionId so orchestrate-roll-usage --phase can
# attribute cost to the right session_metrics row.
jq --arg ts "$TS" --argjson pr "$PR_NUMBER" --arg sid "${CATALYST_SESSION_ID:-}" '
  .status = "running"
  | .updatedAt = $ts
  | .pr = {number: $pr}
  | if $sid != "" then .catalystSessionId = $sid else . end
' "$SIGNAL_FILE" > "$TMP" && mv "$TMP" "$SIGNAL_FILE"
```

## /goal condition

Plan §"Per-phase /goal conditions":

```
/goal "`gh pr view --json merged` returns `true` for the PR linked to
       ${TICKET} (PR #${PR_NUMBER}) AND I have posted the merge mirror
       comment to Linear and emitted phase-monitor-merge.complete (I have
       printed both confirmations to my transcript);
       OR 24 wall-clock hours have elapsed without merge completion
       and I have recorded status:timeout."
```

Wall-clock cap is 24h (per plan §Failure handling).

## Phase-specific work — active listen loop

Reuse the reactive listen loop from [[oneshot]] § Phase 5 Step 2. The full control flow lives there;
this skill copies the body verbatim, substituting `phase-monitor-merge` framing in place of
`oneshot`'s session-id machinery. Key elements that MUST be preserved:

1. **Event-driven, not polling.** `catalyst-events wait-for` blocks until a PR-lifecycle event
   fires. Filter clause matches the canonical event names `github.pr.merged`,
   `github.check_suite.completed`, `github.pr_review*`, and `github.push` keyed by
   `attributes."vcs.pr.number"` (PR/review events) or `body.payload.prNumbers`
   (check_suite/workflow_run — see [[event-schema]]). When the broker daemon is up, register a
   `pr_lifecycle` interest via `agent.checkin.claimed_pr` and wait on
   `filter.wake.${CATALYST_SESSION_ID}` instead (the single-wake path — see [[monitor-events]]
   Pattern 3). **CTL-1680:** when the reviewer-arrival window (Merge step) sets
   `MERGE_WAKE_TIMEOUT_SEC`, the next wait MUST cap its `--timeout` at that many seconds so the loop
   re-evaluates the window deadline even if no PR-lifecycle event arrives — otherwise the general
   wait can block far past the window (600s broker / 180+7200s raw) and delay an already-earned merge.

2. **REST is authoritative.** Every loop iteration calls `gh api repos/${REPO}/pulls/${PR_NUMBER}`
   and reads `.merged` + `.mergeable_state`. Never use `gh pr view --json mergeable` (GraphQL is
   eventually consistent for the merge-state fields and frequently lies).

3. **State machine.** Branch on `mergeable_state`:

   | state            | action                                                                                                                                  |
   | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
   | clean            | proceed to merge step                                                                                                                   |
   | blocked          | resolve via `/catalyst-dev:review-comments` (bot threads) or run an inline CI fix-up commit (up to 3 attempts); 4th attempt → `stalled` |
   | behind           | `git fetch && git rebase origin/<base> && git -c core.hooksPath=/dev/null push --force-with-lease`                                      |
   | dirty            | merge conflicts — emit `failed` with reason "merge conflicts (DIRTY)"                                                                   |
   | unknown/unstable | continue waiting for the next event                                                                                                     |

4. **Human reviewer changes-requested.** After every wake, query `gh pr view --json reviews` for the
   most recent `CHANGES_REQUESTED` from a human reviewer (filter on `.author.login` not matching
   known bots). If present, emit `failed` with reason "human reviewer ${LOGIN} requested changes —
   operator action required". Do NOT attempt to address human review comments programmatically.
   The same applies to an unresolved human review **thread** left on a `COMMENTED`/`APPROVED`
   review: it never surfaces as `CHANGES_REQUESTED` and does not always flip
   `mergeable_state`, so the unresolved-thread gate counts human threads separately and
   emits `failed` for them instead of dispatching `/catalyst-dev:review-comments` (CTL-1680).

5. **Wake narration.** Every iteration produces one short line of assistant text before re-entering
   the wait (defeats the assistant `end_turn` rendering bleed described in [[monitor-events]] §
   Narration). Shape: `wake: <event.name> #<PR_NUMBER> — <action being taken>`.

6. **⚠️ Never end your turn undeclared (CTL-1854).** If you are about to stop while still waiting
   on work you started — a background job, a CI run, a re-review you requested — you MUST say so:

   ```bash
   "$EMIT" --phase "$PHASE" --ticket "$TICKET" --status yield [--yield-seconds <n>]
   ```

   Ending the turn without a declaration is **not** neutral and does not mean "resume later":
   `sdk-run-phase-agent` writes `failed` / `abandoned` / `ended-without-declaration`, and a human is
   paged for a phase whose work may have completed. Measured 2026-08-14: five such runs across both
   hosts in one day, in exactly this phase and `implement`, every one with a clean SDK exit — two of
   them fleet-blocking. "I'll be re-invoked when it completes" is a belief the runtime does not
   share; a yield is how you actually say it. It is bounded (30 min per episode, re-yielding buys
   no more), so it defers the terminal — it never removes it.

## Merge

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
if [[ "$REVIEWER_VERDICT_PRESENT" != true && -n "$HEAD_EXPOSED_AT" ]] && \
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
  # The complement of the bot filter — every unresolved thread NOT opened by a bot.
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
if [[ "$UNRESOLVED_THREAD_QUERY_FAILED" == true ]]; then
  echo "wake: pr#${PR_NUMBER} unresolved-thread lookup failed; NOT merging until it succeeds (fail-closed)"
  continue  # re-enter the loop; never risk merging past an unconfirmed finding
fi
if [[ "$UNRESOLVED_HUMAN_THREADS" -gt 0 ]]; then
  # CTL-1680 (Codex #3079 round-4 P1): a human's unresolved thread is operator work, not
  # agent work — the same rule as human CHANGES_REQUESTED above ("Do NOT attempt to
  # address human review comments programmatically"). Terminate the phase rather than
  # `continue`: nothing this loop can do will resolve it, so re-waiting would spin until
  # the 24h cap. Checked BEFORE the bot branch so a PR carrying both goes to the operator
  # instead of silently auto-remediating half of it and merging.
  HUMAN_THREAD_REASON="pr#${PR_NUMBER} has ${UNRESOLVED_HUMAN_THREADS} unresolved human review thread(s) (${UNRESOLVED_HUMAN_AUTHORS}) — operator action required"
  echo "wake: ${HUMAN_THREAD_REASON}"
  "$EMIT" --phase "$PHASE" --ticket "$TICKET" --status failed --reason "$HUMAN_THREAD_REASON"
  [[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" send "$CHANNEL" \
    "phase-monitor-merge failed: ${HUMAN_THREAD_REASON}" \
    --as "$TICKET" --type attention --orch "$ORCH_ID" >/dev/null 2>&1 || true
  exit 1
fi
if [[ "$UNRESOLVED_BOT_THREADS" -gt 0 ]]; then
  # CTL-1680 (Codex #3079 re-review P1): dispatch the existing review-remediation path
  # instead of merely re-waiting — a bare `continue` here left the PR permanently wedged
  # whenever conversation resolution isn't branch-protected (mergeable_state stays "clean"
  # and no later wake ever differs from this one, so every future iteration repeats the
  # same continue forever). Mirrors oneshot's Phase 5 `blocked` handling: same skill
  # invocation, same one-dispatch-per-wake shape.
  echo "wake: pr#${PR_NUMBER} has ${UNRESOLVED_BOT_THREADS} unresolved automated-review thread(s); dispatching /catalyst-dev:review-comments"
  /catalyst-dev:review-comments "$PR_NUMBER"
  continue  # re-enter the loop; re-evaluate mergeable_state + threads fresh next iteration
fi
if [[ "$REVIEWER_VERDICT_PRESENT" != true && -n "${HEAD_AGE_SEC:-}" ]]; then
  if [[ "$HEAD_AGE_SEC" -lt "$PHASE_REVIEWER_ARRIVAL_WAIT_SEC" ]]; then
    # CTL-1680 (Codex #3079 P2): BOUND the re-wait by the time left in the window, so
    # we re-evaluate when the window elapses even if NO further PR-lifecycle event
    # wakes us (the general listen-loop wait can otherwise block 600s on the broker
    # path or 180+7200s on the raw path — far past a 300s window). Export the remaining
    # seconds; the reused wait-for MUST cap its --timeout at MERGE_WAKE_TIMEOUT_SEC.
    MERGE_WAKE_TIMEOUT_SEC=$(( PHASE_REVIEWER_ARRIVAL_WAIT_SEC - HEAD_AGE_SEC ))
    export MERGE_WAKE_TIMEOUT_SEC
    echo "wake: reviewer-arrival window — pr#${PR_NUMBER} CLEAN but no automated-reviewer verdict on ${REVIEWED_HEAD:0:8} (age ${HEAD_AGE_SEC}s < ${PHASE_REVIEWER_ARRIVAL_WAIT_SEC}s); waiting up to ${MERGE_WAKE_TIMEOUT_SEC}s"
    continue  # re-enter the event-wait loop (timeout-bounded by MERGE_WAKE_TIMEOUT_SEC); a pr_review wake or the deadline re-evaluates
  fi
  echo "phase-monitor-merge: reviewer-arrival window elapsed; proceeding to merge pr#${PR_NUMBER}" >&2
fi
# CTL-56: capture head ref BEFORE merge so we can delete it checkout-free after confirm.
HEAD_REF=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.head.ref' 2>/dev/null || true)
# Merge via REST only (CTL-56: dropping the local branch-cleanup flag avoids the
# `git checkout <base>` that fails inside a linked worktree when main is checked
# out in the primary clone). The exit code is now meaningful; REST confirm below
# is the authoritative success gate.
gh pr merge "$PR_NUMBER" --squash
# REST is authoritative — confirm via REST, never GraphQL
MERGED_OK=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.merged' 2>/dev/null || echo "false")
[[ "$MERGED_OK" = "true" ]] || { echo "phase-monitor-merge: merge not confirmed via REST" >&2; exit 1; }

# CTL-1680: retry empty merge_commit_sha — GitHub can return it empty for a few
# seconds after a squash merge while it computes the SHA. Bounded + sleeps (no
# GNU `timeout` dependency; portable to stock macOS).
PHASE_MERGE_SHA_RETRIES="${PHASE_MERGE_SHA_RETRIES:-5}"
MERGE_COMMIT_SHA=""
# CTL-1680 (Codex #3079 P1 portability): a portable counting `while` loop, NOT `seq` —
# stock macOS (the fleet's primary launchd environment) ships no `seq` binary unless GNU
# coreutils is installed, so `$(seq 1 N)` there expands to nothing and this loop silently
# runs zero times, leaving MERGE_COMMIT_SHA empty on every successful merge. A bash
# arithmetic while-loop needs no external command.
_sha_retry=1
while [[ "$_sha_retry" -le "$PHASE_MERGE_SHA_RETRIES" ]]; do
  MERGE_COMMIT_SHA=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.merge_commit_sha // empty' 2>/dev/null || true)
  [[ -n "$MERGE_COMMIT_SHA" ]] && break
  sleep 2
  _sha_retry=$((_sha_retry + 1))
done
[[ -z "$MERGE_COMMIT_SHA" ]] && \
  echo "phase-monitor-merge: merge_commit_sha still empty after ${PHASE_MERGE_SHA_RETRIES} attempts for pr#${PR_NUMBER}" >&2
MERGED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Record merge in signal file.
TMP="${SIGNAL_FILE}.tmp.$$"
jq --arg ts "$MERGED_AT" --arg sha "${MERGE_COMMIT_SHA:-}" \
   '.pr.mergedAt = $ts | .pr.ciStatus = "merged"
    | (if $sha != "" then .pr.mergeCommitSha = $sha else . end)
    | .updatedAt = $ts' \
   "$SIGNAL_FILE" > "$TMP" && mv "$TMP" "$SIGNAL_FILE"

# CTL-56: delete the remote head ref checkout-free, AFTER merge is REST-confirmed and SHA
# recorded. Idempotent + best-effort: a 404/422 means the ref is already gone or protected;
# never fail the phase on branch cleanup — the merge already landed.
if [[ -n "${HEAD_REF:-}" ]]; then
  # CTL-56: URL-encode the head ref (preserve '/') so a metacharacter like '#' in a branch name
  # (e.g. feature#123) can't truncate the endpoint into deleting the wrong ref.
  enc_ref=$(printf '%s' "$HEAD_REF" | jq -sRr @uri | sed 's|%2F|/|g')
  gh api --method DELETE "repos/${REPO}/git/refs/heads/${enc_ref}" >/dev/null 2>&1 \
    || echo "CTL-56: remote branch ${HEAD_REF} delete skipped (already gone or protected)" >&2
fi

# CTL-703: Linear Done is written by phase-teardown (10th phase), not here.
echo "phase-monitor-merge: pr#${PR_NUMBER} merged at ${MERGED_AT}"

# CTL-703: worktree + branch removal moved to phase-teardown.
```

Deployment verification (`skipDeployVerification=false`) is **not** in this phase's scope — that is
`phase-monitor-deploy` (plan §Initiative 1 Phase 5). This skill exits cleanly the moment the merge
lands and the End-block mirror is posted (CTL-703: Linear Done and worktree teardown happen in
phase-teardown; the compound-log entry below is best-effort and never extends the phase on failure).

## Compound-log closing entry (CTL-813 — off the critical path)

After the merge lands, write the ticket's compound-log entry so the estimation loop's sink fills
autonomously (the unbuilt CTL-189 — in `merge-pr` a human answers these prompts; here YOU author
them). **Best-effort: on ANY failure log one line and continue to the End block — never fail or
block the phase on this.**

1. **Re-score from the merged diff** (CTL-746 structural bands → points XS=1 S=3 M=5 L=8 XL=13; LOC
   = additions+deletions: `<50→1, <200→3, <800→5, <2000→8, else 13`):

```bash
LOC=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.additions + .deletions' 2>/dev/null || echo "")
if   [[ -z "$LOC" ]];      then POINTS=""
elif [[ "$LOC" -lt 50 ]];  then POINTS=1
elif [[ "$LOC" -lt 200 ]]; then POINTS=3
elif [[ "$LOC" -lt 800 ]]; then POINTS=5
elif [[ "$LOC" -lt 2000 ]]; then POINTS=8
else POINTS=13; fi
```

Adjust ±1 step with judgment (e.g. heavy rework you personally resolved — CI fix-up loops, rebases —
justifies a bump). Skip the whole section when `POINTS` is empty.

2. **Author the two reflections yourself** — you just walked this PR through merge, so you have the
   ground truth: `what_worked` (1-2 sentences) and `what_surprised_me` (1-2 sentences; the
   BEHIND-rebase treadmill, bot review threads, or flaky CI you resolved are exactly this signal).

3. **Write the entry.** The helper resolves `estimate_at_start`/cost/wall from its defaults; on a
   missing default, retry once with explicit overrides; on a duplicate (re-walked phase), the
   "already exists" failure IS the skip path:

```bash
CL="${PLUGIN_ROOT}/scripts/compound-log.sh"
"$CL" write "$TICKET" --pr "$PR_NUMBER" --estimate-actual "$POINTS" \
  --what-worked "$WHAT_WORKED" --what-surprised-me "$WHAT_SURPRISED" 2>/dev/null \
|| "$CL" write "$TICKET" --pr "$PR_NUMBER" --estimate-actual "$POINTS" \
  --what-worked "$WHAT_WORKED" --what-surprised-me "$WHAT_SURPRISED" \
  --cost-usd 0 --estimate-start 0 \
|| echo "phase-monitor-merge: compound-log entry skipped (non-fatal)" >&2
```

Do NOT run the corpus refresh here (that is `compound-estimate` step 6 / operator cadence — a
background phase worker must not mutate the committed corpus).

4. **Run the cross-ticket retro (CTL-831 — the per-ticket learning step).** After the compound-log
   entry (success OR skip), invoke `/catalyst-dev:ticket-retro` with no arguments. It regenerates
   `thoughts/shared/retros/ticket/<today>.md` over the since-last-retro window (same-day re-runs are
   cumulative by design) and refreshes the watch-items the morning briefing surfaces — this is how
   the system learns from every ticket it ships. Same contract as the entry above: **best-effort,
   never blocks the End block** — on any retro failure, log one line and continue.

## End block

Mirror the merge outcome to Linear as a single comment (CTL-632). Best-effort end-of-loop summary
(per the design decision — per-finding detail like individual CI fix-up commits or bot review
threads stays on the PR itself): merge commit + base branch, the final CI check rollup
(passed/total), and a count of bot reviews handled (e.g. Codex) whose threads were resolved before
the merge. Merge metadata is re-read from the signal file (`.pr.mergeCommitSha` / `.pr.mergedAt`,
written in the merge step above); CI + reviews are pulled once from `gh pr view`. Runs inside the
ticket worktree (CTL-703: no auto-teardown `cd` here; the skill stays in the ticket worktree and
relies on absolute signal paths and the PR number). Body hard-truncated to 30,000 bytes. Fail-open
and idempotent via the per-phase marker file. Uniquely-named fence so the e2e test can extract just
this block.

```bash phase-monitor-merge-mirror
LINEAR_MIRROR_MARKER="${ORCH_DIR}/workers/${TICKET}/.linear-mirror-${PHASE}"
if [[ ! -e "${LINEAR_MIRROR_MARKER}" ]]; then
  MM_SIGNAL="${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json"
  MM_PR_NUMBER="$(jq -r '.pr.number // empty' "${MM_SIGNAL}" 2>/dev/null || true)"
  [[ -n "${MM_PR_NUMBER}" ]] || MM_PR_NUMBER="${PR_NUMBER:-}"
  MERGE_SHA="$(jq -r '.pr.mergeCommitSha // empty' "${MM_SIGNAL}" 2>/dev/null || true)"
  MERGED_AT="$(jq -r '.pr.mergedAt // empty' "${MM_SIGNAL}" 2>/dev/null || true)"
  PR_VIEW="{}"
  if [[ -n "${MM_PR_NUMBER}" ]]; then
    PR_VIEW="$(gh pr view "${MM_PR_NUMBER}" --json url,baseRefName,createdAt,statusCheckRollup,reviews 2>/dev/null || echo '{}')"
  fi
  PR_URL="$(printf '%s' "${PR_VIEW}" | jq -r '.url // empty' 2>/dev/null || true)"
  BASE_REF="$(printf '%s' "${PR_VIEW}" | jq -r '.baseRefName // "main"' 2>/dev/null || echo 'main')"
  CREATED_AT="$(printf '%s' "${PR_VIEW}" | jq -r '.createdAt // empty' 2>/dev/null || true)"
  CHECKS_TOTAL="$(printf '%s' "${PR_VIEW}" | jq -r '(.statusCheckRollup // []) | length' 2>/dev/null || echo 0)"
  CHECKS_PASSED="$(printf '%s' "${PR_VIEW}" | jq -r '[(.statusCheckRollup // [])[] | select((.conclusion // .state) == "SUCCESS")] | length' 2>/dev/null || echo 0)"
  BOT_REVIEWS="$(printf '%s' "${PR_VIEW}" | jq -r '[(.reviews // [])[] | select((.author.login // "" | ascii_downcase) | test("codex|bot"))] | length' 2>/dev/null || echo 0)"
  if [[ "${CHECKS_TOTAL}" == "0" ]]; then
    CI_LINE="_no CI checks reported_"
  else
    CI_LINE="${CHECKS_PASSED}/${CHECKS_TOTAL} checks passed"
  fi
  if [[ -n "${MERGE_SHA}" ]]; then
    MERGE_LINE="\`${MERGE_SHA}\` into \`${BASE_REF}\`${MERGED_AT:+ at ${MERGED_AT}}"
  else
    MERGE_LINE="_merge commit unavailable_"
  fi
  # Wall-clock time the PR was open (opened → merged). This is total elapsed,
  # most of it spent WAITING on GitHub (CI, reviews) — the agent's actual
  # working time is the "active" figure in the footer below, so
  # waiting ≈ time-to-merge − active. fromdateiso8601 is portable (needs the Z).
  TIME_TO_MERGE="_unknown_"
  if [[ -n "${CREATED_AT}" && -n "${MERGED_AT}" ]]; then
    TTM_SECS="$(jq -n --arg a "${CREATED_AT}" --arg b "${MERGED_AT}" \
      '(($b|fromdateiso8601) - ($a|fromdateiso8601)) | floor' 2>/dev/null || echo "")"
    if [[ "${TTM_SECS}" =~ ^[0-9]+$ ]]; then
      TTM_H=$(( TTM_SECS / 3600 )); TTM_M=$(( (TTM_SECS % 3600) / 60 ))
      if [[ "${TTM_H}" -gt 0 ]]; then TIME_TO_MERGE="${TTM_H}h ${TTM_M}m"; else TIME_TO_MERGE="${TTM_M}m"; fi
    fi
  fi
  MIRROR_BODY="$(cat <<EOF
**Phase Monitor-Merge** — PR #${MM_PR_NUMBER:-?} merged

- **PR**: ${PR_URL:-_url unavailable_}
- **Merge commit**: ${MERGE_LINE}
- **Time to merge** (PR opened → merged): ${TIME_TO_MERGE} — mostly waiting on CI/reviews; see the footer's _active_ figure for actual working time
- **CI**: ${CI_LINE}
- **Bot reviews handled** (e.g. Codex): ${BOT_REVIEWS} — threads resolved before merge

_Posted automatically by phase-monitor-merge (CTL-632). Per-finding detail —
individual CI fix-up commits and review threads — lives on the PR itself._
EOF
)"
  MIRROR_FOOTER=""
  if [[ -n "${PLUGIN_ROOT:-}" && -x "${PLUGIN_ROOT}/scripts/lib/phase-mirror-footer.sh" ]]; then
    MIRROR_FOOTER="$("${PLUGIN_ROOT}/scripts/lib/phase-mirror-footer.sh" --orch-dir "${ORCH_DIR}" --ticket "${TICKET}" --phase "${PHASE}" 2>/dev/null || true)"
  fi
  [[ -n "${MIRROR_FOOTER}" ]] && MIRROR_BODY="${MIRROR_BODY}
${MIRROR_FOOTER}"
  if [[ ${#MIRROR_BODY} -gt 30000 ]]; then
    MIRROR_BODY="${MIRROR_BODY:0:30000}

_... (truncated)_"
  fi
  COMMENT_POST="${CATALYST_COMMENT_POST_HELPER:-${PLUGIN_ROOT}/scripts/lib/linear-comment-post.sh}"
  if [[ ! -x "$COMMENT_POST" ]]; then COMMENT_POST="$(command -v linear-comment-post.sh 2>/dev/null || true)"; fi
  if [[ -n "$COMMENT_POST" && -x "$COMMENT_POST" ]] && "$COMMENT_POST" "${TICKET}" "${MIRROR_BODY}" >/dev/null; then
    : > "${LINEAR_MIRROR_MARKER}"
  else
    echo "phase-monitor-merge: linear-comment-post failed (continuing)" >&2
  fi
fi
```

```bash phase-monitor-merge-thoughts-doc
# CTL-1490: write durable local thoughts doc (unconditional; push is mode-gated).
# Reuses MIRROR_BODY already computed in the mirror block above.
source "${PLUGIN_ROOT}/scripts/lib/write-phase-thoughts-doc.sh"
write_phase_thoughts_doc "monitor-merge" "$TICKET" "${MIRROR_BODY:-}" || true
"${PLUGIN_ROOT}/scripts/lib/thoughts-sync-gate.sh" --phase "$PHASE" --ticket "$TICKET" || exit 11
```

```bash
EMIT="${PLUGIN_ROOT}/scripts/phase-agent-emit-complete"
if [[ -x "$EMIT" ]]; then
  "$EMIT" --phase "$PHASE" --ticket "$TICKET" --status complete
fi
[[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" done "$CHANNEL" --as "$TICKET" >/dev/null 2>&1 || true
```

## Failure handling

```bash
REASON="${1:-listen loop terminal failure}"
"$EMIT" --phase "$PHASE" --ticket "$TICKET" --status failed --reason "$REASON"
[[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" send "$CHANNEL" \
  "phase-monitor-merge failed: ${REASON}" \
  --as "$TICKET" --type attention --orch "$ORCH_ID" >/dev/null 2>&1 || true
exit 1
```

Failure modes that emit `phase.monitor-merge.failed.${TICKET}`:

- `dirty` (merge conflicts) — operator must rebase manually.
- Human reviewer `CHANGES_REQUESTED` — operator must address comments.
- Unresolved **human** review thread(s) — an unresolved `COMMENTED`/`APPROVED` conversation
  blocks the merge but is not `CHANGES_REQUESTED`, so it terminates here for the operator
  rather than being auto-remediated (CTL-1680).
- CI blocked after 3 auto-fix attempts.
- `gh pr merge` succeeded but REST confirms `.merged == false` (rare; usually a branch-protection
  rule mismatch).
- 24-hour wall-clock cap — orchestrator dispatches a fix-up or escalates.

## Comms discipline

Inherits the contract from [[_phase-agent-template]]:

| Type        | When                                                                   |
| ----------- | ---------------------------------------------------------------------- |
| `info`      | At start with PR number; after each successful inline fix-up.          |
| `attention` | DIRTY, human changes-requested, CI blocked after 3 attempts.           |
| `question`  | Reserved — this phase rarely needs to ask, since the work is reactive. |
| `done`      | Emitted by `phase-agent-emit-complete` on merge confirmed.             |

## Why this is a thin wrapper

Plan architectural commitment #3. The listen loop logic lives in [[oneshot]] SKILL.md and is
exercised every day. Lifting it into a phase-agent skill without duplicating the body keeps both
paths in lockstep — when the legacy oneshot path retires (plan §Initiative 1 Phase 6), this skill
becomes the sole owner.
