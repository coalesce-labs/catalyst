---
name: review-comments
description: "Systematically pull, categorize, and address all PR review comments — code change requests, questions, and suggestions. This skill fetches comments via gh api, groups them by file, implements fixes, handles disagreements diplomatically, and pushes a single commit. You should not try to handle PR review feedback manually — this skill ensures nothing gets missed. **ALWAYS consult this skill when** the user says 'address comments', 'fix review feedback', 'handle PR comments', 'respond to reviewers', 'address review', 'review feedback', or mentions that a PR has unresolved comments or review threads. Also used by /oneshot Phase 5 to process reviewer feedback before merging."
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
version: 1.0.0
argument-hint: "[PR-number]"
---

# Review Comments

Pull PR review comments and feedback, understand the reviewer's intent, implement fixes, and push
updates. The goal is to resolve all actionable feedback in a single pass so the PR can move forward.

## Input

If `$ARGUMENTS` provides a PR number, use it. Otherwise, detect the current PR:

```bash
PR_NUMBER=$(gh pr view --json number --jq '.number' 2>/dev/null)
```

If no PR is found, ask the user for the PR number.

## Step 1: Fetch Comments and Reviews

Gather all review feedback from the PR:

```bash
# Get repo info
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')

# Get PR review comments (inline code comments) — includes file path and line
gh api "repos/${REPO}/pulls/${PR_NUMBER}/comments" \
  --jq '.[] | {id: .id, path: .path, line: .line, body: .body, user: .user.login, created: .created_at, in_reply_to: .in_reply_to_id}'

# Get PR reviews (top-level review bodies with approval state)
gh api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" \
  --jq '.[] | {id: .id, state: .state, body: .body, user: .user.login}'

# Get issue comments (general PR conversation)
gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" \
  --jq '.[] | {id: .id, body: .body, user: .user.login, created: .created_at}'
```

Group comments into threads using `in_reply_to_id` — read the full thread before acting on any
individual comment, since later replies may refine or resolve earlier ones.

## Step 2: Categorize Comments

| Category | Action |
|----------|--------|
| **Code change requested** | Implement the fix |
| **Question / clarification** | Read context and draft a reply |
| **Suggestion (optional)** | Evaluate — implement if it improves the code, explain trade-off if not |
| **Approval / praise** | No action needed |
| **Already resolved** | Skip (check if thread is marked resolved) |

For each actionable comment, note:
- File path and line number
- What the reviewer is asking for
- Whether it requires a code change or just a response
- Whether it's part of a thread (read the full thread for context)

## Step 3: Address Each Comment

For each actionable comment, in order:

1. **Read the relevant file** at the referenced line (with surrounding context)
2. **Understand the reviewer's concern** — what problem are they pointing out?
3. **Implement the fix** using Edit tool, or draft a reply if it's a question
4. **Verify the fix** doesn't break anything (run relevant tests if available)

**Handling disagreements:** If a reviewer's suggestion would introduce a regression, reduce type
safety, or conflict with project conventions, don't silently ignore it. Draft a respectful reply
explaining the trade-off and let the user decide whether to post it. Present it as:
```
Reviewer @name suggested X on file.ts:42.
I think this would [concern]. Draft reply:
  "Thanks for the suggestion! I considered X but went with Y because [reason].
   Happy to discuss if you feel strongly about this."
Post this reply? [y/N]
```

Group related comments that affect the same file — make all changes to a file before moving on.

## Step 4: Commit and Push

After all changes are made, stage only the files that were modified to address comments:

```bash
# Stage specific changed files (NOT git add -A which could catch unrelated changes)
git add path/to/changed-file1.ts path/to/changed-file2.ts
git commit -m "address review comments from PR #${PR_NUMBER}"
git push
```

## Output Format

```markdown
## PR Review Comments — #${PR_NUMBER}

### Comments Addressed

1. **@reviewer** on `path/to/file.ts:42`
   - Comment: "This should use optional chaining instead of non-null assertion"
   - Action: Changed `user!.name` to `user?.name ?? ''`

2. **@reviewer** on `path/to/file.ts:89`
   - Comment: "Missing error handling for the API call"
   - Action: Added try/catch with proper error propagation

### Questions Answered

3. **@reviewer** on general
   - Question: "Why did you choose X over Y?"
   - Reply: {drafted reply — post via gh api if requested}

### Disagreements (Needs Decision)

4. **@reviewer** on `path/to/file.ts:120`
   - Suggestion: "Use a map instead of switch"
   - Analysis: The switch is more readable here and has exhaustiveness checking.
   - Draft reply ready — awaiting your decision.

### No Action Needed

5. **@reviewer**: "LGTM" (approval)

### Summary
- Code changes: {N}
- Questions answered: {N}
- Disagreements flagged: {N}
- Skipped (resolved/approval): {N}
- Commit: {short hash} pushed to branch
```
