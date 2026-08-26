# Steps 12–13 — Post-Merge Tasks, Compound Close, and Deployment Detection

_Covers extracting post-merge tasks from the PR description, the compound closing ritual,
deployment workflow detection, and the success summary._

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

## Step 12b — Compound closing ritual (CTL-189 / CTL-813 / CTL-831)

Two learning steps run for every merged ticket, in order:

1. **Estimation actuals** — invoke `/catalyst-dev:compound-estimate $ticket_id`. Prompts for
   the post-merge re-score (CTL-746 scale: XS=1 S=3 M=5 L=8 XL=13) plus two short reflections;
   appends the weekly compound-log entry (`thoughts/shared/retros/estimate/`).
2. **Cross-ticket retro** — invoke `/catalyst-dev:ticket-retro` (no arguments). Regenerates
   `thoughts/shared/retros/ticket/<today>.md` over the since-last-retro window.

Off the critical path: if the user declines, the ticket was never estimated, or either skill
errors, log one line and continue — never block the merge ritual on them.

## Step 13 — Detect deployments and report success

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

`gh run list` above only shows *workflow runs*; it says nothing about whether the merged change
reached a live surface. Call `verify_post_merge_deploy "$merge_sha"` from
[post-merge-deploy-verify.md](post-merge-deploy-verify.md) — using the REST-confirmed
`merge_commit_sha` from Step 9 ([worktree-safe-merge.md](worktree-safe-merge.md)), never a local
`git rev-parse HEAD`, which `gh pr merge` never updates. The function decides whether the *current
repo* even has a known deploy surface to check (`NO_DEPLOY_CONFIG` outside catalyst itself), and
within catalyst, whether *this merge* has one (most don't; the plugin marketplace is git-native),
then bounded-polls the CF Pages status plus a live HTTP smoke check where one applies. Report the
returned sentinel (`DEPLOYED` / `NOT_APPLICABLE` / `NO_DEPLOY_CONFIG` / `DEPLOY_PENDING` /
`DEPLOY_FAILED` / `SMOKE_FAILED`) alongside the success summary below — never silently skip it.

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
