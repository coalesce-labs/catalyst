---
title: Getting Started
description: Get up and running with Catalyst in 5 minutes.
sidebar:
  order: 1
---

Get Catalyst installed and working in your project in under 5 minutes.

## Prerequisites

- **Claude Code** — [Install Claude Code](https://docs.anthropic.com/en/docs/claude-code) before running setup
- **Git** — required for repository detection and thoughts system

The setup script checks for and installs additional dependencies automatically:

| Dependency | Required? | Auto-installed? |
|-----------|-----------|-----------------|
| jq | Yes | Yes (via Homebrew or apt-get) |
| HumanLayer CLI | Yes | Yes (via pip) |
| GitHub CLI (gh) | Optional | Opens install page |
| Linearis CLI | Optional | Shows npm install command |
| agent-browser | Optional | Shows npm install command |

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
/catalyst-dev:research_codebase
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
