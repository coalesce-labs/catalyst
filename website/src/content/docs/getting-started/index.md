---
title: Quick Start
description: Get up and running with Catalyst in 5 minutes.
---

Get Catalyst installed and working in your project in under 5 minutes.

## Install Prerequisites

- **Claude Code** installed and working
- **HumanLayer CLI** for the persistent thoughts system:

```bash
pip install humanlayer
# or
pipx install humanlayer
```

## Run the Setup Script

```bash
curl -O https://raw.githubusercontent.com/coalesce-labs/catalyst/main/setup-catalyst.sh
chmod +x setup-catalyst.sh
./setup-catalyst.sh
```

The script will:

- Check and install prerequisites (HumanLayer, jq)
- Set up a thoughts repository (one per org)
- Create project configuration
- Configure worktree directories
- Prompt for API tokens (Linear, Sentry, etc.)
- Link your project to shared thoughts

## Install the Plugin

In Claude Code:

```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-dev
```

Restart Claude Code after installing.

## Add Catalyst Context to Your Project

Copy the Catalyst snippet into your project's `CLAUDE.md` so Claude Code understands the available workflows:

```bash
cat plugins/dev/templates/CLAUDE_SNIPPET.md >> .claude/CLAUDE.md
```

## Try It Out

Start a Claude Code session and run:

```
/research-codebase
```

Follow the prompts to research your codebase. Catalyst will spawn parallel agents, document what exists, and save findings to `thoughts/shared/research/`.

## Optional Plugins

Catalyst is a 5-plugin system. Install what you need:

```bash
# Project management (Linear integration)
/plugin install catalyst-pm

# Analytics (PostHog integration)
/plugin install catalyst-analytics

# Debugging (Sentry integration)
/plugin install catalyst-debugging

# Workflow discovery (advanced users)
/plugin install catalyst-meta
```

## Next Steps

- [Configuration](/getting-started/configuration/) — Two-layer config system and secrets management
- [First Workflow](/getting-started/first-workflow/) — Walk through the research-plan-implement cycle
- [Multi-Project Setup](/getting-started/multi-project/) — Managing multiple clients or projects
