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
| `inReview`   | Running `create-pr` or `describe-pr` | In Review   |
| `done`       | Running `merge-pr`                   | Done        |
| `canceled`   | Manual cancellation                  | Canceled    |

Set any key to `null` to skip that automatic transition.

**`stateMap` values are auto-detected from Linear** — when you run `setup-catalyst.sh` with a Linear
API token, the script fetches your team's actual workflow states and populates `stateMap` with the
correct names. Manual customization is only needed for non-standard state names.

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

## Worktree Setup

Define the commands that run when creating a new worktree via `/create-worktree` or `/orchestrate`. This replaces the default auto-detected setup (dependency install + thoughts init) with full project control — like `conductor.json`'s lifecycle hooks.

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
      "workerCommand": "/oneshot",
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
| `workerCommand` | string | `/oneshot` | Skill to dispatch in each worker |
| `workerModel` | string | `opus` | Model for worker sessions |
| `testRequirements` | object | See above | Required test types by scope (backend/frontend/fullstack) |
| `verifyBeforeMerge` | boolean | `true` | Run adversarial verification before allowing merge |
| `allowSelfReportedCompletion` | boolean | `false` | Trust worker's self-reported completion without verification |

## Workflow Context (`.catalyst/.workflow-context.json`)

Auto-managed by Claude Code hooks and skills. Not committed to git.

```json
{
  "lastUpdated": "2025-10-26T10:30:00Z",
  "currentTicket": "PROJ-123",
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

This file is what enables skill chaining — when you save research, `create-plan` finds it
automatically. When you save a plan, `implement-plan` finds it. You never need to specify file paths
between workflow phases.

### Script API

The `workflow-context.sh` script manages this file programmatically:

```bash
workflow-context.sh init                    # Create file if missing
workflow-context.sh set-ticket PROJ-123     # Set currentTicket (no document needed)
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
