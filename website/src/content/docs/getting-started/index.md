---
title: Install Catalyst
description: Get Catalyst installed and running in your project in about five minutes.
sidebar:
  order: 2
---

Get Catalyst installed and running in about five minutes.

## What you need first

- **macOS** — Catalyst is built and tested on macOS only.
- **Claude Code** — [install it](https://docs.anthropic.com/en/docs/claude-code) before you start.
- **Git** — needed to detect your repo and run the thoughts system.

The setup script installs the rest for you: `jq`, `sqlite3`, the HumanLayer CLI, and Bun (the runtime behind the dashboard and broker). It also offers to set up optional tools — the GitHub CLI (`gh`), the Linearis CLI, `agent-browser`, and `direnv`.

## 1. Run the setup script

```bash
curl -O https://raw.githubusercontent.com/coalesce-labs/catalyst/main/setup-catalyst.sh
chmod +x setup-catalyst.sh
./setup-catalyst.sh
```

It checks your platform, installs the prerequisites, creates your project config, sets up a shared thoughts repository, and asks for any API tokens (like Linear).

## 2. Install the plugin

In Claude Code:

```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-dev
```

Restart Claude Code after installing.

## 3. Install the command-line tools

Several Catalyst features call shell tools by name (`catalyst-monitor`, `catalyst-hud`, `catalyst-events`, and more). Install them onto your PATH:

```bash
bash ~/.claude/plugins/cache/catalyst/catalyst-dev/*/scripts/install-cli.sh
```

They install to `$HOME/.catalyst/bin`. If that folder isn't on your PATH, the installer adds it to your shell's startup file. Open a new terminal to pick up the change, then check it worked:

```bash
which catalyst-events
catalyst-events help
```

## 4. Add Catalyst to your project

Copy the Catalyst snippet into your project's `CLAUDE.md` so Claude Code knows the available workflows:

```bash
cat plugins/dev/templates/CLAUDE_SNIPPET.md >> .claude/CLAUDE.md
```

## 5. Try it

Start a Claude Code session and run:

```
/research-codebase
```

Follow the prompts. Catalyst spawns helper agents, documents what your code does, and saves the findings to `thoughts/shared/research/`.

## Optional plugins

Catalyst is a set of plugins. Install only what you need:

```bash
/plugin install catalyst-pm           # product strategy
/plugin install catalyst-pm-ops       # cycle, backlog, and cadence ops
/plugin install catalyst-analytics    # PostHog analytics
/plugin install catalyst-debugging    # Sentry error monitoring
/plugin install catalyst-meta         # workflow discovery
```

See [Plugins](/reference/plugins/) for what each one does.

## Keeping plugins up to date

Claude Code checks for plugin updates when a session starts and pulls them automatically. Restart Claude Code to load a new version. To force an update now:

```bash
/plugins update
```

Check your installed versions any time with `/plugins`.

## Next steps

- [How Catalyst works](/getting-started/how-catalyst-works/) — the autonomous loop, end to end
- [Configuration](/reference/configuration/) — the settings Catalyst reads
