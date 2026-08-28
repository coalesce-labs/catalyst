# Post-PR Monitoring & Resolution Loop (Step 12)

**Creating the PR is NOT the end of this skill.** Monitor CI, wait for automated reviewer comments, address them, and only report success once the PR is clean/mergeable or genuinely blocked on a human gate. Don't just say "PR created" and stop.

## Step 12a — Wait for CI checks and automated reviewers (event-driven)

Automated reviewers (Codex, security scanners, linters) typically post within 3–5 minutes; CI needs time too. Use the canonical "Reactive PR lifecycle" pattern (Pattern 3, CTL-228; the `monitor-events` skill that first documented it was removed with the daemon, CTL-2240) — one multi-event subscription that wakes on PR merged, PR closed, CI completed, review submitted, or a push to the base branch — instead of polling on a sleep loop. That subscription needs the unified event log actually live (`~/catalyst/events/YYYY-MM.jsonl` present, not just the `catalyst-events` CLI installed) — on a relay-default host with no live log, the fallback below takes over instead.

```bash
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
BASE_BRANCH=$(gh api "repos/${REPO}/pulls/${pr_number}" --jq '.base.ref' 2>/dev/null || echo "main")

EVENT_LOG="${CATALYST_DIR:-$HOME/catalyst}/events/$(date +%Y-%m).jsonl"
if command -v catalyst-events >/dev/null 2>&1 && [ -f "$EVENT_LOG" ]; then
  EVENT_JSON=$(catalyst-events wait-for \
    --filter '
      (.attributes."event.name" == "github.pr.merged" and .attributes."vcs.pr.number" == '"$pr_number"') or
      (.attributes."event.name" == "github.pr.closed" and .attributes."vcs.pr.number" == '"$pr_number"') or
      (.attributes."event.name" == "github.check_suite.completed"
         and (.body.payload.prNumbers // [] | index('"$pr_number"') != null)) or
      (.attributes."event.name" == "github.pr_review.submitted"
         and .attributes."vcs.pr.number" == '"$pr_number"') or
      (.attributes."event.name" == "github.issue_comment.created"
         and .attributes."vcs.pr.number" == '"$pr_number"') or
      (.attributes."event.name" == "github.pr_review_comment.created"
         and .attributes."vcs.pr.number" == '"$pr_number"') or
      (.attributes."event.name" == "github.push" and .attributes."vcs.ref.name" == "refs/heads/'"$BASE_BRANCH"'")
    ' \
    --timeout 300 || true)

  # MANDATORY authoritative REST re-check on every wake-up.
  PR_DATA=$(gh api "repos/${REPO}/pulls/${pr_number}" \
    --jq '{merged: .merged, state: .state, head_sha: .head.sha}' 2>/dev/null || echo '{}')
  PR_STATE=$(echo "$PR_DATA" | jq -r 'if .merged then "MERGED" elif .state == "closed" then "CLOSED" else "OPEN" end')
  HEAD_SHA=$(echo "$PR_DATA" | jq -r '.head_sha // ""')
  CI_STATUS="unknown"
  if [ -n "$HEAD_SHA" ]; then
    CI_STATUS=$(gh api "repos/${REPO}/commits/${HEAD_SHA}/check-runs" \
      --jq '[.check_runs[] | .conclusion // .status] | unique | join(",")' 2>/dev/null || echo "pending")
  fi
  echo "wake: state=${PR_STATE} CI=${CI_STATUS} event=$(echo "$EVENT_JSON" | jq -r '.attributes."event.name" // "(timeout)"')"
else
  # Fallback when the catalyst-events CLI isn't installed — REST-only poll, 5-min intervals, 2-hour cap. This is the bounded-poll merge/review preset — see merge-pr/references/bounded-poll.md for the full pattern and ceiling.
  COUNT=0; MAX=24; MERGED_FLAG="false"
  while [ "$MERGED_FLAG" != "true" ] && [ $COUNT -lt $MAX ]; do
    sleep 300; COUNT=$((COUNT + 1))
    PR_DATA=$(gh api "repos/${REPO}/pulls/${pr_number}" 2>/dev/null || echo '{"merged":false}')
    MERGED_FLAG=$(echo "$PR_DATA" | jq -r '.merged')
    COMMENT_COUNT=$(gh api "repos/${REPO}/pulls/${pr_number}/comments" --jq 'length' 2>/dev/null || echo "0")
    REVIEW_COUNT=$(gh api "repos/${REPO}/pulls/${pr_number}/reviews" \
      --jq '[.[] | select(.state != "APPROVED" and .state != "DISMISSED")] | length' 2>/dev/null || echo "0")
    echo "REST poll @$((COUNT * 5))min: merged=${MERGED_FLAG} comments=${COMMENT_COUNT} reviews=${REVIEW_COUNT}"
    [ "$MERGED_FLAG" = "true" ] && break
    { [ "$COMMENT_COUNT" -gt 0 ] || [ "$REVIEW_COUNT" -gt 0 ]; } && break
  done
fi
```

The `--timeout 300` floor keeps this from blocking indefinitely if the event feed has nothing to say. `gh api` REST is the source of truth on every wake-up; the event is only the trigger.

## Step 12b — Address all review comments

If any comments/reviews exist, run `/review-comments $pr_number`: fetch and categorize (inline, threads, issue comments), implement requested changes, resolve threads via GraphQL, push one addressing commit.

## Step 12c — Diagnose and resolve merge blockers

Read `"${CLAUDE_PLUGIN_ROOT}/references/merge-blocker-diagnosis.md"` and run the full loop (max 3 rounds): `ci-failing` → fix + push + re-poll; `unresolved-threads` → `/review-comments`; `branch-behind` → rebase + push; `draft` → `gh pr ready`; `changes-requested` → check/attempt fix.

**Don't confuse "unresolved review threads" with "needs approving reviewer."** Automated-reviewer threads are yours to resolve by addressing the feedback. Only `review-required` (no approving reviews at all) is a genuine human gate.

## Step 12d — Re-poll until clean or genuinely human-blocked

Continue until `mergeStateStatus` is `CLEAN` (report success), the only blocker is `review-required` (report what's needed), or 3 attempts are exhausted (report exactly what's still blocking).
