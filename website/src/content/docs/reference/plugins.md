---
title: Plugins
description: Catalyst is a set of Claude Code plugins. Install only the ones you need.
sidebar:
  order: 1
---

Catalyst comes as separate Claude Code plugins. Install only what you need, so Claude stays fast.

## Available plugins

| Plugin | What it does | Context cost | Skills | Agents |
| --- | --- | :---: | :---: | :---: |
| `catalyst-dev` | Core dev workflow — research, plan, build, verify, ship | ~3.5K | 50 | 9 |
| `catalyst-pm-ops` | PM work — cycle health, backlog, cadence, Slack | Minimal | 12 | 4 |
| `catalyst-meta` | Find, build, and manage workflows | Minimal | 6 | — |

"Context cost" is how much space the plugin takes up when it's on.

## Install

```bash
# Add the marketplace
/plugin marketplace add coalesce-labs/catalyst

# Install plugins (catalyst-dev is required; the rest are optional)
/plugin install catalyst-dev
/plugin install catalyst-pm-ops
/plugin install catalyst-meta
```

Most sessions run with just `catalyst-dev`.

## Hooks (catalyst-dev)

The dev plugin adds three hooks that run on their own in Claude Code:

- `inject-plan-template` — adds Catalyst's plan layout when you enter plan mode
- `sync-plan-to-thoughts` — saves your plan to `thoughts/shared/plans/` when you leave plan mode
- `update-workflow-context` — records what you wrote so the next step can find it

## Updating

Claude Code updates plugins when a session starts. Restart to load a new one, or force it now with `/plugins update`. Check versions with `/plugins`. See the [changelogs](/changelog/catalyst-dev/) for what's new.
