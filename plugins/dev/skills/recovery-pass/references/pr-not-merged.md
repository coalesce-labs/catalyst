# PR-not-merged Sub-playbook (CTL-1496)

When the recovery-pass brief category is `pr-not-merged` (set by the Phase-2 classifier when
`phase-teardown` failed with `failureReason: "pr_not_merged"`), follow this sub-playbook before
the general Rubric Two logic. The brief already embeds the concrete blockers from the classify-time
probe; re-probe live state at act-time to get the current picture:

```bash
# Re-probe live PR state (read-only; same seam as classifier)
gh pr view --json number,state,mergeStateStatus,mergeable,statusCheckRollup
```

**Step 1 — CI branch** (failing required checks): for each failing check named in the brief:
1. `gh run view --log-failed` to read the failure log.
2. Fix the root cause in code (bounded by the existing attempts cap).
3. `git add … && git commit && git push` to re-trigger CI.
4. Re-probe after CI completes; if CLEAN, proceed to Step 3 (merge).

**Step 2 — Review branch** (unresolved bot-review threads): apply
`/catalyst-dev:review-comments`'s round-aware severity policy inline — do NOT invoke that skill
via a nested slash command (slash commands cannot nest inside a running skill or a `claude --bg`
worker). Do the equivalent yourself:
1. For each unresolved bot thread, read its priority tag (P0/P1/P2/P3) and determine the reviewing
   bot's round. An actionable bot finding with **no priority tag at all** is classified
   conservatively into the P0/P1 path below — an untagged finding must never be the reason
   recovery gets stuck.
2. Classify disagreement/judgment-call findings first, regardless of priority tag — a P2 tag does
   not make a finding non-judgmental. Those go to step 6 (escalate), not steps 3-4.
3. P0/P1 (any round) and untagged bot findings: read the thread body, address the finding in code,
   commit, **push** (`git push` — the remote PR must actually change before its blocker is
   resolved), then resolve the thread via the `resolveReviewThread` GraphQL mutation (reuse
   `orchestrate-resolve-fixed-threads`'s mutation).
4. P2/P3, bot-authored only: round 1 is a judgment call. Round 2+ always defers: file a
   follow-up ticket, reply linking it, resolve the thread.
5. Only if step 3 or 4 actually pushed a code change (HEAD moved on the remote), post `@codex
   review` via `plugins/dev/scripts/lib/gh-pr-comment.sh <PR> "@codex review" --idempotent` to
   re-trigger the automated reviewer, then wait bounded (`catalyst-events wait-for`) for re-review.
   A pass that only deferred findings (no push) must NOT re-trigger — reviewing the same unchanged
   SHA again can resurface the same findings as fresh threads and file duplicate follow-up tickets.
6. Escalate ONLY a finding that is a genuine judgment call (human `CHANGES_REQUESTED` or a design
   decision you cannot resolve).

**Step 3 — Merge** (when the probe returns `mergeStateStatus: "CLEAN"`):
- Run `gh pr view <n> --json mergeable,mergeStateStatus` to confirm.
- Run the cluster fence guard: `"${PLUGIN_ROOT}/scripts/lib/cluster-fence-guard.sh" --phase recovery-pass --ticket <T>`.
- Merge: capture the head ref first (`gh api repos/<owner/repo>/pulls/<n> --jq '.head.ref'`),
  then `gh pr merge <n> --squash` (worktree-safe — CTL-56: no local branch-cleanup side effect).
  **NEVER `--admin` or force-merge past a failing or pending check** — this is the load-bearing
  safety property (Rubric Two invariant).
- After REST-confirm (`.merged == true`), delete the remote head ref checkout-free:
  `gh api --method DELETE repos/<owner/repo>/git/refs/heads/<head_ref>` — but ONLY when the head
  branch lives in that repo (`.head.repo.full_name == <owner/repo>`). A fork PR's `.head.ref` names
  a branch in the FORK, so deleting it from the base repo could hit an unrelated same-named branch
  (CTL-56). URL-encode `<head_ref>` (preserve `/`) first. Idempotent + best-effort.

**Step 4 — Escalate** only when:
- A human reviewer (not a bot) left `CHANGES_REQUESTED` → escalate with the reviewer's SPECIFIC
  ask (file, line, and body), PR number linked. Never "Failure reason: pr_not_merged".
- CI persistently red after 3 honest attempts at a genuine design incompatibility → decision
  escalate naming the failing check and the incompatibility.
- The PR was not found (no open PR for the ticket) → escalate with the specific reason.
