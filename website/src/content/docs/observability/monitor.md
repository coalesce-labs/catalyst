---
title: orch-monitor web dashboard
description: Walkthrough of the orch-monitor server — the web UI for watching orchestrators and workers in real time.
sidebar:
  order: 3
---

`orch-monitor` is a Bun-based HTTP server that aggregates worker signal files, receives GitHub and Linear events via webhooks (with polling fallback), and serves a live dashboard with server-sent event streams. One process powers both the web UI and the terminal UI.

![Orchestrator overview showing active waves, completion percentage, total cost, wall clock, and the worker list](https://assets.coalescelabs.ai/images/screenshots/orchestrator-2026-04-17%20at%2008.05.20%402x.png)

*Orchestrator overview — waves, workers, cost, and wall-clock time at a glance.*

## Running the server

The simplest way to start the monitor:

```bash
bash plugins/dev/scripts/catalyst-monitor.sh start
```

Or if you installed via the plugin marketplace:

```bash
bash ~/.claude/plugins/cache/catalyst/catalyst-dev/*/scripts/catalyst-monitor.sh start
```

The `start` command checks prerequisites (bun, sqlite3, catalyst directory), installs dependencies
and builds the frontend if needed, then starts the server in the background. Other commands:

```bash
bash plugins/dev/scripts/catalyst-monitor.sh status   # Check if running
bash plugins/dev/scripts/catalyst-monitor.sh open      # Start + open browser
bash plugins/dev/scripts/catalyst-monitor.sh stop      # Stop the server
```

The server:

- Starts HTTP on port `7400` (configurable via `MONITOR_PORT` env var)
- Watches `~/catalyst/wt/` for directories matching `orch-*`
- Reads worker signal files via `fs.watch` — instant updates on change
- Receives PR / review / check-suite / deployment events via [GitHub webhooks](../webhooks/)
  when configured; falls back to a 10-minute poll otherwise
- Runs `kill -0 <pid>` every 5s for each known worker PID

Open `http://localhost:7400` in your browser. No login, no persistence — everything is derived on the fly from the filesystem and GitHub API.

## Dashboard layout

The UI has three rows:

### Row 1 — Orchestrator summary cards

One card per active orchestrator showing:

- Orchestrator ID + project
- Wave count (current / total)
- Worker counts: dispatched / in-progress / pr-created / done / failed
- Attention items count (red badge if > 0)
- Total cost so far (from OTel metrics, if OTel is enabled)

Clicking a card filters the rest of the dashboard to that orchestrator.

### Row 2 — Worker grid

One row per worker showing:

- **Ticket** (click to open Linear)
- **Status** color-coded: gray (dispatched), blue (researching/planning/implementing), amber (validating/shipping), green (done), red (failed)
- **Phase** number (0-6)
- **PR** (click to open GitHub) with CI status dot
- **Liveness** indicator: ✓ (alive), ! (dead PID), ? (no PID recorded yet)
- **Duration** since startedAt
- **Last heartbeat** (red if > 15 min)

![Workers tab showing a tabular list of workers per orchestrator with ticket, status, phase, PR number, cost, tokens, and last-update columns](https://assets.coalescelabs.ai/images/screenshots/workers-09.09.12.png)

*Workers tab — one row per worker with ticket, phase, PR, cost, and activity.*

### Row 3 — Event stream

Real-time event log from `~/catalyst/events.jsonl` and filesystem watches, rendered as a timeline. Filters: event type, worker ticket, orchestrator, date range.

![Timeline tab showing a Gantt-style view with colored phase bars per worker across research, plan, implement, validate, ship, and merged states](https://assets.coalescelabs.ai/images/screenshots/timeline-2026-04-17%20at%2009.08.04.png)

*Timeline tab — phase Gantt bars per worker (research → plan → implement → validate → ship → merged).*

### Worker detail

Click any worker row to open a detail drawer with the phase timeline, PR metadata, and the live activity feed for that ticket.

![Worker detail drawer open on the right showing phase timeline, PR info, and a streaming activity feed for a single worker](https://assets.coalescelabs.ai/images/screenshots/worker-detail-9.06.34%402x.png)

*Worker detail — drill into a single ticket for its phase timeline, PR state, and activity feed.*

## API endpoints

The monitor exposes a JSON API for programmatic access:

| Endpoint | Description |
|----------|-------------|
| `GET /api/snapshot` | Full current state of all orchestrators, workers, and PR statuses |
| `GET /api/analytics` | Extended analytics including phase timelines (Gantt data) and cost breakdowns |
| `GET /events` | SSE stream — events: `snapshot`, `worker-update`, `liveness-change`, `pr-update` |

Quick CLI status check:

```bash
curl -s http://localhost:7400/api/snapshot \
  | jq '.orchestrators[].workers | to_entries[] | {ticket: .key, status: .value.status, pr: .value.pr?.number}'
```

Stream all events to stdout:

```bash
curl -N http://localhost:7400/events
```

## Filters

The web UI supports URL-based filters that persist when you reload:

- `?orch=orch-abc123` — show only one orchestrator
- `?status=failed,stalled` — only workers in attention-worthy states
- `?project=CTL` — filter by project key

You can share a filtered URL with someone else running the same monitor — the state is all in the URL.

## What the monitor does NOT do

- **No persistence** — close the server, lose the history (events.jsonl is the durable store)
- **No auth** — bind to localhost only. For team access, put it behind a reverse proxy with its own auth.
- **No writes** — the monitor is read-only. Remediation (re-dispatch, mark failed, merge PR) still happens via skills.

## Troubleshooting

**Dashboard shows workers as "dead" but they're still running**:

The PID-liveness check uses `kill -0 <pid>`. If the worker is running under a different user, the check fails. The worker is actually alive — the monitor just can't see it. Additionally, the monitor can tail the worker's stream-json output file (`workers/<ticket>-stream.jsonl`) to see real-time tool calls and progress.

**PR status says "merged" but the signal file says "pr-created"**:

This is expected and intentional. The worker subprocess reliably exits at its last tool-use, before merge completes. The orchestrator (or the monitor itself) is the authoritative source for `pr.mergedAt`. The signal-file `status` stays at `pr-created` until the orchestrator updates it.

**Monitor misses an orchestrator**:

The monitor globs `~/catalyst/wt/*/workers/` — if your orchestrator is at a non-standard path, export `CATALYST_WT_ROOT=/custom/path` and restart the server.
