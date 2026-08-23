# Pattern 3 — Reactive PR Lifecycle (multi-event wait + classify + dispatch)

_Read this when implementing a wait loop that must react to CI failures, review requests, BEHIND
pushes, and PR merge/close — not just block on merge. See also
[pattern3-gotchas.md](pattern3-gotchas.md) when the loop misbehaves._

Pattern 1's single-event wait is fine for the happy path: the PR merges, the
worker exits. But between PR-create and PR-merge, four things can happen that
the agent should *react to*, not just sleep through:

| Event | Means | Agent should |
|---|---|---|
| `github.check_suite.completed` (conclusion=`failure` / `timed_out`) | CI failed | pull failure logs, fix, push, re-enter the wait |
| `github.pr_review.submitted` (state=`changes_requested`) | Reviewer requested changes | run `/review-comments`, push, re-enter the wait |
| `github.push` to the base branch | PR is now BEHIND | `gh pr update-branch`, re-enter the wait |
| `github.pr.merged` / `github.pr.closed` | terminal | confirm via `gh api` REST, exit |

Wrap one disjunctive `wait-for` around all of them; classify with a `case` on
`.event`; re-enter the loop on every non-terminal event. Authoritative
`gh api` REST check runs on every wake-up — same safety rule as Pattern 1.

```bash
# Two-phase compliant cadence loop — see [[wait-for-github]]. The 1800s timeout
# serves as a cadence fallback; the authoritative REST check runs on every wake-up.
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
BASE_BRANCH=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.base.ref')
ITER=0
MAX_ITER=20

while [ $ITER -lt $MAX_ITER ]; do
  ITER=$((ITER + 1))

  EVENT_JSON=$(catalyst-events wait-for \
    --filter '
      (.attributes."event.name" == "github.pr.merged" and .attributes."vcs.pr.number" == '"$PR_NUMBER"') or
      (.attributes."event.name" == "github.pr.closed" and .attributes."vcs.pr.number" == '"$PR_NUMBER"') or
      (.attributes."event.name" == "github.check_suite.completed"
         and (.body.payload.prNumbers // [] | index('"$PR_NUMBER"') != null)
         and (.attributes."cicd.pipeline.run.conclusion" == "failure" or .attributes."cicd.pipeline.run.conclusion" == "timed_out")) or
      (.attributes."event.name" == "github.pr_review.submitted"
         and .attributes."vcs.pr.number" == '"$PR_NUMBER"'
         and (.body.payload.state == "changes_requested"
              or (.body.payload.state == "commented" and (.body.payload.author.type // "") == "Bot"))) or
      (.attributes."event.name" == "github.push" and .attributes."vcs.ref.name" == "refs/heads/'"$BASE_BRANCH"'")
    ' \
    --timeout 1800 || true)

  # MANDATORY authoritative REST re-check on every wake-up.
  PR_STATE=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" \
    --jq 'if .merged then "MERGED" elif .state == "closed" then "CLOSED" else "OPEN" end' \
    2>/dev/null || echo "OPEN")
  if [ "$PR_STATE" = "MERGED" ]; then break; fi
  if [ "$PR_STATE" = "CLOSED" ]; then exit 1; fi

  EVENT=$(echo "$EVENT_JSON" | jq -r '.attributes."event.name" // ""')
  case "$EVENT" in
    github.check_suite.completed)
      # Pull failure logs, classify, fix, push. Then re-enter the loop.
      ;;
    github.pr_review.submitted)
      # Bot reviewers are addressable inline; humans require operator action.
      AUTHOR_TYPE=$(echo "$EVENT_JSON" | jq -r '.body.payload.author.type // "User"')
      if [ "$AUTHOR_TYPE" = "Bot" ]; then
        /catalyst-dev:review-comments "$PR_NUMBER"
      fi
      ;;
    github.push)
      gh pr update-branch "$PR_NUMBER" || true
      ;;
    "")
      # Timed out — no event. The gh api check above confirmed not merged;
      # fall through to next iteration.
      ;;
  esac
done
```

## Bot vs human authorship

Review and comment events carry `body.payload.author = { login, type }` where `type`
is GitHub's `user.type` field — typically `"User"` or `"Bot"`. Use it to route
review-changes-requested events without re-fetching from the GitHub API:

```bash
AUTHOR_TYPE=$(echo "$EVENT_JSON" | jq -r '.body.payload.author.type // "User"')
case "$AUTHOR_TYPE" in
  Bot)
    # codex, claude-code-review, dependabot — addressable inline.
    /catalyst-dev:review-comments "$PR_NUMBER"
    ;;
  *)
    # Human reviewer — surface to the operator and keep waiting.
    ;;
esac
```

The `// "User"` fallback ensures pre-CTL-228 events (no `author` field) are
treated as human-authored — the safer default.

## Long-lived precedent

The orchestrator's Phase 4 loop has used this shape for a while —
`Monitor` over `tail` with a disjunctive filter, then `case` on the
`gh pr view` result. The pattern above is the short-lived `claude -p`-friendly
equivalent: `wait-for` instead of `Monitor`, `case` on the matched event
instead of the canonical PR state. They share the same safety rule: treat
events as wake-up triggers; treat `gh pr view` (or its equivalent) as truth.
