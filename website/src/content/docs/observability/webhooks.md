---
title: GitHub webhooks for orch-monitor
description: How orch-monitor receives GitHub events in near-real-time via the smee.io tunnel — what to set up, when, and where to configure.
sidebar:
  order: 4
---

`orch-monitor` receives PR, review, check-suite, deployment, and comment events from GitHub
via webhooks tunneled through [smee.io](https://smee.io). This replaces the old 30-second
poll-everything model and reduces steady-state GitHub API usage by ~99% (from ~26,000
calls/hr to under 50 calls/hr at typical worker counts).

When webhooks are enabled, GitHub state changes propagate to the dashboard within seconds
instead of within 30 seconds. Polling stays in place as a 10-minute fallback so missed
events get reconciled within bounded latency.

## What is smee.io?

[smee.io](https://smee.io) is a free webhook proxy run by the Probot project. It gives you
a public URL (`https://smee.io/<channel-id>`) that you can register as a webhook target on
any GitHub repo. The orch-monitor daemon opens a long-lived EventSource connection to that
URL, and any payload GitHub posts there gets forwarded over the connection to your local
`http://localhost:7400/api/webhook` endpoint.

This means:

- **No public ingress required.** Your machine never opens a port to the internet — smee
  pushes events to you over an outbound connection that stays open.
- **No DNS, no TLS termination, no reverse proxy.** Just a smee channel URL and an HMAC
  secret that GitHub signs each delivery with.
- **One channel, many repos.** A single smee channel can receive events from any number of
  GitHub repos. You don't need a channel per repo.

The only third-party in the path is smee itself. It does not log payload bodies (it
forwards them in-flight), but you should not assume privacy on a free public relay — secrets
inside webhook payloads (like environment URLs) traverse smee.

## Setup is per-machine, not per-project

You configure smee **once per machine** that runs orch-monitor. The daemon is
one-process-per-laptop, watching `~/catalyst/wt/` across **every project** (catalyst, adva,
slides, etc.) — so there is exactly one smee tunnel per machine, fanning events in for every
repo it watches. Repository subscriptions are then created automatically on demand: the
daemon registers a webhook on each `(owner, repo)` it observes via worker signal files,
deduping with any existing webhook that already targets the same channel URL.

The channel URL therefore belongs in the **cross-project, per-machine** config file
(`~/.config/catalyst/config.json`), the same place the OTel endpoints live for the same
reason. The env-var **name** (`webhookSecretEnv`) is team-wide and lives in
`.catalyst/config.json`.

| What | Where | Committed | When |
|------|-------|-----------|------|
| smee channel URL | `~/.config/catalyst/config.json` (cross-project, per-machine) or `CATALYST_SMEE_CHANNEL` env | NO | Once at setup |
| `webhookSecretEnv` (env-var name only) | `.catalyst/config.json` (per-repo, team-wide) | YES | Once at setup |
| HMAC secret value | env var named by `webhookSecretEnv` (default `CATALYST_WEBHOOK_SECRET`) | NO (per-developer env) | Once at setup |
| Repo webhook subscription | GitHub repo settings (auto-created via `gh api`) | n/a | Lazily, on first observation of the repo |

**You do not need to add the smee channel to each repo manually.** The daemon does this for
you the first time a worker for that repo runs and is observed by the monitor.

## One-time setup

The fastest way is the helper script:

```bash
plugins/dev/scripts/setup-webhooks.sh
```

It:

1. Calls `curl -L https://smee.io/new` to create a fresh channel (or reuses an existing one
   from `~/.config/catalyst/config.json`, or `CATALYST_SMEE_CHANNEL` if already set)
2. Generates a 32-byte HMAC secret with `openssl rand -hex 32`
3. Writes the secret to `~/.config/catalyst/webhook-secret` (mode 600)
4. Writes `catalyst.monitor.github.smeeChannel` to `~/.config/catalyst/config.json`
   (cross-project, per-machine — never committed)
5. Writes `catalyst.monitor.github.webhookSecretEnv` to `.catalyst/config.json` (committed,
   team-wide — env-var **name** only)
6. Migrates a deprecated `smeeChannel` out of `.catalyst/config.json` if it finds one there
   (one-line console note; commit the resulting diff)

Then export the secret in your shell:

```bash
export CATALYST_WEBHOOK_SECRET="$(cat ~/.config/catalyst/webhook-secret)"
```

Add that line to your `~/.zshrc` / `~/.bashrc` so it persists. Restart orch-monitor and
the webhook tunnel comes up automatically.

## Configuration shape

The webhook config is split across two files because the channel URL is per-machine while
the env-var name is team-wide. This mirrors the [OTel config layout](/reference/configuration/#monitor-otel-config),
where Prometheus and Loki URLs also live in `~/.config/catalyst/config.json` for the same
per-machine reason.

`~/.config/catalyst/config.json` (cross-project, per-machine — never committed):

```json
{
  "catalyst": {
    "monitor": {
      "github": {
        "smeeChannel": "https://smee.io/<channel-id>"
      }
    }
  }
}
```

`.catalyst/config.json` (per-repo, committed, team-wide):

```json
{
  "catalyst": {
    "monitor": {
      "github": {
        "webhookSecretEnv": "CATALYST_WEBHOOK_SECRET"
      }
    }
  }
}
```

Override the channel without editing config (useful for ephemeral debugging):

```bash
CATALYST_SMEE_CHANNEL=https://smee.io/another-channel bun run server.ts
```

If the secret env var is unset or `smeeChannel` is missing from both files, the receiver
disables itself silently and the daemon falls back to 10-minute polling. Nothing breaks; you
just lose the sub-5-second update latency.

### Migration from earlier versions

Earlier `setup-webhooks.sh` runs wrote `smeeChannel` to `.catalyst/config.json` (Layer 1,
committed). That was wrong — the value is per-machine, not per-team. The daemon still reads
that location for one release cycle and emits a one-shot deprecation warning when it does.
To migrate, re-run `setup-webhooks.sh`: it picks up the deprecated value, moves it to
`~/.config/catalyst/config.json`, and removes it from the committed file. Commit the
resulting Layer 1 diff.

## Subscribed events

The daemon subscribes to ten event types per repo. Six drive PR-state updates; four drive
preview-link updates.

| Event                         | What it drives                              |
|-------------------------------|----------------------------------------------|
| `pull_request`                | PR cache + signal-file `done`/`merged` write-through |
| `pull_request_review`         | merge-state recomputation                   |
| `pull_request_review_thread`  | merge-readiness signal                      |
| `pull_request_review_comment` | preview-link refresh                        |
| `check_suite`                 | merge-state recomputation                   |
| `status`                      | logged (sha→PR resolution via 10-min poll)  |
| `push`                        | logged (BEHIND-detection via 10-min poll)   |
| `issue_comment`               | preview-link refresh                        |
| `deployment`                  | logged (preview state via 10-min poll)      |
| `deployment_status`           | logged (preview state via 10-min poll)      |

## What happens on startup

1. The daemon reads `.catalyst/config.json`. If `webhookConfig` is missing, it disables
   the receiver and continues with polling-only.
2. The smee tunnel opens, forwarding `https://smee.io/<channel>` →
   `http://localhost:7400/api/webhook`.
3. For each `(owner, repo)` observed in worker signal files, the daemon calls
   `gh api repos/{repo}/hooks` and creates a webhook (or reuses an existing one whose
   `config.url` matches the smee channel — case-insensitive match).
4. **Replay**: for each subscribed repo, the last hour of webhook deliveries are pulled via
   `gh api repos/{repo}/hooks/{id}/deliveries`, signed synthetically (we own the secret),
   and dispatched through the same handler used for live events. The handler dedupes by
   `X-GitHub-Delivery` so deliveries that raced replay don't double-process.
5. Every accepted webhook event is also appended to
   `~/catalyst/events/YYYY-MM.jsonl` with a topic like `github.pr.merged` —
   see [Event architecture](../events/).

## Verifying it works

After exporting the secret and restarting the daemon, check the log:

```
[webhook-tunnel] connected https://smee.io/<id> → http://localhost:7400/api/webhook
[webhook-subscriber] subscribed to coalesce-labs/catalyst (hook 12345678)
```

Trigger a `pull_request.synchronize` event by pushing to a tracked PR. The dashboard should
update within a few seconds. You can also watch the event log:

```bash
tail -F ~/catalyst/events/$(date -u +%Y-%m).jsonl | jq 'select(.source == "github.webhook")'
```

## Failure modes and recovery

- **smee tunnel drops**: the daemon retries automatically. Up to 60 minutes of missed
  deliveries can be replayed at the next startup; beyond that, polling reconciles state
  within 10 minutes.
- **smee.io is down**: same as above — tunnel reconnect retries; polling fallback keeps the
  daemon functional.
- **HMAC secret rotation**: regenerate via `setup-webhooks.sh --force`, re-export the new
  secret, and restart the daemon. Existing webhooks stay configured against the new secret
  because the subscriber only checks the URL when matching.
- **GitHub returns 401 on hook creation**: the `gh` CLI's stored token doesn't have admin
  access on the repo. Hooks won't be created (logged as a warning) and the daemon falls
  back to polling for that repo only.

## Privacy and trust posture

smee.io is a free third-party relay. It does not persist payloads, but you should treat
the channel URL as a low-grade secret — anyone with it can post events. Mitigations:

- All deliveries are HMAC-SHA256 signed. The handler rejects mismatches with `401`.
- The receiver path never echoes the secret in logs or responses.
- Re-roll the channel + secret periodically by running `setup-webhooks.sh --force`.

If you need higher assurance (regulated environments, etc.), replace smee with a private
relay — the tunnel module (`plugins/dev/scripts/orch-monitor/lib/webhook-tunnel.ts`)
accepts a custom factory you can wire to any EventSource-compatible service.
