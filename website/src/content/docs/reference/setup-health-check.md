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
| `catalyst-broker` | Local event broker — canonical OTel envelope, agent identity, ticket/PR auto-correlation (CTL-303). Primary CLI as of CTL-315. |
| `catalyst-comms` | Agent coordination channels |
| `catalyst-events` | Event log tail / wait-for / append CLI |
| `catalyst-filter` | Backward-compat shim — delegates to `catalyst-broker` (CTL-315). Existing scripts keep working. |
| `catalyst-session` | Session lifecycle tracking |
| `catalyst-state` | Global orchestrator state |
| `catalyst-db` | SQLite database operations |
| `catalyst-monitor` | orch-monitor start/stop/status (also exposes `forward-status` for the forwarder daemon) |
| `catalyst-thoughts` | HumanLayer thoughts shortcuts |
| `catalyst-claude` | Claude Code wrapper with context injection |
| `register-thought` | Register a path with the thoughts system |
| `workflow-context` | Read/write `.catalyst/.workflow-context.json` |
| `catalyst-hud` | Ink-based React TUI for the live event stream (CTL-308/CTL-311/CTL-312) |
| `catalyst-hud-classic` | Shell fallback for `catalyst-hud` |

If `~/.catalyst/bin` is not on your `PATH`, the check prints the one line to add to your shell
profile:

```bash
export PATH="$HOME/.catalyst/bin:$PATH"
```

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

### Config-template drift (CTL-489)

The health check also detects when `plugins/dev/templates/config.template.json` has keys that
your `.catalyst/config.json` lacks. Missing keys appear as yellow-bullet warnings — the same
visual treatment as the other non-fatal issues:

```text
⚠ WARN: Project setup has issues
  • Missing catalyst.orchestration.dispatchMode in .catalyst/config.json — template suggests "phase-agents"
    Run /catalyst-dev:setup-catalyst to apply the missing key.
```

The walker is `plugins/dev/scripts/check-config-drift.sh`. It strips comment/`$schema` keys,
skips `[YOUR_ORG]`/`[YOUR_REPO]` placeholder branches, and suppresses the five roots that
`check-project-setup.sh` already checks individually (`projectKey`, `project.ticketPrefix`,
`linear.teamKey`, `linear.stateMap`, `linear.stateIds`) so you never see double-warnings.

Run `/catalyst-dev:setup-catalyst` to merge the missing keys interactively. The skill calls
`check-config-drift.sh --merge-into`, shows you a unified diff of the proposed merge, and asks
for confirmation. On `y`, the missing keys are added via `jq` deep-merge — your existing
values are never overwritten. If you have a custom `catalyst.filter.groqModel`, the template's
default is **not** applied to that key.

Drift warnings are non-fatal: they keep appearing on every workflow invocation as passive
nagging until you opt in. The motivator was CTL-487, where catalyst itself spent two months
silently running in `oneshot-legacy` dispatch mode because the new `orchestration.dispatchMode`
key wasn't in any existing project's config.

### Secrets Config

Whether `~/.config/catalyst/config-{projectKey}.json` exists and has API tokens configured.

### Observability Stack (Optional)

Whether OTel Docker containers are running and reachable. This is entirely optional — Catalyst
works without observability. If not configured, the check notes it and points to the
[claude-code-otel](https://github.com/ryanrozich/claude-code-otel) repo to set it up.
Automatically detects remapped ports from Docker when configured.

### Broker Daemon

Whether the `catalyst-broker` daemon (CTL-303) is alive. The check verifies that
`~/catalyst/broker.pid` references a live process and surfaces the broker's status.

```bash
catalyst-broker status
```

The broker's structured (pino) logs are written to `~/catalyst/broker.log`. Set `LOG_LEVEL`
(default `info`) to control verbosity (CTL-314). On first start the broker performs a one-shot
rename from the legacy `~/catalyst/filter-interests.json` to `~/catalyst/broker-interests.json` —
nothing further is required from the user.

### Forwarder Daemon

Whether the `catalyst-otel-forward` daemon (CTL-306) is running. Status is reported through the
monitor wrapper:

```bash
bash plugins/dev/scripts/catalyst-monitor.sh forward-status
```

The forwarder reads `catalyst.observability.forwarders` from
`~/.config/catalyst/config-{projectKey}.json` (or the cross-project fallback) and tails the event
log forward to OTLP, PostHog, and Cloudflare Analytics Engine. It honors `LOG_LEVEL` for pino
output (CTL-314) and `OTEL_EXPORTER_OTLP_ENDPOINT` as an override for OTLP destinations.

### Event Log Envelope

Events written to `~/catalyst/events/YYYY-MM.jsonl` use the canonical OTel-shaped envelope
(CTL-300): `attributes['event.name']` carries the event type, payload sits under
`body.payload.*`, and `traceId` is propagated end-to-end — including on webhook-emitted
canonical events (CTL-310).

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

## Orchestrator Healthcheck Flags

The orchestrator's own healthcheck (`orchestrate-healthcheck`, called periodically by the `/catalyst-dev:orchestrate` skill) is separate from `check-setup.sh`. It exposes two tuning knobs for stall detection:

| Flag | Default | Applies to | Purpose |
|------|---------|------------|---------|
| `--grace-seconds <N>` | `15` | Legacy `oneshot-legacy` workers | After a worker is dispatched, wait this long before its `PID` is checked with `kill -0`. Newly-spawned workers get a brief window to register before being declared dead. |
| `--stale-bg-seconds <N>` | `900` | `phase-agents` workers only | Maximum age (in seconds) of `~/.claude/jobs/<bg_job_id>/state.json` before a `--bg` phase is declared `state-json-stale`. Long-running phases that legitimately exceed this should bump the value via `.catalyst/config.json`. |

Defaults are usually fine. Raise `--stale-bg-seconds` if your `phase-implement` runs routinely exceed 15 minutes (e.g., heavy refactors on a Sonnet model) — the healthcheck will otherwise mark them stalled and consume revive budget. See [Orchestrator overview → Healthcheck + revive](https://github.com/coalesce-labs/catalyst/blob/main/docs/orchestrator-overview.md#healthcheck--revive) for the full state-machine context.
