---
description: Generate cycle health report with actionable insights, risk analysis, capacity assessment, and specific recommendations
category: pm
tools: Bash(linearis *), Bash(jq *), Read, Write, TodoWrite, Task
model: inherit
version: 1.0.0
---

# Cycle Status Command

Generates a comprehensive **health report** (not just data) for the current Linear cycle.

**Reports Include**:
- 🟢🟡🔴 Health assessment with overall status
- 📊 Progress metrics with data backing
- 🎯 Actionable takeaways (what needs attention NOW)
- 👥 Team capacity analysis (who can work on what)
- ⚠️ Risk identification (overweight, blocked, at-risk issues)
- 💡 Specific recommendations (what to do about it)

**Philosophy**: Provide insights and recommendations, not just data dumps. PMs should know exactly what action to take after reading the report.

## Prerequisites Check

First, verify all required tools:

```bash
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh" || exit 1
fi
```

## Process

### Step 1: Gather Configuration

```bash
source "${CLAUDE_PLUGIN_ROOT}/scripts/pm-utils.sh"

TEAM_KEY=$(get_team_key)
CONFIG_FILE=".claude/config.json"
```

### Step 2: Fetch Active Cycle Data

Use linearis CLI to get the current active cycle:

```bash
# Get active cycle with issues
cycle_data=$(linearis cycles read --active --team "$TEAM_KEY" --with-issues)

# Parse cycle metadata
cycle_name=$(echo "$cycle_data" | jq -r '.name')
cycle_number=$(echo "$cycle_data" | jq -r '.number')
cycle_starts=$(echo "$cycle_data" | jq -r '.startsAt')
cycle_ends=$(echo "$cycle_data" | jq -r '.endsAt')
cycle_progress=$(echo "$cycle_data" | jq -r '.progress')
is_active=$(echo "$cycle_data" | jq -r '.isActive')

# Get issues array
issues=$(echo "$cycle_data" | jq -c '.issues[]')
```

### Step 3: Spawn Cycle Analysis Agent

Use the cycle-analyzer agent for health analysis and recommendations:

```bash
# Save raw data for agent analysis
echo "$cycle_data" > /tmp/cycle-data.json
```

Use Task tool with `cycle-analyzer` agent:

**Agent receives**:
- Cycle data JSON (metadata + full issues array)
- Current date for time calculations
- Team configuration

**Agent analyzes and returns**:
1. **Health Score** (🟢 On Track / 🟡 At Risk / 🔴 Critical)
   - Based on: progress vs time remaining, blocker count, at-risk issues
2. **Risk Factors**
   - Blocked issues with reasons
   - At-risk issues (>5 days in progress with no activity)
   - Scope creep indicators
3. **Capacity Analysis**
   - Who is over/under capacity
   - Who is available for new work
   - Load distribution recommendations
4. **Specific Recommendations**
   - Actionable next steps (escalate X, assign Y to Z, review W)
   - Priority-ordered by impact

**Agent output format**: Structured markdown with clear sections that the command can format

### Step 4: Generate Health Report

Format the agent's analysis into a user-facing health report:

**Report Structure**:

```markdown
# Cycle Health Report: [Cycle Name]

## 🟢/🟡/🔴 Health Assessment

**Takeaway**: [One-sentence summary of cycle health and key concern]

**Current State**: [Concise statement with specific numbers]
- Progress: X% complete (Y/Z issues done)
- Time: N days remaining of M total
- Projected completion: X% (based on current velocity)
- Risk level: [Explanation]

---

## 📊 Progress Data

**Cycle**: Sprint 2025-W04 (Jan 20-26)
**Progress**: ████████░░ 45% (18/40 issues)

| Status | Count | Percentage |
|--------|-------|------------|
| ✅ Done | 18 | 45% |
| 🔄 In Progress | 12 | 30% |
| 📋 Todo | 10 | 25% |

**By Assignee**:
- Alice: 15 issues (8 done, 5 in progress, 2 todo)
- Bob: 12 issues (6 done, 4 in progress, 2 todo)
- Charlie: 8 issues (4 done, 2 in progress, 2 todo)
- Unassigned: 5 issues

---

## 👥 Team Capacity Analysis

**Available for Work**:
- Bob: 2 active issues, can take 1-2 more
- Charlie: 2 active issues, can take 1 more

**At Capacity**:
- Alice: 5 active issues (near max capacity)

**Needs Attention**:
- Dave: No active issues (assign work)

---

## ⚠️ Risks & Blockers

**🚨 Blockers** (2 issues):
- TEAM-461: External API approval (blocked 6 days)
  - Owner: Alice
  - Blocker: Waiting on partner team response
- TEAM-462: Dependency conflict (blocked 4 days)
  - Owner: Bob
  - Blocker: Upstream library bug

**⚠️ At Risk** (3 issues, >5 days in progress):
- TEAM-463: Complex refactor (7 days, Alice)
  - Risk: No commits in 3 days
- TEAM-464: Database migration (6 days, Bob)
  - Risk: Scope increased mid-work
- TEAM-465: API redesign (5 days, Charlie)
  - Risk: Waiting on code review

---

## 💡 Recommendations

**Priority Actions** (do these today):
1. **Escalate TEAM-461** - Partner team blocking for 6 days, needs PM intervention
2. **Pair Bob with senior dev** on TEAM-462 - Dependency issue may need architectural change
3. **Check in with Alice** on TEAM-463 - 3 days no activity, may need help

**Capacity Optimization**:
1. **Assign 2 issues to Dave** from backlog (currently no active work)
2. **Assign 1 issue to Bob** once TEAM-462 unblocked (has capacity)

**Review Needed**:
1. **TEAM-464**: Scope changed mid-cycle, consider moving to next cycle
2. **TEAM-465**: Waiting on review for 2 days, expedite review process

---

## 📈 Velocity Projection

**Current Velocity**: 2.25 issues/day (18 done in 8 days)
**Remaining Work**: 22 issues
**Days Left**: 3

**Projection**: At current pace, will complete ~7 more issues = 63% total completion

**To Hit 80%**: Need to complete 14 more issues in 3 days (4.7/day) - requires addressing blockers immediately
```

### Step 5: Save Report

Write report to `thoughts/shared/reports/cycles/YYYY-MM-DD-cycle-N-status.md`

```bash
REPORT_DIR="thoughts/shared/reports/cycles"
mkdir -p "$REPORT_DIR"

REPORT_FILE="$REPORT_DIR/$(date +%Y-%m-%d)-cycle-${cycle_number}-status.md"

# Write formatted report to file
cat > "$REPORT_FILE" << EOF
# Cycle Status Report - ${cycle_name}

**Generated**: $(date +"%Y-%m-%d %H:%M")
**Cycle**: ${cycle_number} (${cycle_starts} → ${cycle_ends})

[... formatted report content ...]
EOF

echo "✅ Report saved: $REPORT_FILE"
```

### Step 6: Display Summary

Present concise summary to user with health assessment:

```
🟡 Cycle Health: Sprint 2025-W04 - At Risk

Takeaway: Cycle is 45% complete with 3 days remaining. We're tracking
slightly behind (projected 63% completion). Main risks: 2 blocked issues
and Dave has no assigned work.

Progress: ████████░░ 45% (18/40 issues)
Days Remaining: 3 of 10

Priority Actions:
  1. Escalate TEAM-461 blocker (external dependency, 6 days)
  2. Pair Bob with senior dev on TEAM-462 (dependency conflict)
  3. Assign 2 backlog issues to Dave (no active work)

Status:
  ✅ Done: 18  |  🔄 In Progress: 12  |  📋 Todo: 10
  🚨 Blocked: 2  |  ⚠️  At Risk: 3 (>5 days)

Full health report: thoughts/shared/reports/cycles/2025-01-27-cycle-4-health.md
```

## Success Criteria

### Automated Verification:
- [ ] Prerequisites script passes: `./scripts/check-prerequisites.sh`
- [ ] Command executes without errors
- [ ] Report file created in expected location
- [ ] JSON parsing succeeds for all linearis output
- [ ] TodoWrite tracking works correctly
- [ ] Health assessment is data-backed

### Manual Verification:
- [ ] Health score accurately reflects cycle state
- [ ] Takeaway is clear and actionable
- [ ] Capacity analysis identifies available team members
- [ ] Recommendations are specific and prioritized
- [ ] Risk identification is meaningful
- [ ] Report guides PM to take specific action
