---
title: Configuration Schema
description: Complete configuration reference for .claude/config.json and secrets files.
---

## Project Config (`.claude/config.json`)

Safe to commit to version control.

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

| Field | Type | Description |
|-------|------|-------------|
| `catalyst.projectKey` | string | Links to secrets config file |
| `catalyst.repository.org` | string | GitHub organization |
| `catalyst.repository.name` | string | Repository name |
| `catalyst.project.ticketPrefix` | string | Linear ticket prefix (e.g., "ACME") |
| `catalyst.project.name` | string | Human-readable project name |
| `catalyst.linear.stateMap` | object | Maps workflow phases to Linear states |
| `catalyst.thoughts.user` | string\|null | HumanLayer thoughts user name |

### State Map Keys

| Key | When Used | Default |
|-----|----------|---------|
| `backlog` | Initial ticket state | Backlog |
| `todo` | Acknowledged, unstarted | Todo |
| `research` | `/research-codebase` | In Progress |
| `planning` | `/create-plan` | In Progress |
| `inProgress` | `/implement-plan` | In Progress |
| `inReview` | `/describe-pr`, `/create-pr` | In Review |
| `done` | `/merge-pr` | Done |
| `canceled` | Manual cancellation | Canceled |

Set any key to `null` to skip that automatic transition.

## Secrets Config (`~/.config/catalyst/config-{projectKey}.json`)

Never committed. One file per project.

```json
{
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
  "railway": {
    "token": "...",
    "projectId": "..."
  },
  "posthog": {
    "apiKey": "phc_...",
    "projectId": "12345"
  },
  "exa": {
    "apiKey": "..."
  }
}
```

### Integration Fields

| Integration | Required Fields | Used By |
|------------|----------------|---------|
| Linear | `apiToken`, `teamKey` | catalyst-dev, catalyst-pm |
| Sentry | `org`, `project`, `authToken` | catalyst-debugging |
| Railway | `token`, `projectId` | catalyst-dev |
| PostHog | `apiKey`, `projectId` | catalyst-analytics |
| Exa | `apiKey` | catalyst-dev (external research) |

## Workflow Context (`.claude/.workflow-context.json`)

Auto-managed. Not committed to git.

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

This file is automatically updated by Claude Code hooks when you write to `thoughts/shared/`. Commands use it to auto-discover recent documents.
