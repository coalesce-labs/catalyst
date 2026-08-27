# Steps 12–15 — Post-Merge Tasks, Deployment Verification, Compound Close, and Success Summary

_Covers extracting post-merge tasks from the PR description, deployment workflow detection and verification, the compound closing ritual (gated on that verification), and the success summary._

## Step 12 — Extract post-merge tasks

```bash
desc_file="thoughts/shared/prs/${pr_number}_description.md"
if [ -f "$desc_file" ]; then
    tasks=$(sed -n '/## Post-Merge Tasks/,/^##/p' "$desc_file" | grep -E '^\- \[')
fi
```

If tasks exist, show them and offer to save:

```bash
cat > "thoughts/shared/post_merge_tasks/${ticket}_tasks.md" <<EOF
# Post-Merge Tasks: $ticket

Merged: $(date)
PR: #$pr_number

$tasks
EOF

humanlayer thoughts sync
```

## Step 13 — Detect deployments

```bash
DEPLOY_RUNS=$(gh run list --branch "$base_branch" --limit 5 \
  --json name,status,workflowName,url \
  --jq '.[] | select(.status == "in_progress" or .status == "queued")' 2>/dev/null)

if [[ -n "$DEPLOY_RUNS" ]]; then
  echo "Active workflow runs detected after merge:"
  gh run list --branch "$base_branch" --limit 5 \
    --json workflowName,status,url \
    --jq '.[] | select(.status == "in_progress" or .status == "queued") | "  - \(.workflowName): \(.status) (\(.url))"'
  echo "Tip: /loop 3m gh run list --branch $base_branch --limit 3 ..."
fi
```

## Step 13b — Verify the merge actually deployed (CTL-2232)

`gh run list` above only shows *workflow runs*; it says nothing about whether the merged change reached a live surface. Call `verify_post_merge_deploy "$merge_sha"` from [post-merge-deploy-verify.md](post-merge-deploy-verify.md) — using the REST-confirmed `merge_commit_sha` from Step 9 ([worktree-safe-merge.md](worktree-safe-merge.md)), never a local `git rev-parse HEAD`, which `gh pr merge` never updates. The function decides whether the *current repo* even has a known deploy surface to check (`NO_DEPLOY_CONFIG` outside catalyst itself), and within catalyst, whether *this merge* has one (most don't; the plugin marketplace is git-native), then bounded-polls the CF Pages status plus a live HTTP smoke check where one applies. Capture the returned sentinel (`DEPLOYED` / `NOT_APPLICABLE` / `NO_DEPLOY_CONFIG` / `DEPLOY_PENDING` / `DEPLOY_FAILED` / `SMOKE_FAILED`) — it gates Step 14 below and is reported alongside the success summary — never silently skip it.

## Step 14 — Compound closing ritual (CTL-189 / CTL-813 / CTL-831 / CTL-2244)

This is the one relay-native trigger point for all three compound tools — see [`compound-estimate/references/trigger.md`](../../compound-estimate/references/trigger.md) for the full contract and why it replaced the daemon-era wiring. Run this step only when Step 13b's sentinel is **terminal** — `DEPLOYED`, `NOT_APPLICABLE`, `NO_DEPLOY_CONFIG`, `DEPLOY_FAILED`, or `SMOKE_FAILED` (a failed deploy is itself a learning). On `DEPLOY_PENDING` — the bounded-poll ceiling hit with no answer yet — skip this step for now; a coordinator re-checks later rather than the ritual firing on an unresolved signal.

Three learning steps run for every merged ticket that reaches a terminal sentinel, in order:

1. **Estimation actuals** — invoke `/catalyst-dev:compound-estimate $ticket_id`. Prompts for the post-merge re-score (CTL-746 scale: XS=1 S=3 M=5 L=8 XL=13) plus two short reflections; appends the weekly compound-log entry (`thoughts/shared/retros/estimate/`).
2. **Per-ticket learnings** — invoke `/catalyst-dev:ticket-compound $ticket_id`. Harvests friction + diff into `thoughts/shared/learnings/`. Runs before the retro below on purpose: the retro reads the learnings store, so it must see this ticket's own entry rather than missing the merge that triggered it.
3. **Cross-ticket retro** — invoke `/catalyst-dev:ticket-retro` (no arguments). Regenerates `thoughts/shared/retros/ticket/<today>.md` over the since-last-retro window, including whatever step 2 just wrote.

Off the critical path: if the user declines, the ticket was never estimated, or any of the three skills errors, log one line and continue — never block the merge ritual on them.

## Step 15 — Report success

Display success summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ PR #$pr_number merged successfully!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Merge details:
  Strategy:     Squash and merge
  Commit:       $merge_sha
  Base branch:  $base_branch (updated)

Cleanup:
  Remote branch: $head_branch (deleted)
  Local branch:  $head_branch (deleted)

Linear:
  Ticket:  $ticket → Done ✅
  Comment: Added with merge details

Post-merge tasks: $task_count saved to thoughts/

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
