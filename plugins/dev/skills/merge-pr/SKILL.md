---
name: merge-pr
description:
  "Safely merge PR with verification and Linear integration. **ALWAYS use when** the user says
  'merge the PR', 'merge this', 'ship it', or wants to merge an approved pull request. Runs tests,
  checks CI, verifies approvals, squash merges, cleans up branches, and moves Linear ticket to Done."
disable-model-invocation: false
allowed-tools: Bash(linearis *), Bash(git *), Bash(gh *), Read
version: 1.0.0
---

# Merge Pull Request

Safely merges a PR after comprehensive verification, with Linear integration and automated cleanup.

## Prerequisites

```bash
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" || exit 1
fi
```

## Safety rules

**NEVER** use `--admin`, `--force`, or any flag that bypasses branch protection. Always resolve
blockers legitimately or escalate with specifics. See
`"${CLAUDE_PLUGIN_ROOT}/references/merge-blocker-diagnosis.md"` for the full safety rules section.

## Process overview

1. **Identify PR** — use argument or `gh pr view`/`gh pr list` if none given.
2. **Verify open + mergeable** — rebase if behind, resolve conflicts or exit.
3. **Run local tests** — skip with `--skip-tests`.
4. **Diagnose blockers + reactive wait** — single disjunctive `wait-for` (CI, reviews, push,
   merge/close) with authoritative `gh api` REST re-check on every wake-up.
5. **Squash merge + cleanup** — checkout-free remote-ref delete (CTL-56), Linear ticket to Done,
   worktree-safe local branch delete. **catalyst-cloud queue-merge default (CTC-1219):** for an
   eligible catalyst-cloud PR (no `hold:hand-steps`, no schema/migration path), this step applies
   `queue:ready` and stops instead of calling `gh pr merge` — Mergify (`.mergify.yml`) owns the
   actual merge, and "merged by mergify[bot]" is the terminal signal the coordinator/steward
   watches for, not this session. Hand-step PRs and every other repo keep hand-merging unchanged.
   Re-entrant: re-running this skill against an already-mergify-merged PR skips straight past the
   merge call into cleanup, so Linear/deploy/compound still fire. See
   [worktree-safe-merge.md](references/worktree-safe-merge.md) Step 9 for the exact conditions.
6. **Post-merge** — deployment detection + verification, then (once that verification is terminal) compound-estimate, ticket-compound, ticket-retro, and the success summary.

## Load on demand

| Situation | Reference |
|---|---|
| Identifying the PR, checking mergeable, rebasing, running tests | [pr-identification.md](references/pr-identification.md) |
| Reactive blocker-wait loop (Pattern 3, ci/review/push/merge) | [blocker-loop.md](references/blocker-loop.md) |
| Deeper CI fix-up / BEHIND-rebase technique (hooks-disabled push, bounded fix attempts, human-vs-bot threads, empty `merge_commit_sha` retry) | [ci-fixup-and-behind.md](references/ci-fixup-and-behind.md) |
| Squash merge, CTL-56 checkout-free delete, Linear update, worktree guard | [worktree-safe-merge.md](references/worktree-safe-merge.md) |
| catalyst-cloud queue-merge default (CTC-1219): label `queue:ready` instead of `gh pr merge` when eligible, hand-step/other-repo exceptions, re-entrant post-merge | [queue-merge-catalyst-cloud.md](references/queue-merge-catalyst-cloud.md) |
| Verifying a ticket is genuinely done before Linear Done (other open PRs, orphan-PR reconciliation) | [done-judgment.md](references/done-judgment.md) |
| Deeper pre-merge adversarial review (8-gate table + regression-risk scoring) for a risky diff | [verify-gates.md](references/verify-gates.md) |
| Post-merge tasks, compound close, deployment detection, success summary | [post-merge.md](references/post-merge.md) |
| Confirming a merged change actually deployed + a live smoke check (bounded-poll, no broker dependency) | [post-merge-deploy-verify.md](references/post-merge-deploy-verify.md) |
| Blocking on a GitHub state change (CI, review, merge) with a foreground, bounded, quota-conscious loop — the relay-era wait pattern, no daemon needed | [bounded-poll.md](references/bounded-poll.md) |
| GitHub signal shapes that look like an answer and aren't (empty-string `conclusion`, empty check-run set, reaction-only clean review pass) | [gh-signal-traps.md](references/gh-signal-traps.md) |
| Flags (`--skip-tests`, `--no-update`, `--keep-branch`), errors, examples | [flags-errors.md](references/flags-errors.md) |
| Configuration (`.catalyst/config.json` schema, safety features) | [config-safety.md](references/config-safety.md) |
