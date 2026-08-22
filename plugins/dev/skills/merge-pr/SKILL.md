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
   worktree-safe local branch delete.
6. **Post-merge** — compound-estimate, ticket-retro, deployment detection, success summary.

## Load on demand

| Situation | Reference |
|---|---|
| Identifying the PR, checking mergeable, rebasing, running tests | [pr-identification.md](references/pr-identification.md) |
| Reactive blocker-wait loop (Pattern 3, ci/review/push/merge) | [blocker-loop.md](references/blocker-loop.md) |
| Squash merge, CTL-56 checkout-free delete, Linear update, worktree guard | [worktree-safe-merge.md](references/worktree-safe-merge.md) |
| Post-merge tasks, compound close, deployment detection, success summary | [post-merge.md](references/post-merge.md) |
| Flags (`--skip-tests`, `--no-update`, `--keep-branch`), errors, examples | [flags-errors.md](references/flags-errors.md) |
| Configuration (`.catalyst/config.json` schema, safety features) | [config-safety.md](references/config-safety.md) |
