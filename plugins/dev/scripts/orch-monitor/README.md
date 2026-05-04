# orch-monitor

A local websocket server + React UI that visualises Catalyst orchestrator runs: active orchestrators, workers, phase timelines, event logs, cost and token usage, detail drawers.

The server (`server.ts`) watches `~/catalyst/state.json` and the event stream, and broadcasts snapshots to the browser. The UI (`ui/`) is a Vite + React 19 + Tailwind app that renders those snapshots.

## Running locally

```
bun run dev:ui     # Vite dev server for the UI (http://localhost:5173 → proxies to server)
```

The server is started out-of-band (see `server.ts` and the wrapper script in `plugins/dev/scripts/`). The UI assumes the server is reachable at `http://localhost:7400`.

## Committing UI changes

When modifying anything in `ui/`, run a production build and commit the regenerated bundle alongside the source:

```
bun run build:ui
```

This rewrites `public/index.html` with fresh `public/assets/index-*.{js,css}` references. The committed `public/index.html` must always point to a bundle that exists in `public/assets/`, otherwise the static-asset tests in `server.test.ts` and `ui-features.test.ts` go red.

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
        "webhookSecretEnv": "CATALYST_WEBHOOK_SECRET",
        "watchRepos": []
      }
    }
  }
}
```

Override the channel without editing the config: `CATALYST_SMEE_CHANNEL=https://smee.io/...`.

### Persistent watch list

Add `watchRepos` to subscribe to repos at daemon startup regardless of whether a worker has been observed for them — useful when running orch-monitor as a continuous background activity feed for your core repos. Use the helper to add entries:

```bash
plugins/dev/scripts/setup-webhooks.sh --add-repo coalesce-labs/catalyst
```

Empty/missing → auto-discovery only. See the website docs for the full setup flow: [GitHub webhooks for orch-monitor — Persistent watch list](https://github.com/coalesce-labs/catalyst/blob/main/website/src/content/docs/observability/webhooks.md#persistent-watch-list).

### What the monitor does on startup

1. Reads `monitor.github` config — if absent or the secret is missing, the receiver is disabled and the daemon falls back to 10-min polling
2. Starts the smee tunnel toward `http://localhost:{port}/api/webhook`
3. Subscribes to each repo in `watchRepos` (Layer 1) before replay runs, so configured repos get the 1-hour replay too
4. For each `(owner, repo)` observed in worker signal files, creates or reuses a webhook subscription — deduped against step 3
5. On startup, replays the last hour of deliveries from `gh api repos/{repo}/hooks/{id}/deliveries` so events missed during downtime are reconciled
6. Every accepted webhook event is also fanned out to `~/catalyst/events/YYYY-MM.jsonl` for downstream consumers (UI activity feed, future `catalyst-events` CLI)

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

### Linear webhooks (CTL-210)

The monitor also accepts Linear events at `POST /api/webhook/linear` when `monitor.linear.webhookSecretEnv` is configured:

```bash
plugins/dev/scripts/setup-webhooks.sh --linear-secret-env CATALYST_LINEAR_WEBHOOK_SECRET
export CATALYST_LINEAR_WEBHOOK_SECRET=<your-linear-webhook-signing-secret>
```

Linear webhooks must be registered manually via Linear's GraphQL API (no `gh api` equivalent). See the [website docs](https://github.com/coalesce-labs/catalyst/blob/main/website/src/content/docs/observability/webhooks.md#linear-webhooks) for the `webhookCreate` mutation.

Topics emitted to the unified event log:

| Linear `type` + action | Topic |
|---|---|
| `Issue` create / update (state, priority, assignee, generic) / remove | `linear.issue.created` / `linear.issue.{state,priority,assignee}_changed` / `linear.issue.updated` / `linear.issue.removed` |
| `Comment` create / update / remove | `linear.comment.{created,updated,removed}` |
| `Cycle` create / update / remove | `linear.cycle.{created,updated,removed}` |
| `Reaction` create / remove | `linear.reaction.{created,removed}` |
| `IssueLabel` create / update / remove | `linear.issue_label.{created,updated,removed}` |

The signing scheme differs from GitHub's: Linear sends a bare hex digest in the
`Linear-Signature` header (no `sha256=` prefix), and uses `Linear-Delivery` as the
idempotency header.

### Event log consumption (CTL-210)

Long-lived consumers (orchestrators, the dashboard, operator shells) tail the unified event log via `catalyst-events tail --filter <jq>`. Short-lived `claude -p` workers block on `catalyst-events wait-for --filter <jq> --timeout <sec>` until a matching event arrives. See the `monitor-events` skill (`plugins/dev/skills/monitor-events/SKILL.md`) for the canonical patterns and the safety-net rule (every wait MUST be paired with an authoritative one-shot check, since daemon-down means no webhook events).

### Deploy verification (CTL-211)

The orchestrator's Phase 4 loop drives a production-deploy state machine for repos that opt in via `catalyst.deploy.<repo>.skipDeployVerification: false`. Lifecycle:

```
worker exits → merging → (orchestrator: gh pr view) → MERGED?
   → skipDeployVerification=true → done (today's behavior)
   → skipDeployVerification=false → merged
        → github.deployment.created (production env, merge SHA) → deploying
        → github.deployment_status.success → done
        → github.deployment_status.failure | error → deploy-failed
        → timeoutSec elapsed → stalled (with comms.attention)
```

The dashboard renders these states in a Deploy column. Per-repo configuration (timeoutSec, productionEnvironment, etc.) lives in `.catalyst/config.json` under `catalyst.deploy.<repo>` — see [Deploy Verification](https://github.com/coalesce-labs/catalyst/blob/main/website/src/content/docs/reference/configuration.md#deploy-verification-ctl-211) for the schema.

The Linear ticket fetcher is also event-driven (CTL-211): `linear.issue.*` webhook events trigger an on-demand cache refresh for the affected ticket, in addition to the 5-minute polling fallback.

[shadcn]: https://ui.shadcn.com
