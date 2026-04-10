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

## Workflow Context (`.catalyst/.workflow-context.json`)

Auto-managed by Claude Code hooks. Not committed to git.

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
