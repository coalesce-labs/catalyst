---
title: Plugins
description: Catalyst's modular plugin architecture — install what you need.
sidebar:
  order: 0
---

Catalyst is distributed as independent Claude Code plugins. Install only the ones you need to keep
your context lean and focused.

## Available Plugins

| Plugin                 | Description                                                           | Context Cost | Skills | Agents |
| ---------------------- | --------------------------------------------------------------------- | :----------: | :----: | :----: |
| **catalyst-dev**       | Core development workflow — research, plan, implement, validate, ship |    ~3.5K     |   25   |   9    |
| **catalyst-pm**        | Project management — cycle analysis, backlog grooming, PR sync        |   Minimal    |   46   |   12   |
| **catalyst-meta**      | Workflow discovery, creation, and management                          |   Minimal    |   6    |   —    |
| **catalyst-analytics** | Product analytics via PostHog MCP                                     |     ~40K     |   3    |   —    |
| **catalyst-debugging** | Error monitoring via Sentry MCP                                       |     ~20K     |   3    |   —    |

See the [Skills Reference](/reference/skills/) for the complete list of skills per plugin, and
[Agents](/reference/agents/) for agent details.

## Installation

```bash
# Add the marketplace
/plugin marketplace add coalesce-labs/catalyst

# Install plugins
/plugin install catalyst-dev          # Required
/plugin install catalyst-pm           # Optional
/plugin install catalyst-analytics    # Optional
/plugin install catalyst-debugging    # Optional
/plugin install catalyst-meta         # Optional
```

## Context Management

Plugins with heavy MCP integrations (analytics, debugging) should be enabled only when needed:

```bash
/plugin enable catalyst-analytics    # +40K context
# Do your analysis work...
/plugin disable catalyst-analytics   # -40K context
```

Most sessions start with just `catalyst-dev` (~3.5K tokens) and enable heavier plugins only when
needed.

## Architecture

Each plugin contains:

- **agents/** — Specialized research agents
- **skills/** — Workflow skills (invoked via `/skill-name`)
- **scripts/** — Runtime utilities
- **hooks/** — Automatic triggers (e.g., workflow context tracking)
- **plugin.json** — Manifest with metadata and dependencies

### Hooks (catalyst-dev)

The dev plugin includes three Claude Code hooks that run automatically:

- **inject-plan-template** — Injects Catalyst's plan structure guidance when Claude Code is in plan
  mode.
- **sync-plan-to-thoughts** — Copies plans to `thoughts/shared/plans/` with frontmatter when you
  exit plan mode.
- **update-workflow-context** — Records document writes to `.catalyst/.workflow-context.json`,
  enabling skill chaining.

## Updating

Claude Code auto-updates plugins at session start — if a new version is available, it pulls it automatically. Restart Claude Code to load the update.

To force an immediate update (e.g., a release just dropped):

```bash
# Fetch latest from the marketplace
/plugins update

# Restart Claude Code to load the new version
```

Check your current versions:

```bash
/plugins
```

Compare against the latest:

- [Changelogs](/changelog/catalyst-dev/) — per-plugin changelogs on this site
- [GitHub Releases](https://github.com/coalesce-labs/catalyst/releases) — release notes with full commit history

## Release Strategy

Catalyst uses **Release Please** for automated per-plugin releases with conventional commit
messages:

| Prefix         | Effect                       | Example                              |
| -------------- | ---------------------------- | ------------------------------------ |
| `feat(dev):`   | Minor bump for catalyst-dev  | `feat(dev): add new skill`           |
| `fix(pm):`     | Patch bump for catalyst-pm   | `fix(pm): correct cycle calculation` |
| `feat(dev)!:`  | Major bump (breaking change) | `feat(dev)!: redesign plan format`   |
| `chore(meta):` | No version bump              | `chore(meta): update docs`           |
