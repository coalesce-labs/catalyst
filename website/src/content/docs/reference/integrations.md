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

**Related skills**: `create-pr`, `describe-pr`, `merge-pr`, `commit`, `sync-prs`

### PR-Linear Sync

The `sync-prs` skill correlates GitHub PRs with Linear issues — matching via branch names and descriptions, identifying orphaned PRs and issues, and flagging stale PRs.

### Worktree Integration

Worktrees created with `create-worktree` automatically set up branches with ticket references (e.g., `PROJ-123-feature-name`).

## Linear

Ticket management and automatic status progression via the [Linearis CLI](https://www.npmjs.com/package/linearis).

**Setup**: `npm install -g linearis` + add `apiToken` and `teamKey` to secrets config.

**Why CLI instead of MCP?** Linearis uses ~1K tokens vs Linear MCP's ~13K — a 13x reduction in context cost.

**Related skills**: `linear`, `analyze-cycle`, `analyze-milestone`, `groom-backlog`, `sync-prs`

### Automatic Status Updates

Workflow skills automatically update Linear ticket status as you progress:

| Skill | Linear State |
|-------|-------------|
| `research-codebase` | In Progress |
| `create-plan` | In Progress |
| `implement-plan` | In Progress |
| `create-pr` | In Review |
| `merge-pr` | Done |

Customize state names via `stateMap` in your [project config](/reference/configuration/#state-map).

### Ticket Detection

Skills detect tickets automatically from plan frontmatter (`ticket: PROJ-123`), filenames, handoff documents, and worktree directory names.

## Sentry

Production error monitoring via the `catalyst-debugging` plugin.

**Setup**: `npm install -g @sentry/cli` + add `org`, `project`, and `authToken` to secrets config.

**Context cost**: ~20K tokens when enabled. Enable only during debugging:

```bash
/plugin enable catalyst-debugging    # +20K context
/plugin disable catalyst-debugging   # -20K context
```

**Related skills**: `debug-production-error`, `error-impact-analysis`, `trace-analysis`

**Research agent**: `sentry-research` (Haiku) — gathers error data via Sentry CLI.

## PostHog

Product analytics via the `catalyst-analytics` plugin.

**Setup**: Add `apiKey` and `projectId` to secrets config.

**Context cost**: ~40K tokens when enabled. Enable only when analyzing user behavior:

```bash
/plugin enable catalyst-analytics    # +40K context
/plugin disable catalyst-analytics   # -40K context
```

**Related skills**: `analyze-user-behavior`, `segment-analysis`, `product-metrics`

## Railway

Deployment investigation and service health via the `railway` CLI.

**Setup**: `npm install -g @railway/cli && railway login` + add `token` and `projectId` to secrets config.

**Research agent**: `railway-research` (Haiku) — investigates deployment issues, analyzes logs, checks service configuration.
