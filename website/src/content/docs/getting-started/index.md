---
title: Getting Started
description: Get up and running with Catalyst in 5 minutes.
sidebar:
  order: 2
---

Get Catalyst installed and working in your project in under 5 minutes.

## Prerequisites

- **macOS** — Catalyst is built and tested on macOS only. Other platforms are unsupported.
- **Claude Code** — [Install Claude Code](https://docs.anthropic.com/en/docs/claude-code) before running setup
- **Git** — required for repository detection and thoughts system

The setup script checks for and installs additional dependencies automatically:

| Dependency | Required? | Auto-installed? |
|-----------|-----------|-----------------|
| jq | Yes | Yes (via Homebrew or apt-get) |
| sqlite3 | Yes | Included with macOS |
| HumanLayer CLI | Yes | Yes (via pip) |
| GitHub CLI (gh) | Optional | Opens install page |
| Linearis CLI | Optional | Shows npm install command |
| agent-browser | Optional | Shows npm install command |
| Bun | Optional | For orch-monitor dashboard |
| direnv | Recommended | Per-project env vars, API key isolation |

## Run the Setup Script

```bash
curl -O https://raw.githubusercontent.com/coalesce-labs/catalyst/main/setup-catalyst.sh
chmod +x setup-catalyst.sh
./setup-catalyst.sh
```

The script will:

- Verify platform (macOS) and check/install prerequisites (HumanLayer, jq, sqlite3)
- Set up a thoughts repository (one per org)
- Create project configuration
- Configure worktree directories
- Initialize the SQLite session database (`~/catalyst/catalyst.db`)
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

## Keeping Plugins Up to Date

Catalyst plugins are updated frequently. There are two ways to stay current.

### Automatic Updates

Claude Code checks for plugin updates at session start. If a new version has been released, it pulls the update automatically. You just need to restart Claude Code (exit and reopen, or start a new session) to load the new version.

To confirm auto-updates are working, your plugins should show as installed from the marketplace:

```bash
/plugins
```

### Manual Updates

If you want to pull the latest right now — for example, a release just dropped — you can force an update:

```bash
# Fetch latest from the marketplace
/plugins update

# Restart Claude Code to load the new version
```

### Checking Versions

```bash
# See installed plugins and current versions
/plugins
```

Compare against the latest releases:

- [Documentation — Changelogs](https://catalyst.coalescelabs.ai/changelog/catalyst-dev/) — per-plugin changelogs on the docs site
- [GitHub Releases](https://github.com/coalesce-labs/catalyst/releases) — release notes with full commit history

## Next Steps

- [Configuration](/reference/configuration/) — Two-layer config system, secrets management, and schema reference
- [Development Workflow](/reference/workflows/) — Walk through the research-plan-implement cycle
- [Multi-Project Setup](/getting-started/multi-project/) — Managing multiple clients or projects
