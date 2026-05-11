---
title: Integrations
description: Third-party service integrations — setup, configuration, and available skills.
sidebar:
  order: 4
---

Catalyst integrates with external services via CLI tools and MCP servers. Each integration requires credentials in your [secrets config](/reference/configuration/#secrets-config-configcatalystconfig-projectkeyjson).

## GitHub

Pull request creation, code review, and repository management via the `gh` CLI.

**Setup**: `brew install gh && gh auth login`

No Catalyst-specific configuration needed — `gh` uses its own authentication.

**Related skills**: `/catalyst-dev:create-pr`, `/catalyst-dev:describe-pr`, `/catalyst-dev:merge-pr`, `/catalyst-dev:commit`, `/catalyst-pm-ops:sync-prs`

### PR-Linear Sync

The `/catalyst-pm-ops:sync-prs` skill correlates GitHub PRs with Linear issues — matching via branch names and descriptions, identifying orphaned PRs and issues, and flagging stale PRs.

### Worktree Integration

Worktrees created with `/catalyst-dev:create-worktree` automatically set up branches with ticket references (e.g., `PROJ-123-feature-name`).

## Linear

Ticket management and automatic status progression via the [Linearis CLI](https://www.npmjs.com/package/linearis).

**Setup**: `npm install -g linearis` + add `apiToken` and `teamKey` to secrets config.

**Why CLI instead of MCP?** Linearis uses ~1K tokens vs Linear MCP's ~13K — a 13x reduction in context cost.

**Related skills**: `/catalyst-dev:linear`, `/catalyst-pm-ops:analyze-cycle`, `/catalyst-pm-ops:analyze-milestone`, `/catalyst-pm-ops:groom-backlog`, `/catalyst-pm-ops:sync-prs`

### Automatic Status Updates

Workflow skills automatically update Linear ticket status as you progress:

| Skill | Linear State |
|-------|-------------|
| `/catalyst-dev:research-codebase` | In Progress |
| `/catalyst-dev:create-plan` | In Progress |
| `/catalyst-dev:implement-plan` | In Progress |
| `/catalyst-dev:create-pr` | In Review |
| `/catalyst-dev:merge-pr` | Done |

Customize state names via `stateMap` in your [project config](/reference/configuration/#state-map).

### Ticket Detection

Skills detect tickets automatically from plan frontmatter (`ticket: PROJ-123`), filenames, handoff documents, and worktree directory names.

### Linear ⇄ GitHub Sync

Catalyst's feedback routing (see [Feedback Config](/reference/configuration/#feedback-config))
prefers Linear but falls back to a GitHub issue on a configured repository when Linear is
unavailable. Maintainers can mirror those GitHub issues back into Linear via Linear's native
GitHub integration, so all auto-filed tickets land in the same triage queue regardless of who
filed them.

**Setup** (one-time, Linear workspace admin):

1. In Linear, open **Settings → Integrations → GitHub**.
2. Connect the Linear workspace to the repository that receives fallback filings (default:
   `coalesce-labs/catalyst`, or whatever `catalyst.feedback.githubRepo` is set to in your
   project config).
3. In the connector's issue-sync rules, filter on the `auto-submitted` label so only
   agent-filed issues are mirrored.
4. Map the target Linear team (e.g., `CTL`) and the default status (e.g., `Backlog`).

Once configured, any GitHub issue created by a Catalyst skill surfaces in the maintainer's
Linear workspace automatically, preserving the `auto-submitted` label plus the skill-name
label (e.g., `oneshot`, `orchestrate`). See Linear's [GitHub integration
docs](https://linear.app/docs/github) for the current setup UI.

## Sentry

Production error monitoring via the `catalyst-debugging` plugin.

**Setup**: `npm install -g @sentry/cli` + add `org`, `project`, and `authToken` to secrets config.

**Context cost**: ~20K tokens when enabled. Enable only during debugging:

```bash
/plugin enable catalyst-debugging    # +20K context
/plugin disable catalyst-debugging   # -20K context
```

**Related skills**: `/catalyst-debugging:debug-production-error`, `/catalyst-debugging:error-impact-analysis`, `/catalyst-debugging:trace-analysis`

**Research agent**: `@catalyst-dev:sentry-research` (Haiku) — gathers error data via Sentry CLI.

## PostHog

Product analytics via the `catalyst-analytics` plugin.

**Setup**: Add `apiKey` and `projectId` to secrets config.

**Context cost**: ~40K tokens when enabled. Enable only when analyzing user behavior:

```bash
/plugin enable catalyst-analytics    # +40K context
/plugin disable catalyst-analytics   # -40K context
```

**Related skills**: `/catalyst-analytics:analyze-user-behavior`, `/catalyst-analytics:segment-analysis`, `/catalyst-analytics:product-metrics`

PostHog is used in two distinct ways inside Catalyst:

- **Read** — the `catalyst-analytics` plugin queries PostHog for product metrics and user behavior.
- **Write** — the `catalyst-otel-forward` daemon (CTL-306) ships canonical events to PostHog as a
  forwarder destination. See [Event Forwarding](/observability/forwarder/) and the
  [Forwarders configuration](/reference/configuration/#forwarders-catalystobservabilityforwarders-ctl-306).

## Groq

Semantic event routing for the `catalyst-broker` daemon (CTL-303).

**Setup**: Add `apiKey` to `~/.config/catalyst/config.json` (Layer-2 secret):

```json
{
  "groq": {
    "apiKey": "gsk_..."
  }
}
```

**Default model**: `llama-3.1-8b-instant`. Override per-project with the `FILTER_GROQ_MODEL` env
var or `GROQ_API_KEY` for the key itself.

**Purpose**: `catalyst-broker` resolves deterministic interest types
(`pr_lifecycle`, `ticket_lifecycle`) without calling Groq. For ambiguous prose interests it
batches one request per debounce window and asks Groq to classify which registered interests
match — keeping latency low and cost minimal.

**Related skills / tools**: `catalyst-broker`, `catalyst-events wait-for` (downstream consumer),
the `broker` skill protocol reference.

## Cloudflare Analytics Engine

Forwarder destination for the `catalyst-otel-forward` daemon (CTL-306). Cloudflare Analytics
Engine (AE) accepts high-cardinality time-series writes via Workers HTTP API.

**Setup**: under `catalyst.observability.forwarders.cloudflareAE` in
`~/.config/catalyst/config-{projectKey}.json`:

```json
{
  "catalyst": {
    "observability": {
      "forwarders": {
        "cloudflareAE": {
          "enabled": true,
          "accountId": "...",
          "apiToken": "...",
          "dataset": "catalyst_events"
        }
      }
    }
  }
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `accountId` | Yes | — | Cloudflare account ID |
| `apiToken` | Yes | — | API token with Analytics Engine write scope |
| `dataset` | No | `catalyst_events` | AE dataset name |

See [Event Forwarding](/observability/forwarder/) for the full schema and end-to-end setup.

## OTLP

Forwarder destination for `catalyst-otel-forward` (CTL-306). Sends canonical events as
OpenTelemetry signals over HTTP.

**Setup**: configure under `catalyst.observability.forwarders.otlp`, or set the standard
`OTEL_EXPORTER_OTLP_ENDPOINT` env var. The daemon auto-rewrites `:4317` (gRPC) to `:4318` (HTTP)
when the env var is used, so the same endpoint string works whether your collector advertises the
gRPC or HTTP port.

```json
{
  "catalyst": {
    "observability": {
      "forwarders": {
        "otlp": {
          "enabled": true,
          "endpoint": "http://localhost:4318"
        }
      }
    }
  }
}
```

The local `claude-code-otel` Compose stack exposes the OTLP/HTTP collector on `:4318` by default.
For hosted backends (Grafana Cloud, Honeycomb, etc.), point the endpoint at the vendor URL and
configure auth headers via collector environment.

## Exa

Optional web search and code-search augmentation for research agents via the Exa MCP server.

**Setup**: Add `exaApiKey` to secrets config. Used automatically by `@catalyst-dev:external-research` when doing web/library research.

**Context cost**: MCP server — small baseline, per-query token cost.

