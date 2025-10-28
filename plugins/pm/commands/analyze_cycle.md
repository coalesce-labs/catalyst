---
description: Analyze cycle health and generate comprehensive report with actionable insights, risk analysis, capacity assessment, and specific recommendations
category: pm
tools: Task, Read, Write, TodoWrite
model: inherit
version: 1.0.0
---

# Analyze Cycle Command

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

First, verify all required tools and systems:

```bash
# 1. Validate thoughts system (REQUIRED)
if [[ -f "scripts/validate-thoughts-setup.sh" ]]; then
  ./scripts/validate-thoughts-setup.sh || exit 1
else
  # Inline validation if script not found
  if [[ ! -d "thoughts/shared" ]]; then
    echo "❌ ERROR: Thoughts system not configured"
    echo "Run: ./scripts/humanlayer/init-project.sh . {project-name}"
    exit 1
  fi
fi

# 2. Determine script directory with fallback
if [[ -n "${CLAUDE_PLUGIN_ROOT}" ]]; then
  SCRIPT_DIR="${CLAUDE_PLUGIN_ROOT}/scripts"
else
  # Fallback: resolve relative to this command file
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts"
fi

# 3. Check PM plugin prerequisites
if [[ -f "${SCRIPT_DIR}/check-prerequisites.sh" ]]; then
  "${SCRIPT_DIR}/check-prerequisites.sh" || exit 1
else
  echo "⚠️ Prerequisites check skipped (script not found at: ${SCRIPT_DIR})"
fi
```

## Process

### Step 1: Gather Configuration

```bash
# Determine script directory with fallback (if not already set)
if [[ -z "${SCRIPT_DIR}" ]]; then
  if [[ -n "${CLAUDE_PLUGIN_ROOT}" ]]; then
    SCRIPT_DIR="${CLAUDE_PLUGIN_ROOT}/scripts"
  else
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts"
  fi
fi

source "${SCRIPT_DIR}/pm-utils.sh"

TEAM_KEY=$(get_team_key)
CONFIG_FILE=".claude/config.json"
```

### Step 2: Spawn Research Tasks (Parallel)

Spawn multiple research agents in parallel to gather data:

**Task 1 - Get Active Cycle**:

Use Task tool with `catalyst-dev:linear-research` agent:

```
Prompt: "Get the active cycle for team ${TEAM_KEY} with all issues"
Model: haiku (fast data gathering)
```

**Task 2 - Get Team Workload**:

Use Task tool with `catalyst-dev:linear-research` agent:

```
Prompt: "List all in-progress issues for team ${TEAM_KEY}"
Model: haiku (fast data gathering)
```

**Wait for both tasks to complete**

### Step 3: Spawn Analysis Agent

Use Task tool with `cycle-analyzer` agent:

**Input**:
- Cycle data JSON from Task 1
- In-progress issues from Task 2
- Current date: $(date +%Y-%m-%d)

**Agent returns**:
Structured markdown with health assessment, risks, capacity, recommendations

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

# Update workflow context
if [[ -f "${SCRIPT_DIR}/workflow-context.sh" ]]; then
  "${SCRIPT_DIR}/workflow-context.sh" add reports "$REPORT_FILE" "${TICKET_ID:-null}"
fi
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
