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
- **`phase-agents`** — runs each ticket as nine short background jobs, one per step.
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
| `orchestration.phaseAgents.models[phase]` | `opus` | Model per step (`opus`, `sonnet`, or `haiku`). Phases: `triage`, `research`, `plan`, `implement`, `verify`, `review`, `pr`, `monitor-merge`, `monitor-deploy` |
| `orchestration.phaseAgents.turnCaps[phase]` | per-phase | Max Claude turns per step |

For `execution-core` mode, the number of workers comes from a separate committed block, `orchestration.executionCore.maxParallel` (default `4`). One daemon runs per machine and serves all your projects.

### Which tickets the daemon picks up

In `execution-core` mode, the daemon reads a central registry at `~/catalyst/execution-core/registry.json`. Each project there has an `eligibleQuery` that says which tickets are ready — for example, `status: "Ready"`. The setup tool `setup-execution-core-states.sh` writes this for you; you don't edit it by hand. That mode also needs six Linear states to exist — `Ready`, `Research`, `Plan`, `Implement`, `Validate`, and `PR` — which the same tool creates.

## Linear app-actor identity (`catalyst.monitor.linear.botUserId`)

You must set `catalyst.monitor.linear.botUserId` for the Linear app-actor comms channel — i.e. when the daemon mirrors phase-agent output to Linear and wakes on human replies (the "Linear for Agents" identity that posts comments **as Catalyst**). It's the Linear user UUID of that app actor. This lives in the committed `.catalyst/config.json` — not the secrets file — because the value isn't secret (it appears on every comment the app posts), but it is workspace-specific.

```json
{
  "catalyst": {
    "monitor": {
      "linear": {
        "teams": ["ACME"],
        "webhookSecretEnv": "CATALYST_LINEAR_WEBHOOK_SECRET",
        "botUserId": null
      }
    }
  }
}
```

| Key | What it does |
| --- | --- |
| `catalyst.monitor.linear.botUserId` | Linear user UUID of the Catalyst app actor. Required for the Linear app-actor comms channel — when the daemon mirrors phase-agent output to Linear and wakes on human replies; leave `null` otherwise |

### Why it's required

Catalyst's app identity lets it post comments as the app, and a human reply on a ticket can wake a parked worker. To make that work, the system must tell the agent's **own** comments and description updates apart from a human's. Without `botUserId` loaded, it can't:

- The agent's own mirror comments get written into the worker inbox as if a human had replied — noise, and a false "human replied" signal.
- Bot-authored issue events feed back into the event log as write loops.

So `botUserId` is the self-echo and loop-prevention guard for the whole Linear-for-Agents channel. Set it for any workspace that uses the app-actor comms.

### How to obtain it

Query `viewer.id` with the app-actor token. The app OAuth credentials live in the secrets file under `catalyst.linear.agent`:

```bash
TOKEN=$(jq -r '.catalyst.linear.agent.accessToken' ~/.config/catalyst/config-{projectKey}.json)
BOT_ID=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"query{viewer{id name}}"}' | jq -r .data.viewer.id)
```

Write `$BOT_ID` into `.catalyst/config.json` under `catalyst.monitor.linear.botUserId`, then restart both readers — they only load it at startup:

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
