---
title: Terminal Renderer (catalyst-hud-classic)
description: Pure-bash ANSI fallback renderer for environments where the full Ink-based catalyst-hud cannot run.
sidebar:
  order: 9
---

`catalyst-hud-classic` is a pure-bash ANSI renderer for environments where the full
Ink-based [`catalyst-hud`](./hud/) cannot run — SSH from iPad, minimal-deps boxes,
locked-down CI. For day-to-day use, prefer [`catalyst-hud`](./hud/).

## Running it

```bash
catalyst-hud-classic
```

The installed symlink is the canonical entry point. If you need the legacy server-driven
mode (the `--terminal` flag on the orch-monitor server itself), invoke the monitor wrapper
directly:

```bash
bash plugins/dev/scripts/catalyst-monitor.sh start --terminal
```

This:

- Clears the screen and draws a compact 80-column dashboard
- Subscribes to the same SSE event stream that powers the web UI
- Redraws on every `worker-update`, `liveness-change`, or `pr-update` event
- Still runs the HTTP server on port 7400 — you get web access simultaneously

Quit with `q` or `Ctrl-C`.

## What it shows

```
┌─ orch-2026-04-14-abc123 ────────────── wave 2/3 ──┐
│ dispatched: 0  running: 2  pr-created: 3  done: 1 │
│ attention: 0                        cost: $2.47   │
├────────────────────────────────────────────────────┤
│ CTL-42  done           ✓  pr#118  merged   34m 12s │
│ CTL-43  done           ✓  pr#119  merged   29m  4s │
│ CTL-44  monitor-merge  ✓  pr#120  passing  12m 38s │
│ CTL-45  implement      ✓                    8m 22s │
│ CTL-46  verify         ✓                    4m 01s │
│ CTL-48  research       !                    1m 15s │  ← dead PID
└────────────────────────────────────────────────────┘
Events (most recent first):
  19:15:32  CTL-44  phase.pr.complete.CTL-44             pr#120 opened
  19:14:01  CTL-46  phase.implement.complete.CTL-46      → verify dispatched
  19:13:44  CTL-48  worker-failed                        crashed — PID gone
  19:13:10  CTL-45  phase.plan.complete.CTL-45           → implement dispatched
```

The example above is a `dispatchMode = "phase-agents"` run — the status column carries the
canonical phase name (CTL-452) and the event stream surfaces
`phase.<name>.complete.<TICKET>` directly. Under `dispatchMode = "oneshot-legacy"` the same
columns instead show the oneshot status names (`researching`, `validating`, `pr-created`,
etc.) and v1 envelope events (`worker-pr-created`, `worker-phase-advanced`). Both modes feed
the same SSE event stream — the renderer is mode-agnostic.

Color coding matches the web UI: blue for in-progress phases, green for done, red for
failed/dead, amber for verify/review/monitor-merge (oneshot equivalents: validating/shipping).

## When to prefer classic over the Ink HUD

| Situation | Why classic |
|-----------|-------------|
| SSH from iPad / iOS terminal app where Ink's input handling misbehaves | Pure ANSI, no `readline` quirks |
| Minimal-deps box where you can't install Bun + Node + Ink | Bash + standard `tput` only |
| Locked-down CI where binary downloads are blocked | Ships as text in the plugin |
| Low-bandwidth remote session | ANSI is tiny vs Ink's screen-redraw payloads |
| You just want "is it done yet?" at a glance | Redraws on every event |

The Ink HUD is richer — scrollback, regex filter, detail pane, trace pivot, canonical
SVC/SEV/TRACE columns — but for read-only "is my wave still healthy?" checks from a
constrained environment, the classic view is sufficient.

## Differences from the Ink HUD

The classic renderer is intentionally a smaller surface than `catalyst-hud`:

- **No scrollback.** The dashboard redraws the visible window; events scroll off the top.
  Use `tail -f ~/catalyst/events/$(date -u +%Y-%m).jsonl` in a separate pane for
  persistent scroll.
- **No filters.** The classic renderer shows all active orchestrators. Use the web UI's
  URL filters (`?orch=...`) or the Ink HUD's filter pane if you need to isolate one wave.
- **80-column assumption.** Narrower terminals will clip the ticket/status columns. Widen
  your pane or switch to the web UI.
- **No trace pivot.** Use the Ink HUD or the web UI to pivot from an event to its
  enclosing trace.

## Non-interactive snapshot

If you just want a one-shot dump (no live updates), use the JSON API instead:

```bash
curl -s http://localhost:7400/api/snapshot | jq
```

That gives you a machine-readable snapshot suitable for piping into scripts, cron jobs, or
other monitoring systems.
