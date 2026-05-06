---
title: Setup Health Check
description: Validate your Catalyst installation and automatically fix common issues.
sidebar:
  order: 6
---

The `/catalyst-dev:setup-catalyst` skill validates your full Catalyst environment and automatically
fixes what it can. Use it for new installs, after upgrades, or when something isn't working.

## Running the Health Check

In Claude Code:

```
/catalyst-dev:setup-catalyst
```

The skill runs the diagnostic script, fixes auto-fixable issues, then verifies the fixes.

### Outside Claude Code

If you need to run the diagnostic script directly (for troubleshooting without Claude Code):

```bash
bash plugins/dev/scripts/check-setup.sh
```

Or if you installed via the plugin marketplace:

```bash
bash ~/.claude/plugins/cache/catalyst/catalyst-dev/*/scripts/check-setup.sh
```

## What It Checks

### Catalyst CLI Install

The script checks that `~/.catalyst/bin/` exists and that all symlinks inside it resolve to their
targets. The following CLIs are installed as symlinks:

| CLI | Purpose |
|-----|---------|
| `catalyst-comms` | Agent coordination channels |
| `catalyst-session` | Session lifecycle tracking |
| `catalyst-state` | Global orchestrator state |
| `catalyst-db` | SQLite database operations |
| `catalyst-monitor` | orch-monitor start/stop/status |
| `catalyst-thoughts` | HumanLayer thoughts shortcuts |
| `catalyst-claude` | Claude Code wrapper with context injection |

If `~/.catalyst/bin` is not on your `PATH`, the check prints the one line to add to your shell
profile:

```bash
export PATH="$HOME/.catalyst/bin:$PATH"
```

Note: `catalyst-events` is not yet wired into `install-cli.sh`'s `CLI_NAMES` array. Until it is,
run it via the full path: `plugins/dev/scripts/catalyst-events`.

### Tools

Required CLIs (Git, jq, sqlite3, gh, humanlayer, linearis) and optional tools (agent-browser,
sentry-cli, bun, direnv).

### Catalyst Directory

The `~/catalyst/` directory structure: database files, worktree root (`wt/`), event logs
(`events/`).

### Session Database

Whether `~/catalyst/catalyst.db` exists, has all tables, is on the correct schema migration, and
has WAL mode enabled.

### Project Config

Whether `.catalyst/config.json` exists in the current directory with the required fields:
`projectKey`, `ticketPrefix`, `teamKey`, and `stateMap`.

### Secrets Config

Whether `~/.config/catalyst/config-{projectKey}.json` exists and has API tokens configured.

### Observability Stack (Optional)

Whether OTel Docker containers are running and reachable. This is entirely optional — Catalyst
works without observability. If not configured, the check notes it and points to the
[claude-code-otel](https://github.com/ryanrozich/claude-code-otel) repo to set it up.
Automatically detects remapped ports from Docker when configured.

### Orchestration Monitor (Optional)

Whether the orch-monitor web dashboard is running. This check is classified as **`warn`** (not
`info`) when the monitor is not running, because `catalyst-events wait-for` falls back to 600-second
polling intervals when the monitor is absent — significantly increasing latency for event-driven
skills. The monitor is optional but strongly recommended for orchestration workflows.

If not running, the check shows the command to start it:

```bash
bash plugins/dev/scripts/catalyst-monitor.sh start
```

### Webhook Configuration

Two webhook-related items are verified:

| Check | Source | What it means if absent |
|-------|--------|------------------------|
| `smeeChannel` | Layer 2 (`~/.config/catalyst/config.json`) | No smee tunnel — monitor falls back to 10-min polling |
| `webhookId` (Linear) | Layer 2 (`~/.config/catalyst/config-<projectKey>.json`) | Linear events not registered — monitor won't receive Linear webhook deliveries |

Run `plugins/dev/scripts/setup-webhooks.sh` to provision both. See
[Webhook Pipeline Setup](/observability/webhooks/) for the full setup guide.

### direnv

Whether direnv is installed, library functions (`profiles.sh`, `otel.sh`) exist, profile `.env`
files are present, and the current project has a valid `.envrc`.

### Thoughts System

Whether `thoughts/` is initialized with the required subdirectories and linked to a HumanLayer
profile.

### CLAUDE.md

Whether the project has a `CLAUDE.md` with the Catalyst workflow snippet.

## Auto-Fixed Issues

The skill automatically fixes these without asking:

| Issue | Fix |
|-------|-----|
| Missing `~/catalyst/` directories | Creates `wt/`, `events/`, `history/` |
| Missing or incomplete database | Runs `catalyst-db.sh init` |
| WAL mode not set | `PRAGMA journal_mode=WAL` |
| Missing `thoughts/shared/` subdirectories | Creates `research/`, `plans/`, `handoffs/`, `prs/`, `reports/` |

## Issues Requiring Manual Action

These need your input — the skill tells you exactly what to do:

| Issue | What to do |
|-------|-----------|
| Missing CLI tools | Install commands are shown (e.g., `brew install jq`) |
| Missing API tokens | Add to `~/.config/catalyst/config-{projectKey}.json` |
| No project config | Run `setup-catalyst.sh` or create `.catalyst/config.json` manually |
| direnv not installed | `brew install direnv` + shell hook setup |
| OTel not configured (optional) | See [claude-code-otel](https://github.com/ryanrozich/claude-code-otel) |

## Exit Codes

When running the script directly:

- **0** — All checks passed (warnings are OK)
- **N > 0** — N failures found (things that need fixing)
