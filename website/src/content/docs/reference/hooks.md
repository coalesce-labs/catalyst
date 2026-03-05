---
title: Hooks Reference
description: Complete reference for all Claude Code hooks across Catalyst plugins.
---

Hooks are shell scripts that run automatically at specific points in the Claude Code workflow. They enable guardrails, automation, and context tracking without manual intervention.

## catalyst-dev Hooks

### inject-plan-template

| Property | Value |
|----------|-------|
| **Event** | `UserPromptSubmit` |
| **Trigger** | Every user prompt (self-filters to plan mode only) |
| **Source** | [inject-plan-template.sh](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/hooks/inject-plan-template.sh) |

When Claude Code is in plan mode, this hook injects Catalyst's plan structure guidance as additional context. This nudges Claude's free-form plan output toward the phased structure that `/catalyst-dev:implement_plan` expects — with phases, success criteria, and file-level change specifications.

Outside of plan mode, the hook exits immediately (under 10ms overhead).

### sync-plan-to-thoughts

| Property | Value |
|----------|-------|
| **Event** | `PermissionRequest` |
| **Matcher** | `tool_name = "ExitPlanMode"` |
| **Source** | [sync-plan-to-thoughts.sh](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/hooks/sync-plan-to-thoughts.sh) |

When the user exits plan mode, this hook:

1. Reads the plan from `~/.claude/plans/plan.md`
2. Wraps it in Catalyst frontmatter (date, git commit, branch, repository)
3. Writes it to `thoughts/shared/plans/YYYY-MM-DD-{ticket}-{slug}.md`
4. Updates workflow context so `/catalyst-dev:implement_plan` can auto-discover it
5. Runs `humanlayer thoughts sync` in the background

Designed for silent operation — exits 0 with no stdout so the normal approval dialog is never blocked.

### update-workflow-context

| Property | Value |
|----------|-------|
| **Event** | `PostToolUse` |
| **Matcher** | Write and Edit tools |
| **Source** | [update-workflow-context.sh](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/hooks/update-workflow-context.sh) |

After any file write or edit, this hook checks if the written file is inside `thoughts/shared/`. If so, it determines the document type from the path segment (`research`, `plans`, `handoffs`, or `prs`) and updates `.claude/.workflow-context.json` to record it as the most recent document.

This enables command chaining — `/catalyst-dev:research_codebase` saves research, then `/catalyst-dev:create_plan` auto-discovers it without the user specifying a path.
