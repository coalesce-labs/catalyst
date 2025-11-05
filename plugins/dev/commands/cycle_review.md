---
description: Review cycle progress and identify blockers using Linearis and GitHub
category: project-task-management
tools: Bash(linearis *), Bash(gh *), Read, Write, TodoWrite
model: inherit
version: 1.0.0
status: placeholder
---

# Cycle Review

**Status**: Placeholder for v1.0 - Full implementation coming in future release

## Planned Functionality

This command will help you review cycle progress by:

1. Fetching active cycle details
2. Calculating completion percentage by status
3. Identifying blocked tickets
4. Generating velocity metrics
5. Creating cycle summary report

## Current Workaround

Use Linearis CLI directly:

```bash
# Get active cycle with tickets
linearis cycles read "Sprint 2025-10" --team TEAM

# List tickets by status (use cycles read to get all issues, then filter)
linearis cycles read "Sprint 2025-10" --team TEAM | \
  jq '.issues[] | select(.state.name == "In Progress")'
linearis cycles read "Sprint 2025-10" --team TEAM | \
  jq '.issues[] | select(.state.name == "Done")'

# Calculate completion manually (count tickets)
```

### Example Workflow

```bash
# 1. Get active cycle info
CYCLE=$(linearis cycles list --team ENG --active | jq -r '.[0].name')
echo "Active cycle: $CYCLE"

# 2. Get all tickets in cycle
linearis issues list --team ENG | \
  jq --arg cycle "$CYCLE" '.[] | select(.cycle.name == $cycle)'

# 3. Count by status (use cycles read to get issues)
CYCLE_DATA=$(linearis cycles read "$CYCLE" --team ENG)

echo "Backlog:"
echo "$CYCLE_DATA" | jq '[.issues[] | select(.state.name == "Backlog")] | length'

echo "In Progress:"
echo "$CYCLE_DATA" | jq '[.issues[] | select(.state.name == "In Progress")] | length'

echo "Done:"
echo "$CYCLE_DATA" | jq '[.issues[] | select(.state.name == "Done")] | length'

# 4. Calculate completion percentage
# total_tickets = backlog + in_progress + done
# completion = (done / total_tickets) * 100

# 5. Find blocked tickets (use cycles read)
linearis cycles read "$CYCLE" --team ENG | \
  jq '.issues[] | select(.state.name == "Blocked") | {id, title, blockedReason}'

# 6. Review PRs merged during cycle
# Get cycle start date (example: 2 weeks ago)
CYCLE_START=$(date -v-14d +%Y-%m-%d)

# List all PRs merged during cycle
gh pr list --state merged --search "merged:>=$CYCLE_START" \
  --json number,title,author,mergedAt --jq \
  '.[] | "\(.mergedAt | split("T")[0]) - \(.author.login): \(.title)"'

# 7. Identify active contributors
gh pr list --state merged --search "merged:>=$CYCLE_START" \
  --json author --jq '[.[].author.login] | group_by(.) | map({author: .[0], count: length}) | sort_by(-.count)'

# 8. Check open PRs (work in progress)
gh pr list --state open --json number,title,author,createdAt,isDraft | \
  jq '.[] | {author: .author.login, title, days_open: ((now - (.createdAt | fromdateiso8601)) / 86400 | floor), draft: .isDraft}'

# 9. Find work without Linear tickets
# Compare PR titles with Linear ticket IDs (TEAM-XXX pattern)
gh pr list --state merged --search "merged:>=$CYCLE_START" \
  --json number,title --jq '.[] | select(.title | test("TEAM-[0-9]+") | not) | {number, title}'
```

## Future Implementation

When fully implemented, this command will:

- **Automated metrics** - Calculate completion, velocity, cycle time
- **Status breakdown** - Show tickets grouped by status with percentages
- **Blocker identification** - Highlight blocked tickets with reasons
- **Trend analysis** - Compare to previous cycles
- **Risk assessment** - Identify at-risk tickets (large, old, no progress)
- **PR-based activity tracking** - Analyze GitHub PR data to:
  - Identify who completed what work during the cycle
  - Find work done without Linear tickets (untracked work)
  - Calculate actual velocity based on merged PRs
  - Show contributor activity breakdown
  - Flag stale PRs that need attention
- **Work reconciliation** - Match PRs to Linear tickets, flag mismatches
- **Team contribution report** - Show per-person breakdown of PRs and tickets
- **Summary generation** - Create review document in thoughts/
- **Burndown visualization** - Show progress over time (text-based chart)

Track progress at: https://github.com/coalesce-labs/catalyst/issues

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

- Review **mid-cycle** to course-correct
- Review **end-of-cycle** for retrospectives
- Track **blockers daily** - don't wait for review
- Compare velocity across cycles for **capacity planning**
- Document **lessons learned** for process improvement
- Celebrate **wins** - acknowledge team progress
- **Use PR data to understand actual work**:
  - Merged PRs show completed work (even if not in Linear)
  - Open PRs show current work in progress
  - PR activity reveals team contribution patterns
  - Missing ticket references indicate process gaps
- **Reconcile Linear and GitHub regularly** to ensure all work is tracked
