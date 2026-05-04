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
| `catalyst.linear.stateIds`      | object\|null | Map of Linear state display names to UUIDs. Eliminates per-call UUID resolution.                  |
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
| `inReview`   | Running `create-pr` or `describe-pr` | In Review   |
| `done`       | Running `merge-pr`                   | Done        |
| `canceled`   | Manual cancellation                  | Canceled    |

Set any key to `null` to skip that automatic transition.

**`stateMap` values are auto-detected from Linear** — when you run `setup-catalyst.sh` with a Linear
API token, the script fetches your team's actual workflow states and populates `stateMap` with the
correct names. Manual customization is only needed for non-standard state names.

### Cached UUIDs

The `teamId` and `stateIds` fields cache Linear UUIDs so that `linear-transition.sh` can pass them
directly to the linearis CLI, skipping per-call name-to-UUID resolution. This reduces Linear API
requests by ~17% per state transition — significant during orchestrator runs with parallel workers.

Populate the cache by running:

```bash
plugins/dev/scripts/resolve-linear-ids.sh
```

This makes a single Linear GraphQL query to fetch all workflow states for the configured team and
writes the results to `.catalyst/config.json`. Re-run with `--force` after changing workflow states
in Linear. The cache is optional — `linear-transition.sh` falls back to name-based calls when
`stateIds` is absent.

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

For this repo shape, the recommended required check currently enabled in GitHub is:

- `Cloudflare Pages`

Once your repository runs the following checks on **every** PR to `main`, you should add them as
required checks too:

- `audit-references`
- `check-versions`
- `validate`

`Cloudflare Pages` covers preview deploy readiness. The other three checks are repository-owned
guardrails:

- `audit-references` catches broken plugin references
- `check-versions` verifies plugin changes are releasable through Release Please
- `validate` checks release configuration consistency

If your repository has additional always-on checks, add them too. The important rule is: only mark a
check as required if it runs on every PR to `main`.

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

| Integration | Required Fields               | Used By                          |
| ----------- | ----------------------------- | -------------------------------- |
| Linear      | `apiToken`, `teamKey`         | catalyst-dev, catalyst-pm        |
| Sentry      | `org`, `project`, `authToken` | catalyst-debugging               |
| PostHog     | `apiKey`, `projectId`         | catalyst-analytics               |
| Exa         | `apiKey`                      | catalyst-dev (external research) |

Only configure the integrations you use. The setup script prompts for each one.

### Monitor OTel Config

The orchestration monitor reads OpenTelemetry backend endpoints from the per-project secrets
file `~/.config/catalyst/config-<projectKey>.json` (layer 2). If that file is not present it
falls back to the global `~/.config/catalyst/config.json`.

```json
{
  "otel": {
    "enabled": true,
    "prometheusUrl": "http://localhost:9090",
    "lokiUrl": "http://localhost:3100"
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `otel.enabled` | boolean | `false` | Enable OTel proxy endpoints on orch-monitor |
| `otel.prometheusUrl` | string | `null` | Prometheus query URL (for `/api/otel/query` and cost/token panels) |
| `otel.lokiUrl` | string | `null` | Loki query URL (for `/api/otel/logs`, Tool Usage, and API Errors panels) |

Environment variable overrides: `OTEL_ENABLED`, `PROMETHEUS_URL`, `LOKI_URL`. Env vars take
precedence over the file when both are set.

**Deprecated names**: the monitor still accepts `otel.prometheus` and `otel.loki` for one
release cycle, but emits a deprecation warning on startup. Rename to `otel.prometheusUrl` and
`otel.lokiUrl` to silence the warning.

If you're running the [claude-code-otel](https://github.com/ryanrozich/claude-code-otel) Docker
Compose stack locally, the defaults above match the standard ports. For hosted backends (Grafana
Cloud, Datadog, etc.), point these URLs at your hosted Prometheus/Loki-compatible endpoints.

See [Setting up the OTel stack](/observability/setup/) for the full installation guide.

### Monitor Webhook Config

The orch-monitor daemon receives GitHub events through a smee.io tunnel — see
[GitHub webhooks for orch-monitor](/observability/webhooks/) for the why and the full setup
flow. The webhook config is split across two files because the channel URL is per-machine
(one daemon, one tunnel, every project on the laptop) while the env-var **name** is
team-wide.

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
        "watchRepos": [
          "coalesce-labs/catalyst",
          "coalesce-labs/adva"
        ]
      },
      "linear": {
        "webhookSecretEnv": "CATALYST_LINEAR_WEBHOOK_SECRET"
      }
    }
  }
}
```

| Field | Where | Type | Default | Description |
|-------|-------|------|---------|-------------|
| `catalyst.monitor.github.smeeChannel` | `~/.config/catalyst/config.json` | string | _(none)_ | Per-machine smee.io channel URL the daemon tunnels deliveries through |
| `catalyst.monitor.github.webhookSecretEnv` | `.catalyst/config.json` | string | `"CATALYST_WEBHOOK_SECRET"` | **Name** of the env var the HMAC secret value is read from at runtime |
| `catalyst.monitor.github.watchRepos` | `.catalyst/config.json` | string[] | `[]` | Repos (owner/repo) subscribed at daemon startup — additive on top of worker-driven auto-discovery. See [Persistent watch list](/observability/webhooks/#persistent-watch-list). |
| `catalyst.monitor.linear.webhookSecretEnv` | `.catalyst/config.json` | string | `"CATALYST_LINEAR_WEBHOOK_SECRET"` | **Name** of the env var the Linear HMAC secret is read from. Empty/missing → `POST /api/webhook/linear` returns 503. See [Linear webhooks](/observability/webhooks/#linear-webhooks). |
| `catalyst.monitor.suppressVersionWarning` | `.catalyst/config.json` | boolean | `false` | Suppress the version-drift warning printed by `catalyst-monitor start` / `restart` when running an older daemon version than the highest available in the plugin cache. See [Version drift detection](/observability/webhooks/#version-drift-detection). |

Environment variable overrides:
- `CATALYST_SMEE_CHANNEL` — overrides any file-derived channel.
- The env var named by `webhookSecretEnv` (default `CATALYST_WEBHOOK_SECRET`) holds the
  shared GitHub HMAC secret value.
- The env var named by `monitor.linear.webhookSecretEnv` (default fallback
  `CATALYST_LINEAR_WEBHOOK_SECRET`) holds the Linear HMAC secret value.

If the channel is missing from both files (and unset in env), the receiver disables itself
silently and the daemon falls back to 10-minute polling. Run `plugins/dev/scripts/setup-webhooks.sh`
to provision both files and the secret.

**Deprecated location**: `catalyst.monitor.github.smeeChannel` was originally written to
`.catalyst/config.json` (Layer 1). The monitor still reads that location for one release
cycle and emits a one-shot deprecation warning on startup if it finds a value there.
Re-running `setup-webhooks.sh` migrates the value to the right home and clears it from the
committed config.

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

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `ai.enabled` | Yes (project config) | `false` | Master toggle. No API calls when off. |
| `ai.gateway` | Yes (secrets) | — | Cloudflare AI Gateway URL |
| `ai.provider` | No | `anthropic` | AI provider: `anthropic` or `openai` |
| `ai.model` | No | `claude-haiku-4-5-20251001` | Model ID |
| `ai.apiKey` | Yes (secrets) | — | Provider API key |

The AI briefing generates a natural-language status summary and suggests session labels based on
Linear ticket context. It is on-demand (button click) or optionally auto-refreshing. Zero cost
when disabled.

### AI Summarize Endpoint

The monitor exposes `POST /api/summarize` for on-demand orchestrator summaries. Unlike the
briefing endpoint (which routes through a Cloudflare AI gateway), summarize calls each provider
directly using an API key sourced from an environment variable.

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
        "openai":    { "apiKeyEnv": "OPENAI_API_KEY" },
        "grok":      { "apiKeyEnv": "XAI_API_KEY" }
      }
    }
  }
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `ai.defaultProvider` | No | `anthropic` | Provider used when request omits `provider` |
| `ai.defaultModel` | No | `claude-sonnet-4-6` | Model used when request omits `model` |
| `ai.providers.{name}.apiKeyEnv` | Yes (per provider) | — | Name of the env var that holds that provider's API key |

Only providers whose `apiKeyEnv` resolves to a non-empty value at monitor startup are considered
enabled. If no providers have their env var set, the endpoint returns `503 {"error": "AI not
configured"}`.

**Request body** (`POST /api/summarize`):

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `orchId` | Yes | — | Orchestrator directory name (e.g. `orch-2026-04-22-3`) |
| `template` | No | `run-summary` | `run-summary`, `attention-digest`, or `worker-status` |
| `provider` | No | config default | `anthropic`, `openai`, or `grok` |
| `model` | No | config default | Provider-specific model ID |

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

Results are cached in-memory for 5 minutes keyed by `(orchId, template, snapshotHash, provider,
model)`. When the cache hits, `cached` is `true` and no provider call is made. A simple
per-provider rate limiter (concurrency + minimum interval) returns `429` on bursts.

## Worktree Setup

Define the commands that run when creating a new worktree via `/create-worktree` or `/orchestrate`. This replaces the default auto-detected setup (dependency install + thoughts init) with full project control — like `conductor.json`'s lifecycle hooks.

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

Commands run in order, inside the new worktree directory. Each command supports variable substitution:

| Variable | Value |
|----------|-------|
| `${WORKTREE_PATH}` | Absolute path to the new worktree |
| `${BRANCH_NAME}` | Git branch name |
| `${TICKET_ID}` | Same as branch name |
| `${REPO_NAME}` | Repository name |
| `${DIRECTORY}` | Thoughts directory (from `catalyst.thoughts.directory` or repo name) |
| `${PROFILE}` | Thoughts profile (from `catalyst.thoughts.profile` or auto-detected) |

If `catalyst.worktree.setup` is **not configured**, the script falls back to auto-detected setup: `make setup` or `bun/npm install`, then `humanlayer thoughts init` + `sync`. Once you define `setup`, only your commands run — the auto-detection is skipped entirely.

Catalyst now pre-trusts newly created worktrees in Claude Code automatically, so you do **not**
need to add a separate `trust-workspace.sh` command to your setup array.

## Orchestration Config

Optional. Add this block to enable `/orchestrate` — see [Orchestration](/reference/orchestration/) for full documentation.

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
      "workerCommand": "/catalyst-dev:oneshot",
      "workerModel": "opus",
      "testRequirements": {
        "backend": ["unit"],
        "frontend": ["unit"],
        "fullstack": ["unit"]
      },
      "verifyBeforeMerge": true,
      "allowSelfReportedCompletion": false
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `worktreeDir` | string\|null | `~/catalyst/wt/<projectKey>` | Base directory for worktrees |
| `maxParallel` | number | 3 | Max concurrent workers |
| `hooks.setup` | string[] | `[]` | Run after worktree creation (supports `${WORKTREE_PATH}`, `${BRANCH_NAME}`, `${TICKET_ID}`, `${REPO_NAME}`, `${DIRECTORY}` variables) |
| `hooks.teardown` | string[] | `[]` | Run before worktree removal |
| `workerCommand` | string | `/catalyst-dev:oneshot` | Plugin-namespaced skill to dispatch in each worker. Must be in `/<plugin>:<skill>` form — bare slashes (e.g. `/oneshot`) are rejected at dispatch. |
| `workerModel` | string | `opus` | Model for worker sessions |
| `testRequirements` | object | See above | Required test types by scope (backend/frontend/fullstack) |
| `verifyBeforeMerge` | boolean | `true` | Run adversarial verification on merged commits (post-merge) |
| `allowSelfReportedCompletion` | boolean | `false` | When `true`, verification failures are advisory (wave advances). When `false` (default), verification failures block wave advancement until remediation is filed |

## Feedback Config

Optional. Controls where catalyst skills auto-file improvement tickets at run end and on whose
permission. CTL-183 ships the routing layer, CTL-176 ships the findings-collection layer that
populates it: skills call `plugins/dev/scripts/add-finding.sh` to record observations during a
run, and the end-of-run hook drains the queue via `file-feedback.sh`.

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

| Field         | Type     | Default                      | Description                                                                                                                                           |
| ------------- | -------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoFile`    | boolean  | `false`                      | When `true`, skills may auto-file findings at run end without prompting. When `false` or absent, skills prompt before filing each run.                |
| `githubRepo`  | string   | `"coalesce-labs/catalyst"`   | `<owner>/<repo>` slug used when Linear filing fails or is unavailable. Defaults to upstream; override to redirect findings to your own fork.          |
| `labels`      | string[] | `["auto-submitted"]`         | Base labels applied to every auto-filed ticket. The invoking skill name is appended automatically (e.g., `oneshot`, `orchestrate`, `implement-plan`). |

### Routing

Skills attempt `linearis issues create` first, using `catalyst.linear.teamKey`. On Linear
failure (no API key, team mismatch, CLI unavailable), they fall back to
`gh issue create --repo <feedback.githubRepo>`. Destinations are never split — GitHub is used
only when Linear is unavailable.

### Consent

The first time a skill is ready to auto-file, it prompts:

> Would you like us to automatically file tickets at the end of each run? [Y/n]

- **Yes** → `autoFile` is set to `true` in `.catalyst/config.json`; no prompt on subsequent runs.
- **No** → nothing is persisted; the prompt will return on the next run.

Revoke by setting `autoFile` to `false` or deleting the `feedback` block. The
`plugins/dev/scripts/feedback-consent.sh` helper exposes `check`, `grant`, and `status`
subcommands for scripted use.

See [Integrations › Linear ⇄ GitHub Sync](/reference/integrations/#linear--github-sync) for the
maintainer-side setup that mirrors `auto-submitted`-labeled GitHub issues back into Linear.

### Findings queue

Skills record improvement findings the moment they are observed by calling
`plugins/dev/scripts/add-finding.sh` with `--title` and `--body`. Each call appends one JSON
line to a per-run queue; the end-of-run hook reads the queue and files one ticket per line
via `file-feedback.sh` (respecting consent and routing above).

Queue path resolution (first match wins):

1. `$CATALYST_FINDINGS_FILE` — orchestrator dispatch sets this to
   `<orch-dir>/findings.jsonl` so the orchestrator and all workers share one queue per run.
2. `.catalyst/findings/${CATALYST_SESSION_ID}.jsonl` — standalone oneshot / implement-plan
   runs, scoped to the catalyst session id.
3. `.catalyst/findings/current.jsonl` — final fallback when neither var is set.

Each line has the shape:

```json
{"ts":"2026-04-24T20:30:00Z","skill":"oneshot","title":"…","body":"…","severity":"low","tags":[]}
```

The hook deletes the queue file after a successful full drain. On partial failure (some
entries filed, some not), the queue is preserved so the next run can retry.

## Archive Config

Optional. Controls where orchestrator artifacts are persisted and how long they are retained.
The archive is a hybrid SQLite index plus filesystem blob store written by
`catalyst-archive` (see [ADR-009](https://github.com/coalesce-labs/catalyst/blob/main/docs/adrs.md)).

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

| Field             | Type         | Default               | Description                                                                                      |
| ----------------- | ------------ | --------------------- | ------------------------------------------------------------------------------------------------ |
| `root`            | string       | `~/catalyst/archives` | Root directory for archived blobs. One subdirectory per orchestrator id.                         |
| `syncToThoughts`  | boolean      | `false`               | When `true`, `catalyst-archive sweep` also copies the top-level SUMMARY.md to `thoughts/shared/handoffs/`. |
| `retention.days`  | number\|null | `null` (no prune)     | Default threshold for `catalyst-archive prune` when `--older-than` is not supplied.              |

Environment variables override these paths when set:

- `CATALYST_ARCHIVE_ROOT` — overrides `archive.root`
- `CATALYST_RUNS_DIR` — orchestrator runtime source (default `~/catalyst/runs`)
- `CATALYST_DB_FILE` — SQLite index path (default `~/catalyst/catalyst.db`)
- `CATALYST_COMMS_DIR` — catalyst-comms source (default `~/catalyst/comms/channels`)

The archive root is created on first sweep and tolerates missing optional artifacts (e.g., a
worker without a rollup fragment). Re-running the sweep is idempotent (all upserts).

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

| Field | Type | Description |
|-------|------|-------------|
| `currentTicket` | string \| null | Active ticket ID for this worktree |
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

- **Skill prerequisites** — all workflow skills call `check-project-setup.sh` which runs `workflow-context.sh init`
- **Worktree creation** — `create-worktree.sh` initializes the file and sets `currentTicket` from the worktree name (e.g., worktree `ENG-123` sets ticket to `ENG-123`)
- **Ticket-based skills** — `/oneshot PROJ-123` calls `set-ticket` immediately after parsing the ticket, before any research begins

### OpenTelemetry Integration

The workflow context file is also read by [direnv](https://direnv.net/) to populate
`OTEL_RESOURCE_ATTRIBUTES` with the current ticket. This enables per-ticket telemetry correlation
in Claude Code's native OpenTelemetry support.

**Setup**: Add a `.envrc` to your repo root:

```bash
source_up
use_otel_context "your-project-name"
```

The `use_otel_context` function (from `~/.config/direnv/lib/otel.sh`) sets these OTEL resource
attributes:

| Attribute | Source |
|-----------|--------|
| `project` | Argument to `use_otel_context` |
| `hostname` | Machine short name |
| `git.branch` | Current git branch |
| `linear.key` | Ticket from branch name, fallback to `currentTicket` in workflow context |

`source_up` inherits environment from parent `.envrc` files (e.g., profile-based secrets at the
workspace root). When using worktrees, `create-worktree.sh` generates a `.envrc` and runs
`direnv allow` automatically.

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

**`use_otel_context`** — sets `OTEL_RESOURCE_ATTRIBUTES` for telemetry correlation:

```bash
# ~/.config/direnv/lib/otel.sh
# Sets project, hostname, git.branch, linear.key, catalyst.orchestration
```

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
