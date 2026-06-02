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
