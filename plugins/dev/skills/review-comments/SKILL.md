---
name: review-comments
description: "Systematically pull, categorize, and address all PR review comments — code change requests, questions, and suggestions. This skill fetches comments via gh api, groups them by file, implements fixes, handles disagreements diplomatically, and pushes a single commit. You should not try to handle PR review feedback manually — this skill ensures nothing gets missed. **ALWAYS consult this skill when** the user says 'address comments', 'fix review feedback', 'handle PR comments', 'respond to reviewers', 'address review', 'review feedback', or mentions that a PR has unresolved comments or review threads. Also used by /oneshot Phase 5 to process reviewer feedback before merging."
disable-model-invocation: false
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
version: 1.0.0
argument-hint: "[PR-number]"
---

# Review Comments

Pull PR review comments and feedback, understand the reviewer's intent, implement fixes, and push updates. The goal is to resolve all actionable feedback in a single pass so the PR can move forward.

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

Group comments into threads using `in_reply_to_id` — read the full thread before acting on any individual comment, since later replies may refine or resolve earlier ones.

## Step 1.5: Determine the Review Round (per reviewer)

Automated reviewers re-review after every remediation push, and each round can surface new, smaller findings. Track the round **per bot**, not globally — a PR can have more than one automated reviewer (this repo's `create-pr`/`merge-pr` already anticipate that), and applying one bot's count to another bot's findings misclassifies them:

```bash
# Round for a specific bot login = how many times that login has submitted a review on this PR.
review_round_for_bot() {
  local bot_login="$1"
  gh api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" \
    --jq "[.[] | select(.user.login == \"${bot_login}\")] | length"
}
```

When categorizing a finding (Step 2), look up its round using **that finding's own reviewer login** — never one shared "current round" variable:

```bash
FINDING_BOT_LOGIN="…"   # the .user.login on the review/review-comment this finding came from
REVIEW_ROUND=$(review_round_for_bot "$FINDING_BOT_LOGIN")
```

- `REVIEW_ROUND == 1` → P0/P1 mandatory-fix; use judgment on P2/P3 — fix it now if it's real,
  cheap, and clearly correct, otherwise defer (Step 2/3).
- `REVIEW_ROUND >= 2` → P0/P1 stays mandatory-fix; P2-and-lower is **always** deferred, no
  exceptions (see "Deferring low-priority findings after round one" under Step 3).

This exists because fine-grained automated reviewers keep surfacing progressively smaller findings on every pass — chasing all of them to zero, round after round, burns disproportionate time and tokens for diminishing value. Round 1 still gets a real look (early findings are often genuine gaps); it's only the rounds after that narrow strictly to P0/P1.

## Step 2: Categorize Comments

| Category | Action |
|----------|--------|
| **Code change requested** | P0/P1: implement the fix, every round. P2/P3: round 1 is a judgment call; round 2+ always defers — see below |
| **Question / clarification** | Read context and draft a reply |
| **Suggestion (optional)** | Evaluate — implement if it improves the code, explain trade-off if not |
| **Deferred (P2/P3, per round policy)** | File a follow-up ticket capturing the finding; reply linking it; do not implement inline — see "Deferring low-priority findings after round one" |
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

**Handling disagreements:** If a reviewer's suggestion would introduce a regression, reduce type safety, or conflict with project conventions — regardless of its priority tag or which round produced it — don't silently ignore it and don't auto-defer it via ticket. Draft a respectful reply explaining the trade-off and let the user decide whether to post it. Present it as:
```
Reviewer @name suggested X on file.ts:42.
I think this would [concern]. Draft reply:
  "Thanks for the suggestion! I considered X but went with Y because [reason].
   Happy to discuss if you feel strongly about this."
Post this reply? [y/N]
```
Classify a finding as a disagreement/judgment call **before** applying the round-based P2 policy below — a P2 tag does not make a finding non-judgmental.

**Deferring low-priority findings after round one:** applies only to **addressable findings authored by the automated reviewer** — never a human reviewer's comment, which always goes through existing human-request handling (`phase-monitor-merge` requires human change requests to be surfaced for operator action, never addressed programmatically) — and only once the disagreement check above has ruled out a judgment call.

- **Round 1**: P0/P1 always gets fixed. For P2/P3, use judgment — fix it now if it's real, cheap,
  and clearly correct; otherwise defer (below).
- **Round 2+**: P0/P1 always gets fixed. P2/P3 is always deferred — no exceptions, even a trivial
  one-liner.

To defer a finding:
1. File a follow-up ticket capturing it (file, line, what the reviewer flagged) — same team as the
   PR's ticket, Backlog status.
2. Reply on the thread linking the follow-up ticket, then resolve the thread (Step 5).

If ticket filing fails (Linearis unavailable, no usable Linear credentials), don't let that block the thread indefinitely — fall back to fixing the finding inline instead (the normal Step 3 path). An optional dependency should never become load-bearing for getting a PR unstuck.

This is a policy decision, not itself a judgment call: it applies identically in interactive and headless mode and does NOT go through the `[y/N]` prompt above. It keeps AGENTS.md's "every review thread resolved" rule intact — deferral resolves the thread via that reply, it does not leave it open.

## Non-interactive / headless mode (CTL-1496)

When `CATALYST_PHASE` is set **or** `--headless` is passed as an argument, this skill runs in a mode safe for `claude --bg` workers (no stdin available):

- **Addressable findings** (code change requested, clear fix) → address in code + resolve the
  thread via `resolveReviewThread` mutation (same as the interactive path). Unchanged.
- **Deferred findings** (bot-authored, non-judgment-call P2/P3 — round 1 by judgment, round 2+
  always) → same in both modes: file the follow-up ticket, reply, resolve the thread. Not gated on `--headless` — see "Deferring low-priority findings after round one" above; this is a policy decision, not a judgment call.
- **Disagreement / judgment-call findings** → the `Post this reply? [y/N]` prompt is **SKIPPED** in headless mode.
  Instead, the thread is left unresolved and a structured record is appended to the ticket's
  worker directory under the orchestrator dir:
  `${CATALYST_ORCHESTRATOR_DIR:-${ORCH_DIR:-.}}/workers/${CATALYST_TICKET:-unknown}/.review-escalations.jsonl`:
  ```json
  {"prNumber":42,"threadId":"T1","path":"a.ts","line":5,"finding":"…","why":"…"}
  ```
  (Resolve `CATALYST_ORCHESTRATOR_DIR` **first** — a `claude --bg` worker receives that var, not `ORCH_DIR` — CTL-1496. Keying off `ORCH_DIR` alone wrote the record to `./workers/<ticket>` in the worktree instead of the shared orchestrator dir.) CTL-2141 removed this file's only consumer (the recovery-pass skill, which read `.review-escalations.jsonl` to author a curated escalation brief); the write here is retained as a durable record for manual triage, but nothing currently reads it automatically.
- **Interactive path preserved** — when neither `CATALYST_PHASE` is set nor `--headless` is
  passed, the existing `[y/N]` prompt behaviour is unchanged.

## Step 4: Commit and Push

After all changes are made, stage only the files that were modified to address comments:

```bash
# Stage specific changed files (NOT git add -A which could catch unrelated changes)
git add path/to/changed-file1.ts path/to/changed-file2.ts
git commit -m "address review comments from PR #${PR_NUMBER}"
git push
```

## Step 5: Resolve Comment Threads

After pushing fixes (or posting replies for disagreements), resolve each addressed thread on GitHub so it no longer blocks merge under branch protection rules that require resolved conversations.

Read and follow `"${CLAUDE_PLUGIN_ROOT}/references/review-thread-resolution.md"` for the full workflow. Summary:

1. Fetch unresolved review threads via GraphQL
2. For each thread addressed in steps above, resolve it via `resolveReviewThread` mutation
3. Verify remaining unresolved count

**Resolution rules:**

- **Code change implemented** → resolve the thread
- **Reply posted** (disagreement or clarification) → resolve the thread
- **Deferred to follow-up ticket** (P2/P3, per the round policy) → resolve the thread
- **Approval / praise** → already not blocking, skip
- **Could not address** → do NOT resolve; leave for human review

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

### Deferred to Follow-up (low priority, per round policy)

5. **@reviewer** on `path/to/file.ts:200`
   - Comment: "Consider extracting this into a helper"
   - Filed as: {TICKET-ID} — reply posted, thread resolved

### No Action Needed

6. **@reviewer**: "LGTM" (approval)

### Summary
- Code changes: {N}
- Questions answered: {N}
- Disagreements flagged: {N}
- Deferred to follow-up: {N}
- Skipped (resolved/approval): {N}
- Commit: {short hash} pushed to branch
```
