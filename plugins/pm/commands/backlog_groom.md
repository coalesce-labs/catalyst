---
description: Analyze Linear backlog to identify orphaned issues, incorrect project assignments, and health issues
category: pm
tools: Bash(linearis *), Bash(jq *), Read, Write, Task
model: inherit
version: 1.0.0
---

# Backlog Grooming Command

Comprehensive backlog health analysis that identifies:
- Issues without projects (orphaned)
- Issues in wrong projects (misclassified)
- Issues without estimates
- Stale issues (no activity >30 days)
- Duplicate issues (similar titles)

## Process

### Step 1: Fetch All Backlog Issues

```bash
source "${CLAUDE_PLUGIN_ROOT}/scripts/pm-utils.sh"

TEAM_KEY=$(get_team_key)

# Get all issues in Backlog status (or no cycle assignment)
backlog_issues=$(linearis issues list \
  --team "$TEAM_KEY" \
  --status "Backlog" \
  --limit 1000 \
  --json)

# Also get issues without cycles
no_cycle_issues=$(linearis issues list \
  --team "$TEAM_KEY" \
  --no-cycle \
  --limit 1000 \
  --json)
```

### Step 2: Spawn Backlog Groomer Agent

Use Task tool with backlog-groomer agent:

**Agent Input**:
- All backlog issues JSON
- Project definitions (if available)
- Team configuration

**Agent Responsibilities**:
1. Categorize issues by theme/project
2. Identify orphaned issues (no project assignment)
3. Detect misplaced issues (wrong project based on content)
4. Flag issues needing estimates
5. Identify stale issues (>30 days no activity)
6. Detect potential duplicates (similar titles/descriptions)

**Agent Output**: Structured recommendations with:
- Issue ID
- Current state (project, status, assignee)
- Recommendation (move to X project, add estimate, close as duplicate)
- Confidence score (high/medium/low)
- Reasoning

### Step 3: Generate Grooming Report

Create markdown report with sections:

**Orphaned Issues** (no project):
```markdown
## 🏷️ Orphaned Issues (No Project Assignment)

### High Priority
- **TEAM-456**: "Add OAuth support"
  - **Suggested Project**: Auth & Security
  - **Reasoning**: Mentions authentication, OAuth, security tokens
  - **Action**: Move to Auth project

[... more issues ...]

### Medium Priority
[... issues ...]
```

**Misplaced Issues** (wrong project):
```markdown
## 🔄 Misplaced Issues (Wrong Project)

- **TEAM-123**: "Fix dashboard bug" (currently in: API)
  - **Should be in**: Frontend
  - **Reasoning**: UI bug, no backend changes mentioned
  - **Action**: Move to Frontend project
```

**Stale Issues** (>30 days inactive):
```markdown
## 🗓️ Stale Issues (No Activity >30 Days)

- **TEAM-789**: "Investigate caching" (last updated: 45 days ago)
  - **Action**: Review and close, or assign to current cycle
```

**Duplicates** (similar titles):
```markdown
## 🔁 Potential Duplicates

- **TEAM-111**: "User authentication bug"
- **TEAM-222**: "Authentication not working"
  - **Similarity**: 85%
  - **Action**: Review and merge
```

**Missing Estimates**:
```markdown
## 📊 Issues Without Estimates

- TEAM-444: "Implement new feature"
- TEAM-555: "Refactor old code"
  - **Action**: Add story point estimates
```

### Step 4: Interactive Review

Present recommendations and ask user:

```
📋 Backlog Grooming Report Generated

Summary:
  🏷️ Orphaned: 12 issues
  🔄 Misplaced: 5 issues
  🗓️ Stale: 8 issues
  🔁 Duplicates: 3 pairs
  📊 No Estimates: 15 issues

Would you like to:
1. Review detailed report (opens in editor)
2. Apply high-confidence recommendations automatically
3. Generate Linear update commands for manual execution
4. Skip (report saved for later)
```

### Step 5: Generate Update Commands

If user chooses option 3, generate batch update script:

```bash
#!/usr/bin/env bash
# Backlog grooming updates - Generated 2025-01-27

# Move TEAM-456 to Auth project
linearis issues update TEAM-456 --project "Auth & Security"

# Move TEAM-123 to Frontend project
linearis issues update TEAM-123 --project "Frontend"

# Close stale issue TEAM-789
linearis issues update TEAM-789 --status "Canceled" \
  --comment "Closing stale issue (>30 days inactive)"

# [... more commands ...]

echo "✅ Backlog grooming updates applied"
```

Save to `thoughts/shared/reports/backlog/YYYY-MM-DD-grooming-updates.sh`

### Step 6: Save Report

Save detailed report to `thoughts/shared/reports/backlog/YYYY-MM-DD-backlog-grooming.md`

## Success Criteria

### Automated Verification:
- [ ] All backlog issues fetched successfully
- [ ] Agent analysis completes without errors
- [ ] Report generated with all sections
- [ ] Update script is valid bash syntax
- [ ] Files saved to correct locations

### Manual Verification:
- [ ] Orphaned issues correctly identified
- [ ] Project recommendations make sense
- [ ] Stale issues are actually inactive
- [ ] Duplicate detection has few false positives
- [ ] Report is actionable and clear
