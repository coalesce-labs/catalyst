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

## Step 1.5: Determine the Review Round (per reviewer)

Automated reviewers re-review after every remediation push, and each round can surface new,
smaller findings. Track the round **per bot**, not globally — a PR can have more than one
automated reviewer (this repo's `create-pr`/`merge-pr` already anticipate that), and applying one
bot's count to another bot's findings misclassifies them:

```bash
# Round for a specific bot login = how many times that login has submitted a review on this PR.
review_round_for_bot() {
  local bot_login="$1"
  gh api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" \
    --jq "[.[] | select(.user.login == \"${bot_login}\")] | length"
}
```

When categorizing a finding (Step 2), look up its round using **that finding's own reviewer
login** — never one shared "current round" variable:

```bash
FINDING_BOT_LOGIN="…"   # the .user.login on the review/review-comment this finding came from
REVIEW_ROUND=$(review_round_for_bot "$FINDING_BOT_LOGIN")
```

**Round-based escalation schedule** (current default as of 2026-08-19 — canonical fleet-wide
record: `docs/DECISIONS/2026-08-07-pr-review-convergence-policy.md`, filename shared with the
other 6 HagaleTechnologies repos on this policy; this repo's own incident history behind the
schedule — VAN-292/326/351 — lives in
`docs/DECISIONS/2026-08-19-review-convergence-policy-update.md`):

- **Rounds 1-5**: fix everything reasonable, P0/P1 and P2/P3 alike. No ticket filing yet.
- **Rounds 6-15**: P0/P1 stays mandatory-fix. For genuinely new (or reopened) P2/P3 findings,
  don't fix inline — file or append to the single per-PR follow-up ticket (Step 3b) instead.
- **Rounds 16-25**: ticket BOTH P0/P1 and P2/P3 findings by default, same single-ticket
  mechanics — UNLESS the P0/P1 is critical (security vulnerability, data loss/corruption, broken
  build/tests) or blocks the PR's own stated purpose outright (it literally can't do the thing it
  exists to do without this fix). Those still get fixed inline regardless of round. When
  genuinely unsure whether a finding clears that bar, fix it inline rather than ticket it.
- **Round 25 is a hard stop**: escalate to the user rather than opening a 26th round
  unilaterally.

This exists because fine-grained automated reviewers keep surfacing progressively smaller findings
on every pass — chasing all of them to zero, round after round, burns disproportionate time and
tokens for diminishing value. Rounds 1-5 still get a real look (early findings are often genuine
gaps); it's the rounds after that narrow to P0/P1, and eventually to only the P0/P1s that are
critical or blocking.

**Severity: classify by substance, not by the reviewer's own label.** Many bots use "P2" for an
ordinary real correctness bug, not a style nit. Reconcile against: P0/P1-equivalent = correctness
bugs, security vulnerabilities, data loss/corruption, broken build/tests, spec/contract
violations. P2/P3-equivalent = style, naming, structure preferences, unverified
micro-optimizations, doc nits, subjective suggestions. When unsure, treat it as P0/P1.

**Two check-in triggers override the round math regardless of count** — these are structural red
flags, not schedule math, and can fire well before round 25:
- **The fix strategy itself needs to change.** The same code region produces a genuinely NEW bug
  shape on 3+ consecutive rounds even though each individual fix was locally correct — that
  signals the abstraction itself is wrong, not that you're almost done patching it. Check in and
  consider proposing a redesign rather than a 4th point patch.
- **A "finding" is actually a scope-expansion request in disguise, not a defect.** Check the
  finding against the ticket's OWN plan/research doc — did the current behavior violate what THIS
  ticket said it would do, not "could this theoretically be more correct with more machinery"?
  Ticket it as a fresh design-needed follow-up rather than expanding in-PR.

**Run the equivalent review locally before pushing each round** (e.g. `codex exec review --base
main` for a full branch diff, or `codex exec review --uncommitted` for a quick pre-push look), and
iterate until clean. This doesn't replace the remote review round — it's still the authoritative
round counter — it just means the remote round should usually come back clean, so a round that
DOES find something is genuinely new signal, not something a first local look would have caught
for free.

## Step 1.6: Claim the PR Before Starting a Round (Collision Awareness)

Round-based reasoning (Step 1.5) assumes one worker driving one PR through its review loop. That
breaks down the moment a second session is independently active on the same PR — "round N" stops
meaning anything coherent once two threads push fixes and re-trigger reviews out of sync with each
other. Before starting work on ANY round (including round 1), claim the PR:

```bash
# Preferred: broker daemon present (see [[broker]] and [[wait-for-github]] for the primitive).
if command -v catalyst-broker >/dev/null 2>&1 && catalyst-broker status 2>/dev/null | grep -q "^running"; then
  PR_BASE_BRANCH=$(gh pr view "$PR_NUMBER" --json baseRefName --jq '.baseRefName' 2>/dev/null || echo "main")
  broker_claim_pr "$PR_NUMBER" "${CATALYST_TICKET:-$PR_NUMBER}" "$(git branch --show-current)" \
    "$REPO" "$PR_BASE_BRANCH" || true

  # A claim is a check-in, not an exclusive lock — detect a competing session by querying for
  # OTHER active agents already claiming this same PR (see [[broker]] §8, Querying Agent State).
  OTHER_CLAIMS=$(sqlite3 ~/catalyst/filter-state.db \
    "SELECT agent_name, ticket FROM agents
     WHERE claimed_pr = ${PR_NUMBER} AND status = 'active'
       AND session_id != '${CATALYST_SESSION_ID:-__none__}';" 2>/dev/null || true)

  if [ -n "$OTHER_CLAIMS" ]; then
    echo "PR #${PR_NUMBER} is already claimed by another active session: ${OTHER_CLAIMS}" >&2
    echo "PAUSING — not starting a competing fix round. Surface this rather than racing it." >&2
    exit 0
  fi
else
  # Fallback: no broker daemon. Heuristic — has the remote branch moved since we last looked, in a
  # way we didn't cause? (very recent commits/pushes we didn't make)
  BRANCH="$(git branch --show-current)"
  LOCAL_SHA="$(git rev-parse HEAD)"
  git fetch origin "$BRANCH" --quiet 2>/dev/null || true
  REMOTE_SHA="$(git rev-parse "origin/${BRANCH}" 2>/dev/null || echo "")"
  if [ -n "$REMOTE_SHA" ] && [ "$REMOTE_SHA" != "$LOCAL_SHA" ]; then
    RECENT_AUTHOR="$(git log -1 --format='%an <%ae> at %ad' "$REMOTE_SHA" 2>/dev/null || echo "unknown")"
    echo "origin/${BRANCH} has moved since our last known commit (${RECENT_AUTHOR}) and we did not push it." >&2
    echo "Possible concurrent session on this PR. PAUSING — do not race it." >&2
    exit 0
  fi
fi
```

**If you detect a collision, do not race it.** Pause and surface it (hand off, split scope
explicitly, or stand down) rather than pushing a competing fix round — never assume the other
session will notice and back off first. See "Collision awareness" in
`docs/DECISIONS/2026-08-07-pr-review-convergence-policy.md`.

## Step 2: Categorize Comments

| Category | Action |
|----------|--------|
| **Code change requested** | P0/P1: fix every round 1-25 unless critical/blocking rules it mandatory past round 16 too — see the round schedule above. P2/P3: rounds 1-5 fix if real/cheap/clear; round 6+ defers — see below |
| **Question / clarification** | Read context and draft a reply |
| **Suggestion (optional)** | Evaluate — implement if it improves the code, explain trade-off if not |
| **Deferred (per round policy)** | File a follow-up ticket capturing the finding; reply linking it; do not implement inline — see "Deferring low-priority findings" |
| **Approval / praise** | No action needed |
| **Already resolved** | Skip (check if thread is marked resolved) |

For each actionable comment, note:
- File path and line number
- What the reviewer is asking for
- Severity (P1/P2, per the table above)
- Whether it requires a code change or just a response
- Whether it's part of a thread (read the full thread for context)

## Step 3: Address Each Comment

For each actionable comment this round's schedule tier says to fix inline (see the round schedule
in Step 1.5), in order:

1. **Read the relevant file** at the referenced line (with surrounding context)
2. **Understand the reviewer's concern** — what problem are they pointing out?
3. **Implement the fix** using Edit tool, or draft a reply if it's a question
4. **Verify the fix** doesn't break anything (run relevant tests if available)

Comments this round's tier says to defer skip this step entirely — see Step 3b.

**Handling disagreements:** If a reviewer's suggestion would introduce a regression, reduce type
safety, or conflict with project conventions — regardless of its priority tag or which round
produced it — don't silently ignore it and don't auto-defer it via ticket. Draft a respectful
reply explaining the trade-off and let the user decide whether to post it. Present it as:
```
Reviewer @name suggested X on file.ts:42.
I think this would [concern]. Draft reply:
  "Thanks for the suggestion! I considered X but went with Y because [reason].
   Happy to discuss if you feel strongly about this."
Post this reply? [y/N]
```
Classify a finding as a disagreement/judgment call **before** applying the round-based P2 policy
below — a P2 tag does not make a finding non-judgmental.

**Deferring low-priority findings:** applies only to **addressable findings authored by the
automated reviewer** — never a human reviewer's comment, which always goes through existing
human-request handling (`phase-monitor-merge` requires human change requests to be surfaced for
operator action, never addressed programmatically) — and only once the disagreement check above
has ruled out a judgment call. Follow the round schedule in Step 1.5: rounds 1-5 fix everything;
rounds 6-15 defer new P2/P3 (P0/P1 stays mandatory-fix); rounds 16-25 defer P0/P1 too unless
critical/blocking; round 25 is a hard stop.

To defer a finding:
1. File a follow-up ticket capturing it (file, line, what the reviewer flagged) — same team as the
   PR's ticket, Backlog status.
2. Reply on the thread linking the follow-up ticket, then resolve the thread (Step 5).

If ticket filing fails (Linearis unavailable, no usable Linear credentials), don't let that block
the thread indefinitely — fall back to fixing the finding inline instead (the normal Step 3 path).
An optional dependency should never become load-bearing for getting a PR unstuck.

This is a policy decision, not itself a judgment call: it applies identically in interactive and
headless mode and does NOT go through the `[y/N]` prompt above. It keeps AGENTS.md's "every review
thread resolved" rule intact — deferral resolves the thread via that reply, it does not leave it
open.

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
- **Deferred findings** (bot-authored, non-judgment-call, per the round schedule in Step 1.5) →
  same in both modes: file the follow-up ticket, reply, resolve the thread. Not gated on
  `--headless` — see "Deferring low-priority findings" above; this is a policy decision, not a
  judgment call.
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
- Review round: {N}
- Code changes: {N}
- Questions answered: {N}
- Disagreements flagged: {N}
- Deferred to follow-up: {N}
- Skipped (resolved/approval): {N}
- Commit: {short hash} pushed to branch
```
