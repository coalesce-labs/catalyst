# PR Lifecycle Commands

Complete automation of the pull request workflow from commit to merge, with Linear integration and
intelligent defaults.

## Overview

Four commands work together to handle the entire PR lifecycle:

1. **`/commit`** - Create conventional commits
2. **`/create_pr`** - Create PR with auto-rebase and description
3. **`/describe_pr`** - Update PR description incrementally
4. **`/merge_pr`** - Safely merge with verification

## Quick Start

```bash
# 1. Make changes and commit
/commit

# 2. Create PR (auto-rebases, describes, links Linear)
/create_pr

# 3. After code review, update description
/describe_pr

# 4. Merge when ready
/merge_pr
```

---

## Command Details

### `/commit` - Conventional Commits

Creates git commits using conventional commit format with auto-detection.

**What it does:**

- Analyzes changed files to suggest type and scope
- Extracts ticket reference from branch name
- Generates properly formatted conventional commit
- Asks for confirmation before committing

**Example:**

```bash
# Working on branch: RCW-13-implement-pr-lifecycle
# Changed files: commands/commit.md, commands/create_pr.md

/commit

# Detects:
# - Type: feat (new functionality)
# - Scope: commands (directory with changes)
# - Ticket: RCW-13 (from branch name)

# Suggests:
# feat(commands): implement pr lifecycle commands
#
# Adds complete PR lifecycle automation with conventional commits,
# auto-rebase, incremental descriptions, and Linear integration.
#
# Refs: RCW-13
```

**Conventional Commit Format:**

```
<type>(<scope>): <short summary>

<body>

<footer>
```

**Types:**

- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation
- `refactor` - Code restructuring
- `test` - Tests
- `chore` - Maintenance
- `style`, `perf`, `ci`, `build`

**Auto-detection heuristics:**

- Only docs changed → `docs`
- Only tests → `test`
- Package files → `build`
- CI files → `ci`
- Otherwise → prompts for `feat`, `fix`, `refactor`, `chore`

**Configuration:**

```json
{
  "commit": {
    "useConventional": true,
    "scopes": ["agents", "commands", "hack", "docs", "claude", "config"],
    "autoDetectType": true,
    "autoDetectScope": true
  }
}
```

---

### `/create_pr` - Full PR Creation

Orchestrates complete PR creation: commit → rebase → push → create → describe → Linear update.

**What it does:**

1. Checks for uncommitted changes (offers to commit)
2. Verifies not on main/master
3. Checks if branch is up-to-date with main
4. Auto-rebases if behind (fails on conflicts)
5. Checks for existing PR (prevents duplicates)
6. Pushes branch with upstream tracking
7. Extracts ticket from branch name
8. Creates PR with ticket-based title
9. Calls `/describe_pr` automatically
10. Updates Linear ticket → "In Review"
11. Assigns ticket to you
12. Links PR to Linear ticket

**Example:**

```bash
# Branch: RCW-13-implement-pr-lifecycle

/create_pr

# Output:
Checking for uncommitted changes... none
Branch is behind main by 2 commits
Auto-rebasing onto origin/main... ✅
Pushing branch...
✅
Creating PR...
Title: "RCW-13: Implement pr lifecycle"
✅ PR #2 created

Generating comprehensive description...
(calls /describe_pr internally)

Updating Linear RCW-13:
- Status: In Progress → In Review
- Assignee: ryan
- Link added: PR #2

✅ Pull request created successfully!
PR: #2 - RCW-13: Implement pr lifecycle
URL: https://github.com/org/repo/pull/2
```

**Only prompts when:**

- PR already exists for branch
- Rebase conflicts (can't auto-resolve)

**Linear integration:**

- Extracts ticket: `RCW-13` from branch `RCW-13-feature-name`
- Moves to "In Review" status
- Assigns to current user
- Adds PR as attachment
- Comments with PR link

---

### `/describe_pr` - Incremental PR Descriptions

Generates or updates PR description with comprehensive analysis, preserving manual edits.

**What it does:**

1. Reads PR description template
2. Identifies target PR (current branch or asks)
3. Extracts ticket reference
4. Reads existing PR description (if any)
5. Gathers full PR info (diff, commits, files)
6. **Analyzes changes incrementally**
7. **Merges descriptions intelligently**
8. Adds Linear ticket reference
9. Generates updated title
10. Runs verification checks automatically
11. Saves to `thoughts/shared/prs/{number}_description.md`
12. Updates PR title and body on GitHub
13. Updates Linear ticket

**Incremental updates:**

```markdown
<!-- Auto-generated: 2025-10-06T10:00:00Z -->
<!-- Last updated: 2025-10-06T15:30:00Z -->
<!-- PR: #123 -->
<!-- Previous commits: abc123,def456,ghi789 -->

---

**Update History:**

- 2025-10-06 15:30: Added error handling (2 commits)
- 2025-10-06 10:00: Initial implementation (3 commits)

---

## Summary

[Regenerated to reflect ALL changes]

## Changes Made

### Backend Changes

[Existing changes preserved]

**New changes** (since last update):

- Added validation logic
- Improved error messages

[Rest of description...]
```

**Preserves:**

- Reviewer Notes
- Screenshots/Videos
- Manually checked boxes
- Post-Merge Tasks

**Updates:**

- Summary
- Changes Made (appends new)
- How to Verify It (reruns checks)
- Changelog Entry

**Verification checks:** Automatically attempts to run:

- `make test` / `npm test`
- `make lint` / `npm run lint`
- `make build` / `npm run build`
- `npm run typecheck`

Marks checkboxes:

- `[x]` if passed
- `[ ]` if failed (with error)
- `[ ]` if manual verification required

**No prompts** - fully automated.

---

### `/merge_pr` - Safe Merge with Verification

Safely merges PR after comprehensive checks, with Linear integration and cleanup.

**What it does:**

1. Identifies PR to merge
2. Verifies PR is open and mergeable
3. Checks if branch up-to-date with main
4. Auto-rebases if behind (fails on conflicts)
5. **Runs local tests** (configurable command)
6. Checks CI/CD status
7. Checks approval status
8. Shows merge summary
9. **Squash merges** (always)
10. Updates Linear ticket → "Done"
11. **Deletes remote branch** (automatically)
12. Switches to main and pulls
13. **Deletes local branch** (automatically)
14. Extracts post-merge tasks
15. Reports comprehensive summary

**Example:**

```bash
/merge_pr

Running tests: make test
✅ All tests passed (15 passed, 0 failed)

Checking CI status...
✅ All checks passed

About to merge:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 PR:      #2 - RCW-13: Implement pr lifecycle
 From:    RCW-13-implement-pr-lifecycle
 To:      main
 Commits: 5
 Files:   8 changed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Reviews: APPROVED
 CI:      ✅ All checks passed
 Tests:   ✅ Passed locally
 Ticket:  RCW-13 (will move to Done)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Merge strategy: Squash and merge

Proceed? [Y/n]: Y

Merging...
✅ PR merged!
✅ Remote branch deleted
✅ Linear ticket RCW-13 → Done
✅ Local branch deleted
✅ Switched to main and pulled latest

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ PR #2 merged successfully!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Intelligent defaults:**

- Always squash merge
- Always delete branches
- Always run tests (unless `--skip-tests`)
- Always update Linear (unless `--no-update`)

**Prompts only for:**

- Missing required approvals (override option)
- Failing CI checks (override option)

**Flags:**

```bash
/merge_pr --skip-tests      # Skip local test execution
/merge_pr --no-update       # Don't update Linear ticket
/merge_pr --keep-branch     # Don't delete local branch
```

---

## Complete Workflow Example

### Scenario: Implementing a new feature

```bash
# 1. Create feature branch
git checkout -b RCW-42-add-validation

# 2. Implement feature
# ... make changes ...

# 3. Commit with conventional format
/commit
# Suggests: feat(commands): add validation command
# You confirm

# 4. Create PR
/create_pr
# - Rebases onto main
# - Creates PR
# - Generates description
# - Linear: RCW-42 → In Review (assigned to you)

# 5. Code review feedback
# Reviewer asks for changes

# 6. Make changes
# ... fix issues ...

# 7. Commit changes
/commit
# Suggests: fix(commands): handle edge cases in validation

# 8. Update PR description
/describe_pr
# - Appends new changes
# - Preserves reviewer notes
# - Reruns verification checks
# - Shows what changed since last update

# 9. Approval received, ready to merge
/merge_pr
# - Runs tests ✅
# - Checks CI ✅
# - Squash merges
# - Deletes branches
# - Linear: RCW-42 → Done
```

---

## Linear Integration

### Workflow State Progression

```
Backlog → Research → Planning → In Progress → In Review → Done
          ↑          ↑          ↑             ↑            ↑
     /research  /create-plan  /implement  /create_pr  /merge_pr
```

### Auto-Assignment

All commands that update Linear tickets automatically assign them to you:

```javascript
mcp__linear__update_issue({
  id: ticket,
  state: "In Review",
  assignee: "me", // Current user
});
```

### PR Linking

PRs are automatically linked to Linear tickets:

```javascript
mcp__linear__update_issue({
  id: ticket,
  links: [
    {
      url: "https://github.com/org/repo/pull/123",
      title: "PR #123: Ticket title",
    },
  ],
});
```

View linked PRs in Linear:

- Open ticket in Linear
- Check right sidebar "Links" or "Attachments"
- Click to open PR

---

## Configuration

### Recommended `.claude/config.json`

```json
{
  "project": {
    "ticketPrefix": "RCW"
  },
  "linear": {
    "teamId": "your-team-id",
    "projectId": "your-project-id",
    "thoughtsRepoUrl": "https://github.com/org/thoughts/blob/main",
    "inReviewStatusName": "In Review",
    "doneStatusName": "Done"
  },
  "commit": {
    "useConventional": true,
    "scopes": ["agents", "commands", "hack", "docs", "claude", "config"],
    "autoDetectType": true,
    "autoDetectScope": true
  },
  "pr": {
    "defaultMergeStrategy": "squash",
    "deleteRemoteBranch": true,
    "deleteLocalBranch": true,
    "updateLinearOnMerge": true,
    "requireApproval": false,
    "requireCI": false,
    "testCommand": "make test",
    "lintCommand": "make lint",
    "buildCommand": "make build"
  }
}
```

---

## Best Practices

### Branch Naming

Always include ticket ID in branch name:

```bash
git checkout -b RCW-123-feature-name
git checkout -b ENG-456-bug-fix
```

This enables automatic ticket extraction and Linear integration.

### Commit Frequently

Use `/commit` often for atomic changes:

- Easier to review
- Clearer history
- Better rollback capability

### Update Descriptions After Review

After pushing review changes, run `/describe_pr`:

- Shows reviewers what changed
- Updates verification status
- Maintains description accuracy

### Test Before Merge

`/merge_pr` runs tests by default. Don't skip unless absolutely necessary:

```bash
# ✅ Good: tests run automatically
/merge_pr

# ⚠️ Use sparingly: skips safety checks
/merge_pr --skip-tests
```

### Monitor CI

Check CI status before merging:

- `/merge_pr` shows CI status
- Can override if needed
- Better to fix issues than override

---

## Troubleshooting

### Rebase Conflicts

```
❌ Rebase conflicts detected

Resolve manually:
  gh pr checkout 123
  git fetch origin main
  git rebase origin/main
  # Fix conflicts
  git add <files>
  git rebase --continue
  git push --force-with-lease
  /create_pr  # or /merge_pr
```

### Tests Failing

```
❌ Tests failed

Fix tests or skip (not recommended):
  # Fix tests
  make test

  # Or skip (use caution)
  /merge_pr --skip-tests
```

### Linear Ticket Not Found

```
⚠️  Could not find Linear ticket RCW-999

- Check ticket exists in Linear
- Verify ticket ID in branch name
- Ticket may be in different team

PR operations continue, but Linear not updated.
```

### PR Already Exists

```
PR #123 already exists

What would you like to do?
  [D] Describe/update this PR
  [S] Skip
  [A] Abort

# Choose D to update existing PR
```

---

## Advanced Usage

### Custom Scopes

Add project-specific scopes to config:

```json
{
  "commit": {
    "scopes": ["api", "ui", "database", "auth", "tests"]
  }
}
```

### Custom Test Commands

```json
{
  "pr": {
    "testCommand": "npm run test:all",
    "lintCommand": "npm run lint:fix",
    "buildCommand": "npm run build:prod"
  }
}
```

### Skip Linear Integration

```bash
# Create PR without Linear update
# (if no ticket in branch name, automatic)

# Merge without Linear update
/merge_pr --no-update
```

### Keep Local Branch

```bash
# Merge but don't delete local branch
/merge_pr --keep-branch
```

---

## See Also

- [commands/README.md](../commands/README.md) - All available commands
- [docs/LINEAR_WORKFLOW_AUTOMATION.md](LINEAR_WORKFLOW_AUTOMATION.md) - Linear integration details
- [docs/USAGE.md](USAGE.md) - General workspace usage
- [commands/commit.md](../commands/commit.md) - Commit command details
- [commands/create_pr.md](../commands/create_pr.md) - Create PR command details
- [commands/describe_pr.md](../commands/describe_pr.md) - Describe PR command details
- [commands/merge_pr.md](../commands/merge_pr.md) - Merge PR command details
