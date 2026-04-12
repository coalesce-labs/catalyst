---
name: linearis-cli
description:
  Reference for Linearis CLI commands to interact with Linear project management. Use when working
  with Linear tickets, cycles, projects, milestones, or when the user mentions ticket IDs like
  TEAM-123, BRAVO-456, ENG-789.
---

# Linearis CLI Reference

> Verified against Linearis v2026.4.4 on 2026-04-12.

**CRITICAL: Always use these exact patterns. Do NOT guess or improvise syntax.**

## Issue Operations

### Read a Ticket

```bash
linearis issues read TEAM-123                    # ✅ By identifier
linearis issues read 7690e05c-32fb-4cf2-b709-f9adb12e73e7  # ✅ By UUID
```

**Common mistakes:**

```bash
linearis issues get TEAM-123      # ❌ WRONG - no 'get' command
linearis issue view TEAM-123      # ❌ WRONG - no 'view', use 'read'
linearis issue TEAM-123           # ❌ WRONG - missing subcommand
```

### List Tickets

```bash
linearis issues list                                        # Basic list (50 tickets)
linearis issues list --limit 100                            # With limit
linearis issues list --team BRAVO                           # Filter by team
linearis issues list --team BRAVO --status "In Progress"    # By status (requires --team)
linearis issues list --team BRAVO --assignee "user@co.com"  # By assignee
linearis issues list --project "Auth System"                # By project
linearis issues list --team BRAVO --cycle "Sprint 2026-04"  # By cycle (requires --team)
linearis issues list --priority 1                           # By priority (1=Urgent..4=Low)
linearis issues list --label "bug,urgent"                   # By labels (comma-separated)
linearis issues list --due-before 2026-05-01                # By due date
linearis issues list --has-blockers                         # Only blocked issues
linearis issues list --is-blocking                          # Only issues blocking others
```

**Common mistakes:**

```bash
linearis issues list --filter "keyword"      # ❌ WRONG - no --filter flag. Use issues search
linearis issues list --status "In Progress"  # ❌ WRONG without --team. --status requires --team
```

### Search Tickets

```bash
linearis issues search "keyword"                               # Full-text search
linearis issues search "keyword" --team BRAVO                  # Scoped to team
linearis issues search "auth bug" --team BRAVO --status "Todo" # With status (requires --team)
linearis issues search "keyword" --assignee "user@co.com"      # By assignee
linearis issues search "keyword" --project "Auth System"       # By project
linearis issues search "keyword" --limit 20                    # Limit results
```

### Update a Ticket

```bash
# Update status (use --status, NOT --state)
# Status names should come from stateMap in .catalyst/config.json
linearis issues update TEAM-123 --status "In Progress"
linearis issues update TEAM-123 --status "In Review"
linearis issues update TEAM-123 --status "Done"

# Other updates
linearis issues update TEAM-123 --title "New title"
linearis issues update TEAM-123 --description "New description"
linearis issues update TEAM-123 --priority 1              # 1=Urgent, 2=High, 3=Medium, 4=Low
linearis issues update TEAM-123 --assignee <user-id>
linearis issues update TEAM-123 --project "Project Name"
linearis issues update TEAM-123 --cycle "Cycle Name"
linearis issues update TEAM-123 --project-milestone "Milestone Name"
linearis issues update TEAM-123 --labels "bug,urgent"
linearis issues update TEAM-123 --labels "bug" --label-mode add        # Append labels
linearis issues update TEAM-123 --labels "bug" --label-mode overwrite  # Replace all labels
linearis issues update TEAM-123 --clear-labels
linearis issues update TEAM-123 --parent-ticket TEAM-100
linearis issues update TEAM-123 --clear-parent-ticket
linearis issues update TEAM-123 --estimate 3
linearis issues update TEAM-123 --due-date 2026-05-01
linearis issues update TEAM-123 --clear-cycle
linearis issues update TEAM-123 --clear-project-milestone
linearis issues update TEAM-123 --blocks TEAM-456          # Add relation
linearis issues update TEAM-123 --remove-relation TEAM-456 # Remove relation
```

**Common mistakes:**

```bash
linearis issues update TEAM-123 --state "Done"    # ❌ WRONG - use --status (--state removed in v2025.12.2)
```

### Create a Ticket

```bash
linearis issues create "Title of ticket" --team BRAVO
linearis issues create "Title" --team BRAVO --description "Description" --status "Todo" --priority 2
linearis issues create "Title" --team BRAVO --project "Project Name"
linearis issues create "Title" --team BRAVO --parent-ticket TEAM-100
linearis issues create "Title" --team BRAVO --due-date 2026-05-01
linearis issues create "Title" --team BRAVO --labels "bug,urgent"
```

## Comment Operations

### Add a Comment

```bash
linearis comments create TEAM-123 --body "Starting research"

# Multi-line comment
linearis comments create TEAM-123 --body "Research complete!

See findings: https://github.com/..."
```

**Common mistakes:**

```bash
linearis issues comment TEAM-123 "Comment"        # ❌ WRONG
linearis issues add-comment TEAM-123 "Comment"    # ❌ WRONG
linearis comment TEAM-123 --body "Comment"        # ❌ WRONG
```

**Correct pattern:** `linearis comments create` (plural "comments", then "create")

## Cycle Operations

### List Cycles

```bash
linearis cycles list --team BRAVO              # All cycles
linearis cycles list --team BRAVO --active     # Only active cycle
linearis cycles list --team BRAVO --limit 5    # Recent cycles
linearis cycles list --team BRAVO --window 2   # Active cycle +/- 2 neighbors
```

### Read Cycle Details

```bash
linearis cycles read "Sprint 2026-04" --team BRAVO   # By name
linearis cycles read <cycle-uuid>                     # By UUID
linearis cycles read "Sprint 2026-04" --team BRAVO --limit 100  # Fetch more issues (default: 50)
```

### Get Active Cycle Pattern

```bash
CYCLE=$(linearis cycles list --team BRAVO --active | jq -r '.[0].name')
linearis cycles read "$CYCLE" --team BRAVO | jq '.issues[] | {identifier, title, state: .state.name}'
```

## Project Operations

### List Projects

```bash
# NOTE: projects list does NOT support --team. It returns all workspace projects.
linearis projects list
linearis projects list | jq '.[] | select(.name == "Auth System")'
```

## Milestone Operations

### List Milestones

```bash
linearis milestones list --project "Project Name"
linearis milestones list --project <project-uuid>
```

### Read Milestone

```bash
linearis milestones read "Beta Launch" --project "Auth System"
linearis milestones read <milestone-uuid>
linearis milestones read "Beta Launch" --project "Auth System" --limit 100  # Fetch more issues (default: 50)
```

### Create Milestone

```bash
linearis milestones create "Beta Launch" --project "Auth System"
linearis milestones create "GA Release" --project "Auth System" --description "General availability" --target-date 2026-06-15
```

### Update Milestone

```bash
linearis milestones update "Milestone" --project "Project" --name "New Name"
linearis milestones update "Milestone" --project "Project" --target-date "2026-12-31"
linearis milestones update "Milestone" --project "Project" --description "Updated description"
```

**Common mistakes:**

```bash
linearis project-milestones list --project "X"   # ❌ WRONG - renamed to 'milestones' in v2026.4
linearis project-milestones read "M" --project X # ❌ WRONG - use 'milestones', not 'project-milestones'
```

## Team Operations

### List Teams

```bash
linearis teams list
```

Returns all workspace teams with keys, names, and UUIDs.

## Label Operations

```bash
linearis labels list --team BRAVO
```

## Document Operations

```bash
linearis documents list                                          # All documents
linearis documents list --project "Auth System"                  # By project
linearis documents list --issue TEAM-123                         # Attached to issue
linearis documents read <document-id>
linearis documents create --title "Design Doc" --content "# Overview..." --project "Auth System"
linearis documents create --title "Notes" --content "..." --issue TEAM-123  # Attach to issue
linearis documents update <document-id> --title "New Title" --content "..."
linearis documents delete <document-id>
```

## User Operations

```bash
linearis users list                # All workspace members
linearis users list --active       # Only active users
```

## Authentication

```bash
linearis auth login                # Interactive login
linearis auth status               # Check current auth
linearis auth logout               # Remove stored token
```

## Common Workflow Patterns

### Read ticket, update state, add comment

```bash
# 1. Read ticket
linearis issues read TEAM-123

# 2. Update state
linearis issues update TEAM-123 --status "In Progress"

# 3. Add comment
linearis comments create TEAM-123 --body "Starting work on this"
```

### Find tickets in current cycle

```bash
CYCLE=$(linearis cycles list --team BRAVO --active | jq -r '.[0].name')
linearis cycles read "$CYCLE" --team BRAVO | jq '.issues[] | {identifier, title, state: .state.name}'
```

### Get tickets by project and team

```bash
linearis issues list --team BRAVO --project "Auth System" --limit 100
```

### Get blocked tickets

```bash
linearis issues list --team BRAVO --has-blockers
```

### Mark ticket as done with PR link

```bash
# State name from stateMap.done config (default: "Done")
DONE_STATE=$(jq -r '.catalyst.linear.stateMap.done // "Done"' .catalyst/config.json 2>/dev/null || echo "Done")
linearis issues update TEAM-123 --status "$DONE_STATE"
linearis comments create TEAM-123 --body "Merged: PR #456 https://github.com/org/repo/pull/456"
```

### Discover teams in workspace

```bash
linearis teams list | jq '.[] | {key, id, name}'
```

## Quick Reference Card

| Action           | Command                                                      |
| ---------------- | ------------------------------------------------------------ |
| Read ticket      | `linearis issues read TEAM-123`                              |
| Update status    | `linearis issues update TEAM-123 --status "Status"`          |
| Add comment      | `linearis comments create TEAM-123 --body "text"`            |
| Search           | `linearis issues search "keyword" --team BRAVO`              |
| List issues      | `linearis issues list --team BRAVO --status "In Progress"`   |
| Active cycle     | `linearis cycles list --team TEAM --active`                  |
| Cycle details    | `linearis cycles read "Name" --team TEAM`                    |
| List milestones  | `linearis milestones list --project "Project"`               |
| List teams       | `linearis teams list`                                        |
| Create ticket    | `linearis issues create "Title" --team TEAM`                 |

## Important Rules

1. **--status NOT --state**: Always use `--status` for issue status updates (renamed in v2025.12.2)
2. **comments create**: Use `linearis comments create`, not `issues comment`
3. **issues read**: Use `read`, not `get` or `view`
4. **milestones NOT project-milestones**: The command was renamed in v2026.4 — use `linearis milestones`, not `linearis project-milestones`
5. **--team accepts keys, names, and UUIDs**: All commands that support `--team` accept any form (e.g., `--team BRAVO`, `--team "Team Name"`, `--team <uuid>`)
6. **--status requires --team**: On `issues list` and `issues search`, the `--status` flag only works when `--team` is also provided
7. **Quotes for spaces**: `--cycle "Sprint 2026-04"` not `--cycle Sprint 2026-04`
8. **JSON output**: All commands return JSON — use jq for parsing

## Getting Help

```bash
linearis --help
linearis issues --help
linearis issues update --help
linearis comments --help
linearis cycles --help
linearis milestones --help
linearis documents --help
linearis teams --help
```
