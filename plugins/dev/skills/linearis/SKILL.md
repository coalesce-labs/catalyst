---
name: linearis-cli
description:
  Reference for Linearis CLI commands to interact with Linear project management. Use when working
  with Linear tickets, cycles, projects, milestones, or when the user mentions ticket IDs like
  TEAM-123, ENG-456, PROJ-789.
---

# Linearis CLI Reference

> Verified against Linearis v2026.4.4 on 2026-04-12.

**CRITICAL: Always use these exact patterns. Do NOT guess or improvise syntax.**

## Looking Up Syntax

For full flag details, run `linearis usage` (all domains) or `linearis <domain> usage` (one domain).
The `usage` output is authoritative and always current — prefer it over memorizing flags.

```bash
linearis usage                # Full overview of every domain and flag
linearis issues usage         # Just issue operations
linearis milestones usage     # Just milestone operations
linearis cycles usage         # Just cycle operations
```

## Core Operations

### Read a ticket

```bash
linearis issues read ENG-123
```

### Search tickets

```bash
linearis issues search "keyword"
linearis issues search "auth bug" --team ENG --status "Todo"
```

### Create a ticket

```bash
linearis issues create "Title" --team ENG
linearis issues create "Title" --team ENG --description "Details" --priority 2 --project "Project"
```

### Update a ticket

```bash
linearis issues update ENG-123 --status "In Progress"
linearis issues update ENG-123 --priority 1
linearis issues update ENG-123 --labels "bug" --label-mode add
linearis issues update ENG-123 --project "Project Name"
linearis issues update ENG-123 --project-milestone "Milestone Name"
```

### Comment on a ticket

```bash
linearis comments create ENG-123 --body "Starting work on this"
```

**Common mistakes:**

```bash
linearis issues get ENG-123             # ❌ no 'get' — use 'read'
linearis issue view ENG-123             # ❌ no 'view' — use 'read'
linearis issues comment ENG-123 "text"  # ❌ use 'comments create', not 'issues comment'
linearis issues update ENG-123 --state  # ❌ use --status, not --state
linearis project-milestones list        # ❌ renamed to 'milestones' in v2026.4
```

## Workflow: Backlog Grooming

### Get the lay of the land

```bash
# Discover teams and projects
linearis teams list | jq '.nodes[] | {key, name}'
linearis projects list | jq '.nodes[] | {name, status: .status.name, id}'
```

### Pull tickets by project

```bash
# All tickets in a specific project
linearis issues list --project "Auth System" --limit 100

# Tickets in a project, grouped by status (requires --team for --status filter)
linearis issues list --team ENG --project "Auth System" --status "Backlog,Todo" --limit 100
```

### Find orphaned tickets (no project assigned)

```bash
linearis issues list --team ENG --limit 200 | jq '[.nodes[] | select(.project == null)] | length'
linearis issues list --team ENG --limit 200 | jq '.nodes[] | select(.project == null) | {identifier, title, state: .state.name}'
```

### Triage by priority

```bash
# Urgent/high priority tickets
linearis issues list --team ENG --priority 1 --limit 50
linearis issues list --team ENG --priority 2 --limit 50

# Unestimated tickets in a project
linearis issues list --project "Auth System" --limit 100 | jq '.nodes[] | select(.estimate == null) | {identifier, title}'
```

### Find stale tickets

```bash
# Not updated in 30+ days
linearis issues list --team ENG --updated-before 2026-03-13 --status "In Progress" --limit 50
```

### Assign a ticket to a project

```bash
linearis issues update ENG-123 --project "Auth System"
```

## Workflow: Milestone Management

### See milestones for a project

```bash
linearis milestones list --project "Auth System"
```

### Read milestone details (including its issues)

```bash
linearis milestones read "Beta Launch" --project "Auth System"
linearis milestones read "Beta Launch" --project "Auth System" --limit 100
```

### Create a milestone

```bash
linearis milestones create "Beta Launch" --project "Auth System" --target-date 2026-06-15
linearis milestones create "GA Release" --project "Auth System" --description "General availability" --target-date 2026-09-01
```

### Rename or reschedule a milestone

```bash
linearis milestones update "Beta Launch" --project "Auth System" --name "Beta 2.0"
linearis milestones update "Beta Launch" --project "Auth System" --target-date 2026-07-01
```

### Assign tickets to a milestone

```bash
linearis issues update ENG-123 --project-milestone "Beta Launch"

# Clear a milestone assignment
linearis issues update ENG-123 --clear-project-milestone
```

### Audit milestone coverage

```bash
# Tickets in a project with no milestone
linearis issues list --project "Auth System" --limit 100 | jq '.nodes[] | select(.projectMilestone == null) | {identifier, title}'
```

## Workflow: Label Management

### Discover labels

```bash
linearis labels list --team ENG
linearis labels list --team ENG | jq '.nodes[] | {name, color}'
```

### See what a label contains

```bash
linearis issues list --team ENG --label "bug" --limit 100
linearis issues list --team ENG --label "tech-debt" --limit 100
```

### Re-label tickets

```bash
# Add a label (keeps existing labels)
linearis issues update ENG-123 --labels "needs-triage" --label-mode add

# Replace all labels
linearis issues update ENG-123 --labels "bug,P1" --label-mode overwrite

# Remove all labels
linearis issues update ENG-123 --clear-labels
```

## Workflow: Cycle Review

### Get the active cycle

```bash
linearis cycles list --team ENG --active
```

### Read cycle with all issues

```bash
CYCLE=$(linearis cycles list --team ENG --active | jq -r '.nodes[0].name')
linearis cycles read "$CYCLE" --team ENG --limit 100
```

### Summarize cycle progress

```bash
CYCLE=$(linearis cycles list --team ENG --active | jq -r '.nodes[0].name')
linearis cycles read "$CYCLE" --team ENG --limit 100 | jq '
  .issues
  | group_by(.state.name)
  | map({status: .[0].state.name, count: length, tickets: [.[].identifier]})
'
```

### Nearby cycles (for planning)

```bash
# Active cycle plus 2 before and after
linearis cycles list --team ENG --window 2
```

## Workflow: Status Transitions

Status names come from the team's workflow configuration. Use the stateMap in `.catalyst/config.json`
when available, otherwise read a ticket to discover valid status names.

```bash
# Common flow
linearis issues update ENG-123 --status "In Progress"
linearis issues update ENG-123 --status "In Review"
linearis issues update ENG-123 --status "Done"

# With comment
linearis issues update ENG-123 --status "Done"
linearis comments create ENG-123 --body "Merged: PR #456"
```

## Important Rules

1. **--status NOT --state**: Always `--status` for issue updates (`--state` was removed in v2025.12.2)
2. **comments create**: The command is `linearis comments create`, not `issues comment`
3. **milestones NOT project-milestones**: The command was renamed in v2026.4
4. **--status requires --team**: On `issues list` and `issues search`, `--status` only works when `--team` is also provided
5. **--team accepts keys, names, and UUIDs**: Any form works on all commands (e.g., `--team ENG`)
6. **Quotes for spaces**: `--status "In Progress"` not `--status In Progress`
7. **JSON output**: All commands return JSON — use jq for parsing
8. **Use `linearis <domain> usage`**: When unsure about flags, check usage instead of guessing
