---
name: merge-pr
description:
  "Safely merge PR with verification and Linear integration. **ALWAYS use when** the user says
  'merge the PR', 'merge this', 'ship it', or wants to merge an approved pull request. Runs tests,
  checks CI, verifies approvals, squash merges, cleans up branches, and moves Linear ticket to Done."
disable-model-invocation: true
allowed-tools: Bash(linearis *), Bash(git *), Bash(gh *), Read
version: 1.0.0
---

# Merge Pull Request

Safely merges a PR after comprehensive verification, with Linear integration and automated cleanup.

## Branch Protection — Safety Rules

**NEVER bypass branch protection.** These rules are non-negotiable:

- **NEVER** use `--admin` flag on `gh pr merge`
- **NEVER** use `--force` or any flag that bypasses branch protection rules
- **NEVER** disable or modify branch protection rules programmatically
- **NEVER** suggest the user disable branch protection to unblock a merge
- If `gh pr merge` fails due to branch protection, **diagnose the specific blockers and fix them
  legitimately** — do not work around the protection

The goal is to satisfy branch protection requirements, not circumvent them. If a blocker cannot be
resolved autonomously, tell the user **exactly** what is needed and what they need to do — not just
"branch protection is blocking the merge."

## Configuration

Read team configuration from `.catalyst/config.json`:

```bash
CONFIG_FILE=".catalyst/config.json"
[[ ! -f "$CONFIG_FILE" ]] && CONFIG_FILE=".claude/config.json"
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
test_cmd=$(jq -r '.catalyst.pr.testCommand // "make test"' .catalyst/config.json)
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

### 6. Diagnose and resolve merge blockers

Instead of checking individual requirements in sequence, query GitHub for the **complete merge
readiness state** and resolve all blockers in a loop. This prevents the common failure mode of
`gh pr merge` returning a generic "branch protection" error with no actionable detail.

**Step 6a: Query full merge state**

```bash
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
OWNER=$(echo "$REPO" | cut -d'/' -f1)
NAME=$(echo "$REPO" | cut -d'/' -f2)

# Single GraphQL query to get everything at once
MERGE_STATE=$(gh api graphql -f query='
query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      mergeStateStatus
      mergeable
      reviewDecision
      isDraft
      baseRefName
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 100) {
                nodes {
                  ... on CheckRun {
                    name
                    conclusion
                    status
                    detailsUrl
                  }
                  ... on StatusContext {
                    context
                    state
                    targetUrl
                  }
                }
              }
            }
          }
        }
      }
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes { body author { login } path line }
          }
        }
      }
      reviews(last: 20) {
        nodes {
          state
          author { login }
          body
        }
      }
    }
  }
}' -f owner="$OWNER" -f name="$NAME" -F pr="$pr_number")
```

**Step 6b: Identify blockers**

Parse the response and build a list of every reason the PR cannot merge:

| `mergeStateStatus` | Meaning | Blocker Type |
|---|---|---|
| `CLEAN` | Ready to merge | None |
| `BEHIND` | Branch needs update | `branch-behind` |
| `DIRTY` | Merge conflicts | `conflicts` |
| `BLOCKED` | Branch protection rule(s) not satisfied | Decompose further (see below) |
| `DRAFT` | PR is a draft | `draft` |
| `UNSTABLE` | Required checks not yet complete or failing | `ci-failing` |
| `HAS_HOOKS` | Merge hooks pending | `hooks-pending` |
| `UNKNOWN` | State not yet computed | Wait and re-query |

When `mergeStateStatus` is `BLOCKED`, decompose into specific blockers by checking each field:

```
blockers = []

if reviewDecision == "REVIEW_REQUIRED":
  blockers += "review-required"
if reviewDecision == "CHANGES_REQUESTED":
  blockers += "changes-requested"
if any reviewThread has isResolved == false:
  blockers += "unresolved-threads"
if statusCheckRollup.state != "SUCCESS":
  blockers += "ci-failing"
if isDraft:
  blockers += "draft"
```

If `BLOCKED` and no specific blockers identified from the above fields, query branch protection
rules directly to surface what's missing:

```bash
gh api graphql -f query='
query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    branchProtectionRules(first: 10) {
      nodes {
        pattern
        requiresApprovingReviews
        requiredApprovingReviewCount
        requiresStatusChecks
        requiredStatusCheckContexts
        requiresConversationResolution
        requiresLinearHistory
        requiresStrictStatusChecks
        isAdminEnforced
      }
    }
  }
}' -f owner="$OWNER" -f name="$NAME" -f branch="$base_branch"
```

Use this to explain exactly which rule is unsatisfied.

**Step 6c: Resolve each blocker**

Loop through the blockers list. For each one, attempt autonomous resolution. **Never bypass — always
resolve legitimately.**

```
MAX_RESOLVE_ATTEMPTS=3
attempt=0

while blockers is not empty AND attempt < MAX_RESOLVE_ATTEMPTS:
  for each blocker:
    attempt_resolution(blocker)
  re-query merge state (step 6a)
  rebuild blockers list (step 6b)
  attempt += 1
```

**Blocker resolution strategies:**

---

**`branch-behind`** — Branch needs to be updated with base branch changes.

*Can fix:* Yes, always attempt.

```bash
git fetch origin $base_branch
git rebase origin/$base_branch
if [ $? -eq 0 ]; then
  git push --force-with-lease
else
  git rebase --abort
  # Report specific conflicting files to user
fi
```

---

**`conflicts`** — Merge conflicts exist.

*Can fix:* Attempt rebase. If conflicts are in generated files (lockfiles, etc.), try auto-resolve.
Otherwise, report specific files.

```
❌ Merge conflicts in $N file(s):
  - src/components/Header.tsx (manual resolution needed)
  - package-lock.json (can be regenerated)

I can regenerate lockfiles automatically. For source conflicts, you'll need to:
  1. Resolve conflicts in the listed files
  2. git add <resolved-files>
  3. git rebase --continue
  4. git push --force-with-lease
  5. Run /merge-pr again
```

---

**`draft`** — PR is still in draft mode.

*Can fix:* Yes.

```bash
gh pr ready $pr_number
```

---

**`ci-failing`** — One or more required status checks are failing or pending.

*Can fix:* Depends on the failure. Analyze each failing check.

For **pending** checks: wait and re-poll (up to 10 minutes).

```bash
gh pr checks $pr_number --watch --fail-fast
```

For **failed** checks: read the failure details and attempt a fix.

```bash
# Get the failed check's log
gh run view $run_id --log-failed
```

Analyze the failure. If it's a linting, type-check, or test error that can be fixed in code:
1. Read the error output
2. Fix the code
3. Commit and push
4. Re-poll checks

If it's an infrastructure failure (timeout, flaky test, service unavailable):

```
⚠️  CI check "$check_name" failed — appears to be infrastructure-related, not a code issue.

Failure: $failure_summary
Log: $details_url

Options:
  [1] Re-run the failed check: gh run rerun $run_id --failed
  [2] I'll investigate and re-run /merge-pr when ready
```

Do NOT suggest force-merging past a failing required check.

---

**`unresolved-threads`** — Unresolved review conversation threads.

*Can fix:* Yes — run `/review-comments` which addresses comments and resolves threads.

```bash
/review-comments $pr_number
# review-comments now fixes code, posts replies, AND resolves threads via GraphQL
```

After `/review-comments`, re-query to confirm threads are resolved. If some remain unresolved
(couldn't be addressed automatically), report them specifically:

```
⚠️  $N unresolved thread(s) could not be resolved automatically:

  1. @reviewer on src/api/auth.ts:42:
     "This changes the public API contract — needs migration guide"
     → Requires your decision: write a migration guide or reply explaining why it's not needed

  2. @reviewer on src/db/schema.ts:15:
     "This migration is irreversible — are we sure?"
     → Requires your confirmation to proceed
```

---

**`changes-requested`** — A reviewer requested changes.

*Can fix:* Partially. Check if the changes have already been addressed.

1. Check if commits were pushed after the review that requested changes
2. If yes, the reviewer may just need to re-review — tell the user:

```
⚠️  @reviewer requested changes on $(date of review).
    $N commit(s) have been pushed since that review.

The changes may already address the feedback. Options:
  [1] I'll request a re-review from @reviewer
  [2] I'll check with @reviewer — don't re-request yet
```

If user says yes to option 1:

```bash
gh pr edit $pr_number --add-reviewer "$reviewer_login"
```

3. If no commits since the review, tell the user what was requested:

```
❌ @reviewer requested changes:
   "$review_body_summary"

Address the feedback first, then re-run /merge-pr.
Or run /review-comments to see all outstanding feedback.
```

---

**`review-required`** — Branch protection requires approving reviews that haven't been given yet.

*Can fix:* No — this requires a human reviewer.

Query the specific requirement:

```
❌ Branch protection requires $required_count approving review(s).
   Current: $current_approvals approval(s).

Reviewers who can approve:
  - @reviewer1 (already reviewed — requested changes)
  - @reviewer2 (not yet reviewed)
  - Request review: gh pr edit $pr_number --add-reviewer "username"
```

Do NOT suggest any workaround. This is a human gate.

---

**`hooks-pending`** — Pre-merge hooks are running.

*Can fix:* Wait.

```
Merge hooks are running. Waiting...
```

Re-query after 30 seconds.

---

**`unknown-blocker`** — `BLOCKED` but none of the above matched.

*Can fix:* No — but provide maximum diagnostic detail.

```
❌ Branch protection is blocking the merge, but I couldn't identify the specific blocker.

Branch protection rules for "$base_branch":
  - Requires $N approving review(s): $status
  - Requires status checks: $check_list
  - Requires conversation resolution: $status
  - Requires linear history: $status
  - Requires strict status checks (branch up-to-date): $status
  - Admin enforced: $status

Current PR state:
  mergeStateStatus: $state
  reviewDecision: $decision
  CI: $ci_state
  Unresolved threads: $thread_count

Check the branch protection settings at:
  https://github.com/$OWNER/$NAME/settings/branches
```

---

**Step 6d: Final state after resolution attempts**

After the resolution loop, if blockers remain:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  Cannot merge — $N blocker(s) remain
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Resolved:
  ✅ CI checks — fixed lint errors, pushed commit abc1234
  ✅ Unresolved threads — 3 comments addressed and resolved
  ✅ Branch behind — rebased on main

Still blocking:
  ❌ Review required — needs 1 more approval
     → Request: gh pr edit $pr_number --add-reviewer "username"

  ❌ Changes requested by @reviewer2
     → 2 commits pushed since review; re-request review or address feedback

Run /merge-pr again after resolving these.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If all blockers resolved, continue to next step.

### 7. Extract ticket reference

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

### 8. Show merge summary

```
About to merge:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 PR:       #$pr_number - $title
 From:     $head_branch
 To:       $base_branch
 Commits:  $commit_count
 Files:    $file_count changed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Merge:    $mergeStateStatus (CLEAN)
 Reviews:  $review_status
 CI:       $ci_status
 Tests:    ✅ Passed locally
 Ticket:   $ticket (will move to Done)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Merge strategy: Squash and merge

Proceed? [Y/n]:
```

### 9. Execute squash merge

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

### 10. Update Linear ticket

If ticket found and not using `--no-update`:

```bash
# Verify linearis is available
if ! command -v linearis &> /dev/null; then
    echo "⚠️  Linearis CLI not found - skipping Linear ticket update"
    echo "Install: npm install -g linearis"
else
    # Move to configured "Done" state
    DONE_STATE=$(jq -r '.catalyst.linear.stateMap.done // "Done"' .catalyst/config.json 2>/dev/null || echo "Done")
    if [[ "$DONE_STATE" != "null" ]]; then
        linearis issues update "$ticket" --status "$DONE_STATE"
    fi

    # Add merge comment
    linearis comments create "$ticket" \
        --body "✅ PR merged!\n\n**PR**: #${prNumber} - ${prTitle}\n**Merge commit**: ${mergeSha}\n**Merged into**: ${baseBranch}\n\nView PR: ${prUrl}"
fi
```

### 11. Delete local branch and update base

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

### 11a. Update primary worktree

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

### 12. Extract post-merge tasks

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

### 13. Detect Deployments and Report Success

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
**Never give up with a generic message** — always diagnose the specific cause and provide actionable
next steps.

**Fail fast (stop execution):**

- Rebase conflicts → show conflicting files, instructions to resolve manually, then re-run
  `/merge-pr`
- Test failures → show failed tests, suggest fix or `--skip-tests`
- PR not open/mergeable → show current state

**Diagnose and attempt to fix (step 6 blocker loop):**

- CI checks failing → analyze failure, attempt code fix, re-push, re-poll
- Unresolved threads → run `/review-comments`, resolve threads
- Branch behind → rebase and push
- Draft PR → mark as ready
- Changes requested → check if addressed, suggest re-request review
- Infrastructure failures → suggest re-run, provide log URL

**Escalate with specifics (never generic):**

- Review required → tell user exactly how many approvals needed and who to request
- Unresolvable conflicts → list specific files and what conflicts exist
- Unknown blockers → query branch protection rules and list every requirement with its status

**Never suggest:**

- Force merge, admin override, or disabling branch protection
- Skipping required checks or reviews
- Any workaround that bypasses the protection rather than satisfying it

**Warn but continue (graceful degradation):**

- Linearis CLI not found → warn, suggest install, merge proceeds
- Linear API error → warn, merge proceeds
- Branch deletion error → warn, merge already succeeded

## Configuration

Uses `.catalyst/config.json`:

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

State names are read from `stateMap` with sensible defaults. See `.catalyst/config.json` for all
keys.

## Examples

```bash
/merge-pr 123              # Merge PR for current branch
/merge-pr 123 --skip-tests # Skip local test execution
/merge-pr 123 --no-update  # Don't update Linear ticket
/merge-pr 123 --keep-branch # Don't delete local branch
```

## Safety Features

**Never bypass branch protection:**

- No `--admin`, `--force`, or any flag that circumvents protection rules
- No disabling or modifying branch protection rules
- No suggesting the user disable protections
- Always satisfy requirements legitimately or escalate with specifics

**Fail fast on:**

- Merge conflicts (can't auto-resolve)
- Test failures (unless --skip-tests)
- Rebase conflicts
- PR not in mergeable state

**Diagnose and fix automatically:**

- CI failures → analyze errors, fix code, push, re-poll
- Unresolved review threads → run `/review-comments`, resolve via GraphQL
- Branch behind → rebase and push
- Draft PR → mark as ready with `gh pr ready`

**Escalate with actionable specifics:**

- Review required → who to request, how many needed
- Changes requested → what was asked, whether commits address it
- Unknown blockers → full branch protection rule breakdown

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

- **Never bypass branch protection** — diagnose and resolve blockers legitimately
- **Always squash merge** — clean history
- **Always delete branches** — no orphan branches
- **Always run tests** — unless explicitly skipped
- **Auto-rebase** — keep up-to-date with base
- **Diagnose, don't give up** — identify specific blockers and fix or explain them
- **Update Linear** — move ticket to Done automatically (if Linearis available)
- **Graceful degradation** — work without Linearis if needed
- For Linearis CLI syntax, see the `linearis` skill reference
