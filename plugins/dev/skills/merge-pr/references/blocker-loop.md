# Step 6 — Diagnose and Resolve Merge Blockers (Reactive PR Lifecycle)

_The canonical reactive-PR loop (documented here since CTL-2240 removed `monitor-events`): a single `wait-for` fires on any of PR merged, PR closed, CI failure, review changes-requested, or push to the base branch. Each wake-up is paired with an authoritative `gh api` REST re-check._

Read and follow the full workflow in
`"${CLAUDE_PLUGIN_ROOT}/references/merge-blocker-diagnosis.md"`.

The wake-up mechanism here is the **canonical "Reactive PR lifecycle" pattern (Pattern 3, CTL-228; the `monitor-events` skill that first documented it was removed with the daemon, CTL-2240)**: each wake-up tells the agent *what changed*; `gh api` tells it *the current truth*. Subscribe only to `github.pr.merged` is wrong — most of the interval between PR-create and PR-merge is spent on CI, review, and base-branch churn; the disjunctive filter restores event-driven dispatch for those cases.

```bash
# Two-phase compliant cadence loop. The 600s timeout serves as a fallback cadence;
# the authoritative REST check runs on every wake-up.
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
BASE_BRANCH=$(gh api "repos/${REPO}/pulls/${pr_number}" --jq '.base.ref')
ITER=0
MAX_ITER=20

while [ $ITER -lt $MAX_ITER ]; do
  ITER=$((ITER + 1))

  EVENT_JSON=$(catalyst-events wait-for \
    --filter '
      (.attributes."event.name" == "github.pr.merged" and .attributes."vcs.pr.number" == '"$pr_number"') or
      (.attributes."event.name" == "github.pr.closed" and .attributes."vcs.pr.number" == '"$pr_number"') or
      (.attributes."event.name" == "github.check_suite.completed"
         and (.body.payload.prNumbers // [] | index('"$pr_number"') != null)
         and (.attributes."cicd.pipeline.run.conclusion" == "failure" or .attributes."cicd.pipeline.run.conclusion" == "timed_out")) or
      (.attributes."event.name" == "github.pr_review.submitted"
         and .attributes."vcs.pr.number" == '"$pr_number"'
         and (.body.payload.state == "changes_requested"
              or (.body.payload.state == "commented" and (.body.payload.author.type // "") == "Bot"))) or
      (.attributes."event.name" == "github.push" and .attributes."vcs.ref.name" == "refs/heads/'"$BASE_BRANCH"'")
    ' \
    --timeout 600 || true)

  # MANDATORY authoritative REST re-check on every wake-up.
  STATE=$(gh api "repos/${REPO}/pulls/${pr_number}" \
    --jq 'if .merged then "MERGED" elif .state == "closed" then "CLOSED" else "OPEN" end' \
    2>/dev/null || echo "OPEN")
  if [ "$STATE" = "MERGED" ]; then break; fi
  if [ "$STATE" = "CLOSED" ]; then
    echo "❌ PR #$pr_number was closed without merging"; exit 1
  fi

  EVENT=$(echo "$EVENT_JSON" | jq -r '.attributes."event.name" // ""')
  case "$EVENT" in
    github.check_suite.completed)
      # CI failed — diagnose via merge-blocker-diagnosis.md, push fix.
      ;;
    github.pr_review.submitted)
      # Bot reviewers (Codex, claude-code-review): addressable inline.
      # Codex submits inline-thread reviews as state="commented"; handle both.
      AUTHOR_TYPE=$(echo "$EVENT_JSON" | jq -r '.body.payload.author.type // "User"')
      if [ "$AUTHOR_TYPE" = "Bot" ]; then
        /catalyst-dev:review-comments "$pr_number"
      fi
      ;;
    github.push)
      gh pr update-branch "$pr_number" || true
      ;;
    "")
      # Timeout — gh api confirmed not merged; fall through to next iteration.
      ;;
  esac
done
```

**Why every wake-up runs `gh api`:** if orch-monitor is down, no events flow and `wait-for` blocks until the timeout. The REST call is the safety net for merge confirmation when the event stream has dropped. Events are wake-up triggers; `gh api` REST is the source of truth.

Blocker resolution table (full details in `merge-blocker-diagnosis.md`):

| Blocker | Auto-resolution |
|---|---|
| BEHIND | `gh api -X PUT /repos/{owner}/{repo}/pulls/{n}/update-branch`, then continue |
| DIRTY (conflicts) | `gh pr checkout && git rebase origin/<base>`; if unresolvable, exit non-success |
| draft | `gh pr ready` |
| UNSTABLE (CI failing) | analyze failure logs, fix code, push, continue polling |
| unresolved-threads | run `/review-comments`, resolve via GraphQL, continue polling |
| changes-requested | check if addressed; suggest re-request review |
| review-required | exit non-success — report how many approvals needed and who to request |
| HAS_HOOKS | wait one cadence cycle and re-query |
| UNKNOWN | query branch protection rules, report every requirement with status |

When the loop confirms `state == "MERGED"`, capture `mergedAt` and proceed to Step 7.

**Signal file write (worker context):** if `$SIGNAL_FILE` is set, write `pr.mergedAt`, `pr.ciStatus = "merged"`, and `status = "done"` as soon as `state == MERGED` is observed:

```bash
if [ -n "$SIGNAL_FILE" ] && [ -f "$SIGNAL_FILE" ]; then
  PR_MERGED_AT=$(gh pr view "$PR_NUMBER" --json mergedAt --jq '.mergedAt')
  jq --arg ts "$PR_MERGED_AT" \
    '.pr.ciStatus = "merged" | .pr.mergedAt = $ts | .status = "done" | .updatedAt = $ts | .completedAt = $ts' \
    "$SIGNAL_FILE" > "$SIGNAL_FILE.tmp" && mv "$SIGNAL_FILE.tmp" "$SIGNAL_FILE"
fi
```
