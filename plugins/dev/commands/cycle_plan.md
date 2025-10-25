---
description: Plan work for current or next cycle using Linearis and GitHub
category: project-task-management
tools: Bash(linearis *), Bash(gh *), Read, Write, TodoWrite
model: inherit
version: 1.0.0
status: placeholder
---

# Cycle Planning

**Status**: Placeholder for v1.0 - Full implementation coming in future release

## Planned Functionality

This command will help you plan work for the current or upcoming cycle by:

1. Fetching current and next cycle information
2. Listing backlog tickets ready for planning
3. Interactively assigning tickets to cycles
4. Setting milestones and priorities
5. Generating cycle plan summary

## Current Workaround

Use Linearis CLI directly:

```bash
# Get active cycle
linearis cycles list --team TEAM --active

# List backlog tickets
linearis issues list --team TEAM --status "Backlog"

# Assign ticket to cycle
linearis issues update TICKET-123 --cycle "Sprint 2025-11"

# Set priority
linearis issues update TICKET-123 --priority 2
```

### Example Workflow

```bash
# 1. View active cycle
linearis cycles list --team ENG --active | jq '.[] | {name, startsAt, endsAt, progress}'

# 2. View next cycle
linearis cycles list --team ENG --limit 5 | jq '.[1]'

# 3. List backlog tickets ready for planning
linearis issues list --team ENG --status "Backlog" | \
  jq '.[] | {id, title, priority}'

# 4. Review recent PRs to understand current work
# This helps identify work done but not captured in Linear tickets
gh pr list --state merged --limit 20 --json number,title,author,mergedAt,closedAt

# Filter by date range (e.g., last 2 weeks for planning context)
gh pr list --state merged --search "merged:>=$(date -v-14d +%Y-%m-%d)" \
  --json number,title,author,mergedAt --jq '.[] | "\(.author.login): \(.title)"'

# 5. Identify who is working on what
gh pr list --state open --json number,title,author,createdAt | \
  jq 'group_by(.author.login) | map({author: .[0].author.login, prs: map({number, title})})'

# 6. Assign high-priority tickets to next cycle
linearis issues update ENG-123 --cycle "Sprint 2025-11" --priority 2
linearis issues update ENG-124 --cycle "Sprint 2025-11" --priority 2

# 7. Generate summary (manual)
# Count tickets by cycle and priority
```

## Future Implementation

When fully implemented, this command will:

- **Interactive cycle selection** - Choose current or next cycle
- **Smart backlog filtering** - Show tickets by priority and readiness
- **Batch assignment** - Select multiple tickets to assign at once
- **Capacity planning** - Estimate points/hours per ticket
- **Milestone tracking** - Group tickets by project milestones
- **PR-based work tracking** - Auto-detect work from merged/open PRs to identify:
  - Work completed but not tracked in Linear
  - Who is actively working on what
  - Team velocity based on PR activity
- **Team activity report** - Show contribution breakdown by team member
- **Summary generation** - Create cycle plan document in thoughts/

Track progress at: https://github.com/coalesce-labs/catalyst/issues/PLACEHOLDER

## Configuration

Uses `.claude/config.json`:

```json
{
  "linear": {
    "teamKey": "ENG",
    "defaultTeam": "Backend"
  }
}
```

## Tips

- Plan cycles **before they start** - gives team time to review
- Prioritize by **user impact** and **dependencies**
- Leave **buffer capacity** for bugs and urgent tasks
- Use **milestones** to group related work
- Review cycle plans in team meetings for alignment
- **Check PR activity** before planning to understand:
  - What work has been completed recently
  - Who is actively contributing
  - Untracked work that should be captured in Linear
  - Team velocity and capacity trends
