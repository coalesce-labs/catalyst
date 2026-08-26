# pr_lifecycle Interest Type (CTL-284 — Unchanged)

_Read this when registering an explicit PR-number interest, or when auto-correlation is not sufficient (e.g. watching a PR whose ticket you do not own)._

Explicit PR-number registration still works:

```bash
jq -nc \
  --arg orch "${CATALYST_ORCHESTRATOR_ID:-}" \
  --arg sid "$CATALYST_SESSION_ID" \
  --argjson pr "$PR_NUMBER" \
  --arg repo "$(gh repo view --json nameWithOwner --jq '.nameWithOwner')" \
  --arg base "main" \
  '{ts: (now | todate), event: "filter.register",
    orchestrator: $orch,
    worker: null,
    detail: {
      interest_id: $sid,
      interest_type: "pr_lifecycle",
      notify_event: ("filter.wake." + $sid),
      persistent: true,
      pr_numbers: [$pr],
      repo: $repo,
      base_branches: [{pr: $pr, base: $base}],
      session_id: $sid
    }}' >> ~/catalyst/events/$(date -u +%Y-%m).jsonl
```

Events matched: `github.check_suite.completed`, `github.pr.merged`, `github.pr.closed`, `github.pr_review.submitted`, `github.pr_review_comment.created`, `github.pr_review_thread.resolved`, `github.deployment.created`, `github.deployment_status.*`, `github.push` (base-branch pushes).
