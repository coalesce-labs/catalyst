---
description: Quick daily status check showing yesterday's deliveries, current work, and team members needing assignments
category: pm
tools: Bash(linearis *), Bash(gh *), Bash(jq *), Read, Task
model: inherit
version: 1.0.0
---

# Team Daily Command

Lightweight daily standup report for quick team status checks.

**Focus Areas**:
- ✅ What was delivered yesterday (completed issues/PRs)
- 🔄 What is the team working on RIGHT NOW (active issues)
- 👥 Who needs work assigned (no open PRs or active issues)
- ⚠️ Quick blockers/risks (issues blocked or stalled)

**Philosophy**: Fast, focused report for daily standups. Takes <30 seconds to read. No deep analysis - save that for weekly reports.

## Process

### Step 1: Gather Configuration

```bash
source "${CLAUDE_PLUGIN_ROOT}/scripts/pm-utils.sh"

TEAM_KEY=$(get_team_key)
TODAY=$(date +%Y-%m-%d)
YESTERDAY=$(date -v-1d +%Y-%m-%d)
```

### Step 2: Fetch Yesterday's Completions

```bash
# Get issues completed yesterday
completed_yesterday=$(linearis issues list \
  --team "$TEAM_KEY" \
  --status "Done" \
  --completed-since "$YESTERDAY" \
  --completed-before "$TODAY" \
  --json)

# Get PRs merged yesterday
merged_yesterday=$(gh pr list \
  --state merged \
  --search "merged:$YESTERDAY" \
  --json number,title,author,mergedAt \
  --limit 50)
```

### Step 3: Fetch Current Work in Progress

```bash
# Get all issues currently in progress
in_progress=$(linearis issues list \
  --team "$TEAM_KEY" \
  --status "In Progress" \
  --json)

# Get open PRs
open_prs=$(gh pr list \
  --state open \
  --json number,title,author,headRefName,createdAt \
  --limit 50)
```

### Step 4: Identify Team Members Needing Work

```bash
# Get all team members with their current workload
# Parse in_progress and open_prs to find who has 0 active items
```

### Step 5: Check for Blockers

```bash
# Get blocked issues
blocked=$(linearis issues list \
  --team "$TEAM_KEY" \
  --label "blocked" \
  --status "In Progress" \
  --json)
```

### Step 6: Generate Daily Report

```markdown
# Team Daily - [Date]

## ✅ Delivered Yesterday (${YESTERDAY})

**Issues Completed** (N):
- TEAM-456: OAuth integration (Alice)
- TEAM-457: Bug fix for login (Bob)
- TEAM-458: Update docs (Charlie)

**PRs Merged** (N):
- #123: OAuth integration → prod (Alice)
- #124: Login bug fix → prod (Bob)

---

## 🔄 Currently Working On

**Alice**:
- TEAM-461: Payment processing (in progress 3 days)
- PR #130: API refactor (in review)

**Bob**:
- TEAM-462: Database migration (in progress 1 day)
- TEAM-463: Performance optimization (in progress 2 days)

**Charlie**:
- TEAM-465: UI redesign (in progress 4 days)

---

## 👥 Available for Work

**Dave**: No active issues or PRs
**Emily**: No active issues or PRs

**Recommendation**: Assign 1-2 backlog issues to Dave and Emily

---

## ⚠️ Blockers & Quick Risks

**Blocked** (1):
- TEAM-461: Waiting on external API approval (Alice, 3 days)

**Stalled** (1):
- TEAM-465: No commits in 2 days (Charlie)

---

**Next Actions**:
1. Check in with Alice on TEAM-461 blocker status
2. Sync with Charlie on TEAM-465 progress
3. Assign work to Dave and Emily from backlog
```

### Step 7: Display Summary

```
📅 Team Daily - 2025-01-27

✅ Delivered yesterday: 3 issues, 2 PRs merged
🔄 In progress: 5 issues, 3 PRs open
👥 Need work: Dave, Emily (2 team members)
⚠️  Blockers: 1 issue (TEAM-461)

Quick Actions:
  • Follow up on TEAM-461 blocker (Alice)
  • Assign backlog work to Dave and Emily
  • Check TEAM-465 status with Charlie

Full report: thoughts/shared/reports/daily/2025-01-27-team-daily.md
```

## Success Criteria

### Automated Verification:
- [ ] Data fetched from Linear and GitHub successfully
- [ ] Team member workload calculated correctly
- [ ] Report generated in under 10 seconds
- [ ] File saved to expected location

### Manual Verification:
- [ ] Yesterday's completions are accurate
- [ ] Current work assignments match reality
- [ ] Team members needing work are correctly identified
- [ ] Report is scannable in <30 seconds
- [ ] Actionable next steps are clear
