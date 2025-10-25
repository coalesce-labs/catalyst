---
description: Safely merge PR with verification and Linear integration
category: version-control-git
tools: Bash(linearis *), Bash(git *), Bash(gh *), Read
model: inherit
version: 1.0.0
---

# Merge Pull Request

Safely merges a PR after comprehensive verification, with Linear integration and automated cleanup.

## Configuration

Read team configuration from `.claude/config.json`:

```bash
CONFIG_FILE=".claude/config.json"
TEAM_KEY=$(jq -r '.linear.teamKey // "PROJ"' "$CONFIG_FILE")
TEST_CMD=$(jq -r '.pr.testCommand // "make test"' "$CONFIG_FILE")
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
  5. Run /merge_pr again
```

Exit with error.

### 5. Run local tests

**Read test command from config:**

```bash
test_cmd=$(jq -r '.pr.testCommand // "make test"' .claude/config.json)
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
  /merge_pr $pr_number --skip-tests
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
    echo "Install: npm install -g --install-links ryanrozich/linearis#feat/cycles-cli"
else
    # Move to "Done"
    linearis issues update "$ticket" --status "Done"

    # Add merge comment
    linearis issues comment "$ticket" \
        "✅ PR merged!\n\n**PR**: #${prNumber} - ${prTitle}\n**Merge commit**: ${mergeSha}\n**Merged into**: ${baseBranch}\n\nView PR: ${prUrl}"
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

### 14. Report success summary

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

Next steps:
  - Monitor deployment
  - Check CI/CD pipeline
  - Verify in production

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Flags

**`--skip-tests`** - Skip local test execution

```bash
/merge_pr 123 --skip-tests
```

**`--no-update`** - Don't update Linear ticket

```bash
/merge_pr 123 --no-update
```

**`--keep-branch`** - Don't delete local branch

```bash
/merge_pr 123 --keep-branch
```

**Combined:**

```bash
/merge_pr 123 --skip-tests --no-update
```

## Error Handling

**Rebase conflicts:**

```
❌ Rebase conflicts detected

Conflicting files:
  - src/app.ts
  - tests/app.test.ts

Resolve manually:
  gh pr checkout $pr_number
  git fetch origin $base_branch
  git rebase origin/$base_branch
  # Fix conflicts
  git add <files>
  git rebase --continue
  git push --force-with-lease
  /merge_pr $pr_number
```

**Tests failing:**

```
❌ Tests failed (exit code 1)

Failed tests:
  - validation.test.ts:45 - Expected true but got false
  - auth.test.ts:12 - Timeout exceeded

Fix tests or skip (not recommended):
  /merge_pr $pr_number --skip-tests
```

**CI checks failing:**

```
⚠️  Required CI checks failing

Failed:
  - build: Compilation error in src/types.ts
  - security: Dependency vulnerability found

You can:
  1. Fix issues and try again
  2. Override and merge anyway (not recommended)

Override? [y/N]:
```

**Linearis CLI not found:**

```
⚠️  Linearis CLI not found

PR merged successfully, but Linear ticket not updated.

Install Linearis:
  npm install -g --install-links ryanrozich/linearis#feat/cycles-cli

Configure:
  export LINEAR_API_TOKEN=your_token

Then update ticket manually:
  linearis issues update $ticket --status "Done"
```

**Linear API error:**

```
⚠️  Could not update Linear ticket $ticket

Error: Ticket not found or API unavailable

PR merged successfully, but ticket status not updated.
Update manually in Linear.
```

**Branch deletion error:**

```
⚠️  Could not delete local branch $head_branch

Error: Branch has unpushed commits

This won't affect the merge (already complete).
Delete manually: git branch -D $head_branch
```

## Configuration

Uses `.claude/config.json`:

```json
{
  "project": {
    "ticketPrefix": "RCW"
  },
  "linear": {
    "teamKey": "RCW",
    "doneStatusName": "Done"
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
```

## Examples

**Happy path (all checks pass):**

```bash
/merge_pr 123

Running tests: make test
✅ All tests passed
✅ CI checks passed
✅ PR approved

About to merge PR #123...
[shows summary]
Proceed? Y

✅ Merged!
✅ Linear ticket RCW-13 → Done
✅ Branches deleted
```

**With failing CI (user override):**

```bash
/merge_pr 124

⚠️  Some CI checks failing
Continue anyway? y

✅ Merged (with overrides)
```

**Skip tests:**

```bash
/merge_pr 125 --skip-tests

⚠️  Skipping tests (not recommended)
✅ Merged!
```

**Linearis not installed:**

```bash
/merge_pr 126

✅ PR merged successfully!
⚠️  Linearis CLI not found - Linear ticket not updated

Install Linearis to enable automatic ticket updates.
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

## Post-Merge Workflow

```
PR merged
    ↓
Linear ticket → Done (if Linearis available)
    ↓
Branches deleted
    ↓
Base branch updated locally
    ↓
Post-merge tasks extracted
    ↓
Monitor deployment
```

## Remember:

- **Always squash merge** - clean history
- **Always delete branches** - no orphan branches
- **Always run tests** - unless explicitly skipped
- **Auto-rebase** - keep up-to-date with base
- **Fail fast** - stop on conflicts or test failures
- **Update Linear** - move ticket to Done automatically (if Linearis available)
- **Extract tasks** - save post-merge checklist
- **Clear summary** - show what happened
- **Only prompt for exceptions** - approvals missing, CI failing
- **Graceful degradation** - Work without Linearis if needed
