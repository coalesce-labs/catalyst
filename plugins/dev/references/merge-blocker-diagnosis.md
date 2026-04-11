# Merge Blocker Diagnosis Workflow

Shared workflow for diagnosing and resolving all merge blockers on a pull request. Referenced by
`/merge-pr` (Step 6) and `/oneshot` (Phase 5, Step 3).

## Safety Rules

**NEVER bypass branch protection.** These rules are non-negotiable:

- **NEVER** use `--admin` flag on `gh pr merge`
- **NEVER** use `--force` or any flag that bypasses branch protection rules
- **NEVER** disable or modify branch protection rules programmatically
- **NEVER** suggest the user disable branch protection to unblock a merge

The goal is to satisfy branch protection requirements, not circumvent them. If a blocker cannot be
resolved autonomously, tell the user **exactly** what is needed and what they need to do — not just
"branch protection is blocking the merge."

## Step 1: Query Full Merge State

Get everything in a single GraphQL call to avoid multiple round-trips:

```bash
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
OWNER=$(echo "$REPO" | cut -d'/' -f1)
NAME=$(echo "$REPO" | cut -d'/' -f2)

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
}' -f owner="$OWNER" -f name="$NAME" -F pr="$PR_NUMBER")
```

## Step 2: Identify Blockers

Parse the response and build a list of every reason the PR cannot merge:

| `mergeStateStatus` | Meaning                                       | Blocker Type                   |
| ------------------- | --------------------------------------------- | ------------------------------ |
| `CLEAN`             | Ready to merge                                | None                           |
| `BEHIND`            | Branch needs update                           | `branch-behind`                |
| `DIRTY`             | Merge conflicts                               | `conflicts`                    |
| `BLOCKED`           | Branch protection rule(s) not satisfied        | Decompose further (see below) |
| `DRAFT`             | PR is a draft                                 | `draft`                        |
| `UNSTABLE`          | Required checks not yet complete or failing   | `ci-failing`                   |
| `HAS_HOOKS`         | Merge hooks pending                           | `hooks-pending`                |
| `UNKNOWN`           | State not yet computed                        | Wait and re-query              |

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

## Step 3: Resolve Each Blocker

Loop through the blockers list. For each one, attempt autonomous resolution. **Never bypass — always
resolve legitimately.**

```
MAX_RESOLVE_ATTEMPTS=3
attempt=0

while blockers is not empty AND attempt < MAX_RESOLVE_ATTEMPTS:
  for each blocker:
    attempt_resolution(blocker)
  re-query merge state (step 1)
  rebuild blockers list (step 2)
  attempt += 1
```

### Resolution Strategies

---

#### `branch-behind` — Branch needs to be updated with base branch changes.

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

#### `conflicts` — Merge conflicts exist.

*Can fix:* Attempt rebase. If conflicts are in generated files (lockfiles, etc.), try auto-resolve.
Otherwise, report specific files.

```
I can regenerate lockfiles automatically. For source conflicts, you'll need to:
  1. Resolve conflicts in the listed files
  2. git add <resolved-files>
  3. git rebase --continue
  4. git push --force-with-lease
  5. Run /merge-pr again
```

---

#### `draft` — PR is still in draft mode.

*Can fix:* Yes.

```bash
gh pr ready $pr_number
```

---

#### `ci-failing` — One or more required status checks are failing or pending.

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
CI check "$check_name" failed — appears to be infrastructure-related, not a code issue.

Failure: $failure_summary
Log: $details_url

Options:
  [1] Re-run the failed check: gh run rerun $run_id --failed
  [2] I'll investigate and re-run /merge-pr when ready
```

Do NOT suggest force-merging past a failing required check.

---

#### `unresolved-threads` — Unresolved review conversation threads.

*Can fix:* Yes — run `/review-comments` which addresses comments and resolves threads.

```bash
/review-comments $pr_number
# review-comments fixes code, posts replies, AND resolves threads via GraphQL
# (see review-thread-resolution.md for the resolution workflow)
```

After `/review-comments`, re-query to confirm threads are resolved. If some remain unresolved
(couldn't be addressed automatically), report them specifically:

```
$N unresolved thread(s) could not be resolved automatically:

  1. @reviewer on src/api/auth.ts:42:
     "This changes the public API contract — needs migration guide"
     -> Requires your decision: write a migration guide or reply explaining why it's not needed

  2. @reviewer on src/db/schema.ts:15:
     "This migration is irreversible — are we sure?"
     -> Requires your confirmation to proceed
```

---

#### `changes-requested` — A reviewer requested changes.

*Can fix:* Partially. Check if the changes have already been addressed.

1. Check if commits were pushed after the review that requested changes
2. If yes, the reviewer may just need to re-review — tell the user:

```
@reviewer requested changes on $(date of review).
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
@reviewer requested changes:
   "$review_body_summary"

Address the feedback first, then re-run /merge-pr.
Or run /review-comments to see all outstanding feedback.
```

---

#### `review-required` — Branch protection requires approving reviews that haven't been given yet.

*Can fix:* No — this requires a human reviewer.

Query the specific requirement:

```
Branch protection requires $required_count approving review(s).
Current: $current_approvals approval(s).

Reviewers who can approve:
  - @reviewer1 (already reviewed — requested changes)
  - @reviewer2 (not yet reviewed)
  - Request review: gh pr edit $pr_number --add-reviewer "username"
```

Do NOT suggest any workaround. This is a human gate.

---

#### `hooks-pending` — Pre-merge hooks are running.

*Can fix:* Wait. Re-query after 30 seconds.

---

#### `unknown-blocker` — `BLOCKED` but none of the above matched.

*Can fix:* No — but provide maximum diagnostic detail.

```
Branch protection is blocking the merge, but I couldn't identify the specific blocker.

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

## Step 4: Report Final State

After the resolution loop, if blockers remain:

```
Resolved:
  [list what was fixed and how]

Still blocking:
  [list each remaining blocker with specific actionable guidance]
```

If all blockers resolved, the PR is ready to merge.
