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
| `watchRepos` (persistent watch list) | `.catalyst/config.json` (per-repo, team-wide) | YES | Optional; once per added repo |
| Repo webhook subscription | GitHub repo settings (auto-created via `gh api`) | n/a | At startup for `watchRepos` entries; lazily for repos observed via worker signals |

**You do not need to add the smee channel to each repo manually.** The daemon does this for
you the first time a worker for that repo runs and is observed by the monitor — or eagerly at
startup if you list the repo in `watchRepos` (see [Persistent watch list](#persistent-watch-list)
below).

## Persistent watch list

The default subscription model is **worker-driven**: the daemon registers a webhook on a
`(owner, repo)` only after it observes a worker signal file referencing that repo. That works
well for repos you actively orchestrate against, but it leaves a gap for the "always-on
activity feed" use case — running orch-monitor as a background daemon (auto-start at login)
and wanting a continuous event stream for your core repos even when no worker is currently
active for them.

For that, configure `catalyst.monitor.github.watchRepos` in `.catalyst/config.json` (Layer 1,
team-wide). On daemon startup, after the smee tunnel is up and **before** the 1-hour replay
window runs, the daemon iterates this list and ensures each repo is subscribed.

`.catalyst/config.json`:

```json
{
  "catalyst": {
    "monitor": {
      "github": {
        "webhookSecretEnv": "CATALYST_WEBHOOK_SECRET",
        "watchRepos": [
          "coalesce-labs/catalyst",
          "coalesce-labs/adva"
        ]
      }
    }
  }
}
```

To add a repo without hand-editing the JSON, use the helper script:

```bash
plugins/dev/scripts/setup-webhooks.sh --add-repo coalesce-labs/catalyst
```

The flag is repeatable (`--add-repo a/b --add-repo c/d`) and idempotent (re-running with the
same repo doesn't duplicate). When `--add-repo` is the only intent flag, the script skips
channel/secret setup and just merges the repos into Layer 1 — safe to commit the resulting
diff.

### Auto-discovery still works alongside it

`watchRepos` is **additive**, not a replacement. Any repo observed in a worker signal file
still gets subscribed lazily, deduping against the in-memory cache so configured repos that
later show up in worker signals don't double-subscribe. You can use either path, both, or
neither — the daemon doesn't care which mechanism added a `(owner, repo)` to its subscription
set.

### When the gh CLI can't admin a configured repo

If a repo in `watchRepos` is inaccessible to the `gh` CLI's stored token (no admin
permission, repo doesn't exist, or the token is missing the `admin:repo_hook` scope), hook
creation fails. The daemon logs a warning and continues — same tolerance as the
auto-discovery path:

```
[webhook-subscriber] failed to list hooks for unknown-org/no-access; skipping
[webhook-subscriber] failed to create hook for unknown-org/no-access; falling back to polling
```

The 10-minute polling fallback then handles that repo. Fix the token (or remove the repo from
`watchRepos`) to silence the warning.

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
        "webhookSecretEnv": "CATALYST_WEBHOOK_SECRET",
        "watchRepos": []
      }
    }
  }
}
```

`watchRepos` is optional; see [Persistent watch list](#persistent-watch-list) for what it
does and when to use it. Empty/missing → auto-discovery only.

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
3. For each repo listed in `watchRepos`, the daemon calls
   `gh api repos/{repo}/hooks` and creates a webhook (or reuses an existing one whose
   `config.url` matches the smee channel — case-insensitive match). This step runs
   **before** the replay window so configured repos get the 1-hour replay too.
4. For each `(owner, repo)` observed in worker signal files, the daemon does the same
   thing — auto-discovery. The subscriber's in-memory cache dedupes against step 3.
5. **Replay**: for each subscribed repo, the last hour of webhook deliveries are pulled via
   `gh api repos/{repo}/hooks/{id}/deliveries`, signed synthetically (we own the secret),
   and dispatched through the same handler used for live events. The handler dedupes by
   `X-GitHub-Delivery` so deliveries that raced replay don't double-process.
6. Every accepted webhook event is also appended to
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

## Daemon liveness prerequisite

The orch-monitor daemon is the only writer to `~/catalyst/events/`, so any skill that
consumes events depends on it being alive. The Tier-1 event-driven skills are:

- `orchestrate` — Phase 4 watcher and auto-fixup classifier consume events
- `oneshot` — Phase 5 deploy-monitoring loop consumes events
- `merge-pr` — Phase 6 wait-for-merged consumes events
- `monitor-events` — the canonical pattern doc; reused everywhere the primitives are needed

If the daemon is stopped, `catalyst-events wait-for` blocks until its 600 s timeout and
exits non-zero. Callers fall back to `gh pr view` polling, which is functionally correct
for merge detection but **cannot observe production deploy events** — those only arrive
via the GitHub webhook stream that the daemon owns.

`plugins/dev/scripts/check-project-setup.sh` runs a liveness check on every prereq pass.
Behavior splits on whether the invocation is interactive:

- **Interactive (TTY stdin, `CATALYST_AUTONOMOUS` unset)**: prompts to start the daemon
  with `[Y/n]`, defaulting yes. On accept, runs `catalyst-monitor.sh start` and surfaces
  its output. On decline, adds a non-fatal warning.
- **Autonomous (`CATALYST_AUTONOMOUS=1` or non-TTY stdin)**: warns to stderr and
  proceeds. CI variants (`ci-commit`, `ci-describe-pr`) and orchestrator-dispatched
  workers take this path so a missing daemon never blocks an automation run.

Manual liveness check:

```bash
plugins/dev/scripts/catalyst-monitor.sh status            # human-readable
plugins/dev/scripts/catalyst-monitor.sh status --json     # {"running":true,"pid":N,...}
plugins/dev/scripts/catalyst-monitor.sh start             # idempotent — no-op if alive
```

The `status --json` exit code is `0` when running and `1` when stopped, so scripts can
gate cheaply via `if catalyst-monitor.sh status --json &>/dev/null; then ...`.

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

## Linear webhooks

CTL-210 added a parallel receiver for Linear events. When configured, the daemon exposes
`POST /api/webhook/linear` and writes Linear-origin events to the same unified event log
(`~/catalyst/events/YYYY-MM.jsonl`) as GitHub events. Topics use `linear.<noun>.<verb>` —
e.g. `linear.issue.state_changed`, `linear.comment.created`.

### Configuration

| What | Where | Committed |
|------|-------|-----------|
| `webhookSecretEnv` (env-var name only) | `catalyst.monitor.linear.webhookSecretEnv` in `.catalyst/config.json` | YES |
| HMAC secret value | env var named above (default fallback `CATALYST_LINEAR_WEBHOOK_SECRET`) | NO (per-developer env) |
| `smeeChannel` (Linear smee URL) | `catalyst.monitor.linear.smeeChannel` in `~/.config/catalyst/config.json` | NO (per-machine, written by `--linear-register`) |
| Registration record (`webhookId`, `webhookUrl`, `registeredAt`, `resourceTypes`) | `catalyst.monitor.linear` in `~/.config/catalyst/config.json` | NO (per-machine, written by `--linear-register`) |
| HMAC secret file | `~/.config/catalyst/linear-webhook-secret` (mode 600, read by `--linear-register` post-create) | NO (per-developer) |

Run `setup-webhooks.sh --linear-secret-env CATALYST_LINEAR_WEBHOOK_SECRET` to write the
env-var name to `.catalyst/config.json`. Then `export CATALYST_LINEAR_WEBHOOK_SECRET=<your-secret>`
in your shell rc file. Linear webhooks share the same Layer 1 / Layer 2 split as GitHub:
team-wide config in `.catalyst/config.json`, per-developer values in environment, and
per-machine registration state in `~/.config/catalyst/config.json` (CTL-238 — mirrors the
GitHub `smeeChannel` write).

#### Layer 2 registration record

`~/.config/catalyst/config.json` (cross-project, per-machine — never committed; written by
`setup-webhooks.sh --linear-register` after a successful `webhookCreate`):

```json
{
  "catalyst": {
    "monitor": {
      "linear": {
        "webhookId": "abc-123-uuid-from-linear",
        "webhookUrl": "https://your-tunnel/api/webhook/linear",
        "registeredAt": "2026-05-04T20:00:00Z",
        "resourceTypes": ["Issue", "Comment", "IssueLabel", "Cycle", "Reaction", "Project"]
      }
    }
  }
}
```

This is the Linear analogue of `catalyst.monitor.github.smeeChannel` — same Layer 2 file,
same per-machine semantics. The local record is the source of truth for idempotency on
re-run: when the URL matches, `--linear-register` short-circuits without calling Linear's
GraphQL API, and `--linear-deregister` reads `webhookId` from this record to call
`webhookDelete` cleanly.

### Registering the webhook with Linear

The setup script auto-registers the webhook for you (CTL-224) and, when no
`--webhook-url` is supplied, auto-provisions a smee.io channel for delivery
(CTL-242). The simplest end-to-end setup is a single command:

```bash
plugins/dev/scripts/setup-webhooks.sh \
  --linear-secret-env CATALYST_LINEAR_WEBHOOK_SECRET \
  --linear-register
```

This creates a fresh smee.io channel, writes `catalyst.monitor.linear.smeeChannel`
to `~/.config/catalyst/config.json`, registers the webhook against that URL
with Linear, and writes the resulting HMAC secret to
`~/.config/catalyst/linear-webhook-secret`. The daemon picks up the smee
channel automatically on next start and tunnels Linear deliveries to
`http://localhost:7400/api/webhook/linear`.

To reuse an existing smee channel instead of generating a new one, set
`CATALYST_LINEAR_SMEE_CHANNEL` before running:

```bash
CATALYST_LINEAR_SMEE_CHANNEL=https://smee.io/existing-channel \
  plugins/dev/scripts/setup-webhooks.sh --linear-register
```

To use an existing public URL instead:

```bash
plugins/dev/scripts/setup-webhooks.sh \
  --linear-secret-env CATALYST_LINEAR_WEBHOOK_SECRET \
  --linear-register \
  --webhook-url https://your-tunnel/api/webhook/linear
```

The script:

1. Reads your Linear API token from `~/.config/catalyst/config-<projectKey>.json`
   (`.linear.apiToken`) — the same Layer 2 secrets file that
   `resolve-linear-ids.sh` uses.
2. Reads your team UUID from the Layer 1 `.catalyst/config.json` cache
   (`catalyst.linear.teamId`). Run `resolve-linear-ids.sh` first if that
   field is empty.
3. Lists existing Linear webhooks. If one already targets the same URL
   (case-insensitive match), it is reused — `--linear-register` is
   **idempotent**.
4. Otherwise, calls `webhookCreate` with `resourceTypes` set to the canonical
   six: `Issue`, `Comment`, `IssueLabel`, `Cycle`, `Reaction`, `Project`.
   `IssueRelation` is intentionally excluded — Linear does not deliver it.
5. Persists the returned `secret` to `~/.config/catalyst/linear-webhook-secret`
   (mode 600), mirroring the GitHub-side `~/.config/catalyst/webhook-secret`.
6. Writes the registration record (`webhookId`, `webhookUrl`, `registeredAt`,
   `resourceTypes`) to `~/.config/catalyst/config.json` under
   `catalyst.monitor.linear` (CTL-238). Subsequent re-runs short-circuit on
   this record — no Linear API call needed for the dedup decision. See
   [Layer 2 registration record](#layer-2-registration-record) above.
7. Prints the `export CATALYST_LINEAR_WEBHOOK_SECRET="$(cat …)"` line for
   your shell rc.

#### Idempotency on re-run (CTL-238)

When you re-run `--linear-register --webhook-url <U>`, the script consults the Layer 2
record before touching the Linear API:

- **Record matches `<U>`, no `--force`** → prints `Webhook already registered (id=…); skipping`
  and exits 0. Zero API calls.
- **Record holds a different URL, no `--force`** → errors out, leaves the record untouched,
  asks the user to pass `--force` to delete the old webhook and register the new URL.
- **`--force`** → deletes the recorded webhook by ID, clears the record, calls `webhookCreate`
  for `<U>`, rewrites the record. The list-then-match step from CTL-224 is skipped on this
  path (we already know the world from the Layer 2 record).
- **No record** → falls back to the CTL-224 path: list webhooks via API, dedup by URL,
  reuse-or-create. On reuse, writes a partial Layer 2 record (no `resourceTypes` —
  the list response doesn't expose them) so subsequent runs short-circuit locally.

To rotate the secret (or change the URL), re-run with `--force`:

```bash
plugins/dev/scripts/setup-webhooks.sh \
  --linear-register \
  --webhook-url https://new-tunnel/api/webhook/linear \
  --force
```

`--force` deletes the matching webhook and recreates — note that the new
secret can only be retrieved once, so persist it immediately (the script
does this automatically) and re-export it in any active shell.

smee.io URLs work with Linear (empirically verified — Linear accepts any public HTTPS
non-localhost URL). The limitation is offline buffering: smee.io is a pass-through relay
and does not persist payloads, so events sent while the tunnel is offline are lost. The
daemon's `linear.ts` polling fallback (every 5 minutes) compensates for this. For a
durable relay see CTL-241 (Cloudflare-based store-and-forward, in progress).

You can also run the helper directly without `setup-webhooks.sh` if you only
want webhook registration (no env-var-name write):

```bash
plugins/dev/scripts/setup-linear-webhook.sh \
  --webhook-url https://your-tunnel/api/webhook/linear
```

### Deregistering the webhook (CTL-238)

To clean up a registered Linear webhook:

```bash
plugins/dev/scripts/setup-webhooks.sh --linear-deregister
```

The script reads `webhookId` from the Layer 2 registration record, calls Linear's
`webhookDelete`, clears the record, and removes `~/.config/catalyst/linear-webhook-secret`.
Errors cleanly with a non-zero exit when no Layer 2 record exists (nothing to delete).

`--linear-deregister` and `--linear-register` are mutually exclusive — pass one or the
other, not both.

### Signing scheme

| | GitHub | Linear |
|---|---|---|
| Header | `X-Hub-Signature-256` | `Linear-Signature` |
| Format | `sha256=<hex>` | `<hex>` (no prefix) |
| Algorithm | HMAC-SHA256 over raw body | HMAC-SHA256 over raw body |
| Delivery ID header | `X-GitHub-Delivery` | `Linear-Delivery` |

### Event topics

| Linear `type` + `action` (and changed fields) | Topic emitted |
|---|---|
| `Issue` create | `linear.issue.created` |
| `Issue` update + `stateId` changed | `linear.issue.state_changed` |
| `Issue` update + `priority` changed | `linear.issue.priority_changed` |
| `Issue` update + `assigneeId` changed | `linear.issue.assignee_changed` |
| `Issue` update (other fields only) | `linear.issue.updated` |
| `Issue` remove | `linear.issue.removed` |
| `Comment` create / update / remove | `linear.comment.{created,updated,removed}` |
| `Cycle` create / update / remove | `linear.cycle.{created,updated,removed}` |
| `Reaction` create / remove | `linear.reaction.{created,removed}` |
| `IssueLabel` create / update / remove | `linear.issue_label.{created,updated,removed}` |

For Issue updates with multiple changed fields, the topic is selected by priority order:
state > priority > assignee > generic. This matches the GitHub PR pattern of one event
per delivery.

`IssueRelation` is not in Linear's webhook resourceTypes and is not received.

### Testing the receiver

```bash
# After configuring the secret and starting the daemon:
catalyst-events tail --filter '.event | startswith("linear.")'

# In another shell, cause a Linear ticket state change.
# The first shell should print the matching event line within seconds.
```

## Version drift detection

The `catalyst-monitor` wrapper checks at startup whether it is running a stale version of
the daemon code. This catches the case where `/plugin update` lands new code in the plugin
cache but the active symlink (or shell alias) still points at the previous version.

On `start` and `restart`, the wrapper:

1. Reads the version of the script being executed (from the adjacent `version.txt`).
2. Reads the highest semver subdirectory under `~/.claude/plugins/cache/catalyst/catalyst-dev/`.
3. Prints a warning to stderr when the running version is older.

The same fields are exposed in `status --json`:

```json
{
  "running": true,
  "pid": 12345,
  "port": 7400,
  "url": "http://localhost:7400",
  "runningVersion": "8.1.0",
  "latestAvailableVersion": "8.1.0",
  "isStale": false
}
```

The startup pre-flight (`check-setup.sh`, run by setup skills) consumes these fields and
surfaces drift as a warning with the remediation command.

To suppress the warning (e.g. when deliberately pinned to an older version), add the
following to `.catalyst/config.json`:

```json
{
  "catalyst": {
    "monitor": {
      "suppressVersionWarning": true
    }
  }
}
```

When running the wrapper from a source-tree clone (no plugin cache), `runningVersion`
comes from `plugins/dev/version.txt` and `latestAvailableVersion` is `null` if the plugin
cache directory does not exist on the machine.

