# Catalyst Configuration Reference

This document describes every configuration file Catalyst reads or writes, how the two-layer config
system works, and common patterns for tuning behavior per-machine or per-project.

JSON Schema files for all config shapes live in [`docs/schemas/`](./schemas/).

---

## Two-Layer Config System

Catalyst uses two separate JSON files that are merged at runtime:

| Layer | File | Committed? | Purpose |
|-------|------|-----------|---------|
| **Layer 1** | `.catalyst/config.json` (repo root) | Yes | Team-wide defaults, safe to share |
| **Layer 2** | `~/.config/catalyst/config.json` | Never | Machine-specific secrets and overrides |

Layer 2 wins over Layer 1 on a **per-field basis** — only the fields present in Layer 2 override
their Layer-1 counterparts. Fields absent from Layer 2 fall back to Layer-1 values.

---

## Layer 1 — Project Config (`.catalyst/config.json`)

**Schema:** [`docs/schemas/catalyst-config.schema.json`](./schemas/catalyst-config.schema.json)

### Purpose

This file is committed to the repository and contains settings that apply to the whole team:

- Project identity (`projectKey`, `ticketPrefix`)
- Linear team and state mapping
- Orchestration dispatch mode and seed concurrency values
- Monitor dashboard display settings
- Feedback filing config
- Phase turn caps and model routing defaults

### Initializing

```bash
# Run the interactive setup script
plugins/dev/scripts/setup-catalyst.sh

# Or copy the template and edit manually
cp plugins/dev/templates/config.template.json .catalyst/config.json
```

### Key Fields

#### Project Identity

```jsonc
{
  "catalyst": {
    "projectKey": "CTL",              // used to namespace machine config lookup
    "project": {
      "ticketPrefix": "CTL"           // prefix for Linear ticket IDs (CTL-123)
    }
  }
}
```

#### Linear Integration

```jsonc
{
  "catalyst": {
    "linear": {
      "teamKey": "CTL",               // must match your Linear team key
      "stateMap": {
        "backlog":     "Backlog",
        "todo":        "Todo",
        "triage":      "Triage",
        "research":    "Research",
        "planning":    "Plan",
        "inProgress":  "Implement",
        "verifying":   "Validate",
        "reviewing":   "Review",
        "remediating": "Remediate",
        "inReview":    "PR",
        "done":        "Done",
        "canceled":    "Canceled"
      }
    }
  }
}
```

All `stateMap` values must exactly match the state names in your Linear team. The daemon uses
these to transition tickets as phases complete.

#### Linear Webhook Bot Identity

```jsonc
{
  "catalyst": {
    "monitor": {
      "linear": {
        "botUserId": null               // Linear user UUID of the Catalyst app-actor
      }
    }
  }
}
```

`monitor.linear.botUserId` is the Linear user UUID of the Catalyst app-actor — the "Linear for
Agents" app user that posts comments **as the app**. It is the self-echo / loop-prevention guard
for the whole Linear app-actor comms channel:

- The orch-monitor server uses it to suppress bot-authored issue events so the app's own writes
  don't feed back into the event log as write loops.
- The execution-core daemon uses it to filter the agent's own mirror comments and
  description-updates out of each worker's `inbox.jsonl`, so a human reply on a ticket is the
  only thing that wakes a parked worker (not the agent's own echo).

**When to set it:** required for the Linear app-actor comms channel — i.e. when the execution-core
daemon mirrors phase-agent output to Linear and wakes on human replies (CTL-550 / CTL-549 /
CTL-749). Without it, the system cannot tell the agent's own comments apart from a human's. The
value is not secret (it appears on every comment the app posts) but it **is workspace-specific**,
so the committed config ships `null` and each operator fills in their own.

**How to obtain it:** query `viewer.id` with the app-actor token. The app OAuth credentials live
in the per-project Layer-2 file (`~/.config/catalyst/config-<projectKey>.json` →
`catalyst.linear.agent.{clientId,clientSecret,accessToken}`). Using the stored access token:

```bash
TOKEN=$(jq -r '.catalyst.linear.agent.accessToken' ~/.config/catalyst/config-<projectKey>.json)
BOT_ID=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"query{viewer{id name}}"}' | jq -r .data.viewer.id)
```

Write `$BOT_ID` into `.catalyst/config.json` → `catalyst.monitor.linear.botUserId`, then restart
both readers (they read `botUserId` only at startup):

```bash
catalyst-monitor stop && catalyst-monitor start
catalyst-execution-core restart
```

#### Orchestration

```jsonc
{
  "catalyst": {
    "orchestration": {
      "dispatchMode": "phase-agents",    // or "oneshot-legacy"
      "executionCore": {
        "maxParallel": 4,                // seed value — Layer-2 wins if present
        "minParallel": 1,
        "maxParallelCeiling": 10
      },
      "phaseAgents": {
        "models": {
          "triage":         "sonnet",
          "research":       "sonnet",
          "plan":           "sonnet",
          "implement":      "opus",
          "verify":         "sonnet",
          "review":         "sonnet",
          "pr":             "sonnet",
          "monitor-merge":  "sonnet",
          "monitor-deploy": "sonnet"
        },
        "turnCaps": {
          "triage":         10,
          "research":       30,
          "plan":           20,
          "implement":      80,
          "verify":         30,
          "review":         40,
          "pr":             10,
          "monitor-merge":  20,
          "monitor-deploy": 20
        }
      }
    }
  }
}
```

**`dispatchMode`**

- `"phase-agents"` (default) — runs one short-lived `claude --bg` job per pipeline phase
  (triage → research → plan → implement → verify → review → pr → monitor-merge → monitor-deploy).
- `"oneshot-legacy"` — runs a single long-lived `claude -p /catalyst-legacy:oneshot` job per ticket.
  Preserved as a fallback; not recommended for new setups.

**`executionCore.eligibleQuery`** is **deprecated** — this field is ignored by the daemon. Use
the registry instead (see [Registry](#registry) below).

---

## Layer 2 — Machine Config (`~/.config/catalyst/config.json`)

**Schema:** [`docs/schemas/machine-config.schema.json`](./schemas/machine-config.schema.json)

### Purpose

This file is machine-local and **must never be committed**. It contains:

- API keys and secrets (`groq.apiKey`)
- Webhook registration records written by setup scripts
- Per-machine concurrency overrides (win over Layer-1)
- Per-machine model routing overrides (win over Layer-1)
- OTEL / observability endpoint configuration

### How It Gets Written

- **`setup-webhooks.sh`** — writes `catalyst.monitor.github.smeeChannel`
- **`setup-linear-webhook.sh`** — writes `catalyst.monitor.linear.{teamKey}` records
- **Manual editing** — for concurrency overrides and model routing

### Merging Rules

The scheduler and phase-agent-dispatch scripts read both files. For the following fields, Layer 2
wins **per-field**:

| Field | Layer-2 path |
|-------|-------------|
| `maxParallel` | `catalyst.orchestration.executionCore.maxParallel` |
| `minParallel` | `catalyst.orchestration.executionCore.minParallel` |
| `maxParallelCeiling` | `catalyst.orchestration.executionCore.maxParallelCeiling` |
| Phase models | `catalyst.orchestration.phaseAgents.models.{phase}` |

### Key Fields

#### Concurrency Overrides

```jsonc
{
  "catalyst": {
    "orchestration": {
      "executionCore": {
        "maxParallel": 6     // this machine runs 6 parallel phase-agents
      }
    }
  }
}
```

#### Model Routing Overrides

```jsonc
{
  "catalyst": {
    "orchestration": {
      "phaseAgents": {
        "models": {
          "implement": "opus",   // override just the implement phase on this machine
          "verify":    "sonnet"
        }
      }
    }
  }
}
```

#### Webhook Registration (written by setup scripts)

```jsonc
{
  "catalyst": {
    "monitor": {
      "github": {
        "smeeChannel": "https://smee.io/AbCdEfGhIjKlMnOp"
      },
      "linear": {
        "CTL": {
          "webhookId":     "uuid-of-webhook",
          "smeeChannel":   "https://smee.io/XyZAbCdEfGhIjKl",
          "registeredAt":  "2026-05-28T10:00:00Z",
          "resourceTypes": ["Issue", "Comment"]
        }
      }
    }
  }
}
```

#### OTEL / Observability

```jsonc
{
  "otel": {
    "enabled":    true,
    "prometheus": "http://localhost:9091/metrics/job/catalyst",
    "loki":       "http://localhost:3100/loki/api/v1/push"
  }
}
```

#### Groq API Key

```jsonc
{
  "groq": {
    "apiKey": "gsk_..."
  }
}
```

Required when `catalyst.filter.groqModel` is configured and the broker's LLM event filtering is
active.

---

## Registry (`~/catalyst/execution-core/registry.json`)

**Schema:** [`docs/schemas/registry.schema.json`](./schemas/registry.schema.json)

### Purpose

The registry is the execution-core daemon's source of truth for which projects are enrolled and
what Linear state constitutes "eligible for dispatch." It is **not** part of the two-layer config
— it lives in the daemon's working directory and is managed separately.

This file supersedes the deprecated `catalyst.orchestration.executionCore.eligibleQuery` field in
Layer-1 config. The daemon ignores that field and reads the registry exclusively.

### Structure

```jsonc
{
  "projects": [
    {
      "team":     "CTL",
      "repoRoot": "/Users/ryan/code-repos/github/coalesce-labs/catalyst",
      "eligibleQuery": {
        "status":        "Todo",      // Linear state to pull for dispatch
        "triageStatus":  "Triage",    // Linear state for one-shot triage dispatch
        "project":       null,        // null = no project filter
        "label":         null,        // null = no label filter
        "priority":      null         // null = all priorities
      }
    }
  ]
}
```

### How to Update

```bash
# Run the interactive enrollment script
plugins/dev/scripts/setup-execution-core-states.sh --team CTL

# Or use the registry CLI directly
node plugins/dev/scripts/execution-core/registry.mjs upsert \
  --team CTL \
  --repo-root /path/to/repo \
  --status Todo
```

---

## Phase Signal Files

**Schema:** [`docs/schemas/phase-signal.schema.json`](./schemas/phase-signal.schema.json)

**Location:** `~/catalyst/execution-core/workers/{TICKET}/phase-{name}.json`

Phase signal files are the coordination channel between the execution-core daemon and phase-agent
workers. The daemon writes the file to dispatch a phase; the worker updates `status` and
`bg_job_id` as it runs; the daemon reads the file to decide when to advance to the next phase.

Workers emit terminal status values (`done`, `failed`, `skipped`, `turn-cap-exhausted`) using the
`phase-agent-emit-complete` helper script, which updates the signal file atomically.

---

## External Dependency: `~/.claude/jobs/*/state.json`

**Schema:** [`docs/schemas/state-json-contract.schema.json`](./schemas/state-json-contract.schema.json)

This file is **written by Claude Code, not Catalyst**. Catalyst reads it read-only for:

- **Session continuation** — `resumeSessionId` (Claude Code ≥2.x) is the primary field passed as
  `--resume-session` when boot-resume or turn-cap revival re-launches a phase-agent.
- **Job liveness probes** — the `state` field (`"running"` / `"stopped"`) is read by
  `defaultStatJob` to determine if a bg job is still alive.
- **Worktree validation** — `cwd` is read during orphan detection.

The legacy `linkScanPath` field (Claude Code <2.x) is still read as a fallback for sessions
running older Claude Code versions.

---

## Prerequisites Checklist

### Required

| Tool | Purpose |
|------|---------|
| `claude` (Claude Code CLI) | Runs phase-agent bg jobs |
| `git` | Worktree creation, commit probing |
| `bash` | All setup and helper scripts |
| `node` / `bun` | Execution-core daemon and scheduler |

### Optional

| Tool | Purpose |
|------|---------|
| `humanlayer` | Thoughts persistence (`catalyst-thoughts` commands) |
| `linearis` | Linear API CLI used by phase agents |
| `gh` (GitHub CLI) | PR creation and merge operations |
| `catalyst-session` | Session cost/duration tracking (`plugins/dev/scripts/catalyst-session.sh`) |
| `sqlite3` | Reading `~/catalyst/catalyst.db` actuals |
| `smee` | Webhook proxy for local Linear/GitHub event reception |
| `groq` API key | LLM-based broker event filtering |

---

## Common Configuration Patterns

### "I want 6 parallel workers on this machine"

Edit `~/.config/catalyst/config.json`:

```json
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

This overrides Layer-1's `maxParallel` for this machine only. The committed `.catalyst/config.json`
is unchanged.

### "Route triage, research, and implement to specific models"

Edit `~/.config/catalyst/config.json`:

```json
{
  "catalyst": {
    "orchestration": {
      "phaseAgents": {
        "models": {
          "triage":    "sonnet",
          "research":  "sonnet",
          "implement": "opus"
        }
      }
    }
  }
}
```

Only the listed phases are overridden; other phases fall back to the Layer-1 model map.

### "Add a new project team to the daemon"

```bash
# Enroll the new team in the registry
plugins/dev/scripts/setup-execution-core-states.sh --team NEW-TEAM

# Register Linear webhooks for the new team
plugins/dev/scripts/setup-linear-webhook.sh --team NEW-TEAM

# Add the new team to the monitor display (edit .catalyst/config.json)
```

Add to `.catalyst/config.json`:

```json
{
  "catalyst": {
    "monitor": {
      "linear": {
        "teams": [
          { "key": "CTL", "vcsRepo": "coalesce-labs/catalyst" },
          { "key": "NEW-TEAM", "vcsRepo": "owner/new-repo" }
        ]
      }
    }
  }
}
```

### "Disable the orphan reaper for debugging"

Edit `.catalyst/config.json`:

```json
{
  "catalyst": {
    "orchestration": {
      "orphanReaper": {
        "enabled": false
      }
    }
  }
}
```

### "Change the Linear state the daemon polls for new work"

Edit `~/catalyst/execution-core/registry.json` directly or re-run the enrollment script:

```bash
node plugins/dev/scripts/execution-core/registry.mjs upsert \
  --team CTL \
  --repo-root /path/to/repo \
  --status Ready    # was: Todo
```

The daemon reads `eligibleQuery.status` from the registry on each scheduler tick.

---

## Schema Files Reference

| Schema | Validates |
|--------|----------|
| [`catalyst-config.schema.json`](./schemas/catalyst-config.schema.json) | `.catalyst/config.json` (Layer 1) |
| [`machine-config.schema.json`](./schemas/machine-config.schema.json) | `~/.config/catalyst/config.json` (Layer 2) |
| [`registry.schema.json`](./schemas/registry.schema.json) | `~/catalyst/execution-core/registry.json` |
| [`phase-signal.schema.json`](./schemas/phase-signal.schema.json) | `~/catalyst/execution-core/workers/{TICKET}/phase-{name}.json` |
| [`state-json-contract.schema.json`](./schemas/state-json-contract.schema.json) | `~/.claude/jobs/{bg_job_id}/state.json` (external, read-only) |
