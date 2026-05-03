# orch-monitor

A local websocket server + React UI that visualises Catalyst orchestrator runs: active orchestrators, workers, phase timelines, event logs, cost and token usage, detail drawers.

The server (`server.ts`) watches `~/catalyst/state.json` and the event stream, and broadcasts snapshots to the browser. The UI (`ui/`) is a Vite + React 19 + Tailwind app that renders those snapshots.

## Running locally

```
bun run dev:ui     # Vite dev server for the UI (http://localhost:5173 → proxies to server)
```

The server is started out-of-band (see `server.ts` and the wrapper script in `plugins/dev/scripts/`). The UI assumes the server is reachable at `http://localhost:7400`.

## UI design

See [`ui/DESIGN.md`](ui/DESIGN.md) for the design language of the monitor — surface tokens, status semantics, spacing, typography, and the policy for when to hand-roll components vs. reach for [shadcn/ui][shadcn] primitives. Read it before adding a new screen, drawer, or component.

[shadcn]: https://ui.shadcn.com

## Webhook configuration

The monitor receives GitHub events via webhooks tunneled through smee.io. With webhooks enabled, steady-state polling drops from ~26k calls/hr to under 50 calls/hr (CTL-209).

### One-time setup

Use the helper script:

```
plugins/dev/scripts/setup-webhooks.sh
```

It generates a smee.io channel, generates an HMAC secret, and writes both into `.catalyst/config.json`. Then export the secret:

```
export CATALYST_WEBHOOK_SECRET="$(cat ~/.config/catalyst/webhook-secret)"
```

(or set `webhookSecretEnv` in the config to point at a different env var).

### Configuration shape

```json
{
  "catalyst": {
    "monitor": {
      "github": {
        "smeeChannel": "https://smee.io/<channel-id>",
        "webhookSecretEnv": "CATALYST_WEBHOOK_SECRET"
      }
    }
  }
}
```

Override the channel without editing the config: `CATALYST_SMEE_CHANNEL=https://smee.io/...`.

### What the monitor does on startup

1. Reads `monitor.github` config — if absent or the secret is missing, the receiver is disabled and the daemon falls back to 10-min polling
2. Starts the smee tunnel toward `http://localhost:{port}/api/webhook`
3. For each observed `(owner, repo)` (via worker signal files), creates or reuses a webhook subscription on that repo
4. On startup, replays the last hour of deliveries from `gh api repos/{repo}/hooks/{id}/deliveries` so events missed during downtime are reconciled
5. Every accepted webhook event is also fanned out to `~/catalyst/events/YYYY-MM.jsonl` for downstream consumers (UI activity feed, future `catalyst-events` CLI)

### Subscribed events

The monitor subscribes to ten event types per repo:

| Event                         | Used for                                |
|-------------------------------|------------------------------------------|
| `pull_request`                | PR cache + signal-file merge write-through |
| `pull_request_review`         | PR mergeStateStatus refresh             |
| `pull_request_review_thread`  | merge-readiness signal                  |
| `pull_request_review_comment` | preview-link refresh                    |
| `check_suite`                 | mergeStateStatus refresh                |
| `status`                      | (logged; sha→PR resolution via fallback poll) |
| `push`                        | (logged; BEHIND-detection via poll)     |
| `issue_comment`               | preview-link refresh                    |
| `deployment`                  | (logged; preview state via fallback poll) |
| `deployment_status`           | (logged; preview state via fallback poll) |

[shadcn]: https://ui.shadcn.com
