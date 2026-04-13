---
title: Orchestration
description: Coordinate multiple tickets in parallel — wave-based execution, worker dispatch, adversarial verification, and cross-wave knowledge sharing.
sidebar:
  order: 5
---

Orchestration is Catalyst's system for coordinating **multiple tickets in parallel** across git worktrees. An AI coordinator dispatches workers, tracks progress via a dashboard, and enforces quality through adversarial verification.

## Orchestration Levels

Catalyst workflows operate at two levels:

| Level | What | How |
|-------|------|-----|
| **Level 2** | Single-ticket pipeline | `/oneshot` chains research, plan, implement, validate, ship, merge with context isolation |
| **Level 3** | Multi-ticket coordination | `/orchestrate` dispatches Level 2 workers across worktrees with wave-based parallelism and independent verification |

Level 3 builds on Level 2 — each worker runs the full `/oneshot` pipeline autonomously. The orchestrator adds coordination, knowledge sharing, and anti-reward-hacking verification on top.

## Prerequisites

### Required Tools

| Tool | Purpose | Install |
|------|---------|---------|
| **Git** | Worktree creation, branch management | Pre-installed on macOS |
| **Linearis CLI** | Read tickets from Linear, update states | `npm install -g @anthropic/linearis` |
| **GitHub CLI** | PR creation, CI monitoring | `brew install gh` |
| **jq** | Config parsing, signal file updates | `brew install jq` |
| **HumanLayer CLI** | Worker dispatch with context isolation, thoughts system | `pip install humanlayer` |

If HumanLayer is not installed, the orchestrator falls back to launching workers with the `claude` CLI directly. The thoughts system (shared research, plans, handoffs across worktrees) requires HumanLayer.

### Claude Code Settings

Add `~/catalyst` to Claude Code's trusted directories so all worktrees across all projects are accessible without per-worktree approval:

```json
// ~/.claude/settings.json
{
  "permissions": {
    "additionalDirectories": [
      "/Users/you/catalyst"
    ]
  }
}
```

This is a one-time setup. All orchestrator and worker worktrees for every project land under `~/catalyst/wt/<projectKey>/`.

### Project Configuration

The orchestrator reads from your project's Catalyst config (`.catalyst/config.json` or `.claude/config.json`). Two config blocks are relevant:

#### 1. Worktree Setup Commands (`catalyst.worktree.setup`)

**This is the most important configuration to get right.** It defines the commands that run in every new worktree — both standalone worktrees from `/create-worktree` and orchestrator/worker worktrees from `/orchestrate`.

```json
{
  "catalyst": {
    "worktree": {
      "setup": [
        "humanlayer thoughts init --directory ${DIRECTORY} --profile ${PROFILE}",
        "humanlayer thoughts sync",
        "bun install",
        "~/.claude/scripts/trust-workspace.sh \"$(pwd)\""
      ]
    }
  }
}
```

**What to include in your setup array:**

| Step | Command | Why |
|------|---------|-----|
| Thoughts init | `humanlayer thoughts init --directory ${DIRECTORY} --profile ${PROFILE}` | Workers need access to shared research, plans, and handoffs. Without this, workers can't read wave briefings or save their findings for other waves. |
| Thoughts sync | `humanlayer thoughts sync` | Pulls down existing shared documents so the worker starts with full context. |
| Dependency install | `bun install` or `npm install` or `make setup` | Workers need project dependencies to run tests, typecheck, and build. |
| Permission grant | `~/.claude/scripts/trust-workspace.sh "$(pwd)"` | Adds the worktree to Claude Code's allowed directories. Not needed if `~/catalyst` is already in `additionalDirectories`. |
| Environment setup | `cp .env.example .env.local` | Workers may need environment variables for local dev. |
| Database setup | `./scripts/setup-test-db.sh` | If tests require a local database. |

**If `catalyst.worktree.setup` is NOT configured:** The script falls back to auto-detected setup — it will auto-detect `make setup`/`bun install`/`npm install` for dependencies, and run `humanlayer thoughts init` + `sync` if HumanLayer is installed. This fallback is convenient for simple projects but gives you no control over the order, additional steps, or error handling.

**Once you define `catalyst.worktree.setup`, only your commands run.** The auto-detection is skipped entirely. This means you must include dependency install and thoughts init in your array if you need them — they are not added automatically.

#### 2. Orchestration Config (`catalyst.orchestration`)

Optional. Controls orchestrator-specific behavior. All fields have sensible defaults:

```json
{
  "catalyst": {
    "orchestration": {
      "worktreeDir": null,
      "maxParallel": 3,
      "hooks": {
        "setup": [],
        "teardown": []
      },
      "workerCommand": "/oneshot",
      "workerModel": "opus",
      "testRequirements": {
        "backend": ["unit", "bruno"],
        "frontend": ["unit", "functional"],
        "fullstack": ["unit", "bruno", "functional"]
      },
      "verifyBeforeMerge": true,
      "allowSelfReportedCompletion": false
    }
  }
}
```

**The difference between `worktree.setup` and `orchestration.hooks.setup`:**

- `catalyst.worktree.setup` — runs for **every** worktree (standalone, orchestrator, and workers). This is your base project setup.
- `catalyst.orchestration.hooks.setup` — runs **only** for orchestrator-managed worktrees, **after** the base setup. Use this for orchestration-specific steps that don't apply to standalone worktrees.
- `catalyst.orchestration.hooks.teardown` — runs when the orchestrator cleans up completed worktrees after wave advancement.

Most projects only need `catalyst.worktree.setup`. The orchestration hooks are for edge cases like registering workers with an external monitoring system.

### Full Config Example

Here's a complete config for a project using orchestration:

```json
{
  "catalyst": {
    "projectKey": "acme",
    "repository": { "org": "acme-corp", "name": "api" },
    "project": { "ticketPrefix": "ACME", "name": "Acme Corp API" },
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
      "user": "ryan",
      "profile": "acme",
      "directory": "api"
    },
    "worktree": {
      "setup": [
        "humanlayer thoughts init --directory ${DIRECTORY} --profile ${PROFILE}",
        "humanlayer thoughts sync",
        "bun install",
        "~/.claude/scripts/trust-workspace.sh \"$(pwd)\""
      ]
    },
    "orchestration": {
      "maxParallel": 4,
      "workerModel": "opus",
      "testRequirements": {
        "backend": ["unit", "bruno"],
        "frontend": ["unit", "functional"],
        "fullstack": ["unit", "bruno", "functional"]
      },
      "verifyBeforeMerge": true
    }
  }
}
```

### Setup Checklist

Before running `/orchestrate` for the first time:

- [ ] **Linearis CLI installed** and authenticated (`linearis auth login`)
- [ ] **GitHub CLI installed** and authenticated (`gh auth login`)
- [ ] **HumanLayer CLI installed** and thoughts initialized in the main repo (`humanlayer thoughts init`)
- [ ] **`~/catalyst` added** to `~/.claude/settings.json` `additionalDirectories`
- [ ] **`catalyst.worktree.setup` configured** with your project's setup commands (thoughts init, dependency install, permission grant, etc.)
- [ ] **`catalyst.linear.stateMap` configured** so ticket state transitions work
- [ ] **`catalyst.thoughts` configured** with your profile and directory names

## Quick Start

Once prerequisites are met:

```
/orchestrate ACME-101 ACME-102 ACME-103
```

The orchestrator:
1. Reads each ticket from Linear
2. Builds a dependency graph and groups tickets into waves
3. Presents the wave plan for approval
4. Creates worktrees for each ticket (running your `worktree.setup` commands)
5. Dispatches `/oneshot` workers into each worktree
6. Monitors progress and updates a dashboard
7. Runs adversarial verification when workers claim "done"
8. Advances to the next wave when all tickets pass
9. Writes wave briefings so later waves benefit from earlier discoveries

## Invocation

```bash
/orchestrate ACME-101 ACME-102 ACME-103        # explicit tickets
/orchestrate --project "Q2 API Redesign"         # from a Linear project
/orchestrate --cycle current                      # from the current Linear cycle
/orchestrate --file tickets.txt                   # from a file (one ID per line)
```

### Flags

| Flag | Description |
|------|-------------|
| `--name <name>` | Name this orchestrator (default: auto-generated) |
| `--auto-merge` | Workers auto-merge when CI + verification pass |
| `--max-parallel <n>` | Override max concurrent workers (default: 3) |
| `--base-branch <branch>` | Base branch for worktrees (default: main) |
| `--dry-run` | Show wave plan without executing |
| `--interactive` | Include PM intake phase before orchestration |

## Wave-Based Parallelism

Tickets are grouped into **waves** based on their dependency graph:

```
Wave 1 (parallel, 3 workers):
  ACME-101: Auth middleware rewrite
  ACME-102: Rate limiting service
  ACME-103: Email templates

Wave 2 (after Wave 1, 2 workers):
  ACME-104: OAuth integration         — depends on ACME-101
  ACME-105: API usage dashboard        — depends on ACME-102

Wave 3 (after Wave 2, 1 worker):
  ACME-106: Self-service API keys      — depends on ACME-104, ACME-105
```

- **Wave 1** tickets have no dependencies on other tickets in the set — they run in parallel
- **Wave 2** tickets depend on Wave 1 — they start only after Wave 1 is verified and merged
- Circular dependencies are flagged and rejected

The orchestrator presents the wave plan and waits for approval before provisioning.

## Directory Layout

All worktrees for a project land under `~/catalyst/wt/<projectKey>/`:

```
~/catalyst/wt/acme/
├── api-redesign/                    # orchestrator (read-only, no code changes)
│   ├── DASHBOARD.md                 # live status board
│   ├── state.json                   # machine-readable state for crash recovery
│   ├── wave-1-briefing.md           # knowledge transfer to Wave 2
│   └── workers/
│       ├── ACME-101.json            # worker signal file
│       ├── ACME-102.json
│       └── ACME-103.json
├── api-redesign-ACME-101/           # worker worktree
├── api-redesign-ACME-102/           # worker worktree
└── api-redesign-ACME-103/           # worker worktree
```

The base directory is resolved in this order:

1. `catalyst.orchestration.worktreeDir` from config (explicit override)
2. `~/catalyst/wt/<projectKey>/` (default — reads `catalyst.projectKey` from config)
3. `~/catalyst/wt/<repo>/` (fallback if no config)

## What Happens When a Worktree is Created

For every worktree (orchestrator and workers), the `create-worktree.sh` script runs this sequence:

```
1. git worktree add -b <name> <path> <base-branch>
2. Copy .claude/ directory (plugins, rules, prompts)
3. Copy .catalyst/ directory (project config)
4. Initialize workflow context with ticket from worktree name
   (e.g., worktree "ENG-123" → currentTicket: "ENG-123")
5. Generate .envrc (source_up + use_otel_context) and run direnv allow
6. Run catalyst.worktree.setup commands (your config)
   — OR auto-detect: dependency install + humanlayer thoughts init (fallback)
7. Run catalyst.orchestration.hooks.setup (orchestration-only, if present)
```

Steps 4–5 ensure that `.catalyst/.workflow-context.json` exists with the ticket set and that OTEL resource attributes include the ticket — before any skills run.

The orchestrator then creates its status directory (`workers/`, `DASHBOARD.md`, `state.json`) and initializes worker signal files.

## Worker Dispatch

Workers are launched via `humanlayer launch` (preferred for context isolation and named sessions) or `claude` CLI (fallback). Each runs `/oneshot <ticket> --auto-merge` autonomously.

The dispatch prompt includes **mandatory testing requirements** — not suggestions. Workers are told their output will be independently verified. The `CATALYST_ORCHESTRATOR_DIR` environment variable is set so workers know where to write their signal files.

## Testing Enforcement (3 Layers)

The orchestrator addresses a specific failure mode: **agents ship PRs with minimal tests and self-report "done."** Three layers prevent this:

### Layer 1 — Dispatch Prompt (Prevention)

Every worker's dispatch prompt includes hard requirements for TDD, unit tests, API tests, security review, and code review. The prompt explicitly states that work will be independently verified.

### Layer 2 — Quality Gates (Automated)

Inside each worker's `/oneshot` pipeline, the existing quality gate system runs: `/validate-type-safety`, `/security-review`, `code-reviewer` agent, `pr-test-analyzer` agent, plus any project-specific gates from config.

### Layer 3 — Independent Verification (Adversarial)

After a worker claims "done", the orchestrator runs `orchestrate-verify.sh` **independently** in the worker's worktree. This script:

- Checks that every changed source file has a corresponding test file
- Verifies API test coverage for new/modified routes
- Runs the test suite to confirm tests pass
- Scans for security anti-patterns (SQL injection, hardcoded secrets, eval, innerHTML)
- Scans for reward-hacking patterns (`as any`, `@ts-ignore`, empty catch blocks)
- Cross-checks the worker's self-reported `definitionOfDone` against actual findings

If verification **fails**, the worker gets explicit remediation instructions and must fix the gaps before advancing. The orchestrator re-verifies after fixes.

## Wave Briefing Documents

Before dispatching each wave after Wave 1, the orchestrator writes a **briefing document** summarizing what prior waves learned:

- Patterns and conventions established (e.g., "Auth uses `withAuth()` decorator")
- New dependencies added
- Test helpers created (e.g., `createTestToken()`)
- Gotchas discovered (e.g., "Redis requires `REDIS_URL` env var")
- File organization conventions from merged PRs

Wave 2+ workers read the briefing before starting. This means:

- Workers follow established patterns instead of inventing conflicting ones
- Workers reuse test helpers instead of writing duplicates
- Workers avoid known gotchas instead of hitting them again
- **Knowledge compounds across waves** instead of being lost

This requires the thoughts system to be initialized in each worktree (via `catalyst.worktree.setup`). Without it, workers can't access shared documents.

## Dashboard

The orchestrator maintains a live dashboard at `DASHBOARD.md` in its worktree directory, updated after each monitoring poll:

```markdown
# Orchestration Dashboard
**Orchestrator:** api-redesign
**Started:** 2026-04-10 14:00 UTC
**Total:** 6 tickets | 3 waves

## Current Wave: 1 of 3

| Ticket | Status | PR | Unit Tests | API Tests | Security | Verified |
|--------|--------|-----|-----------|-----------|----------|----------|
| ACME-101 | Implementing | — | — | — | — | — |
| ACME-102 | PR Created | #87 | 18 tests | 6 requests | PASS | Pending |
| ACME-103 | Validating | — | 12 tests | N/A | Pending | — |

## Event Log
- 14:32 — ACME-102 PR #87 created, CI running
- 14:15 — ACME-101 research complete, starting plan
- 14:00 — Wave 1 dispatched (3 workers)
```

## Worker Signal Files

Workers report status via JSON signal files in `workers/`. The orchestrator writes the initial file; workers update it at each phase transition.

```json
{
  "ticket": "ACME-101",
  "status": "pr-created",
  "phase": 5,
  "pr": { "number": 87, "ciStatus": "passing" },
  "definitionOfDone": {
    "testsWrittenFirst": true,
    "unitTests": { "exists": true, "count": 22 },
    "apiTests": { "exists": true, "count": 8 },
    "typeCheck": { "passed": true },
    "securityReview": { "passed": true },
    "codeReview": { "passed": true }
  }
}
```

The `definitionOfDone` is the accountability layer — workers declare yes/no for each gate, and the orchestrator's verification independently confirms. A worker claiming 22 unit tests when 0 exist gets caught.

## Configuration Reference

### Orchestration Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `worktreeDir` | string\|null | `~/catalyst/wt/<projectKey>` | Base directory for worktrees |
| `maxParallel` | number | 3 | Max concurrent workers per wave |
| `hooks.setup` | string[] | `[]` | Extra commands after base `worktree.setup` (orchestration-only) |
| `hooks.teardown` | string[] | `[]` | Commands before worktree removal on wave advancement |
| `workerCommand` | string | `/oneshot` | Skill to run in each worker |
| `workerModel` | string | `opus` | Model for worker sessions |
| `testRequirements` | object | `{"backend":["unit"]}` | Required test types by scope |
| `verifyBeforeMerge` | boolean | `true` | Run adversarial verification before merging |
| `allowSelfReportedCompletion` | boolean | `false` | Trust worker's `definitionOfDone` without verification |

### Hook Variables

All setup and teardown commands support these variables:

| Variable | Source | Value |
|----------|--------|-------|
| `${WORKTREE_PATH}` | Computed | Absolute path to the worktree |
| `${BRANCH_NAME}` | Computed | Git branch name |
| `${TICKET_ID}` | Computed | Same as branch name (includes orchestrator prefix) |
| `${REPO_NAME}` | Git | Repository name |
| `${DIRECTORY}` | Config | `catalyst.thoughts.directory` or repo name |
| `${PROFILE}` | Config | `catalyst.thoughts.profile` or auto-detected from HumanLayer |

## Linear Integration

The orchestrator manages Linear state as a safety net:

| Event | Linear Action |
|-------|--------------|
| Worker dispatched | Move ticket to In Progress |
| Worker creates PR | Verify ticket is In Review — fix if not |
| PR merged | Verify ticket is Done — fix if not |
| Worker fails/stalls | Add comment with status |

Comments are added to tickets for team visibility:

```
Orchestrator [api-redesign]: Worker dispatched. Starting research phase.
Orchestrator [api-redesign]: PR #87 created. CI running. Unit: 18, API: 6.
```

## Named Orchestrators

Multiple orchestrators can run concurrently. Each gets a unique name that prefixes its worktrees:

```bash
# Two orchestrators for different projects, running simultaneously
/orchestrate --project "Auth Rewrite" --name auth-orch
/orchestrate --project "Dashboard V2" --name dash-orch

# Worktrees are namespaced — no collisions
~/catalyst/wt/acme/
├── auth-orch/
├── auth-orch-ACME-101/
├── dash-orch/
└── dash-orch-ACME-201/
```

## Global State & Event Log

When multiple orchestrators run concurrently — or you want to check on things after the fact — a single global state file at `~/catalyst/state.json` provides a unified view of all active orchestrators, their workers, and anything that needs your attention.

### File Layout

```
~/catalyst/
├── state.json              # Active orchestrators (machine-readable)
├── events/                 # Append-only event stream, rotated monthly
│   ├── 2026-03.jsonl
│   └── 2026-04.jsonl
├── history/                # Completed/archived orchestrator snapshots
│   └── q2-api-redesign--2026-04-11T14-00-00Z.json
└── wt/                     # Worktrees (existing)
    └── <projectKey>/...
```

**`state.json`** contains all active orchestrators with their progress, worker status, and attention items. Orchestrators register at startup and heartbeat every 2-3 minutes. Workers update their own entries at each phase transition.

**`events/`** contains append-only JSONL files, rotated monthly. Every significant transition — worker dispatched, status change, PR created, verification passed/failed, attention raised — is logged here. Query across all months with `cat ~/catalyst/events/*.jsonl | jq`.

**`history/`** contains full snapshots of orchestrators after they complete, fail, or are garbage-collected due to stale heartbeats.

### Global State Schema

Each orchestrator entry in `state.json` contains:

```json
{
  "id": "q2-api-redesign",
  "projectKey": "acme",
  "repository": "acme-corp/api",
  "status": "active",
  "lastHeartbeat": "2026-04-11T18:30:00Z",
  "progress": {
    "totalTickets": 6,
    "completedTickets": 3,
    "currentWave": 2,
    "totalWaves": 3
  },
  "workers": {
    "ACME-101": {
      "title": "Add OAuth2 provider",
      "status": "done",
      "phase": 6,
      "pr": { "number": 234, "url": "...", "ciStatus": "passing" },
      "needsAttention": false
    },
    "ACME-105": {
      "title": "Audit log schema",
      "status": "stalled",
      "phase": 3,
      "needsAttention": true,
      "attentionReason": "No progress for 15+ minutes"
    }
  },
  "attention": [
    {
      "type": "stalled",
      "ticketId": "ACME-105",
      "message": "No progress for 15+ minutes",
      "since": "2026-04-11T17:10:00Z"
    }
  ]
}
```

The full JSON Schema is at `plugins/dev/templates/global-state.json`. The global state is a denormalized summary — each orchestrator's detailed local state remains at `<worktree>/state.json` for crash recovery.

### Querying with jq

The global state is designed for fast `jq` queries. Here are common patterns:

```bash
# What needs my attention right now?
jq '[.orchestrators[].attention[]] | sort_by(.since)' ~/catalyst/state.json

# All active orchestrators at a glance
jq '.orchestrators[] | {id, status, progress: "\(.progress.completedTickets)/\(.progress.totalTickets)", wave: "\(.progress.currentWave)/\(.progress.totalWaves)"}' ~/catalyst/state.json

# Workers currently in-flight
jq '[.orchestrators[].workers[] | select(.status != "done" and .status != "failed") | {ticket: .ticketId, title, status, phase}]' ~/catalyst/state.json

# PRs ready for review
jq '[.orchestrators[].workers[] | select(.status == "pr-created") | {ticket: .ticketId, pr: .pr.url}]' ~/catalyst/state.json

# Filter by project
jq '[.orchestrators[] | select(.projectKey == "acme")]' ~/catalyst/state.json
```

### Querying Events

Events are JSONL files (one JSON object per line), so `grep`, `jq`, and standard Unix tools all work:

```bash
# Last 20 events
tail -20 ~/catalyst/events/2026-04.jsonl | jq .

# All events for a specific ticket
grep '"ACME-105"' ~/catalyst/events/*.jsonl | jq .

# All attention events
cat ~/catalyst/events/*.jsonl | jq 'select(.event == "attention-raised")'

# Timeline for an orchestrator
grep '"q2-api-redesign"' ~/catalyst/events/*.jsonl | jq -r '"\(.ts) \(.worker // "-") \(.event)"'

# Event types
cat ~/catalyst/events/*.jsonl | jq -r '.event' | sort | uniq -c | sort -rn
```

### The catalyst-state.sh CLI

All state reads and writes go through `catalyst-state.sh`, which handles file locking for concurrent access:

```bash
# View active orchestrators
catalyst-state.sh status

# Filter by project
catalyst-state.sh status --project acme

# Run any jq query
catalyst-state.sh query '.orchestrators | keys'

# Query events
catalyst-state.sh events --last 10
catalyst-state.sh events --ticket ACME-105
catalyst-state.sh events --type verification-failed

# Garbage collect stale orchestrators and old events
catalyst-state.sh gc --stale-after 10 --events-older-than 6m
```

Orchestrators and workers call `catalyst-state.sh` internally — you don't need to run it manually unless you're querying or debugging.

### Heartbeat & Stale Detection

Orchestrators write a `lastHeartbeat` timestamp during each monitoring poll (every 2-3 minutes). If an orchestrator dies without clean shutdown (process killed, machine restarts), its heartbeat goes stale.

`catalyst-state.sh gc` detects stale entries (default: heartbeat older than 10 minutes), marks them as `abandoned`, and archives them to `~/catalyst/history/`. Run it manually or let the next orchestrator startup clean up automatically.

### Building Interfaces

The global state JSON is a stable contract designed for building rich interfaces:

**Terminal dashboard** — Simplest approach with `watch`:
```bash
watch -n5 'jq ".orchestrators[] | {id, status, progress: \"\(.progress.completedTickets)/\(.progress.totalTickets)\", attention: (.attention | length)}" ~/catalyst/state.json'
```

**Web dashboard** — Serve `state.json` via a lightweight HTTP server and build a React/Svelte frontend that polls or watches for changes. The schema is documented in `plugins/dev/templates/global-state.json`.

**Agent integration** — Any Claude Code agent can read `~/catalyst/state.json` directly to answer questions like "what's the status of the auth migration?" or "are any workers waiting for me?" without asking the orchestrator.

**Event replay** — The event log in `~/catalyst/events/` gives you a full audit trail. Build timeline views, calculate cycle times, or feed events into analytics. Every event has a timestamp, orchestrator ID, optional worker/ticket ID, and event type — so you can reconstruct the full sequence of what happened in any orchestration run:

```bash
# Replay an entire orchestration run chronologically
grep '"q2-api-redesign"' ~/catalyst/events/*.jsonl | jq -r '"\(.ts) [\(.worker // "orch")] \(.event) \(.detail // "" | tostring)"'

# Calculate time from dispatch to PR for each worker
cat ~/catalyst/events/*.jsonl | jq -s '
  group_by(.worker) | map(select(.[0].worker != null)) | map({
    ticket: .[0].worker,
    dispatched: (map(select(.event == "worker-dispatched")) | .[0].ts),
    pr_created: (map(select(.event == "worker-pr-created")) | .[0].ts)
  }) | map(select(.dispatched and .pr_created))'

# Total duration per orchestrator (start to completion)
cat ~/catalyst/events/*.jsonl | jq -s '
  group_by(.orchestrator) | map({
    orchestrator: .[0].orchestrator,
    started: (map(select(.event == "orchestrator-started")) | .[0].ts),
    completed: (map(select(.event == "orchestrator-completed")) | .[0].ts)
  })'
```

### Token Usage & Cost Tracking

Each orchestrator and worker entry in the global state includes a `usage` block that tracks token consumption and cost:

```json
{
  "usage": {
    "inputTokens": 15420,
    "outputTokens": 8730,
    "cacheReadTokens": 42000,
    "cacheCreationTokens": 29670,
    "costUSD": 1.47,
    "numTurns": 23,
    "durationMs": 847000,
    "durationApiMs": 312000,
    "model": "claude-opus-4-6[1m]"
  }
}
```

**How it works**: Workers launched via the `claude` CLI with `--output-format json` produce a JSON output that includes full token counts, cost, and timing. After a worker process exits, the orchestrator parses this output and writes the usage data to both the worker's entry and the orchestrator's aggregate.

**Query patterns**:

```bash
# Total cost across all active orchestrators
jq '[.orchestrators[].usage.costUSD] | add' ~/catalyst/state.json

# Cost per worker in an orchestration
jq '.orchestrators["q2-api-redesign"].workers | to_entries[] | {ticket: .key, cost: .value.usage.costUSD}' ~/catalyst/state.json

# Most expensive workers (from history)
cat ~/catalyst/history/*.json | jq -s '[.[].workers | to_entries[] | {ticket: .key, cost: .value.usage.costUSD}] | sort_by(.cost) | reverse | .[:10]'

# Average cost per ticket across all historical orchestrations
cat ~/catalyst/history/*.json | jq -s '[.[].usage.costUSD / .[].progress.totalTickets] | add / length'
```

**Current limitations**:
- Workers launched via `humanlayer launch` do not currently expose session usage — their `usage` fields remain null
- The orchestrator itself cannot capture its own usage from within the session
- Usage is only captured after a worker process exits, not in real-time

As these tools evolve to expose usage data, the schema is ready to accept it.

## Error Handling

**Worker crashes or stalls**: The orchestrator detects no progress for 15+ minutes (no commits, no signal updates). It marks the worker as "stalled" on the dashboard, flags it in the global state's `attention` array, and emits an `attention-raised` event. It does not auto-restart — it flags for human decision.

**Orchestrator crash recovery**: Local state lives in `<worktree>/state.json` + worker signal files. Resume with `/orchestrate --resume <orch-dir>` to pick up where it left off. The orchestrator re-registers itself in the global state on resume.

**Orchestrator unclean death**: If the orchestrator process dies, its `lastHeartbeat` goes stale. `catalyst-state.sh gc` archives the entry as `abandoned`. Workers that were in-flight may still be running — check their worktrees and signal files manually, or let the next orchestrator pick them up.

**Verification failure**: The worker gets specific remediation instructions. The global state gets an `attention` item with type `verification-failed`. The orchestrator re-verifies after fixes. A ticket cannot advance to merge until verification passes.
