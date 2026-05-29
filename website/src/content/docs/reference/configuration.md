---
title: Configuration
description:
  Two-layer configuration system — what you need to set up and what the AI checks automatically.
sidebar:
  order: 3
---

Catalyst uses a **two-layer configuration system** that keeps secrets out of git while allowing
project metadata to be shared with your team. The setup script (`setup-catalyst.sh`) generates both
layers automatically.

## Project Config (`.catalyst/config.json`)

Safe to commit. Contains non-sensitive project metadata that Catalyst reads to understand your
project structure, ticket conventions, and workflow state mapping.

```json
{
  "catalyst": {
    "projectKey": "acme",
    "repository": {
      "org": "acme-corp",
      "name": "api"
    },
    "project": {
      "ticketPrefix": "ACME",
      "name": "Acme Corp API"
    },
    "linear": {
      "teamKey": "ACME",
      "stateMap": {
        "backlog": "Backlog",
        "todo": "Todo",
        "research": "In Progress",
        "planning": "In Progress",
        "inProgress": "In Progress",
        "verifying": "In Progress",
        "reviewing": "In Progress",
        "inReview": "In Review",
        "done": "Done",
        "canceled": "Canceled"
      }
    },
    "thoughts": {
      "user": null
    }
  }
}
```

### Fields

| Field                           | Type         | Description                                                                                       |
| ------------------------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| `catalyst.projectKey`           | string       | Links to the secrets config file (`config-{projectKey}.json`)                                     |
| `catalyst.repository.org`       | string       | GitHub organization                                                                               |
| `catalyst.repository.name`      | string       | Repository name                                                                                   |
| `catalyst.project.ticketPrefix` | string       | Linear ticket prefix (e.g., "ACME")                                                               |
| `catalyst.project.name`         | string       | Human-readable project name                                                                       |
| `catalyst.linear.teamKey`       | string       | Linear team identifier used in ticket IDs (e.g., "ACME" for ACME-123). Must match `ticketPrefix`. |
| `catalyst.linear.teamId`        | string\|null | Cached Linear team UUID. Resolved by `resolve-linear-ids.sh`.                                     |
| `catalyst.linear.stateMap`      | object       | Maps workflow phases to your Linear workspace state names                                         |
| `catalyst.thoughts.user`        | string\|null | HumanLayer thoughts user name                                                                     |

### State Map

The `stateMap` controls automatic Linear status updates as you move through the development
workflow:

| Key          | Updated When                         | Default     |
| ------------ | ------------------------------------ | ----------- |
| `backlog`    | Initial ticket state                 | Backlog     |
| `todo`       | Acknowledged, unstarted              | Todo        |
| `research`   | Running `research-codebase`          | In Progress |
| `planning`   | Running `create-plan`                | In Progress |
| `inProgress` | Running `implement-plan`             | In Progress |
| `verifying`  | Phase-agent verify step running      | In Progress |
| `reviewing`  | Phase-agent review step running      | In Progress |
| `inReview`   | Running `create-pr` or `describe-pr` | In Review   |
| `done`       | Running `merge-pr`                   | Done        |
| `canceled`   | Manual cancellation                  | Canceled    |

Set any key to `null` to skip that automatic transition.

**Finer-grained phase visibility.** The `verifying` and `reviewing` keys default to `In Progress` so
dispatching a phase-agent transition is always safe. If you want a dedicated Linear lane for those
phases, create `Verifying` and `Reviewing` workflow states in Linear admin first, then point
`stateMap.verifying` and `stateMap.reviewing` at the new names and re-run
`plugins/dev/scripts/resolve-linear-ids.sh --force` to refresh the cached UUIDs. Pointing `stateMap`
at a state that does not exist in Linear will cause the next transition call to fail at the linearis
layer.

**`stateMap` values are auto-detected from Linear** — when you run `setup-catalyst.sh` with a Linear
API token, the script fetches your team's actual workflow states and populates `stateMap` with the
correct names. Manual customization is only needed for non-standard state names.

### Cached UUIDs

`linear-transition.sh` passes Linear UUIDs directly to the linearis CLI to skip per-call
name-to-UUID resolution — roughly a 17% drop in Linear API requests per state transition,
significant during orchestrator runs with parallel workers.

- **`teamId`** is cached in `.catalyst/config.json` — a Linear team UUID is stable.
- **`stateIds`** is a **machine-local derived cache** at `~/.config/catalyst/linear-state-ids.json`
  — a registry keyed by Linear `teamKey`. It is **never committed to git**, so the UUID table can
  never travel stale (the failure mode behind CTL-575/576). Each entry records a `resolvedAt`
  timestamp:

  ```json
  {
    "CTL": {
      "resolvedAt": "2026-05-22T15:00:00Z",
      "stateIds": { "Backlog": "71a1…", "Plan": "b64f…", "Done": "5d77…" }
    }
  }
  ```

Populate or refresh the cache explicitly:

```bash
plugins/dev/scripts/resolve-linear-ids.sh          # resolve if not already cached
plugins/dev/scripts/resolve-linear-ids.sh --force  # re-resolve after Linear state changes
```

`resolve-linear-ids.sh` makes a single Linear GraphQL query for the team's whole state set. The
cache is also **self-healing** — on a cache miss `linear-transition.sh` resolves it automatically,
and if the resolver cannot run it falls back to name-based calls (always correct). `stateMap`
remains the single committed source of truth.

### Execution-Core State Contract

When `orchestration.dispatchMode` is `"execution-core"`, the team's Linear
workflow states become the daemon's state machine, and `stateMap` is rewritten
to a fixed **9-phase → 5-state collapse**. Setup tooling owns this contract — it
is not a one-off migration.

| `stateMap` key | Execution-core value |
| -------------- | -------------------- |
| `backlog`      | `Backlog`            |
| `todo`         | `Ready`              |
| `triage`       | `Triage`             |
| `research`     | `Research`           |
| `planning`     | `Plan`               |
| `inProgress`   | `Implement`          |
| `verifying`    | `Validate`           |
| `reviewing`    | `Validate`           |
| `inReview`     | `PR`                 |
| `done`         | `Done`               |
| `canceled`     | `Canceled`           |

`verify` + `review` collapse to `Validate`; `pr` + `monitor-merge` +
`monitor-deploy` collapse to `PR`. The six **contract states** —
`Ready`, `Research`, `Plan`, `Implement`, `Validate`, `PR` (`Triage` already
exists in every team workflow) — are ensured in Linear by
`plugins/dev/scripts/setup-execution-core-states.sh`. That script is idempotent,
runs once per team, and is invoked automatically by `setup-catalyst.sh` for
`execution-core` repos. It writes the collapse `stateMap`, refreshes the
machine-local `stateIds` cache,
and upserts the team's registry entry. Run it directly with `--dry-run --json`
to preview the contract without writing anything.

Moving a ticket **Backlog → Ready** directly (skipping `Triage`) is supported:
if no `triage.json` exists yet, the monitor auto-runs the triage phase before
the ticket enters the pipeline at `Research`. (CTL-625)

### Central Registry (`~/catalyst/execution-core/registry.json`)

For `execution-core` teams, the central registry is the single source of
`team → repoRoot → eligibleQuery`. It is **execution-core only** — `phase-agents`
and `oneshot-legacy` repos never write or read it. Schema:

```jsonc
{
  "projects": [
    {
      "team": "CTL",
      "repoRoot": "/abs/path/to/repo",
      "eligibleQuery": { "status": "Ready", "triageStatus": "Triage", "project": null, "label": null, "priority": null }
    }
  ]
}
```

All registry access flows through `plugins/dev/scripts/execution-core/registry.mjs`
(`listProjects`, `getProjectConfig`, `resolveEligibleQuery`, `upsertProjectEntry`,
plus a `list | get | upsert` CLI) so the access path stays a single seam. The
execution-core daemon reads the registry directly (CTL-582 D4); the per-repo
enrollment records CTL-554 wrote under `~/catalyst/execution-core/projects/` and
the `/orchestrate` enroll step they relied on were retired.

`check-project-setup.sh` adds an **execution-core verification check**: when a
repo is `dispatchMode: execution-core`, it warns if any contract state is
missing from `stateMap`/`stateIds` or if no registry entry exists for the team,
pointing the operator at `setup-catalyst` / `setup-execution-core-states.sh`.

### Plain-Language State Flow

In most teams, the intended meaning is:

- `research` — Catalyst is still understanding the problem and the current code
- `planning` — the implementation approach is being written and reviewed
- `inProgress` — code changes are actively being made
- `inReview` — a PR exists and is being worked through review and CI
- `done` — the PR has merged

This is useful because the PR stage is not just "waiting on somebody else." In Catalyst's model,
`inReview` still includes active follow-up work such as fixing CI, addressing automated review
feedback, updating the PR description, and re-checking merge readiness.

## GitHub Merge Rules Are Separate

Catalyst can open PRs, watch checks, address review comments, and try to merge safely. But GitHub
decides what is actually required before `main` can be merged into.

Those merge requirements live in **GitHub branch protection or repository rulesets**, not in
`.catalyst/config.json`.

If you want GitHub to block merges until review is complete, configure that in GitHub:

- require pull requests for `main`
- require status checks before merge
- require one or more approving reviews
- require conversation resolution if review threads must be closed
- optionally enable auto-merge once those requirements pass

Catalyst should behave as if these gates matter, but only GitHub can enforce them.

## Recommended GitHub Repo Settings

For most teams using Catalyst, the best default is **autonomous mode**: let Catalyst work the PR to
completion, but make GitHub enforce the quality gates around checks and unresolved review comments.

### Repository Settings

- Enable pull requests.
- Enable squash merge.
- Enable auto-merge.
- Enable automatic deletion of head branches after merge.
- Set the default branch to `main`.

### `main` Ruleset

Target `refs/heads/main` with an active branch ruleset that:

- blocks direct deletion
- blocks non-fast-forward pushes
- requires pull requests for changes into `main`
- requires review conversations to be resolved before merge
- requires status checks to pass before merge

For **autonomous mode**, set:

- required approving reviews: `0`
- required review thread resolution: `true`
- required status checks: `true`

This gives you a fully automated merge path where Catalyst can:

- open the PR
- wait for checks and bot comments
- fix actionable feedback
- resolve review threads
- merge once the PR is genuinely clean

without waiting for a human approval click.

For this repo shape, the recommended (and only) required check is:

- `docs-gate`

`docs-gate` is an in-repo GitHub Action (`.github/workflows/docs-gate.yml`) that runs on **every**
PR to `main` with no path filter, so the required context always reports. It is path-aware: on
non-docs PRs it passes in seconds, and on docs PRs (anything under `website/`, or a
`plugins/*/CHANGELOG.md` the docs build renders) it runs `npm run build` (`astro build`) and must
be green. This lets the slow `Cloudflare Pages` preview build be **build-watch-path gated and no
longer required** — non-docs PRs (the ~75% that change nothing the docs site deploys) merge without
waiting on it, while docs PRs still block on the in-CI build. See
[CI required checks rollout](https://github.com/coalesce-labs/catalyst/blob/main/docs/ci-required-checks-rollout.md)
for the operator runbook that performs this swap safely (CTL-670).

`audit-references`, `check-versions`, and `validate` also run on every PR and report status, but are
**not** required gates. They are repository-owned guardrails you may add to the required set if you
want them enforced:

- `audit-references` catches broken plugin references
- `check-versions` verifies plugin changes are releasable through Release Please
- `validate` checks release configuration consistency

If your repository has additional always-on checks, add them too. The important rule is: only mark a
check as required if it runs on every PR to `main` — which is exactly why `docs-gate` (no path
filter) is the required check and `Cloudflare Pages` (skips on non-docs PRs, posting no status) is
not.

### Optional Human-In-The-Loop Mode

If you want a human signoff before merge, keep everything above and additionally set:

- required approving reviews: `1` or more

That changes the operating model from autonomous shipping to human-approved shipping. Catalyst still
does the same review-follow-up work, but GitHub will not allow the merge until a human reviewer
approves it.

### Review Expectations

The recommended operating model is:

- automated reviewers can leave comments and request fixes
- Catalyst should address actionable review feedback and resolve threads
- GitHub should block merge until required conversations and checks are complete
- human approval should be optional and controlled by the repository owner, not assumed by Catalyst

### Why This Split Matters

Catalyst can do the work of:

- opening the PR
- waiting for checks
- reading bot and human review comments
- fixing code
- updating the PR
- attempting the merge once the PR is clean

But the repository settings are what make those expectations enforceable for every contributor, not
just when Catalyst happens to be driving.

## Secrets Config (`~/.config/catalyst/config-{projectKey}.json`)

Never committed. One file per project, linked by `projectKey`.

```json
{
  "catalyst": {
    "linear": {
      "apiToken": "lin_api_...",
      "teamKey": "ACME",
      "defaultTeam": "ACME"
    },
    "sentry": {
      "org": "acme-corp",
      "project": "acme-web",
      "authToken": "sntrys_..."
    },
    "posthog": {
      "apiKey": "phc_...",
      "projectId": "12345"
    },
    "exa": {
      "apiKey": "..."
    }
  }
}
```

### Integration Fields

| Integration | Required Fields               | Used By                                                    |
| ----------- | ----------------------------- | ---------------------------------------------------------- |
| Linear      | `apiToken`, `teamKey`         | catalyst-dev, catalyst-pm                                  |
| Sentry      | `org`, `project`, `authToken` | catalyst-debugging                                         |
| PostHog     | `apiKey`, `projectId`         | catalyst-analytics (read), `catalyst-otel-forward` (write) |
| Exa         | `apiKey`                      | catalyst-dev (external research)                           |
| Groq        | `apiKey`                      | `catalyst-broker` (semantic-prose routing, CTL-303)        |

Only configure the integrations you use. The setup script prompts for each one.

#### Execution-core concurrency (host-wide, CTL-678)

The cross-project Layer-2 file `~/.config/catalyst/config.json` (no `projectKey`
suffix) is **also** the live source for the execution-core scheduler's worker-slot
ceiling. Under `catalyst.orchestration.executionCore` it accepts the same three
concurrency keys as the committed Layer-1 seed — `maxParallel`, `minParallel`,
`maxParallelCeiling` — each overriding the committed value per-field. See
[Execution-core concurrency (`executionCore.maxParallel`)](#execution-core-concurrency-executioncoremaxparallel)
for precedence, per-field merge semantics, and worked examples. The execution-core
daemon is one-per-machine and serves all enrolled projects, so this knob is
intentionally host-wide rather than per-project.

### Broker (`catalyst.broker` / `groq`)

The `catalyst-broker` daemon (CTL-303) is the local event broker that registered agents and skills
wait on for relevant events. It evolved from the earlier `catalyst-filter` daemon —
`catalyst-filter` remains as a backward-compat shim that delegates to `catalyst-broker` (CTL-315).

Layer-2 secrets (`~/.config/catalyst/config-{projectKey}.json` or the cross-project
`~/.config/catalyst/config.json`):

```json
{
  "groq": {
    "apiKey": "gsk_...",
    "gateway": {
      "enabled": false,
      "baseUrl": "https://gateway.internal/groq",
      "headers": { "X-Project": "Adva AI Gateway" }
    }
  }
}
```

| Field                  | Type    | Description                                                                                                                                                                                                                                                                   |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `groq.apiKey`          | string  | Groq API key used by `catalyst-broker` for semantic-prose classification of ambiguous events. Not required for deterministic routes (`pr_lifecycle`, `ticket_lifecycle`).                                                                                                     |
| `groq.gateway.enabled` | boolean | When `true`, route Groq chat-completions through a configured gateway (e.g. Litellm, Helicone, Adva AI Gateway) so all Catalyst traffic lands in one dashboard regardless of which key owns the underlying calls. Defaults to `false` (call `https://api.groq.com` directly). |
| `groq.gateway.baseUrl` | string  | Gateway base URL. The broker appends `/chat/completions` for completions and `/v1/models` for the startup probe. Trailing slashes are stripped.                                                                                                                               |
| `groq.gateway.headers` | object  | Extra headers merged into every Groq request — useful for project-tag headers required by your gateway.                                                                                                                                                                       |

#### Key resolution precedence (CTL-343)

`catalyst-broker` resolves the Groq API key with three layers, in this order:

1. `process.env.GROQ_API_KEY` — highest priority. Set per-project via direnv, or for one-off
   overrides.
2. `~/.config/catalyst/config-<projectKey>.json` → `groq.apiKey` — per-project secrets when a
   `projectKey` is configured.
3. `~/.config/catalyst/config.json` → `groq.apiKey` — cross-project default.

If none of the three resolve, the broker logs a multi-line warning at startup naming the missing
key, the config path, the env var, and the Groq signup URL. Semantic-prose routing is then disabled
until a key is provided; deterministic routes continue to work.

#### Startup probe + status surface (CTL-343)

At daemon start the broker issues a single `GET /v1/models` against the resolved endpoint to surface
a 401/403 within seconds rather than hours later. The result is recorded in the runtime state file
(below) under `keyHealth.groq.probeStatus`:

| Probe status   | Meaning                                                              |
| -------------- | -------------------------------------------------------------------- |
| `ok`           | Key is valid, response 200, `modelCount` populated                   |
| `unauthorized` | 401 or 403 — key is present but invalid; semantic routing disabled   |
| `error`        | Network error or 5xx                                                 |
| `missing`      | No key resolved (see precedence above)                               |
| `pending`      | State file written, probe still in flight (~first second of startup) |

Consumers:

```sh
catalyst-broker status --json     # broker-only view
catalyst-monitor status --json    # monitor + broker key-health combined
```

The HUD (`catalyst-hud`) renders a colour-coded chip in the header — green/yellow/red — and the
key's first 12 characters with its resolution source (`env`, `project-config`, or `config`), so the
operator can sanity-check "is this the right key?" at a glance.

Runtime files (created on demand under `$CATALYST_DIR`, default `~/catalyst/`):

| Path                               | Purpose                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `~/catalyst/broker.pid`            | Liveness PID file written by the daemon                                 |
| `~/catalyst/broker.log`            | Pino structured log output (CTL-314)                                    |
| `~/catalyst/broker.state.json`     | Key-health + gateway state surface (CTL-343), removed on clean shutdown |
| `~/catalyst/broker-interests.json` | Persistent interest registry                                            |

`LOG_LEVEL` (default `info`) controls broker log verbosity through pino (CTL-314). The same env var
also gates verbosity in `catalyst-otel-forward`.

On first start, `catalyst-broker` performs a one-shot rename from the legacy
`~/catalyst/filter-interests.json` to `~/catalyst/broker-interests.json` if the legacy file exists.
The startup line written to the event log was renamed from `filter.daemon.startup` to
`broker.daemon.startup` at the same time; the legacy event name is no longer emitted.

### Monitor OTel Config

The orchestration monitor reads OpenTelemetry backend endpoints from the per-project secrets file
`~/.config/catalyst/config-<projectKey>.json` (layer 2). If that file is not present it falls back
to the global `~/.config/catalyst/config.json`.

```json
{
  "otel": {
    "enabled": true,
    "prometheusUrl": "http://localhost:9090",
    "lokiUrl": "http://localhost:3100"
  }
}
```

| Field                | Type    | Default | Description                                                              |
| -------------------- | ------- | ------- | ------------------------------------------------------------------------ |
| `otel.enabled`       | boolean | `false` | Enable OTel proxy endpoints on orch-monitor                              |
| `otel.prometheusUrl` | string  | `null`  | Prometheus query URL (for `/api/otel/query` and cost/token panels)       |
| `otel.lokiUrl`       | string  | `null`  | Loki query URL (for `/api/otel/logs`, Tool Usage, and API Errors panels) |

Environment variable overrides: `OTEL_ENABLED`, `PROMETHEUS_URL`, `LOKI_URL`. Env vars take
precedence over the file when both are set.

**Deprecated names**: the monitor still accepts `otel.prometheus` and `otel.loki` for one release
cycle, but emits a deprecation warning on startup. Rename to `otel.prometheusUrl` and `otel.lokiUrl`
to silence the warning.

If you're running the [claude-code-otel](https://github.com/ryanrozich/claude-code-otel) Docker
Compose stack locally, the defaults above match the standard ports. For hosted backends (Grafana
Cloud, Datadog, etc.), point these URLs at your hosted Prometheus/Loki-compatible endpoints.

See [Setting up the OTel stack](/observability/setup/) for the full installation guide.

### Forwarders (`catalyst.observability.forwarders`, CTL-306)

The `catalyst-otel-forward` daemon (CTL-306) tails the canonical event log
(`~/catalyst/events/YYYY-MM.jsonl`) and fans events out to OTLP, PostHog, and Cloudflare Analytics
Engine. Config lives in `~/.config/catalyst/config-{projectKey}.json` under
`catalyst.observability.forwarders`; the daemon also reads the cross-project
`~/.config/catalyst/config.json` as a fallback.

| Key                                       | Type    | Default                        | Description                     |
| ----------------------------------------- | ------- | ------------------------------ | ------------------------------- |
| `forwarders.otlp.enabled`                 | boolean | `false`                        | Enable OTLP/HTTP forwarding     |
| `forwarders.otlp.endpoint`                | string  | `$OTEL_EXPORTER_OTLP_ENDPOINT` | Collector URL (port 4318)       |
| `forwarders.otlp.batchSize`               | number  | `100`                          | Max events per POST             |
| `forwarders.otlp.flushIntervalMs`         | number  | `5000`                         | Flush interval in ms            |
| `forwarders.posthog.enabled`              | boolean | `false`                        | Enable PostHog forwarding       |
| `forwarders.posthog.apiKey`               | string  | —                              | Project API key (`phc_...`)     |
| `forwarders.posthog.host`                 | string  | `https://us.i.posthog.com`     | PostHog ingest host             |
| `forwarders.posthog.batchSize`            | number  | `50`                           | Max events per POST             |
| `forwarders.posthog.flushIntervalMs`      | number  | `10000`                        | Flush interval in ms            |
| `forwarders.cloudflareAE.enabled`         | boolean | `false`                        | Enable Cloudflare AE forwarding |
| `forwarders.cloudflareAE.accountId`       | string  | —                              | Cloudflare account ID           |
| `forwarders.cloudflareAE.apiToken`        | string  | —                              | Cloudflare API token            |
| `forwarders.cloudflareAE.dataset`         | string  | `catalyst_events`              | AE dataset name                 |
| `forwarders.cloudflareAE.batchSize`       | number  | `100`                          | Max events per write batch      |
| `forwarders.cloudflareAE.flushIntervalMs` | number  | `5000`                         | Flush interval in ms            |

See [Event Forwarding](/observability/forwarder/) for full setup and operations guide.

### Environment Variables

A reference of the env vars Catalyst's daemons honor at runtime. File-based config wins unless the
env var is set.

| Variable                                     | Daemon / scope                             | Description                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CATALYST_DIR`                               | All                                        | Base directory for runtime files. Default `~/catalyst/`.                                                                                                                                                                                                                                                                                    |
| `LOG_LEVEL`                                  | `catalyst-broker`, `catalyst-otel-forward` | Pino log level (CTL-314). Default `info`.                                                                                                                                                                                                                                                                                                   |
| `BROKER_PID_FILE`                            | `catalyst-broker`                          | Override broker PID path. Default `$CATALYST_DIR/broker.pid`.                                                                                                                                                                                                                                                                               |
| `BROKER_LOG_FILE`                            | `catalyst-broker`                          | Override broker log path. Default `$CATALYST_DIR/broker.log`.                                                                                                                                                                                                                                                                               |
| `GROQ_API_KEY`                               | `catalyst-broker`                          | Groq API key (overrides `groq.apiKey` in config).                                                                                                                                                                                                                                                                                           |
| `CATALYST_BROKER_PROSE_ENABLED`              | `catalyst-broker`                          | Set to `1` to enable Groq-backed prose classification for open-ended interests (`interest_type: null`). Disabled by default — requires `GROQ_API_KEY` and incurs Groq API costs proportional to interest volume. When unset, prose interests persist in `broker-interests.json` but are never evaluated; the HUD marks them `[prose: OFF]`. |
| `FILTER_GROQ_MODEL`                          | `catalyst-broker`                          | Groq model for semantic-prose classification. Default `llama-3.1-8b-instant`.                                                                                                                                                                                                                                                               |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                | `catalyst-otel-forward`                    | OTLP endpoint URL. Port `4317` is auto-rewritten to `4318` for HTTP transport.                                                                                                                                                                                                                                                              |
| `OTEL_ENABLED`, `PROMETHEUS_URL`, `LOKI_URL` | `orch-monitor`                             | See [Monitor OTel Config](#monitor-otel-config).                                                                                                                                                                                                                                                                                            |
| `MONITOR_PORT`                               | `orch-monitor`                             | HTTP port. Default `7400`.                                                                                                                                                                                                                                                                                                                  |
| `CATALYST_SMEE_CHANNEL`                      | `orch-monitor`                             | Override `monitor.github.smeeChannel`.                                                                                                                                                                                                                                                                                                      |
| `CATALYST_DB_FILE`                           | All                                        | SQLite session DB path. Default `$CATALYST_DIR/catalyst.db`.                                                                                                                                                                                                                                                                                |
| `CATALYST_ARCHIVE_ROOT`                      | `catalyst-archive`                         | Archive root. Default `$CATALYST_DIR/archives`.                                                                                                                                                                                                                                                                                             |
| `CATALYST_RUNS_DIR`                          | `catalyst-archive`                         | Orchestrator runtime root. Default `$CATALYST_DIR/runs`.                                                                                                                                                                                                                                                                                    |
| `CATALYST_COMMS_DIR`                         | `catalyst-comms`                           | Comms channel root. Default `$CATALYST_DIR/comms/channels`.                                                                                                                                                                                                                                                                                 |
| `SCHEDULER_DISPATCH_COOLDOWN_MS`             | `catalyst-execution-core` (scheduler)      | Per-(ticket,phase) dispatch cool-down (CTL-624). Throttles re-dispatch of the same phase after a refused dispatch (e.g. `prior_artifact_missing`) so the scheduler doesn't storm. Default `60000` (60s).                                                                                                                                     |
| `SCHEDULER_DISPATCH_PERMANENT_COOLDOWN_MS`   | `catalyst-execution-core` (scheduler)      | Permanent-failure cooldown applied to `code=2` (`prior_artifact_missing`) dispatch refusals (CTL-713). `code=2` is a structural refusal — back it off far longer than the 60s transient window. The GC sweep reaps the marker once the ticket leaves the eligible set. Default `1800000` (30 min).                                           |
| `SCHEDULER_DISPATCH_FAILURE_ESCALATION_THRESHOLD` | `catalyst-execution-core` (scheduler) | Number of consecutive same-code dispatch failures on one `(ticket, phase)` pair before `needs-human` is applied (CTL-713). Mirrors `REMEDIATE_CYCLE_CAP`. Default `3`.                                                                                                                                                                      |
| `RECOVERY_ESCALATION_COOLDOWN_MS`            | `catalyst-execution-core` (recovery sweep) | Per-(ticket,phase) escalation cool-down (CTL-638) on the recovery sweep's `needs-human` label escalation, so a stuck phase isn't re-escalated on every sweep. Default `600000` (10 min).                                                                                                                                                     |

### Monitor Webhook Config

The orch-monitor daemon receives GitHub events through a smee.io tunnel — see
[GitHub webhooks for orch-monitor](/observability/webhooks/) for the why and the full setup flow.
The webhook config is split across two files because the channel URL is per-machine (one daemon, one
tunnel, every project on the laptop) while the env-var **name** is team-wide.

`~/.config/catalyst/config.json` — cross-project, per-machine, **not committed**:

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

`.catalyst/config.json` — per-repo, **committed**, team-wide:

```json
{
  "catalyst": {
    "monitor": {
      "github": {
        "webhookSecretEnv": "CATALYST_WEBHOOK_SECRET",
        "watchRepos": ["coalesce-labs/catalyst", "coalesce-labs/adva"],
        "repoColors": {
          "coalesce-labs/catalyst": "green",
          "coalesce-labs/adva": "blue"
        }
      },
      "linear": {
        "webhookSecretEnv": "CATALYST_LINEAR_WEBHOOK_SECRET",
        "teams": [
          { "key": "CTL", "vcsRepo": "coalesce-labs/catalyst" },
          { "key": "ADV", "vcsRepo": "coalesce-labs/adva" }
        ]
      }
    }
  }
}
```

| Field                                      | Where                            | Type                 | Default                            | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | -------------------------------- | -------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalyst.monitor.github.smeeChannel`      | `~/.config/catalyst/config.json` | string               | _(none)_                           | Per-machine smee.io channel URL the daemon tunnels deliveries through                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `catalyst.monitor.github.webhookSecretEnv` | `.catalyst/config.json`          | string               | `"CATALYST_WEBHOOK_SECRET"`        | **Name** of the env var the HMAC secret value is read from at runtime                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `catalyst.monitor.github.watchRepos`       | `.catalyst/config.json`          | string[]             | `[]`                               | Repos (owner/repo) subscribed at daemon startup — additive on top of worker-driven auto-discovery. See [Persistent watch list](/observability/webhooks/#persistent-watch-list).                                                                                                                                                                                                                                                                                                         |
| `catalyst.monitor.github.repoColors`       | `.catalyst/config.json`          | object               | `{}`                               | Map of `"owner/repo"` → color name. Colors the repo chip in the HUD activity feed. Supported values: `blue`, `green`, `purple`, `amber`, `red`, `teal`, `cyan`, `lime`.                                                                                                                                                                                                                                                                                                                 |
| `catalyst.monitor.linear.webhookSecretEnv` | `.catalyst/config.json`          | string               | `"CATALYST_LINEAR_WEBHOOK_SECRET"` | **Name** of the env var the Linear HMAC secret is read from. Empty/missing → `POST /api/webhook/linear` returns 503. See [Linear webhooks](/observability/webhooks/#linear-webhooks).                                                                                                                                                                                                                                                                                                   |
| `catalyst.monitor.linear.teams`            | `.catalyst/config.json`          | `{ key, vcsRepo }[]` | `[]`                               | Linear team→repo map (CTL-362). When a Linear webhook event carries a `team.key` that appears here (or a comment whose ticket prefix matches), the canonical envelope gets `attributes["vcs.repository.name"]` set so the HUD's REPO column populates for `linear.issue.*` / `linear.comment.*` / `linear.cycle.*` events. Each entry must have a non-empty `key` (team short key, e.g. `"CTL"`) and a `vcsRepo` in `"owner/repo"` shape; malformed entries are skipped with a warning. |
| `catalyst.monitor.suppressVersionWarning`  | `.catalyst/config.json`          | boolean              | `false`                            | Suppress the version-drift warning printed by `catalyst-monitor start` / `restart` when running an older daemon version than the highest available in the plugin cache. See [Version drift detection](/observability/webhooks/#version-drift-detection).                                                                                                                                                                                                                                |

Environment variable overrides:

- `CATALYST_SMEE_CHANNEL` — overrides any file-derived channel.
- The env var named by `webhookSecretEnv` (default `CATALYST_WEBHOOK_SECRET`) holds the shared
  GitHub HMAC secret value.
- The env var named by `monitor.linear.webhookSecretEnv` (default fallback
  `CATALYST_LINEAR_WEBHOOK_SECRET`) holds the Linear HMAC secret value.

If the channel is missing from both files (and unset in env), the receiver disables itself silently
and the daemon falls back to 10-minute polling. Run `plugins/dev/scripts/setup-webhooks.sh` to
provision both files and the secret.

**Deprecated location**: `catalyst.monitor.github.smeeChannel` was originally written to
`.catalyst/config.json` (Layer 1). The monitor still reads that location for one release cycle and
emits a one-shot deprecation warning on startup if it finds a value there. Re-running
`setup-webhooks.sh` migrates the value to the right home and clears it from the committed config.

### Deploy Verification (CTL-211)

Per-repo configuration for the orchestrator's production deploy state machine. When a repo emits
GitHub Deployments, the orchestrator's Phase 4 loop watches `deployment_status` events on the merge
SHA and only writes `status: "done"` after a `success` on the configured production environment.
Repos that don't emit Deployments opt out via `skipDeployVerification: true` (the default for
unknown repos), and the orchestrator short-circuits MERGED → done immediately.

```json
{
  "catalyst": {
    "deploy": {
      "coalesce-labs/adva": {
        "timeoutSec": 1800,
        "productionEnvironment": "production",
        "stagingEnvironment": "staging",
        "skipDeployVerification": false
      },
      "coalesce-labs/catalyst": {
        "skipDeployVerification": true
      }
    }
  }
}
```

| Field                                           | Where                   | Type    | Default        | Description                                                                                                                                                                       |
| ----------------------------------------------- | ----------------------- | ------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `catalyst.deploy.<repo>.timeoutSec`             | `.catalyst/config.json` | integer | `1800`         | Hard timeout for the deploy phase. After this elapses without a `deployment_status` resolution, the orchestrator escalates with `comms.attention` and writes `status: "stalled"`. |
| `catalyst.deploy.<repo>.productionEnvironment`  | `.catalyst/config.json` | string  | `"production"` | GitHub deployment environment that gates `status: "done"`.                                                                                                                        |
| `catalyst.deploy.<repo>.stagingEnvironment`     | `.catalyst/config.json` | string  | `"staging"`    | Optional staging environment shown in the dashboard but not gating.                                                                                                               |
| `catalyst.deploy.<repo>.skipDeployVerification` | `.catalyst/config.json` | boolean | `true`         | When `true`, MERGED → done immediately (today's CTL-133 behavior). When `false`, the new lifecycle states (`merged → deploying → done                                             | deploy-failed`) are driven by GitHub Deployment events. |

Lifecycle states the orchestrator writes to the worker's signal file (CTL-211):

| Status          | Trigger                                                                                            | Notes                                                |
| --------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| `merged`        | `gh pr view` returns `state=MERGED` AND `skipDeployVerification: false`                            | PR landed, waiting for deploy to start               |
| `deploying`     | `github.deployment.created` (or `_status` `in_progress`/`pending`) for production env on merge SHA | Deploy in flight                                     |
| `done`          | `github.deployment_status.success` for production env                                              | Terminal success — Linear ticket transitions to Done |
| `deploy-failed` | `github.deployment_status.failure                                                                  | error` for production env                            | Non-terminal failure within retry budget; raises `attention` |
| `stalled`       | `timeoutSec` elapsed without resolution                                                            | Escalates with `comms.attention "deploy-timeout"`    |

The retry budget is currently fixed at 3 attempts per worker. After the budget is exhausted,
attention is raised as `deploy-budget-exhausted` and the worker stays at `deploy-failed` until a
human intervenes.

**Repos without GitHub Deployments**: catalyst itself, repos using bare `git push` deploys, and most
CI-only setups. Set `skipDeployVerification: true` (the default) for these — the worker's terminal
state will be `done` immediately on PR merge, matching today's CTL-133 contract.

### AI Briefing

The monitor dashboard supports AI-powered status summaries. Configuration spans both layers:

**Project config** (`.catalyst/config.json`) — opt-in toggle:

```json
{
  "catalyst": {
    "ai": {
      "enabled": true
    }
  }
}
```

**Secrets config** (`~/.config/catalyst/config-{projectKey}.json`) — provider credentials:

```json
{
  "ai": {
    "gateway": "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}",
    "provider": "anthropic",
    "model": "claude-haiku-4-5-20251001",
    "apiKey": "sk-ant-..."
  }
}
```

| Field         | Required             | Default                     | Description                           |
| ------------- | -------------------- | --------------------------- | ------------------------------------- |
| `ai.enabled`  | Yes (project config) | `false`                     | Master toggle. No API calls when off. |
| `ai.gateway`  | Yes (secrets)        | —                           | Cloudflare AI Gateway URL             |
| `ai.provider` | No                   | `anthropic`                 | AI provider: `anthropic` or `openai`  |
| `ai.model`    | No                   | `claude-haiku-4-5-20251001` | Model ID                              |
| `ai.apiKey`   | Yes (secrets)        | —                           | Provider API key                      |

The AI briefing generates a natural-language status summary and suggests session labels based on
Linear ticket context. It is on-demand (button click) or optionally auto-refreshing. Zero cost when
disabled.

### AI Summarize Endpoint

The monitor exposes `POST /api/summarize` for on-demand orchestrator summaries. Unlike the briefing
endpoint (which routes through a Cloudflare AI gateway), summarize calls each provider directly
using an API key sourced from an environment variable.

**Project config** (`.catalyst/config.json`):

```json
{
  "catalyst": {
    "ai": {
      "enabled": true,
      "defaultProvider": "anthropic",
      "defaultModel": "claude-sonnet-4-6",
      "providers": {
        "anthropic": { "apiKeyEnv": "ANTHROPIC_API_KEY" },
        "openai": { "apiKeyEnv": "OPENAI_API_KEY" },
        "grok": { "apiKeyEnv": "XAI_API_KEY" }
      }
    }
  }
}
```

| Field                           | Required           | Default             | Description                                            |
| ------------------------------- | ------------------ | ------------------- | ------------------------------------------------------ |
| `ai.defaultProvider`            | No                 | `anthropic`         | Provider used when request omits `provider`            |
| `ai.defaultModel`               | No                 | `claude-sonnet-4-6` | Model used when request omits `model`                  |
| `ai.providers.{name}.apiKeyEnv` | Yes (per provider) | —                   | Name of the env var that holds that provider's API key |

Only providers whose `apiKeyEnv` resolves to a non-empty value at monitor startup are considered
enabled. If no providers have their env var set, the endpoint returns
`503 {"error": "AI not configured"}`.

**Request body** (`POST /api/summarize`):

| Field      | Required | Default        | Description                                            |
| ---------- | -------- | -------------- | ------------------------------------------------------ |
| `orchId`   | Yes      | —              | Orchestrator directory name (e.g. `orch-2026-04-22-3`) |
| `template` | No       | `run-summary`  | `run-summary`, `attention-digest`, or `worker-status`  |
| `provider` | No       | config default | `anthropic`, `openai`, or `grok`                       |
| `model`    | No       | config default | Provider-specific model ID                             |

**Response body** (`200 OK`):

```json
{
  "summary": "string",
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "cost": 0.0123,
  "tokens": 1500,
  "cached": false,
  "generatedAt": "2026-04-22T20:00:00.000Z"
}
```

Results are cached in-memory for 5 minutes keyed by
`(orchId, template, snapshotHash, provider, model)`. When the cache hits, `cached` is `true` and no
provider call is made. A simple per-provider rate limiter (concurrency + minimum interval) returns
`429` on bursts.

## Worktree Setup

Define the commands that run when creating a new worktree via `/create-worktree` or `/orchestrate`.
This replaces the default auto-detected setup (dependency install + thoughts init) with full project
control — like `conductor.json`'s lifecycle hooks.

```json
{
  "catalyst": {
    "worktree": {
      "setup": [
        "humanlayer thoughts init --directory ${DIRECTORY} --profile ${PROFILE}",
        "humanlayer thoughts sync",
        "bun install"
      ]
    }
  }
}
```

Commands run in order, inside the new worktree directory. Each command supports variable
substitution:

| Variable           | Value                                                                |
| ------------------ | -------------------------------------------------------------------- |
| `${WORKTREE_PATH}` | Absolute path to the new worktree                                    |
| `${BRANCH_NAME}`   | Git branch name                                                      |
| `${TICKET_ID}`     | Same as branch name                                                  |
| `${REPO_NAME}`     | Repository name                                                      |
| `${DIRECTORY}`     | Thoughts directory (from `catalyst.thoughts.directory` or repo name) |
| `${PROFILE}`       | Thoughts profile (from `catalyst.thoughts.profile` or auto-detected) |

If `catalyst.worktree.setup` is **not configured**, the script falls back to auto-detected setup:
`make setup` or `bun/npm install`, then `humanlayer thoughts init` + `sync`. Once you define
`setup`, only your commands run — the auto-detection is skipped entirely.

Catalyst now pre-trusts newly created worktrees in Claude Code automatically, so you do **not** need
to add a separate `trust-workspace.sh` command to your setup array.

## Orchestration Config

:::note[Config drift detection (CTL-489)] Any key documented in this reference that is also present
in `plugins/dev/templates/config.template.json` will be flagged by
`plugins/dev/scripts/check-config-drift.sh` if it's missing from your `.catalyst/config.json`. Drift
warnings appear on every workflow invocation as non-fatal yellow-bullet notes. Run
`/catalyst-dev:setup-catalyst` to interactively merge the missing template keys without overwriting
your existing values. See [setup-health-check](/reference/setup-health-check/) for the Phase 2 flow.
:::

Optional. Add this block to enable `/orchestrate` — see [Orchestration](/reference/orchestration/)
for full documentation.

```json
{
  "catalyst": {
    "orchestration": {
      "worktreeDir": null,
      "maxParallel": 3,
      "hooks": {
        "setup": ["bun install"],
        "teardown": []
      },
      "dispatchMode": "oneshot-legacy",
      "workerCommand": "/catalyst-dev:oneshot",
      "workerModel": "opus",
      "phaseAgents": {
        "models": {
          "implement": "sonnet",
          "pr": "sonnet",
          "monitor-deploy": "haiku"
        },
        "modelOverrides": {
          "implement": {
            "CTL-501": "opus"
          }
        },
        "turnCaps": {
          "implement": 100
        }
      },
      "testRequirements": {
        "backend": ["unit"],
        "frontend": ["unit"],
        "fullstack": ["unit"]
      },
      "verifyBeforeMerge": true,
      "allowSelfReportedCompletion": false,
      "keepWorktreeAfterMerge": false,
      "orphanReaper": {
        "enabled": true,
        "intervalSeconds": 600,
        "minIdleSeconds": 900
      }
    }
  }
}
```

| Field                                       | Type         | Default                      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worktreeDir`                               | string\|null | `~/catalyst/wt/<projectKey>` | Base directory for worktrees                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `maxParallel`                               | number       | 3                            | Max concurrent workers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `hooks.setup`                               | string[]     | `[]`                         | Run after worktree creation (supports `${WORKTREE_PATH}`, `${BRANCH_NAME}`, `${TICKET_ID}`, `${REPO_NAME}`, `${DIRECTORY}` variables)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `hooks.teardown`                            | string[]     | `[]`                         | Run before worktree removal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `dispatchMode`                              | string       | `"oneshot-legacy"`           | Worker spawn strategy. `"oneshot-legacy"` runs one long `claude -p /catalyst-dev:oneshot` per ticket (pre-CTL-452 model). `"phase-agents"` dispatches nine short-lived `claude --bg` jobs per ticket, one per phase, advancing on `phase.<name>.complete.<TICKET>` broker events. `"execution-core"` (CTL-554, CTL-582) is daemon-served: `/orchestrate` just ensures the single machine-level execution-core daemon is running and exits — no wave loop, no Phase 4 session. Enrolled projects are the central `~/catalyst/execution-core/registry.json` (maintained by `setup-execution-core-states.sh`), which the daemon reads directly. See [Phase agents](/reference/orchestration/phase-agents/) for the full pipeline. |
| `workerCommand`                             | string       | `/catalyst-dev:oneshot`      | Plugin-namespaced skill to dispatch in each worker (applies only when `dispatchMode = "oneshot-legacy"`). Must be in `/<plugin>:<skill>` form — bare slashes (e.g. `/oneshot`) are rejected at dispatch.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `workerModel`                               | string       | `opus`                       | Model for legacy oneshot worker sessions (applies only when `dispatchMode = "oneshot-legacy"`). For phase-agents mode, use `phaseAgents.models` instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `phaseAgents.models[phase]`                 | string       | `"opus"`                     | Per-phase default model when `dispatchMode = "phase-agents"`. Keys are phase names: `triage`, `research`, `plan`, `implement`, `verify`, `review`, `pr`, `monitor-merge`, `monitor-deploy`. Values are `opus`, `sonnet`, or `haiku`.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `phaseAgents.modelOverrides[phase][ticket]` | string       | none                         | Per-phase, per-ticket model override. Highest precedence after the `--model` CLI flag. Useful for one-off escape hatches (e.g., bumping a particularly ambiguous plan back to Opus).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `phaseAgents.turnCaps[phase]`               | number       | per-phase default            | Override the hard cap on Claude turns per phase. Per-phase defaults: triage 10, research 35, plan 25, implement 75, verify 20, review 25, pr 12, monitor-merge 50, monitor-deploy 30.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `testRequirements`                          | object       | See above                    | Required test types by scope (backend/frontend/fullstack)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `verifyBeforeMerge`                         | boolean      | `true`                       | Run adversarial verification on merged commits (post-merge)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `allowSelfReportedCompletion`               | boolean      | `false`                      | When `true`, verification failures are advisory (wave advances). When `false` (default), verification failures block wave advancement until remediation is filed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `keepWorktreeAfterMerge`                    | boolean      | `false`                      | When `false` (default), `phase-monitor-merge` auto-tears-down the local worktree + branch after a PR merges (CTL-649): it pre-sweeps any `claude --bg` sessions still cwd'd in the worktree, then `git worktree remove` + `git branch -D`. Set `true` to leave merged worktrees in place for manual inspection.                                                                                                                                                                                                                                                                                                                                          |
| `orphanReaper.enabled`                      | boolean      | `true`                       | When `true` (default), the execution-core daemon runs a periodic sweep (CTL-649) that emits `orphans.reap-requested`; the in-daemon reaper stops any `claude --bg` session whose cwd worktree no longer exists. Set `false` to disable the periodic backstop (the per-call-site reap-intent producers still fire).                                                                                                                                                                                                                                                                                                                                       |
| `orphanReaper.intervalSeconds`              | number       | `600`                        | Cadence of the periodic orphan sweep in seconds (default 10 minutes). Read at daemon launch from `.catalyst/config.json` (path overridable via `CATALYST_CONFIG_FILE`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `orphanReaper.minIdleSeconds`               | number       | `900`                        | Minimum LAST_SEEN (transcript mtime age) in seconds before the periodic orphan reaper will stop a session — protects recently-active sessions. A session whose transcript was touched within this window is left alone even if classified DONE/ORPHAN/DUPLICATE. Read at daemon launch alongside `enabled`/`intervalSeconds` (default 15 minutes).                                                                                                                                                                                                                                                                                                     |
| `draftPr.enabled`                           | boolean      | `true`                       | When `true` (default), `phase-implement` pushes the branch and opens a draft PR as soon as it has commits; `phase-pr` promotes that draft to ready instead of creating a new PR (CTL-709). Set `false` to disable and revert to the previous single-push-at-phase-pr behavior.                                                                                                                                                                                                                                                                                                                                                                       |
| `worktreeRefresh.enabled`                   | boolean      | `true`                       | When `true` (default), the execution-core daemon periodically rebases every idle running worktree onto `origin/<base>` (CTL-707 Layer 1), keeping dispatch-time rebases trivial. Set `false` to disable.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `worktreeRefresh.intervalSeconds`           | number       | `300`                        | How often (in seconds) the background refresh timer checks idle worktrees (default 5 minutes). Read at daemon launch alongside `enabled`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `worktreeRefresh.quietSeconds`              | number       | `30`                         | Minimum worktree-directory mtime age (in seconds) before a worktree is considered idle enough to refresh. Worktrees with a live `claude --bg` session are always skipped regardless of this value.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

For `dispatchMode: "execution-core"` the eligible-set query is **not** per-repo
config — it lives in the central registry's `eligibleQuery` (see [Central
Registry](#central-registry-catalystexecution-coreregistryjson) above), written
by `setup-execution-core-states.sh`.

### Execution-core concurrency (`executionCore.maxParallel`)

The **execution-core scheduler** (the daemon-served `dispatchMode`) reads its
worker-slot ceiling from a **committed** `orchestration.executionCore` block —
distinct from the legacy wave-`/orchestrate` `orchestration.maxParallel` above.
This is the source of truth for how many `claude --bg` phase workers the daemon
runs concurrently across all enrolled projects.

```json
{
  "catalyst": {
    "orchestration": {
      "executionCore": {
        "maxParallel": 4,
        "minParallel": 1,
        "maxParallelCeiling": 10
      }
    }
  }
}
```

| Field                            | Type   | Default | Description                                                                                                                                                                                                       |
| -------------------------------- | ------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executionCore.maxParallel`      | number | `4`     | Committed worker-slot ceiling for the execution-core scheduler. **Distinct from** the legacy wave `orchestration.maxParallel` (default 3) — these are separate code paths. The committed value is authoritative.   |
| `executionCore.minParallel`      | number | `1`     | Lower clamp on the resolved ceiling. Bound for the future adaptive-concurrency feature; given immediate teeth (a resolved value below it is raised to it).                                                          |
| `executionCore.maxParallelCeiling` | number | `10`    | Upper clamp on the resolved ceiling (the safe ceiling on the reference host). A resolved value above it is lowered to it.                                                                                          |

**Precedence:** the committed `executionCore.maxParallel` wins. The runtime
`~/catalyst/execution-core/state.json` `maxParallel` is an **optional back-compat
fallback**, consulted only when the committed config omits a valid value; a
shared hardcoded default is the last resort. The resolved value is then clamped
into `[minParallel, maxParallelCeiling]` when those bounds are present.

#### Layer-2 override (CTL-678)

The **live source of truth** is the machine-canonical Layer-2 file
`~/.config/catalyst/config.json` under the same key —
`catalyst.orchestration.executionCore`. The committed Layer-1 block above is
the **seed/fallback**, consulted per field only when the Layer-2 value is
absent or not a positive integer. Operators override per-field; set just
`maxParallel` in Layer-2 to inherit the Layer-1 bounds:

```json
// ~/.config/catalyst/config.json
{
  "catalyst": {
    "orchestration": {
      "executionCore": {
        "maxParallel": 6
      }
    }
  }
}
```

With the committed Layer-1 default of `{maxParallel:4, minParallel:1,
maxParallelCeiling:10}` and the Layer-2 above, the daemon's resolved boot
concurrency is `{maxParallel:6, minParallel:1, maxParallelCeiling:10}`.

The Layer-2 path is **host-wide** — `config.json`, no `projectKey` suffix.
The execution-core daemon is one-per-machine and serves all enrolled
projects, so this knob is a host knob, not a project knob. Per-project
concurrency and reserve budgets are modeled via `perProject` (see below).

Both files are also **hot-reloaded per scheduler tick** — the same per-tick
re-read CTL-676 introduced for Layer-1 also applies to Layer-2, so editing
either file takes effect on the next tick without a daemon restart. Operators
see the resolved boot object plus a `layer2Present` flag once in the daemon's
startup log (`execution-core: resolved boot concurrency`); the per-tick
behavior is identical to a fresh boot against the current on-disk state.

The env var `CATALYST_LAYER2_CONFIG_FILE` overrides the Layer-2 path for
tests; absent in production.

:::note The default stays **4**. The operator bump to **10** is a separate, later
config edit gated on CTL-661/662/663 being live — this knob is plumbing only.
The `executionCore` block carries **only** these three concurrency keys in the
template; `eligibleQuery` is intentionally central (registry.json, CTL-582 D4).
:::

**Hot-reload (CTL-676 + CTL-678).** `maxParallel`, `minParallel`, and
`maxParallelCeiling` are re-read by the execution-core scheduler on every tick
(~2s under event-log activity via the existing `fs.watch` + 2s debounce, ~30s
otherwise via the periodic backstop) from **both** the committed Layer-1
config and the machine-canonical Layer-2 file. The Layer-2 per-field merge
runs on every tick, so editing either file takes effect on the next tick
without a daemon restart. Lowering `maxParallel` mid-run gates new dispatch
only — in-flight workers continue (the dispatch gate is the only consumer of
the resolved ceiling). Other `executionCore` fields (`eligibleQuery` lives in
the central registry; `dispatchMode` and structural daemon fields elsewhere
in the config) remain boot-time only.

**Auto-tuner (CTL-684).** The daemon runs a side-car auto-tuner that samples
`os.loadavg()` and `os.freemem()` on a 30-second cadence while background
workers are active, applies an asymmetric trend-based decision rule, and writes
the adjusted `executionCore.maxParallel` into the Layer-2 config file. The
scheduler's hot-reload picks up the new value on its next tick — no daemon
restart required. Shrink is multiplicative (`×0.75`, fast back-off); growth is
additive (`+1`, slow ramp) to resist oscillation. Every write is atomic
(tmp + rename) and write-on-change only.

The auto-tuner is controlled by environment variables:

| Env var | Default | Effect |
|---|---|---|
| `EXECUTION_CORE_AUTOTUNE` | `1` (on) | Set to `0` to disable all sampling and Layer-2 writes |
| `EXECUTION_CORE_AUTOTUNE_SAMPLE_INTERVAL_MS` | `30000` | Sample cadence in ms |
| `EXECUTION_CORE_AUTOTUNE_WINDOW_SAMPLES` | `10` | Rolling window depth (~5 min at 30s) |
| `EXECUTION_CORE_AUTOTUNE_TREND_MIN_SAMPLES` | `3` | Consecutive samples required to declare a trend |
| `EXECUTION_CORE_AUTOTUNE_LOAD_SAFE_FACTOR` | `4` | `load1 < cores × factor` threshold for growth |
| `EXECUTION_CORE_AUTOTUNE_MEM_CRITICAL_PCT` | `5` | Free-memory % below which drops to `minParallel` |
| `EXECUTION_CORE_AUTOTUNE_MEM_WARN_PCT` | `20` | Free-memory % below which growth is suppressed |

Tuner events appear in the unified event log as
`phase.scheduler.parallelism-sampled.execution-core` and
`phase.scheduler.parallelism-adjusted.execution-core`.

Resolution order for both `phaseAgents.models` and `phaseAgents.turnCaps` is **CLI flag >
`modelOverrides[phase][ticket]` > `models[phase]` (or `turnCaps[phase]`) > built-in default**. The
dispatcher reads `dispatchMode` at
[`plugins/dev/scripts/orchestrate-dispatch-next:117`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/scripts/orchestrate-dispatch-next);
per-phase resolution lives in
[`phase-agent-dispatch:158-176`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/scripts/phase-agent-dispatch).

#### Per-project budgets (CTL-706)

The `perProject` map under `executionCore` assigns each enrolled project a
**hard cap** and/or a **guaranteed reserve** so one high-volume project cannot
starve another.

```json
{
  "catalyst": {
    "orchestration": {
      "executionCore": {
        "maxParallel": 8,
        "perProject": {
          "ADV": { "maxParallel": 6, "reserve": 2 },
          "CTL": { "maxParallel": 4, "reserve": 1 }
        }
      }
    }
  }
}
```

| Field                              | Type   | Description |
| ---------------------------------- | ------ | ----------- |
| `perProject.<KEY>.maxParallel`     | number | Hard per-project cap. The project may never dispatch more than this many concurrent workers, even when the global pool has free slots. |
| `perProject.<KEY>.reserve`         | number | Minimum guaranteed slot count. When this project has undispatched ready work, other projects yield so it can always reach this floor. |

**Three rules govern the interaction with the global ceiling:**

1. **`perProject.maxParallel` is a hard cap.** A project never exceeds it regardless of global free slots.
2. **`reserve` is a guaranteed floor.** When a project has waiting work and is below its reserve, the dispatcher withholds shared slots from other projects so the reserved project can claim them. A project filling its own reserve is never blocked by another project's reserve.
3. **`sum(reserve)` must be ≤ `maxParallel` (global).** The scheduler clamps over-subscribed reserves at config load and logs a one-time warning; `sum(perProject.maxParallel)` may exceed the global ceiling (projects share overflow slots) but reserves must fit.

**Layer-1 / Layer-2 merge:** the `perProject` map is deep-merged at the project-key level. Layer-2 can add a new project key or override individual sub-fields (`maxParallel` or `reserve`) for an existing key; other fields from Layer-1 are preserved. This lets a machine override just the ADV cap without touching the CTL reserve.

**Hot-reload:** `perProject` is re-read and re-merged on every tick alongside the scalar concurrency fields — no daemon restart required.

**Opt-in, additive.** With no `perProject` key in either config layer the scheduler behaves byte-for-byte as before CTL-706. No state migration required.

## Feedback Config

Optional. Controls where catalyst skills auto-file improvement tickets at run end and on whose
permission. CTL-183 ships the routing layer, CTL-176 ships the findings-collection layer that
populates it: skills call `plugins/dev/scripts/add-finding.sh` to record observations during a run,
and the end-of-run hook drains the queue via `file-feedback.sh`.

```json
{
  "catalyst": {
    "feedback": {
      "autoFile": false,
      "githubRepo": "coalesce-labs/catalyst",
      "labels": ["auto-submitted"]
    }
  }
}
```

| Field        | Type     | Default                    | Description                                                                                                                                           |
| ------------ | -------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoFile`   | boolean  | `false`                    | When `true`, skills may auto-file findings at run end without prompting. When `false` or absent, skills prompt before filing each run.                |
| `githubRepo` | string   | `"coalesce-labs/catalyst"` | `<owner>/<repo>` slug used when Linear filing fails or is unavailable. Defaults to upstream; override to redirect findings to your own fork.          |
| `labels`     | string[] | `["auto-submitted"]`       | Base labels applied to every auto-filed ticket. The invoking skill name is appended automatically (e.g., `oneshot`, `orchestrate`, `implement-plan`). |

### Routing

Skills attempt `linearis issues create` first, using `catalyst.linear.teamKey`. On Linear failure
(no API key, team mismatch, CLI unavailable), they fall back to
`gh issue create --repo <feedback.githubRepo>`. Destinations are never split — GitHub is used only
when Linear is unavailable.

### Consent

The first time a skill is ready to auto-file, it prompts:

> Would you like us to automatically file tickets at the end of each run? [Y/n]

- **Yes** → `autoFile` is set to `true` in `.catalyst/config.json`; no prompt on subsequent runs.
- **No** → nothing is persisted; the prompt will return on the next run.

Revoke by setting `autoFile` to `false` or deleting the `feedback` block. The
`plugins/dev/scripts/feedback-consent.sh` helper exposes `check`, `grant`, and `status` subcommands
for scripted use.

See [Integrations › Linear ⇄ GitHub Sync](/reference/integrations/#linear--github-sync) for the
maintainer-side setup that mirrors `auto-submitted`-labeled GitHub issues back into Linear.

### Findings queue

Skills record improvement findings the moment they are observed by calling
`plugins/dev/scripts/add-finding.sh` with `--title` and `--body`. Each call appends one JSON line to
a per-run queue; the end-of-run hook reads the queue and files one ticket per line via
`file-feedback.sh` (respecting consent and routing above).

Queue path resolution (first match wins):

1. `$CATALYST_FINDINGS_FILE` — orchestrator dispatch sets this to `<orch-dir>/findings.jsonl` so the
   orchestrator and all workers share one queue per run.
2. `.catalyst/findings/${CATALYST_SESSION_ID}.jsonl` — standalone oneshot / implement-plan runs,
   scoped to the catalyst session id.
3. `.catalyst/findings/current.jsonl` — final fallback when neither var is set.

Each line has the shape:

```json
{
  "ts": "2026-04-24T20:30:00Z",
  "skill": "oneshot",
  "title": "…",
  "body": "…",
  "severity": "low",
  "tags": []
}
```

The hook deletes the queue file after a successful full drain. On partial failure (some entries
filed, some not), the queue is preserved so the next run can retry.

## Archive Config

Optional. Controls where orchestrator artifacts are persisted and how long they are retained. The
archive is a hybrid SQLite index plus filesystem blob store written by `catalyst-archive` (see
[ADR-009](https://github.com/coalesce-labs/catalyst/blob/main/docs/adrs.md)).

Goes in the global user config at `~/.config/catalyst/config.json`:

```json
{
  "archive": {
    "root": "~/catalyst/archives",
    "syncToThoughts": false,
    "retention": { "days": 90 }
  }
}
```

| Field            | Type         | Default               | Description                                                                                                |
| ---------------- | ------------ | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `root`           | string       | `~/catalyst/archives` | Root directory for archived blobs. One subdirectory per orchestrator id.                                   |
| `syncToThoughts` | boolean      | `false`               | When `true`, `catalyst-archive sweep` also copies the top-level SUMMARY.md to `thoughts/shared/handoffs/`. |
| `retention.days` | number\|null | `null` (no prune)     | Default threshold for `catalyst-archive prune` when `--older-than` is not supplied.                        |

Environment variables override these paths when set:

- `CATALYST_ARCHIVE_ROOT` — overrides `archive.root`
- `CATALYST_RUNS_DIR` — orchestrator runtime source (default `~/catalyst/runs`)
- `CATALYST_DB_FILE` — SQLite index path (default `~/catalyst/catalyst.db`)
- `CATALYST_COMMS_DIR` — catalyst-comms source (default `~/catalyst/comms/channels`)

The archive root is created on first sweep and tolerates missing optional artifacts (e.g., a worker
without a rollup fragment). Re-running the sweep is idempotent (all upserts).

## Workflow Context (`.catalyst/.workflow-context.json`)

Auto-managed by Claude Code hooks and skills. Not committed to git.

```json
{
  "lastUpdated": "2025-10-26T10:30:00Z",
  "currentTicket": "PROJ-123",
  "orchestration": null,
  "mostRecentDocument": {
    "type": "plans",
    "path": "thoughts/shared/plans/...",
    "created": "2025-10-26T10:30:00Z",
    "ticket": "PROJ-123"
  },
  "workflow": {
    "research": [],
    "plans": [],
    "handoffs": [],
    "prs": []
  }
}
```

| Field           | Type           | Description                                                                                                                                                                     |
| --------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `currentTicket` | string \| null | Active ticket ID for this worktree                                                                                                                                              |
| `orchestration` | string \| null | Orchestration run name (set by `create-worktree.sh --orchestration`). Groups orchestrator + workers for per-run telemetry via `catalyst.orchestration` OTel resource attribute. |

This file is what enables skill chaining — when you save research, `create-plan` finds it
automatically. When you save a plan, `implement-plan` finds it. You never need to specify file paths
between workflow phases.

### Script API

The `workflow-context.sh` script manages this file programmatically:

```bash
workflow-context.sh init                    # Create file if missing
workflow-context.sh set-ticket PROJ-123     # Set currentTicket (no document needed)
workflow-context.sh set-orchestration NAME  # Set orchestration run name
workflow-context.sh add research "path" "PROJ-123"  # Add document + set ticket
workflow-context.sh recent research         # Get most recent document of type
workflow-context.sh most-recent             # Get most recent document (any type)
workflow-context.sh ticket PROJ-123         # Get all documents for a ticket
```

### Initialization

The workflow context file is created automatically at several points:

- **Skill prerequisites** — all workflow skills call `check-project-setup.sh` which runs
  `workflow-context.sh init`
- **Worktree creation** — `create-worktree.sh` initializes the file and sets `currentTicket` from
  the worktree name (e.g., worktree `ENG-123` sets ticket to `ENG-123`)
- **Ticket-based skills** — `/oneshot PROJ-123` calls `set-ticket` immediately after parsing the
  ticket, before any research begins

### OpenTelemetry Integration

The workflow context file is also read by [direnv](https://direnv.net/) to populate
`OTEL_RESOURCE_ATTRIBUTES` with the current ticket. This enables per-ticket telemetry correlation in
Claude Code's native OpenTelemetry support.

**Setup**: Add a `.envrc` to your repo root:

```bash
source_up
use_otel_context "your-project-name"
```

The `use_otel_context` function (from `~/.config/direnv/lib/otel.sh`) sets these OTEL resource
attributes:

| Attribute    | Source                                                                   |
| ------------ | ------------------------------------------------------------------------ |
| `project`    | Argument to `use_otel_context`                                           |
| `hostname`   | Machine short name                                                       |
| `git.branch` | Current git branch                                                       |
| `linear.key` | Ticket from branch name, fallback to `currentTicket` in workflow context |

`source_up` inherits environment from parent `.envrc` files (e.g., profile-based secrets at the
workspace root). When using worktrees, `create-worktree.sh` generates a `.envrc` and runs
`direnv allow` automatically.

**Execution-core daemon identity (CTL-635).** The per-ticket attributes above are correct for an
interactive shell, but the `catalyst-execution-core` daemon's `claude --bg` worker pool freezes
`OTEL_RESOURCE_ATTRIBUTES` at warm time and it's immutable thereafter — so without intervention,
every bg phase worker would inherit (and mis-attribute its cost to) whatever per-ticket context
happened to be set in the launch shell. To prevent this, the daemon **scrubs** the inherited
per-ticket keys (`project`, `branch`, `linear.key`, `catalyst.orchestration`, `task.type`) at
launch and stamps a neutral, honest identity instead:

```text
project=catalyst,catalyst.role=execution-core-daemon
```

So daemon-spawned bg workers carry `catalyst.role=execution-core-daemon` rather than a per-ticket
`linear.key`, and their `claude_code_cost_usage_USD_total` lands in one truthful daemon bucket
instead of being borrowed by an unrelated ticket. (True per-ticket attribution for the bg pool would
require an Anthropic per-job env API; the scrub is the honest fallback until then.)

## direnv Setup (Recommended)

[direnv](https://direnv.net/) is recommended when working across multiple repositories. It
automatically loads per-directory environment variables, keeping API keys isolated between projects
and populating OTel resource attributes for observability.

### Installation

```bash
brew install direnv
```

Add the shell hook to your profile (`~/.zshrc` or `~/.bashrc`):

```bash
eval "$(direnv hook zsh)"   # or bash
```

### Library Functions

Catalyst ships two direnv library functions. Install them to `~/.config/direnv/lib/` so they're
available in all `.envrc` files:

**`use_profile`** — loads environment variables from a named profile file:

```bash
# ~/.config/direnv/lib/profiles.sh
# Loads vars from ~/.config/direnv/profiles/{name}.env
# Later profiles override earlier ones.
```

**`use_otel_context`** — sets `OTEL_RESOURCE_ATTRIBUTES` for telemetry correlation. The
canonical source lives at `plugins/dev/direnv/lib/otel.sh` in the catalyst repo; install it
into `~/.config/direnv/lib/`:

```bash
cp ~/.claude/plugins/marketplaces/catalyst/plugins/dev/direnv/lib/otel.sh \
   ~/.config/direnv/lib/otel.sh
direnv reload
```

The function sets `project`, `hostname`, `branch`, `linear.key`, and `catalyst.orchestration`.
It dedups `OTEL_RESOURCE_ATTRIBUTES` on every direnv reload (last-write-wins per key, per
CTL-637) — older copies of the file accumulate duplicate keys across multiple `cd` events.
`check-setup.sh` warns if the installed copy differs from the vendored source and prints the
re-install command.

### Profile Files

Create profile files at `~/.config/direnv/profiles/` to separate credentials by project:

```
~/.config/direnv/profiles/
├── personal.env     # Global defaults (Cloudflare, AWS, PostHog)
├── adva.env         # Client-specific keys (Supabase, Postmark, geocoding APIs)
├── slides.env       # Project-specific keys (ElevenLabs, Gemini TTS)
└── accounting.env   # Project-specific keys (Wave, Monarch)
```

Each file is a simple `KEY=value` format — no `export` prefix needed (direnv handles that).

### Per-Project `.envrc` Files

Each project root gets an `.envrc` file that layers profiles and sets OTel context:

```bash
# ~/code-repos/github/acme/project/.envrc
use_profile personal          # Base credentials
use_profile acme              # Client-specific overrides
use_otel_context "acme"       # OTel resource attributes
```

Sub-directories (e.g., Conductor workspaces or worktrees) inherit from the parent:

```bash
# ~/conductor/workspaces/acme/workspace-1/.envrc
source_up                     # Inherit from parent .envrc
use_otel_context "acme"       # OTel context for this workspace
```

The `source_up` directive walks up the directory tree until it finds a parent `.envrc`, chaining
configurations. This means worktrees and Conductor workspaces automatically get the parent project's
API keys without duplicating them.

### Why This Matters for Multi-Repo Work

Without direnv, API keys end up in shell profiles (`.zshrc`) where they're global — every project
sees every key. With direnv profiles:

- **Credentials are scoped** — `cd` into a project and only its keys are loaded
- **OTel attributes are automatic** — every Claude Code session gets the right `project` and
  `linear.key` labels without manual configuration
- **Worktrees inherit** — `source_up` means new worktrees get the right environment immediately
- **No secret leakage** — `.envrc` files are committed (they reference profiles, not secrets);
  profile `.env` files are local-only

## Thoughts System

The thoughts system provides git-backed persistent context across sessions. The setup script handles
initialization, but for manual setup:

```bash
cd /path/to/your-project
humanlayer thoughts init

# Or with a specific profile for multi-project isolation
humanlayer thoughts init --profile acme
```

Directory structure:

```
<org_root>/
├── thoughts/                    # Shared by all org projects
│   ├── repos/
│   │   ├── project-a/
│   │   │   ├── {your_name}/
│   │   │   └── shared/
│   │   └── project-b/
│   └── global/
├── project-a/
│   └── thoughts/                # Symlinks to ../thoughts/repos/project-a/
└── project-b/
    └── thoughts/                # Symlinks to ../thoughts/repos/project-b/
```

### Syncing and Backup

```bash
humanlayer thoughts sync                          # Sync changes
humanlayer thoughts status                        # Check status
humanlayer thoughts sync -m "Updated research"    # Sync with message

# Back up to GitHub
cd <org_root>/thoughts
gh repo create my-thoughts --private --source=. --push
```

## Switching Projects

Change `projectKey` in `.catalyst/config.json` to point to a different secrets file:

```json
{
  "catalyst": {
    "projectKey": "work"
  }
}
```

For fully isolated multi-client setups, see [Multi-Project Setup](/getting-started/multi-project/).

## Troubleshooting

### Config not being read

1. File exists: `ls .catalyst/config.json`
2. Valid JSON: `cat .catalyst/config.json | jq`
3. Correct location: must be in the `.catalyst/` directory (or `.claude/` for backward compat)
4. Secrets file exists: `ls ~/.config/catalyst/config-{projectKey}.json`

### Thoughts not syncing

```bash
humanlayer thoughts status
humanlayer thoughts init  # Re-initialize if needed
```
