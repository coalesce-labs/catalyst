---
title: Linear
description: Linear integration for ticket management and automatic workflow status updates.
---

Catalyst integrates with Linear via the [Linearis CLI](https://www.npmjs.com/package/linearis), providing ticket management and automatic status progression as you move through the development workflow.

## Automatic Status Updates

When you run workflow commands, Catalyst automatically updates Linear ticket status:

| Command | Default State |
|---------|--------------|
| `/catalyst-dev:research_codebase` (with ticket) | In Progress |
| `/catalyst-dev:create_plan` (with ticket) | In Progress |
| `/catalyst-dev:implement_plan` (with ticket) | In Progress |
| `/catalyst-dev:create_pr` (with ticket) | In Review |
| `/catalyst-dev:merge_pr` | Done |

## Ticket Detection

Commands detect tickets automatically from:

1. Plan frontmatter: `ticket: PROJ-123`
2. Filenames: `2025-01-08-PROJ-123-feature.md`
3. Handoff documents
4. Worktree directory names

## Configuration

### Default Setup (No Configuration Needed)

Standard Linear workspaces already have the states Catalyst needs:
- Backlog, Todo, In Progress, In Review, Done, Canceled

### Custom State Mapping

For teams with custom Linear states, configure `stateMap` in `.claude/config.json`:

```json
{
  "catalyst": {
    "linear": {
      "stateMap": {
        "backlog": "Backlog",
        "todo": "Todo",
        "research": "Research in Progress",
        "planning": "Plan in Progress",
        "inProgress": "In Dev",
        "inReview": "In Review",
        "done": "Done",
        "canceled": "Canceled"
      }
    }
  }
}
```

Set any key to `null` to skip that transition.

## Commands

The `/catalyst-dev:linear` command provides direct ticket management:

```bash
/catalyst-dev:linear create "Add OAuth support"
/catalyst-dev:linear move PROJ-123 "In Progress"
/catalyst-dev:linear comment PROJ-123 "Started implementation"
```

## PM Plugin Integration

The `catalyst-pm` plugin extends Linear integration with:

- `/catalyst-pm:analyze_cycle` — Cycle health analysis
- `/catalyst-pm:analyze_milestone` — Milestone progress tracking
- `/catalyst-pm:groom_backlog` — Backlog health and cleanup
- `/catalyst-pm:sync_prs` — GitHub-Linear PR correlation

## Setup

1. Install Linearis: `npm install -g linearis`
2. Get a Linear API token from [linear.app/settings/api](https://linear.app/settings/api)
3. Add to secrets config: `~/.config/catalyst/config-{projectKey}.json`

```json
{
  "catalyst": {
    "linear": {
      "apiToken": "lin_api_...",
      "teamKey": "ACME"
    }
  }
}
```

The `setup-catalyst.sh` script auto-detects available states from the Linear API and generates the correct `stateMap` for your workspace.

## Why CLI Instead of MCP?

Linearis CLI uses ~1K tokens vs Linear MCP's ~13K tokens — a **13x reduction** in context cost. For most ticket operations, the CLI provides everything needed at a fraction of the context overhead.
