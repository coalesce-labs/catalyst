---
title: Integrations
description: Third-party service integrations — setup, configuration, and available skills.
sidebar:
  order: 4
---

Catalyst integrates with external services via CLI tools and MCP servers. Each integration requires credentials in your [secrets config](/reference/configuration/#secrets-config-configcatalystconfig-projectkeyjson).

## GitHub

Pull request creation, code review, and repository management via the `gh` CLI.

**Setup**: `brew install gh && gh auth login`

No Catalyst-specific configuration needed — `gh` uses its own authentication.

**Related skills**: `/catalyst-dev:create-pr`, `/catalyst-dev:describe-pr`, `/catalyst-dev:merge-pr`, `/catalyst-dev:commit`, `/catalyst-pm:sync-prs`

### PR-Linear Sync

The `/catalyst-pm:sync-prs` skill correlates GitHub PRs with Linear issues — matching via branch names and descriptions, identifying orphaned PRs and issues, and flagging stale PRs.

### Worktree Integration

Worktrees created with `/catalyst-dev:create-worktree` automatically set up branches with ticket references (e.g., `PROJ-123-feature-name`).

## Linear

Ticket management and automatic status progression via the [Linearis CLI](https://www.npmjs.com/package/linearis).

**Setup**: `npm install -g linearis` + add `apiToken` and `teamKey` to secrets config.

**Why CLI instead of MCP?** Linearis uses ~1K tokens vs Linear MCP's ~13K — a 13x reduction in context cost.

**Related skills**: `/catalyst-dev:linear`, `/catalyst-pm:analyze-cycle`, `/catalyst-pm:analyze-milestone`, `/catalyst-pm:groom-backlog`, `/catalyst-pm:sync-prs`

### Automatic Status Updates

Workflow skills automatically update Linear ticket status as you progress:

| Skill | Linear State |
|-------|-------------|
| `/catalyst-dev:research-codebase` | In Progress |
| `/catalyst-dev:create-plan` | In Progress |
| `/catalyst-dev:implement-plan` | In Progress |
| `/catalyst-dev:create-pr` | In Review |
| `/catalyst-dev:merge-pr` | Done |

Customize state names via `stateMap` in your [project config](/reference/configuration/#state-map).

### Ticket Detection

Skills detect tickets automatically from plan frontmatter (`ticket: PROJ-123`), filenames, handoff documents, and worktree directory names.

### Linear ⇄ GitHub Sync

Catalyst's feedback routing (see [Feedback Config](/reference/configuration/#feedback-config))
prefers Linear but falls back to a GitHub issue on a configured repository when Linear is
unavailable. Maintainers can mirror those GitHub issues back into Linear via Linear's native
GitHub integration, so all auto-filed tickets land in the same triage queue regardless of who
filed them.

**Setup** (one-time, Linear workspace admin):

1. In Linear, open **Settings → Integrations → GitHub**.
2. Connect the Linear workspace to the repository that receives fallback filings (default:
   `coalesce-labs/catalyst`, or whatever `catalyst.feedback.githubRepo` is set to in your
   project config).
3. In the connector's issue-sync rules, filter on the `auto-submitted` label so only
   agent-filed issues are mirrored.
4. Map the target Linear team (e.g., `CTL`) and the default status (e.g., `Backlog`).

Once configured, any GitHub issue created by a Catalyst skill surfaces in the maintainer's
Linear workspace automatically, preserving the `auto-submitted` label plus the skill-name
label (e.g., `oneshot`, `orchestrate`). See Linear's [GitHub integration
docs](https://linear.app/docs/github) for the current setup UI.

## Sentry

Production error monitoring via the `catalyst-debugging` plugin.

**Setup**: `npm install -g @sentry/cli` + add `org`, `project`, and `authToken` to secrets config.

**Context cost**: ~20K tokens when enabled. Enable only during debugging:

```bash
/plugin enable catalyst-debugging    # +20K context
/plugin disable catalyst-debugging   # -20K context
```

**Related skills**: `/catalyst-debugging:debug-production-error`, `/catalyst-debugging:error-impact-analysis`, `/catalyst-debugging:trace-analysis`

**Research agent**: `@catalyst-dev:sentry-research` (Haiku) — gathers error data via Sentry CLI.

## PostHog

Product analytics via the `catalyst-analytics` plugin.

**Setup**: Add `apiKey` and `projectId` to secrets config.

**Context cost**: ~40K tokens when enabled. Enable only when analyzing user behavior:

```bash
/plugin enable catalyst-analytics    # +40K context
/plugin disable catalyst-analytics   # -40K context
```

**Related skills**: `/catalyst-analytics:analyze-user-behavior`, `/catalyst-analytics:segment-analysis`, `/catalyst-analytics:product-metrics`

## Exa

Optional web search and code-search augmentation for research agents via the Exa MCP server.

**Setup**: Add `exaApiKey` to secrets config. Used automatically by `@catalyst-dev:external-research` when doing web/library research.

**Context cost**: MCP server — small baseline, per-query token cost.

