---
title: Setting up the OTel stack
description: Install and configure the claude-code-otel stack to export OpenTelemetry telemetry from every Claude Code session.
sidebar:
  order: 1
---

Catalyst uses [claude-code-otel](https://github.com/ryanrozich/claude-code-otel) to export OpenTelemetry telemetry (events, metrics, logs) from every Claude Code session — including workers dispatched by `/catalyst-dev:orchestrate`.

This page covers setting up the stack itself. For making sure agents record data correctly once the stack is running, see [Recording agent data](../recording/).

## What Gets Exported

When instrumentation is enabled, each Claude Code session emits:

| Telemetry | Examples |
|-----------|----------|
| **Events** | `session_start`, `tool_use`, `tool_error`, `subagent_spawn`, `stop` |
| **Metrics** | Tokens consumed, cache hit rate, cost, tool call counts, duration per phase |
| **Logs** | Stderr/stdout of shell tools, agent final messages |
| **Resource attributes** | `service.name`, `session.id`, `user.id`, `project.key`, `orchestrator.id`, `worker.ticket` |

The resource attributes are what make multi-worker orchestration queryable — you can filter a Grafana dashboard to one orchestrator's wave and see all its workers side-by-side.

## Stack Components

The reference stack runs entirely locally via docker-compose:

```
Claude Code (OTLP HTTP export) ──> OTel Collector ──┬──> Prometheus  ──> Grafana (metrics)
                                                    ├──> Loki        ──> Grafana (logs)
                                                    └──> Tempo       ──> Grafana (traces)
```

For production use, point the OTel Collector at your hosted backend (Honeycomb, Datadog, Grafana Cloud, etc.) instead of the local Prometheus/Loki/Tempo.

## Installation

### 1. Clone and start the stack

```bash
git clone https://github.com/ryanrozich/claude-code-otel.git
cd claude-code-otel
docker compose up -d
```

This starts:

- OTel Collector on `localhost:4318` (OTLP/HTTP)
- Prometheus on `localhost:9090`
- Loki on `localhost:3100`
- Tempo on `localhost:3200`
- Grafana on `localhost:3000` (admin / admin)

### 2. Configure Claude Code

Set environment variables in your shell profile (`.zshrc`, `.bashrc`, or a tool like direnv):

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
```

Alternatively, if you're running Claude Code in an environment without access to your shell profile (e.g., inside an IDE extension or automated harness), you can set these in Claude Code's `settings.json` (`~/.claude/settings.json`):

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp"
  }
}
```

For session-scoped enablement (only when running orchestration), set them in the orchestrator's launch command instead — see the shell wrapper section in [Recording agent data](../recording/).

### 3. Verify ingestion

Start any Claude Code session, then check the OTel collector's logs:

```bash
docker compose logs -f otel-collector
```

You should see batches of telemetry arriving within ~10 seconds of the first tool use. If not, see [Troubleshooting](#troubleshooting) below.

### 4. Start the orchestration monitor (optional)

The orch-monitor is a web dashboard for watching orchestrators and workers in real time. Start it
with:

```bash
bash plugins/dev/scripts/catalyst-monitor.sh start
```

Or from a plugin marketplace install:

```bash
bash ~/.claude/plugins/cache/catalyst/catalyst-dev/*/scripts/catalyst-monitor.sh start
```

The `start` command checks prerequisites, installs dependencies, builds the frontend, and starts the
server in the background on port 7400 (configurable via `MONITOR_PORT`). Open `http://localhost:7400`
in your browser, or use `catalyst-monitor.sh open` to start and open the browser automatically.

The monitor works without the OTel stack — it reads worker signal files and the SQLite session
database directly. To add OTel metrics and logs to the dashboard, configure it to proxy OTel
queries by creating `~/.config/catalyst/config.json`:

```json
{
  "otel": {
    "enabled": true,
    "prometheus": "http://localhost:9090",
    "loki": "http://localhost:3100"
  }
}
```

This enables the `/api/otel/query` and `/api/otel/logs` endpoints on the monitor server, allowing the dashboard to display metrics and logs alongside signal file data.

Alternatively, set environment variables: `OTEL_ENABLED=true`, `PROMETHEUS_URL`, `LOKI_URL`.

### 5. Start the broker daemon (optional)

`catalyst-broker` (CTL-303) is the semantic event broker — it tails the canonical event log
and emits targeted `filter.wake.<id>` events for registered orchestrators and workers. Skills
that wait for ticket lifecycle changes, PR lifecycle changes, or comms messages register
interests with the broker instead of writing bespoke jq predicates.

```bash
catalyst-broker start
```

Logs are pino-structured (CTL-314) and written to `~/catalyst/broker.log`. Set `LOG_LEVEL`
to control verbosity:

```bash
LOG_LEVEL=info catalyst-broker start    # default
LOG_LEVEL=debug catalyst-broker start   # full trace
```

The legacy `catalyst-filter` command is preserved as a backward-compat shim (CTL-315) and
execs `catalyst-broker` with the same arguments. See
[Semantic event routing (`catalyst-broker`)](./catalyst-broker/) for the full protocol.

### 6. Start the event forwarder (optional)

`catalyst-otel-forward` (CTL-306) is a tail-and-forward daemon that ships canonical events
to OTLP/HTTP, PostHog, and Cloudflare Analytics Engine. Start it via the monitor wrapper:

```bash
bash plugins/dev/scripts/catalyst-monitor.sh forward-start
```

Or run it directly:

```bash
catalyst-otel-forward
```

Logs are pino-structured (CTL-314) and respect `LOG_LEVEL`. See
[Event forwarder (`catalyst-otel-forward`)](./forwarder/) for destination configuration and
DLQ semantics.

### 7. Set up the webhook tunnel

The orch-monitor can receive GitHub and Linear events in near-real-time via a smee.io webhook tunnel. Without this step, skills that use `catalyst-events wait-for` — including `/catalyst-dev:orchestrate` Phase 4, `/catalyst-dev:oneshot` Phase 5, and `/catalyst-dev:wait-for-github` — silently fall back to REST polling with up to **10-minute latency** per event.

With the tunnel configured, the same events arrive within **~1 second** of GitHub or Linear posting them.

Run the setup script once per machine:

```bash
bash plugins/dev/scripts/setup-webhooks.sh
```

This creates a smee.io channel, writes the channel URL to `~/.config/catalyst/config.json`, generates an HMAC secret, and registers a webhook on each repo listed in `catalyst.monitor.github.watchRepos`. See [GitHub webhooks for orch-monitor](../webhooks/) for the full setup guide and configuration reference.

### 8. Import the Grafana dashboard

The claude-code-otel repo ships with a pre-built Grafana dashboard at `dashboards/claude-code.json`. Import it via Grafana → Dashboards → New → Import → Upload JSON file.

The dashboard includes:

- **Session overview** — active sessions, tokens/min, cache hit rate
- **Per-project breakdown** — tokens by `project.key` resource attribute
- **Orchestrator view** — filtered by `orchestrator.id`, shows all workers in one wave
- **Tool use frequency** — which tools agents reach for most often
- **Cost tracking** — $ per session, per worker, per orchestrator

#### Per-project slot-usage gauge (CTL-706)

When `executionCore.perProject` is configured, the scheduler emits a structured log line on every tick:

```
scheduler: per-project slots  { freeSlots: 2, perProject: { ADV: { inFlight: 3, maxParallel: 6, reserve: 2 }, CTL: { inFlight: 1, maxParallel: 4, reserve: 1 } } }
```

Fields in `perProject.<KEY>`:

| Field        | Description |
| ------------ | ----------- |
| `inFlight`   | Workers currently occupying a slot for this project. |
| `maxParallel`| Configured hard cap for this project (omitted when not set). |
| `reserve`    | Configured guaranteed floor for this project (omitted when not set). |

The top-level `freeSlots` is the global free-slot count for that tick. The line is emitted only when at least one project key is configured — runs without `perProject` produce no extra noise.

Recommended Grafana panel: a multi-series gauge showing `inFlight` vs `maxParallel` per project key, filtered to log lines where `msg == "scheduler: per-project slots"` via Loki or a pino JSON log scrape.

## Troubleshooting

### No telemetry arriving

```bash
# 1. Confirm env vars are set in the Claude Code process
claude config --debug  # Look for CLAUDE_CODE_ENABLE_TELEMETRY=1

# 2. Confirm the collector is reachable
curl -v http://localhost:4318/v1/metrics
# Expect: 405 Method Not Allowed (because GET, but proves the port is open)

# 3. Check collector logs for rejected batches
docker compose logs otel-collector | grep -i error
```

### Resource attributes missing

Claude Code sets `service.name=claude-code` automatically, but Catalyst-specific attributes (`orchestrator.id`, `worker.ticket`, `project.key`) are set by the **shell wrapper** — not by Claude Code itself. See [Recording agent data](../recording/).

### Dashboard empty after import

Grafana's Prometheus data source defaults may not match the docker-compose stack's port. In Grafana → Connections → Data sources → Prometheus, set the URL to `http://prometheus:9090` (service name, not localhost, since Grafana runs inside the docker network).

## Opting out

To disable telemetry for a single session without unsetting env vars, run:

```bash
CLAUDE_CODE_ENABLE_TELEMETRY=0 claude
```

To disable globally, remove the env vars from your shell profile.
