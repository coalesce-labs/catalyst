---
title: Terminal UI
description: When you want the orch-monitor view without a browser — ANSI-rendered, compact, and streams in-place.
sidebar:
  order: 4
---

The orch-monitor ships with an ANSI terminal renderer for headless environments, SSH sessions, tmux panes, or quick status checks without opening a browser.

## Running it

```bash
bun run plugins/dev/scripts/orch-monitor/server.ts --terminal
```

This flag:

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
│ CTL-42  done        ✓   pr#118  merged    34m 12s │
│ CTL-43  done        ✓   pr#119  merged    29m  4s │
│ CTL-44  pr-created  ✓   pr#120  passing   12m 38s │
│ CTL-45  implementing ✓                     8m 22s │
│ CTL-46  validating  ✓                      4m 01s │
│ CTL-48  researching !                      1m 15s │  ← dead PID
└────────────────────────────────────────────────────┘
Events (most recent first):
  19:15:32  CTL-44  worker-pr-created       pr#120
  19:14:01  CTL-46  worker-phase-advanced   validating
  19:13:44  CTL-48  worker-failed           crashed — PID gone
```

Color coding matches the web UI: blue for in-progress phases, green for done, red for failed/dead, amber for validating/shipping.

## When to prefer the terminal UI

| Situation | Why terminal |
|-----------|--------------|
| SSH'd into a server, can't port-forward | Browser-free |
| Running in a tmux/screen pane alongside other work | Fits in an 80-column pane |
| You want a CI-style log trail to scroll back through | Events render as append-only text |
| Low-bandwidth remote session | ANSI is tiny vs a websocket-heavy SPA |
| You just want "is it done yet?" at a glance | Redraws on every event |

The web UI is richer — filters, click-through to Linear/GitHub, Gantt view — but for 90% of "is my wave still healthy?" checks, the terminal view is all you need.

## Non-interactive snapshot

If you just want a one-shot dump (no live updates), use the JSON API instead:

```bash
curl -s http://localhost:7400/api/snapshot | jq
```

That gives you a machine-readable snapshot suitable for piping into scripts, cron jobs, or other monitoring systems.

## Known limitations

- **80-column assumption** — narrower terminals will clip the ticket/status columns. Widen your pane or use the web UI.
- **No scrollback** — the dashboard redraws the visible window; events scroll off the top. Use `tail -f ~/catalyst/events.jsonl` in a separate pane for persistent scroll.
- **No filters** — the terminal UI shows all active orchestrators. Use the web UI's URL filters (`?orch=...`) if you have multiple concurrent waves and want to isolate one.
