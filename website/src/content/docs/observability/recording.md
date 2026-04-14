---
title: Recording agent data
description: Make sure workers record the right resource attributes and signal-file updates for observability.
sidebar:
  order: 2
---

With the OTel stack running (see [Setting up the OTel stack](../setup/)), every Claude Code session emits telemetry. But telemetry is only useful if you can filter it to **the orchestrator** and **the ticket** you care about. Catalyst makes this work through two mechanisms:

1. **Resource attributes** — a shell wrapper injects `orchestrator.id`, `worker.ticket`, and `project.key` into every session's OTLP resource
2. **Signal files** — each worker writes progress JSON that the orch-monitor reads independently of OTel

Both layers are redundant on purpose: if OTel fails, signal files still work. If signal files get stale (worker crashed), OTel telemetry still flows.

## The Shell Wrapper

When the orchestrator dispatches a worker via `humanlayer launch`, it wraps the command in a shell script that exports Catalyst-specific resource attributes:

```bash
# Simplified version — the real one is in plugins/dev/skills/orchestrate/
export OTEL_RESOURCE_ATTRIBUTES="\
service.name=claude-code,\
orchestrator.id=${ORCH_ID},\
worker.ticket=${TICKET_ID},\
project.key=${PROJECT_KEY},\
user.id=${USER}"

exec humanlayer launch \
  --model opus \
  --title "oneshot ${TICKET_ID}" \
  "/catalyst-dev:oneshot ${TICKET_ID} --auto-merge"
```

The `OTEL_RESOURCE_ATTRIBUTES` env var is picked up by the Claude Code OTel exporter and added to every telemetry batch. Downstream (Prometheus, Loki, Tempo) it's queryable as a label.

### What each attribute means

| Attribute | Set by | Example | Purpose |
|-----------|--------|---------|---------|
| `service.name` | Claude Code | `claude-code` | Distinguishes Catalyst traffic from other OTel sources |
| `orchestrator.id` | Shell wrapper | `orch-2026-04-14-abc123` | Groups all workers in one wave |
| `worker.ticket` | Shell wrapper | `CTL-48` | Per-worker filter |
| `project.key` | Shell wrapper | `CTL` | Cross-orchestrator project view |
| `session.id` | Claude Code | UUID | Unique per `claude` invocation |
| `user.id` | Shell wrapper | `ryan` | Multi-user environments |

## Signal Files

Independent of OTel, every worker writes a signal file at `<orchestrator-dir>/workers/<ticket>.json`. The orchestrate skill documents the schema — the key fields for observability are:

```json
{
  "ticket": "CTL-48",
  "status": "implementing",
  "phase": 3,
  "startedAt": "2026-04-14T18:37:51Z",
  "updatedAt": "2026-04-14T19:15:32Z",
  "lastHeartbeat": "2026-04-14T19:15:32Z",
  "phaseTimestamps": {
    "researching": "2026-04-14T18:40:12Z",
    "planning": "2026-04-14T18:52:44Z",
    "implementing": "2026-04-14T19:03:01Z"
  },
  "pr": {
    "number": 123,
    "url": "https://github.com/...",
    "ciStatus": "pending",
    "prOpenedAt": "2026-04-14T19:15:30Z",
    "autoMergeArmedAt": "2026-04-14T19:15:32Z",
    "mergedAt": null
  },
  "pid": 63709
}
```

The `phaseTimestamps` map is how the monitor builds a Gantt chart — each time a worker transitions status, it appends the new phase and its timestamp. Terminal states (`done`, `failed`, `stalled`) also set `completedAt`.

### Heartbeats

During long-running phases, workers update `lastHeartbeat` every ~60s so the monitor knows they're alive even if no status change happened. The orch-monitor treats a worker as stalled if `now - lastHeartbeat > 15 minutes` — but it never auto-restarts. Stalled workers raise an `attention` entry in the global state for human decision.

### PID liveness

The signal file records `pid` when the worker starts. The orch-monitor runs `kill -0 <pid>` every 5 seconds. If the PID is gone but the signal file doesn't say `done` or `failed`, the monitor marks the worker as **dead** with a `!` indicator — this catches silently crashed workers that stopped updating their own signal file.

## Global Event Log

The third source of truth is `~/catalyst/events.jsonl` — an append-only log of events across all orchestrators. Events are emitted by `catalyst-state.sh event` with schema:

```json
{"ts":"2026-04-14T19:15:32Z","orchestrator":"orch-...","worker":"CTL-48","event":"worker-pr-created","detail":{"pr":123,"url":"..."}}
```

Event types:

- `orchestrator-started`, `orchestrator-completed`, `orchestrator-stalled`
- `wave-started`, `wave-completed`
- `worker-status-change`, `worker-pr-created`, `worker-done`, `worker-failed`
- `verification-started`, `verification-passed`, `verification-failed`
- `attention-raised`, `attention-resolved`

The events.jsonl log is what backs the `/events` SSE stream exposed by the orch-monitor HTTP server — see [Event architecture](../events/) for how that flows to connected frontends.

## Verifying Everything Is Wired

Run a throwaway orchestration and check each layer:

```bash
# 1. Resource attributes flowing to OTel
docker compose logs -f otel-collector | grep orchestrator.id

# 2. Signal file being updated
watch -n 5 'cat ~/catalyst/wt/<orch-dir>/workers/<ticket>.json | jq .status'

# 3. Global events appending
tail -f ~/catalyst/events.jsonl

# 4. Orch-monitor SSE stream
curl -N http://localhost:7400/events
```

If any of these is silent while the others are flowing, you've isolated where the problem is.
