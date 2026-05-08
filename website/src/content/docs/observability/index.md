---
title: Observability Overview
description: Understand what your Claude Code agents are doing — OpenTelemetry instrumentation, the orch-monitor web dashboard, the terminal UI, and SSE event streams.
sidebar:
  order: 0
---

Catalyst ships with an **agent observability stack** so you can see what autonomous workers are doing in real time — which phase they're in, whether their PR is still open, whether their process is still alive, and how long each phase took.

The stack has these layers:

| Layer | What it does | Where it runs |
|-------|--------------|---------------|
| **Instrumentation** | Claude Code emits OTLP telemetry (events, metrics, logs) via `claude-code-otel` | Per-worker, in the Claude Code process |
| **Signal files + global state** | Workers write JSON status to `workers/<ticket>.json`; orchestrator aggregates into `~/catalyst/state.json` | Filesystem |
| **Event log** | Append-only JSONL at `~/catalyst/events/YYYY-MM.jsonl` — canonical OTel-shaped envelopes from webhooks, comms, sessions, and OTel emit scripts | Filesystem |
| **`catalyst-broker` daemon** (CTL-303) | Semantic event broker — tails the event log and emits targeted `filter.wake.<id>` events for registered orchestrators and workers. Supports deterministic `pr_lifecycle` / `ticket_lifecycle` routing and Groq-backed prose routing. Tracks agent identity via `agent.checkin` / `agent.checkout` | Single Bun process |
| **`catalyst-otel-forward` daemon** (CTL-306) | Tail-and-forward daemon that ships canonical events to OTLP/HTTP, PostHog, and Cloudflare Analytics Engine | Single Bun process |
| **`orch-monitor` web dashboard** | Aggregates signal files, polls GitHub, serves a live web UI with SSE event streams | Single Bun process |
| **`catalyst-hud` Ink TUI** (CTL-312) | Ink-based React terminal renderer with scrollback, filter, detail pane, and trace pivot | Terminal |
| **`catalyst-hud-classic` ANSI fallback** | Pure-bash ANSI renderer for environments where the full Ink HUD cannot run | Terminal |

## What You'll See

When you run a `/catalyst-dev:orchestrate` wave, the observability stack lets you answer:

- Is the worker's Claude process still alive? (PID liveness check every 5s)
- What phase is it in — researching, planning, implementing, validating, shipping?
- How long has the PR been open? How long from open to merged?
- Did CI pass, fail, or is it still running?
- Are there unresolved review threads blocking merge?
- Where is the wave stuck — which ticket, which phase, for how long?

All of this is visible **without tailing logs or attaching to the Claude session**.

## Quick Start

If you just want to get the dashboard running for an active orchestrator:

```bash
# In a separate terminal (from any worktree)
bun run plugins/dev/scripts/orch-monitor/server.ts
# Dashboard: http://localhost:7400
```

The server watches `~/catalyst/wt/` for orchestrator directories (matching `orch-*`) and reads their signal files automatically.

For headless environments, pass `--terminal` to get an ANSI-rendered view in the same process:

```bash
bun run plugins/dev/scripts/orch-monitor/server.ts --terminal
```

## Deeper Dives

- [Setting up the OTel stack](./setup/) — instrument Claude Code with `claude-code-otel` for full OpenTelemetry export
- [Making agents record data properly](./recording/) — shell wrapper, resource attributes, environment variables
- [Using the web monitor](./monitor/) — dashboard walkthrough, API endpoints, filters
- [GitHub webhooks for orch-monitor](./webhooks/) — sub-5-second PR / review / deployment updates via smee.io tunnel
- [`catalyst-hud` Ink TUI](./hud/) — terminal HUD with scrollback, filter, detail pane, and trace pivot (`terminal.md` is now the classic-only fallback)
- [`catalyst-hud-classic` ANSI renderer](./terminal/) — pure-bash ANSI fallback for SSH-from-iPad and minimal-deps environments
- [Event architecture](./events/) — how SSE streams and the global event log fit together
- [catalyst-events CLI](./catalyst-events/) — command reference and jq filter cookbook for the event log
- [Event flow — GitHub to worker](./event-flow/) — end-to-end: how a GitHub push becomes a `wait-for` wake
- [Semantic event routing (`catalyst-broker`)](./catalyst-broker/) — daemon that routes raw events to workers and orchestrators via deterministic and Groq-backed matching
- [Event forwarder (`catalyst-otel-forward`)](./forwarder/) — ship canonical events to OTLP/HTTP, PostHog, and Cloudflare Analytics Engine
- [Agent communication (`catalyst-comms`)](../reference/catalyst-comms/) — how workers coordinate with each other across worktrees

## When Not to Enable Observability

The OTel stack adds process startup overhead and network I/O. For single-ticket, single-session work — just running `/catalyst-dev:oneshot` or manual phase-by-phase skills — you usually don't need it. Observability becomes essential when:

- You run `/catalyst-dev:orchestrate` with multiple workers in parallel
- You want post-hoc phase timelines (Gantt-style) for retros
- You need to page an on-call human when a worker stalls
- You're debugging reward-hacking or verification failures across many runs

For everything else, the default **signal file + global state** layer is enough — no external infrastructure required.
