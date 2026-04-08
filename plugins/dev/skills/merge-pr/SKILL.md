---
name: merge-pr
description: "Safely merge PR with verification and Linear integration. **ALWAYS use when** the user says 'merge the PR', 'merge this', 'ship it', or wants to merge an approved pull request. Runs tests, checks CI, verifies approvals, squash merges, cleans up branches, and moves Linear ticket to Done."
disable-model-invocation: true
allowed-tools: Bash(linearis *), Bash(git *), Bash(gh *), Read
version: 1.0.0
---

# Merge Pull Request

Safely merges a PR after comprehensive verification, with Linear integration and automated cleanup.

## Configuration

Read team configuration from `.claude/config.json`:

```bash
CONFIG_FILE=".claude/config.json"
TEAM_KEY=$(jq -r '.catalyst.linear.teamKey // "PROJ"' "$CONFIG_FILE")
TEST_CMD=$(jq -r '.catalyst.pr.testCommand // "make test"' "$CONFIG_FILE")
```

## Process:

### 1. Identify PR to merge

**If argument provided:**

- Use that PR number: `/merge_pr 123`

**If no argument:**

```bash
# Try current branch
gh pr view --json number,url,title,state,mergeable 2>/dev/null
```

If no PR on current branch:

```bash
gh pr list --limit 10 --json number,title,headRefName,state
```

Ask: "Which PR would you like to merge? (enter number)"

### 2. Get PR details

```bash
gh pr view $pr_number --json \
  number,url,title,state,mergeable,mergeStateStatus,\
  baseRefName,headRefName,reviewDecision
```

**Extract:**

- PR number, URL, title
- Mergeable status
- Base branch (usually main)
- Head branch (feature branch)
- Review decision (APPROVED, REVIEW_REQUIRED, etc.)

### 3. Verify PR is open and mergeable

```bash
state=$(gh pr view $pr_number --json state -q .state)
mergeable=$(gh pr view $pr_number --json mergeable -q .mergeable)
```

**If PR not OPEN:**

```
❌ PR #$pr_number is $state

Only open PRs can be merged.
```

**If not mergeable (CONFLICTING):**

```
❌ PR has merge conflicts

Resolve conflicts first:
  gh pr checkout $pr_number
  git fetch origin $base_branch
  git merge origin/$base_branch
  # ... resolve conflicts ...
  git push
```

Exit with error.

### 4. Check if head branch is up-to-date with base

```bash
# Checkout PR branch
gh pr checkout $pr_number

# Fetch latest base
base_branch=$(gh pr view $pr_number --json baseRefName -q .baseRefName)
git fetch origin $base_branch

# Check if behind
if git log HEAD..origin/$base_branch --oneline | grep -q .; then
    echo "Branch is behind $base_branch"
fi
```

**If behind:**

```bash
# Auto-rebase
git rebase origin/$base_branch

# Check for conflicts
if [ $? -ne 0 ]; then
    echo "❌ Rebase conflicts"
    git rebase --abort
    exit 1
fi

# Push rebased branch
git push --force-with-lease
```

**If conflicts during rebase:**

```
❌ Rebase conflicts detected

Conflicting files:
  $(git diff --name-only --diff-filter=U)

Resolve manually:
  1. Fix conflicts in listed files
  2. git add <resolved-files>
  3. git rebase --continue
  4. git push --force-with-lease
  5. Run /merge-pr again
```

Exit with error.

### 5. Run local tests

**Read test command from config:**

```bash
test_cmd=$(jq -r '.catalyst.pr.testCommand // "make test"' .claude/config.json)
```

**Execute tests:**

```bash
echo "Running tests: $test_cmd"
if ! $test_cmd; then
    echo "❌ Tests failed"
    exit 1
fi
```

**If tests fail:**

```
❌ Local tests failed

Fix failing tests before merge:
  $test_cmd

Or skip tests (not recommended):
  /merge-pr $pr_number --skip-tests
```

Exit with error (unless `--skip-tests` flag provided).

### 6. Check CI/CD status

```bash
gh pr checks $pr_number
```

**Parse output for failures:**

- If all checks pass: continue
- If required checks fail: prompt user
- If optional checks fail: warn but allow

**If required checks failing:**

```
⚠️  Some required CI checks are failing

Failed checks:
  - build (required)
  - lint (required)

Passed checks:
  - test ✅
  - security ✅

Continue merge anyway? [y/N]:
```

If user says no: exit. If user says yes: continue (user override).

### 7. Check approval status

```bash
review_decision=$(gh pr view $pr_number --json reviewDecision -q .reviewDecision)
```

**Review decisions:**

- `APPROVED` - proceed
- `CHANGES_REQUESTED` - prompt user
- `REVIEW_REQUIRED` - prompt user
- `null` / empty - no reviews, prompt user

**If not approved:**

```
⚠️  PR has not been approved

Review status: $review_decision

Continue merge anyway? [y/N]:
```

If user says no: exit. If user says yes: continue (user override).

**Skip these prompts if** `requireApproval: false` in config.

### 8. Extract ticket reference

```bash
branch=$(gh pr view $pr_number --json headRefName -q .headRefName)
title=$(gh pr view $pr_number --json title -q .title)

# From branch using configured team key
if [[ "$branch" =~ ($TEAM_KEY-[0-9]+) ]]; then
    ticket="${BASH_REMATCH[1]}"
fi

# From title if not in branch
if [[ -z "$ticket" ]] && [[ "$title" =~ ($TEAM_KEY-[0-9]+) ]]; then
    ticket="${BASH_REMATCH[1]}"
fi
```

### 9. Show merge summary

```
About to merge:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 PR:      #$pr_number - $title
 From:    $head_branch
 To:      $base_branch
 Commits: $commit_count
 Files:   $file_count changed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Reviews: $review_status
 CI:      $ci_status
 Tests:   ✅ Passed locally
 Ticket:  $ticket (will move to Done)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Merge strategy: Squash and merge

Proceed? [Y/n]:
```

### 10. Execute squash merge

```bash
gh pr merge $pr_number --squash --delete-branch
```

**Always:**

- Squash merge (combines all commits into one)
- Delete remote branch automatically

**Capture merge commit SHA:**

```bash
merge_sha=$(git rev-parse HEAD)
```

### 11. Update Linear ticket

If ticket found and not using `--no-update`:

```bash
# Verify linearis is available
if ! command -v linearis &> /dev/null; then
    echo "⚠️  Linearis CLI not found - skipping Linear ticket update"
    echo "Install: npm install -g linearis"
else
    # Move to configured "Done" state
    DONE_STATE=$(jq -r '.catalyst.linear.stateMap.done // "Done"' .claude/config.json 2>/dev/null || echo "Done")
    if [[ "$DONE_STATE" != "null" ]]; then
        linearis issues update "$ticket" --status "$DONE_STATE"
    fi

    # Add merge comment
    linearis comments create "$ticket" \
        --body "✅ PR merged!\n\n**PR**: #${prNumber} - ${prTitle}\n**Merge commit**: ${mergeSha}\n**Merged into**: ${baseBranch}\n\nView PR: ${prUrl}"
fi
```

### 12. Delete local branch and update base

```bash
# Switch to base branch
git checkout $base_branch

# Pull latest (includes merge commit)
git pull origin $base_branch

# Delete local feature branch
git branch -d $head_branch

# Confirm deletion
echo "✅ Deleted local branch: $head_branch"
```

**Always delete local branch** - no prompt (remote already deleted).

### 12a. Update primary worktree

If running in a git worktree, the primary checkout of main may be stale. Update it:

```bash
# Find the primary worktree checked out on the base branch
PRIMARY_WORKTREE=$(git worktree list | grep "\[$base_branch\]" | awk '{print $1}')
CURRENT_DIR=$(pwd)

if [[ -n "$PRIMARY_WORKTREE" && "$PRIMARY_WORKTREE" != "$CURRENT_DIR" ]]; then
    echo "Updating primary worktree at $PRIMARY_WORKTREE..."
    git -C "$PRIMARY_WORKTREE" pull origin "$base_branch"
    echo "✅ Primary worktree updated"
else
    echo "No separate primary worktree to update"
fi
```

### 13. Extract post-merge tasks

**Read PR description:**

```bash
desc_file="thoughts/shared/prs/${pr_number}_description.md"
if [ -f "$desc_file" ]; then
    # Extract "Post-Merge Tasks" section
    tasks=$(sed -n '/## Post-Merge Tasks/,/^##/p' "$desc_file" | grep -E '^\- \[')
fi
```

**If tasks exist:**

```
📋 Post-merge tasks from PR description:
- [ ] Update documentation
- [ ] Monitor error rates in production
- [ ] Notify stakeholders

Save these tasks? [Y/n]:
```

If yes:

```bash
# Save to thoughts
cat > "thoughts/shared/post_merge_tasks/${ticket}_tasks.md" <<EOF
# Post-Merge Tasks: $ticket

Merged: $(date)
PR: #$pr_number

$tasks
EOF

humanlayer thoughts sync
```

### 14. Detect Deployments and Report Success

After branch cleanup, check if the merge triggered any deployment workflows:

```bash
# Check for workflow runs triggered by the merge commit on the base branch
DEPLOY_RUNS=$(gh run list --branch "$base_branch" --limit 5 --json name,status,workflowName,url \
  --jq '.[] | select(.status == "in_progress" or .status == "queued")' 2>/dev/null)

if [[ -n "$DEPLOY_RUNS" ]]; then
  echo ""
  echo "Active workflow runs detected after merge:"
  gh run list --branch "$base_branch" --limit 5 --json workflowName,status,url \
    --jq '.[] | select(.status == "in_progress" or .status == "queued") | "  - \(.workflowName): \(.status) (\(.url))"'
  echo ""
  echo "Tip: Monitor deployment with:"
  echo "  /loop 3m gh run list --branch $base_branch --limit 3 --json workflowName,status,conclusion --jq '.[]'"
  echo ""
else
  echo ""
  echo "No active deployment workflows detected."
fi
```

Display the standard success summary after this check:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ PR #$pr_number merged successfully!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Merge details:
  Strategy:     Squash and merge
  Commit:       $merge_sha
  Base branch:  $base_branch (updated)
  Merged by:    @$user

Cleanup:
  Remote branch: $head_branch (deleted)
  Local branch:  $head_branch (deleted)

Linear:
  Ticket:  $ticket → Done ✅
  Comment: Added with merge details

Post-merge tasks: $task_count saved to thoughts/

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Flags

**`--skip-tests`** - Skip local test execution

```bash
/merge-pr 123 --skip-tests
```

**`--no-update`** - Don't update Linear ticket

```bash
/merge-pr 123 --no-update
```

**`--keep-branch`** - Don't delete local branch

```bash
/merge-pr 123 --keep-branch
```

**Combined:**

```bash
/merge-pr 123 --skip-tests --no-update
```

## Error Handling

For all errors, provide clear messages with the specific error, what went wrong, and how to fix it.

**Fail fast (stop execution):**
- Rebase conflicts → show conflicting files, instructions to resolve manually, then re-run `/merge-pr`
- Test failures → show failed tests, suggest fix or `--skip-tests`
- PR not open/mergeable → show current state

**Prompt for override:**
- CI checks failing → show failures, ask `Continue anyway? [y/N]`
- Missing approvals → show review status, ask `Continue anyway? [y/N]`

**Warn but continue (graceful degradation):**
- Linearis CLI not found → warn, suggest install, merge proceeds
- Linear API error → warn, merge proceeds
- Branch deletion error → warn, merge already succeeded

## Configuration

Uses `.claude/config.json`:

```json
{
  "catalyst": {
    "project": {
      "ticketPrefix": "PROJ"
    },
    "linear": {
      "teamKey": "PROJ",
      "stateMap": {
        "done": "Done"
      }
    },
    "pr": {
      "defaultMergeStrategy": "squash",
      "deleteRemoteBranch": true,
      "deleteLocalBranch": true,
      "updateLinearOnMerge": true,
      "requireApproval": false,
      "requireCI": false,
      "testCommand": "make test"
    }
  }
}
```

State names are read from `stateMap` with sensible defaults. See `.claude/config.json` for all keys.

## Examples

```bash
/merge-pr 123              # Merge PR for current branch
/merge-pr 123 --skip-tests # Skip local test execution
/merge-pr 123 --no-update  # Don't update Linear ticket
/merge-pr 123 --keep-branch # Don't delete local branch
```

## Safety Features

**Fail fast on:**

- Merge conflicts (can't auto-resolve)
- Test failures (unless --skip-tests)
- Rebase conflicts
- PR not in mergeable state

**Prompt for confirmation on:**

- Missing required approvals
- Failing CI checks
- Any exceptional circumstance

**Always automated:**

- Rebase if behind (no conflicts)
- Squash merge
- Delete remote branch
- Delete local branch
- Update Linear to Done (if Linearis available)
- Pull latest base branch

**Graceful degradation:**

- If Linearis not installed, warn but continue
- Merge succeeds regardless of Linear integration

## Remember:

- **Always squash merge** — clean history
- **Always delete branches** — no orphan branches
- **Always run tests** — unless explicitly skipped
- **Auto-rebase** — keep up-to-date with base
- **Fail fast** — stop on conflicts or test failures
- **Update Linear** — move ticket to Done automatically (if Linearis available)
- **Only prompt for exceptions** — approvals missing, CI failing
- **Graceful degradation** — work without Linearis if needed
- For Linearis CLI syntax, see the `linearis` skill reference
