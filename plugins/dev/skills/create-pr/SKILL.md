---
name: create-pr
description:
  "Create pull request with automatic Linear integration. **ALWAYS use when** the user says 'create
  a PR', 'open a pull request', 'ship this', 'ready for review', or wants to push changes and create
  a GitHub PR. Handles commit, rebase, push, PR creation, description generation, and Linear ticket
  update."
disable-model-invocation: false
allowed-tools: Bash(linearis *), Bash(git *), Bash(gh *), Read, Task
version: 1.0.0
---

# Create Pull Request

Orchestrates the complete PR creation flow: commit → rebase → push → create → describe → link Linear
ticket.

## Prerequisites

```bash
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" || exit 1
fi
```

## No Claude attribution

The PR is authored solely by the git user. Never add "Generated with Claude Code",
"Co-Authored-By: Claude", or any AI-assistance reference to its title or body.

## Process overview

1. **Preflight** — uncommitted changes, not on main/master, detect base branch, rebase if behind,
   check for an existing PR, extract the ticket from the branch name. See
   [preflight.md](references/preflight.md).
2. **Title, push, create, link Linear** — `draft_pr_title` (CTL-783), `draft_pr_push_verify`
   (CTL-1051), then create the PR with the CTL-623/633 sibling-skip guard appended to its body (full
   rationale: `../describe-pr/references/linear-sibling-guard.md`), auto-call `/describe-pr`, update
   Linear. See [push-and-create.md](references/push-and-create.md).
3. **Monitor to a clean merge state** — CI, automated reviewers, blocker resolution; this is NOT
   optional. See [monitoring-loop.md](references/monitoring-loop.md).
4. **Report the real outcome, not just "PR created."** See
   [outcomes-and-errors.md](references/outcomes-and-errors.md), which also covers error handling,
   examples, and integration with `/commit`/`/describe-pr`/`/merge-pr`.

## Configuration

Uses `.catalyst/config.json` (`linear.teamKey`, `linear.stateMap.inReview`). State names have
sensible defaults; see `.catalyst/config.json` for all keys.

## Load on demand

| Situation | Reference |
|---|---|
| Uncommitted changes, branch/base checks, existing-PR prompt, ticket extraction | [preflight.md](references/preflight.md) |
| Title generation, guarded push, PR creation + sibling-skip guard, Linear link | [push-and-create.md](references/push-and-create.md) |
| Event-driven CI/reviewer wait, blocker diagnosis loop, re-poll criteria | [monitoring-loop.md](references/monitoring-loop.md) |
| Final-state reports, error handling, worked examples, command integration | [outcomes-and-errors.md](references/outcomes-and-errors.md) |

## Remember

- **Never stop at "PR created"** — monitor through to a clean or genuinely human-blocked state.
- For Linearis CLI syntax, see the `linearis` skill reference.
