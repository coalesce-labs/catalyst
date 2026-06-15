---
title: Configuration
description: The two config files Catalyst reads — one safe to commit, one for secrets — and the keys that matter most.
sidebar:
  order: 0
---

Catalyst reads two config files. The setup script (`setup-catalyst.sh`) writes both for you, so you rarely edit them by hand. This page covers the keys you're most likely to touch.

- **`.catalyst/config.json`** — plain project info. Safe to commit to git.
- **`~/.config/catalyst/config-{projectKey}.json`** — secrets like API keys. Never commit this.

The `projectKey` links the two files.

## Project config (`.catalyst/config.json`)

Safe to commit. It holds your repo, your ticket names, and how workflow steps map to Linear statuses.

```json
{
  "catalyst": {
    "projectKey": "acme",
    "repository": { "org": "acme-corp", "name": "api" },
    "project": { "ticketPrefix": "ACME", "name": "Acme Corp API" },
    "linear": {
      "teamKey": "ACME",
      "stateMap": {
        "todo": "Todo",
        "research": "In Progress",
        "inProgress": "In Progress",
        "inReview": "In Review",
        "done": "Done"
      }
    }
  }
}
```

| Key | What it does |
| --- | --- |
| `catalyst.projectKey` | Links to the secrets file (`config-{projectKey}.json`) |
| `catalyst.repository.org` / `.name` | Your GitHub org and repo |
| `catalyst.project.ticketPrefix` | Linear ticket prefix, e.g. `ACME` |
| `catalyst.linear.teamKey` | Linear team key; must match `ticketPrefix` |
| `catalyst.linear.stateMap` | Maps each workflow step to one of your Linear status names |

### State map

As work moves, Catalyst updates the ticket's Linear status for you. `stateMap` says which status name to use for each step (`research`, `inProgress`, `inReview`, `done`, and so on). Set a key to `null` to skip that update.

You usually don't edit this by hand. When you run `setup-catalyst.sh` with a Linear token, it reads your real status names and fills `stateMap` in. Pointing `stateMap` at a status that doesn't exist makes the next update fail, so only edit it if your status names are unusual.

## How work runs: `dispatchMode`

The `orchestration.dispatchMode` key picks how Catalyst runs each ticket:

- **`execution-core`** — the autonomous daemon. It watches your board, picks up ready tickets, and runs them with no command from you. This is the away-from-keyboard mode.
- **`phase-agents`** — runs each ticket as ten short background jobs, one per step.
- **`oneshot-legacy`** — one long-running job per ticket. The older default.

```json
{
  "catalyst": {
    "orchestration": {
      "dispatchMode": "execution-core",
      "maxParallel": 3,
      "worktreeDir": null,
      "phaseAgents": {
        "models": { "implement": "sonnet", "pr": "sonnet", "monitor-deploy": "haiku" },
        "turnCaps": { "implement": 100 }
      }
    }
  }
}
```

| Key | Default | What it does |
| --- | --- | --- |
| `orchestration.dispatchMode` | `oneshot-legacy` | Which run mode to use (above) |
| `orchestration.maxParallel` | `3` | How many tickets run at once |
| `orchestration.worktreeDir` | `~/catalyst/wt/<projectKey>` | Where worktrees are created |
| `orchestration.pluginDirs` | unset | Path(s) to the plugin checkout(s) workers run from (`<checkout>/plugins/dev`). Set by `setup-plugin-source.sh`; resolved by `phase-agent-dispatch` and refreshed by `catalyst-stack hotpatch` / merge-to-main. String or `:`-joined array. May also live in the machine config (Layer 2); the `CATALYST_PLUGIN_DIRS` env var overrides both. |
| `orchestration.phaseAgents.models[phase]` | `opus` | Model per step (`opus`, `sonnet`, or `haiku`). Phases: `triage`, `research`, `plan`, `implement`, `verify`, `review`, `pr`, `monitor-merge`, `monitor-deploy`, `teardown` |
| `orchestration.phaseAgents.turnCaps[phase]` | per-phase | Max Claude turns per step |
| `orchestration.draftPr.enabled` | `true` | Open a draft PR at the first implement commit; phase-pr flips it ready. Set `false` to create the PR only at the pr phase. |
| `CATALYST_WORKFLOW_GITHUB_TOKEN` _(env var, never committed)_ | unset | A GitHub PAT with the `workflow` OAuth scope. When set, phase-pr automatically routes pushes that touch `.github/workflows/` through this token instead of the ambient `GITHUB_TOKEN` (which lacks `workflow` scope). When unset and such a push is attempted, phase-pr escalates with an actionable `human_question` telling the operator to grant the scope or push manually. Provision via the daemon launch environment or `~/.config/catalyst/config-<projectKey>.json`. Alternative: `gh auth refresh -s workflow` re-auths the host token. |
| `orchestration.stalePrRescue.enabled` | `true` | Periodically rescue orphaned PRs that drifted to DIRTY or BEHIND after their workers died. |
| `orchestration.stalePrRescue.intervalSeconds` | `600` | How often the rescue timer ticks (seconds). |
| `orchestration.stalePrRescue.stableSeconds` | `300` | How long a PR must sit DIRTY/BEHIND before a rescue is attempted (avoids reacting to transient states). |
| `orchestration.stalePrRescue.behindThreshold` | `10` | BEHIND-commit count that triggers a rebase rescue (commits-behind below this are skipped). |
| `orchestration.stalePrRescue.maxAttempts` | `1` | Max rescue attempts per ticket. After exhaustion, the ticket is escalated to `needs-human`. |
| `orchestration.stalePrRescue.maxConflictFiles` | `5` | Max conflicting files before a DIRTY PR is deemed unresolvable and escalated instead of dispatched. |
| `orchestration.orphanReaper.procReaper.mode` | `shadow` | Orphan child-process reaper mode. `off` disables it; `shadow` (the default) logs `procOrphans.would-reap` for each orphaned reparented `node`/`bun` grandchild a dead worker left behind but **kills nothing**; `enforce` actually `SIGTERM`→grace→`SIGKILL`s them. Ships in `shadow` so the never-kill allowlist + live-agent process-tree correlation can be audited on real hosts before any `enforce` flip. |
| `orchestration.orphanReaper.procReaper.graceMs` | `5000` | Milliseconds to wait after `SIGTERM` before re-probing and (only if still alive) `SIGKILL`ing, so `node`/`bun` can flush. |
| `orchestration.orphanReaper.procReaper.minEtimeSec` | `900` | A process must have run at least this long (elapsed time) before it is eligible — corroboration only, never the sole gate. |
| `orchestration.orphanReaper.procReaper.worktreeRoot` | `~/catalyst/wt` | Only orphans whose working directory is under this root are reapable; an interactive `claude` or dev shell outside it is never touched. |
| `orchestration.orphanReaper.procReaper.allowlistPatterns` | `[]` | Extra case-insensitive argv substrings to never kill, on top of the built-in allowlist (the daemon, `broker/index.mjs`, `orch-monitor/server.ts`, the entire live-agent process tree, Tailscale, pid 1, and any foreign-uid process). |
| `orchestration.fleetHealth.enabled` | `true` | Whether the pre-exhaustion fleet-health probe runs. Set `false` (or `CATALYST_FLEET_HEALTH=0`) to disable it entirely. |
| `orchestration.fleetHealth.intervalMs` | `120000` | How often the probe samples the four steady-state signals (milliseconds). |
| `orchestration.fleetHealth.jobsThreshold` | `500` | `~/.claude/jobs` dir count at or above which the `jobs` signal trips. |
| `orchestration.fleetHealth.agentsThreshold` | `12` | Live background-agent count at or above which the `agents` signal trips. |
| `orchestration.fleetHealth.procsThreshold` | `40` | Resident `node`/`bun` worker-process count at or above which the `procs` signal trips. |
| `orchestration.fleetHealth.swapUsedMbThreshold` | `4096` | macOS swap-used MB at or above which the `swap` signal trips. |
| `orchestration.fleetHealth.selfHealEnabled` | `false` | Whether a sustained breach triggers self-heal (the two orphan-reaper intents plus a bounded `ppid==1` `node`/`bun` child sweep). **Default OFF** — the first ship is a pure alert. Enable with `EXECUTION_CORE_FLEET_SELF_HEAL=1`. |
| `orchestration.fleetHealth.sustainedTicks` | `2` | Consecutive degraded ticks required before self-heal fires (once per breach episode; re-armed only after a healthy tick). |

The orphan child-process reaper is the corroboration-heavy companion to the session-level reaper: `claude stop` deregisters a worker's claude agent but leaves its reparented `node`/`bun` grandchildren (MCP servers, sub-agent tooling, `bun test` runners) running — the bulk of the resident-memory leak. It runs on the same 600-second cadence as the orphan-session sweep and refuses to act unless every signal corroborates: a successful `claude agents` read this cycle (a failed read aborts the whole sweep), the process is reparented and outside the live-agent process tree, its command and working directory match, and it has persisted across two consecutive sweeps.

The fleet-health probe is the steady-state guardrail that ties the reapers together: it samples four degradation signals (the `~/.claude/jobs` dir count, the live background-agent count, the resident `node`/`bun` worker-process count, and macOS swap-used MB), each read fail-safe so an unreadable signal can only cause the probe to under-react. On a threshold breach it emits one `fleet.health.degraded` event (the host lives in the OTel `resource` block, so the monitor composes `fleet.health.degraded.<host>`). Self-heal is **default OFF** — the first ship is pure observability. When enabled it fires the same two reap intents the 600-second timer emits plus a capped (25-process) `node`/`bun` child sweep, once per sustained breach, re-armed only after the fleet recovers to healthy.

For `execution-core` mode, the number of workers comes from a separate committed block, `orchestration.executionCore.maxParallel` (default `4`). One daemon runs per machine and serves all your projects.

### Which tickets the daemon picks up

In `execution-core` mode, the daemon reads a central registry at `~/catalyst/execution-core/registry.json`. Each project there has an `eligibleQuery` that says which tickets are ready — for example, `status: "Ready"`. The setup tool `setup-execution-core-states.sh` writes this for you; you don't edit it by hand. That mode also needs six Linear states to exist — `Ready`, `Research`, `Plan`, `Implement`, `Validate`, and `PR` — which the same tool creates.

If the registry is missing (a fresh or headless host), enroll a project with
`catalyst-execution-core register --team <TEAM> --repo-root <path>` rather than writing the
file by hand — see [Remote and unattended hosts](/getting-started/remote-and-unattended-hosts/).

## Linear app-actor identity (`catalyst.linear.bot.{worker,orchestrator}.botUserId`)

Catalyst posts to Linear as a Linear OAuth **app actor** — the "Linear for Agents" identity that comments **as Catalyst**. Linear OAuth apps are account-level (one app serves every team), so the bot identity and OAuth credentials now live in the **global** `~/.config/catalyst/config.json` under `catalyst.linear.bot`, split into two app actors:

- `catalyst.linear.bot.worker` — the worker app that posts phase-agent mirror comments and mints tokens via `client_credentials`.
- `catalyst.linear.bot.orchestrator` — the orchestrator app that posts run-level updates.

Each carries a `botUserId` (the Linear user UUID of that app actor). The daemon and orch-monitor read **both** `botUserId`s into a single set so the self-echo / loop-prevention guard suppresses comments and issue events from **either** app actor. These UUIDs aren't secret (they appear on every comment the app posts), but they are account-specific.

```json
{
  "catalyst": {
    "linear": {
      "bot": {
        "worker": {
          "clientId": "...",
          "clientSecret": "...",
          "webhookSecret": "...",
          "accessToken": "...",
          "botUserId": null
        },
        "orchestrator": {
          "clientId": "...",
          "clientSecret": "...",
          "accessToken": "...",
          "botUserId": null
        }
      }
    }
  }
}
```

| Key | What it does |
| --- | --- |
| `catalyst.linear.bot.worker.botUserId` | Linear user UUID of the worker app actor. Suppresses self-echo on the worker's own mirror comments / description updates |
| `catalyst.linear.bot.orchestrator.botUserId` | Linear user UUID of the orchestrator app actor. Suppresses self-echo on orchestrator-posted updates |
| `catalyst.linear.bot.worker.{clientId,clientSecret,webhookSecret,accessToken}` | OAuth app-actor credentials for the worker identity. Secrets — keep in the un-committed global config |

### Back-compat (transition period)

Every reader prefers the new global path and falls back to the old location, so a running daemon or webhook receiver keeps working whether the value has been migrated yet:

- **Bot IDs:** `catalyst.linear.bot.{worker,orchestrator}.botUserId` (global) → fall back to `catalyst.monitor.linear.botUserId` (per-repo `.catalyst/config.json`, the legacy single-actor location).
- **Worker OAuth creds:** `catalyst.linear.bot.worker.{clientId,clientSecret}` (global) → fall back to `catalyst.linear.agent.{clientId,clientSecret}` (per-team `~/.config/catalyst/config-{projectKey}.json`, the legacy location).

The legacy keys remain readable, so you can migrate the values at any time without coordinating a restart.

### Why it's required

Catalyst's app identity lets it post comments as the app, and a human reply on a ticket can wake a parked worker. To make that work, the system must tell the agent's **own** comments and description updates apart from a human's. Without a `botUserId` loaded:

- The agent's own mirror comments get written into the worker inbox as if a human had replied — noise, and a false "human replied" signal.
- Bot-authored issue events feed back into the event log as write loops.

So the `botUserId` set is the self-echo and loop-prevention guard for the whole Linear-for-Agents channel. Set at least the worker `botUserId` for any workspace that uses the app-actor comms.

### How to obtain it

Query `viewer.id` with each app-actor token. The app OAuth credentials live in the global secrets file under `catalyst.linear.bot.{worker,orchestrator}` (legacy: `catalyst.linear.agent` in the per-team file):

```bash
TOKEN=$(jq -r '.catalyst.linear.bot.worker.accessToken // .catalyst.linear.agent.accessToken' ~/.config/catalyst/config.json)
BOT_ID=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"query{viewer{id name}}"}' | jq -r .data.viewer.id)
```

Write `$BOT_ID` into `~/.config/catalyst/config.json` under `catalyst.linear.bot.worker.botUserId` (repeat for the orchestrator actor), then restart both readers — they only load it at startup:

```bash
catalyst-monitor stop && catalyst-monitor start
catalyst-execution-core restart
```

## Secrets config (`~/.config/catalyst/config-{projectKey}.json`)

Never commit this. One file per project, linked by `projectKey`. It holds API keys.

```json
{
  "catalyst": {
    "linear": { "apiToken": "lin_api_...", "teamKey": "ACME" },
    "sentry": { "org": "acme-corp", "project": "acme-web", "authToken": "sntrys_..." },
    "posthog": { "apiKey": "phc_...", "projectId": "12345" }
  }
}
```

| Integration | Required fields | Used by |
| --- | --- | --- |
| Linear | `apiToken`, `teamKey` | catalyst-dev, catalyst-pm |
| Sentry | `org`, `project`, `authToken` | catalyst-debugging |
| PostHog | `apiKey`, `projectId` | catalyst-analytics |

Only set up the integrations you use — the setup script asks about each one.

## GitHub merge rules live in GitHub

Catalyst can open PRs, fix CI, answer review bots, and merge. But GitHub decides what must pass before code lands. Those rules live in **GitHub branch protection or rulesets**, not in `.catalyst/config.json`.

For hands-off merging, set your `main` branch to require pull requests, require status checks to pass, and require review threads to be resolved. Then Catalyst drives the PR to the finish and GitHub enforces the gates. To require a human sign-off too, also require one approving review.

## More settings

Catalyst reads many more keys — for the event broker, the Monitor dashboard, webhooks, deploy checks, and worktree setup. The setup script writes them, and `plugins/dev/templates/config.template.json` lists them all. You only need the keys above to get started.

### Runaway-dispatch guards (CTL-671)

The execution-core scheduler protects itself against a single ticket dominating the dispatch loop. These knobs are env vars on the `catalyst-execution-core` process:

- `SCHEDULER_CIRCUIT_BREAKER_THRESHOLD` (default `8`) — consecutive failed dispatches (no forward progress) before a ticket is quarantined to terminal `stalled` + `needs-human`. A successful dispatch resets the counter, so a healthy ticket can never trip it.
- `SCHEDULER_RUNAWAY_THRESHOLD` (default `50`) — per-ticket `phase.*.<ticket>` event count within `SCHEDULER_RUNAWAY_WINDOW_MS` that fires one `phase.dispatch.runaway.<ticket>` alert. Observability only — it surfaces a dominating ticket without quarantining it.
- `SCHEDULER_RUNAWAY_WINDOW_MS` (default `600000`, 10 min) — rolling window for the runaway-rate alert and its once-per-window suppression marker.

The **phantom worker-dir validity sweep** quarantines a `workers/<ticket>/` dir only when all three hold: the ticket is definitively **not-found** in Linear (a clean exit-0 not-found body — a nonzero exit or transient outage classifies as `unknown` and is never quarantined), it is **not in the eligible set**, and it has **no live bg worker**. This conjunction guarantees a transient Linear outage can never quarantine a healthy, resolvable, in-flight ticket. `SCHEDULER_CIRCUIT_BREAKER_THRESHOLD` is the Linear-independent backstop; the runaway knobs are observability only.
