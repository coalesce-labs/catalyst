---
name: review-comments
description: "Systematically pull, categorize, and address all PR review comments — code change requests, questions, and suggestions. This skill fetches comments via gh api, groups them by file, implements fixes, handles disagreements diplomatically, and pushes a single commit. You should not try to handle PR review feedback manually — this skill ensures nothing gets missed. **ALWAYS consult this skill when** the user says 'address comments', 'fix review feedback', 'handle PR comments', 'respond to reviewers', 'address review', 'review feedback', or mentions that a PR has unresolved comments or review threads. Also used by /oneshot Phase 5 to process reviewer feedback before merging."
disable-model-invocation: false
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
version: 1.2.0
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

## Step 1b: Determine the review round (convergence policy)

This skill runs once per review round on a PR (bot review, human review, or a re-run after
pushing fixes). Fleet-wide policy: P1 findings get fixed every round; P2-and-lower findings get
fixed inline only on round 1 — from round 2 onward they're filed to a follow-up ticket instead
of chased indefinitely. See `docs/DECISIONS/2026-08-07-pr-review-convergence-policy.md` (repo
root) for the full policy this section implements.

```bash
ROUND=$(( $(git log --oneline --grep="address review comments from PR #${PR_NUMBER}" | wc -l) + 1 ))
echo "review-comments: round ${ROUND} for PR #${PR_NUMBER}"
```

`ROUND == 1` → address P1 and P2 alike (Step 3, unchanged). `ROUND >= 2` → P1 findings still get
fixed inline; P2-or-lower findings go to Step 3b (follow-up ticket) instead of Step 3.

## Step 2: Categorize Comments

| Category | Severity | Action |
|----------|----------|--------|
| **Code change requested — correctness/security/build-breaking** | P1 | Implement the fix (every round) |
| **Code change requested — style/naming/simplification/nit** | P2 | Round 1: implement. Round 2+: Step 3b (ticket) |
| **Question / clarification** | — | Read context and draft a reply |
| **Suggestion (optional)** | P2 | Round 1: evaluate/implement. Round 2+: Step 3b (ticket) |
| **Approval / praise** | — | No action needed |
| **Already resolved** | — | Skip (check if thread is marked resolved) |

Severity: classify by substance against the P1 definition (correctness bug, security issue, data
loss, broken build/tests, spec violation) — don't just trust a reviewer's own numeric label. Only
defer to an explicit tag when its vocabulary maps cleanly onto blocking-vs-not
(`critical`/`blocking` → P1, `minor`/`nit`/`suggestion` → P2). Common bot P0–P3 scales often do
NOT map cleanly: Codex, for instance, uses P2 for an ordinary, still-real correctness defect, not
merely a style nit — treating every bot "P2" as automatically deferrable would let a genuine bug
slip into a follow-up ticket instead of getting fixed. When genuinely unsure, treat it as P1
rather than defer it.

**Round-carryover exemption:** a P2 finding raised in round 1 that simply never got fixed
(omitted, or the fix didn't land) is still owed from round 1 — it does not become ticket-eligible
just by reappearing in round 2. Round-2+ ticketing is for genuinely new findings (or a
previously-fixed one a reviewer reopens with fresh critique), not a way for an incomplete round-1
remediation to dodge the round it was actually due in.

For each actionable comment, note:
- File path and line number
- What the reviewer is asking for
- Severity (P1/P2, per the table above)
- Whether it requires a code change or just a response
- Whether it's part of a thread (read the full thread for context)

## Step 3: Address Each Comment

For each actionable comment that is P1, or P2 on round 1, in order:

1. **Read the relevant file** at the referenced line (with surrounding context)
2. **Understand the reviewer's concern** — what problem are they pointing out?
3. **Implement the fix** using Edit tool, or draft a reply if it's a question
4. **Verify the fix** doesn't break anything (run relevant tests if available)

P2-or-lower comments on round 2+ skip this step entirely — see Step 3b.

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

## Step 3b: File a follow-up ticket for deferred P2 findings (round 2+)

For every P2-or-lower comment identified in Step 2 on round 2 or later:

1. **Do not implement a fix.** Leave the code as-is.
2. **Check for an existing follow-up ticket first**: if this PR was opened by the Catalyst
   pipeline, `${CATALYST_ORCHESTRATOR_DIR}/workers/${CATALYST_TICKET}/review.json`'s
   `followUpTicket` field (set by `phase-review`, see [[phase-review]]) may already name one —
   append to it. Otherwise file a new one, using the repo's normal ticket-authoring convention
   (`gherkin-ticket` where Linear is used). Title: `[follow-up] <PR title> — deferred review
   findings`. Body: each finding pasted **verbatim** (reviewer's exact comment text, file:line,
   thread URL), linked back to this PR and ticket. One ticket per PR, not one per finding.
3. **Reply on the thread** linking the follow-up ticket, e.g.:
   ```
   Tracked in <TICKET-ID> — deferring per the PR review convergence policy so this PR can
   converge instead of chasing progressively finer findings across rounds.
   ```
4. **Resolve the thread** (Step 5) — it's tracked, not dropped, so it no longer blocks merge.

## Non-interactive / headless mode (CTL-1496)

When `CATALYST_PHASE` is set **or** `--headless` is passed as an argument, this skill runs in a
mode safe for `claude --bg` workers (no stdin available):

- **Addressable findings** (code change requested, clear fix) → address in code + resolve the
  thread via `resolveReviewThread` mutation (same as the interactive path). Unchanged.
- **Disagreement / judgment-call findings** → the `Post this reply? [y/N]` prompt is **SKIPPED** in headless mode.
  Instead, the thread is left unresolved and a structured record is appended to the ticket's
  worker directory under the orchestrator dir:
  `${CATALYST_ORCHESTRATOR_DIR:-${ORCH_DIR:-.}}/workers/${CATALYST_TICKET:-unknown}/.review-escalations.jsonl`:
  ```json
  {"prNumber":42,"threadId":"T1","path":"a.ts","line":5,"finding":"…","why":"…"}
  ```
  (Resolve `CATALYST_ORCHESTRATOR_DIR` **first** — a `claude --bg` worker receives that var, not
  `ORCH_DIR`, which is only exported inside the recovery-pass skill's own prelude. Keying off
  `ORCH_DIR` alone wrote the record to `./workers/<ticket>` in the worktree, where the recovery-pass
  caller could never find it — CTL-1496.) The caller (recovery-pass worker) reads
  `.review-escalations.jsonl` from that same path to author a curated escalation brief — one line per
  genuine judgment call — and escalates only those, with the PR number and thread linked.
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

After pushing fixes (or posting replies for disagreements), resolve each addressed thread on GitHub
so it no longer blocks merge under branch protection rules that require resolved conversations.

Read and follow `"${CLAUDE_PLUGIN_ROOT}/references/review-thread-resolution.md"` for the full
workflow. Summary:

1. Fetch unresolved review threads via GraphQL
2. For each thread addressed in steps above, resolve it via `resolveReviewThread` mutation
3. Verify remaining unresolved count

**Resolution rules:**

- **Code change implemented** → resolve the thread
- **Reply posted** (disagreement or clarification) → resolve the thread
- **Deferred to follow-up ticket** (Step 3b) → resolve the thread after linking the ticket
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

### Deferred to Follow-up Ticket (round {N}, P2-and-lower)

5. **@reviewer** on `path/to/file.ts:200`
   - Comment: "Consider extracting this into a helper" (verbatim)
   - Deferred to {TICKET-ID} per the PR review convergence policy; thread resolved.

### No Action Needed

6. **@reviewer**: "LGTM" (approval)

### Summary
- Review round: {N}
- Code changes: {N}
- Questions answered: {N}
- Disagreements flagged: {N}
- Deferred to follow-up ticket: {N}
- Skipped (resolved/approval): {N}
- Commit: {short hash} pushed to branch
```
