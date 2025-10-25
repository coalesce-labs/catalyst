---
description: Review project roadmap and milestone progress
category: project-task-management
tools: Bash(linearis *), Read, Write, TodoWrite
model: inherit
version: 1.0.0
status: placeholder
---

# Roadmap Review

**Status**: Placeholder for v1.0 - Full implementation coming in future release

## Planned Functionality

This command will help you review your roadmap by:

1. Listing all active projects
2. Showing milestone progress for each project
3. Identifying project dependencies
4. Calculating project completion
5. Generating roadmap summary

## Current Workaround

Use Linearis CLI directly:

```bash
# List projects
linearis projects list --team TEAM

# Parse project status from JSON
linearis projects list --team TEAM | jq '.[] | {name, status, progress}'

# List tickets for specific project
linearis issues list --team TEAM | jq '.[] | select(.project.name == "Project Name")'
```

### Example Workflow

```bash
# 1. List all active projects
linearis projects list --team ENG | \
  jq '.[] | select(.state != "completed") | {name, lead, targetDate}'

# 2. Get project details with ticket counts
for project in $(linearis projects list --team ENG | jq -r '.[].name'); do
  echo "Project: $project"

  # Count tickets by status
  linearis issues list --team ENG | \
    jq --arg proj "$project" '
      [.[] | select(.project.name == $proj)] |
      group_by(.state.name) |
      map({status: .[0].state.name, count: length})
    '
done

# 3. Identify project dependencies
# (Manual - look at project descriptions or ticket relationships)

# 4. Calculate overall progress
# total_tickets in project
# completed_tickets in project
# progress = (completed / total) * 100

# 5. Identify at-risk projects
# - No tickets completed in last 2 weeks
# - Target date approaching with <50% completion
# - Blocked tickets preventing progress
```

## Future Implementation

When fully implemented, this command will:

- **Project overview** - Show all projects with key metrics
- **Milestone tracking** - Group tickets by milestone with progress
- **Dependency visualization** - Show project relationships and blockers
- **Risk analysis** - Identify at-risk projects (delayed, under-resourced)
- **Timeline view** - Show project timelines and conflicts
- **Resource allocation** - Show team members assigned to projects
- **Summary generation** - Create roadmap document in thoughts/
- **Trend analysis** - Compare progress month-over-month

Track progress at: https://github.com/ryanisaacg/catalyst/issues

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

- Review roadmap **monthly** or **quarterly**
- Update **target dates** based on actual velocity
- Document **dependencies** explicitly in project descriptions
- Identify **resource constraints** early
- Communicate **delays** proactively to stakeholders
- Use **milestones** to track major deliverables
- Archive **completed projects** to reduce noise
- Link projects to **company OKRs** for alignment

## Related Commands

- `/cycle-plan` - Plan work within cycles for a project
- `/cycle-review` - Review cycle progress
- `/linear` - Manage individual tickets
- `/create-plan` - Create implementation plans for tickets
