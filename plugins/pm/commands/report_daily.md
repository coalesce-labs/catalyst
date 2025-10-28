---
description: Generate daily status report showing yesterday's deliveries, current work, and team members needing assignments
category: pm
tools: Task, Read, Write
model: inherit
version: 1.0.0
---

# Report Daily Command

Lightweight daily standup report for quick team status checks.

**Focus Areas**:
- ✅ What was delivered yesterday (completed issues/PRs)
- 🔄 What is the team working on RIGHT NOW (active issues)
- 👥 Who needs work assigned (no open PRs or active issues)
- ⚠️ Quick blockers/risks (issues blocked or stalled)

**Philosophy**: Fast, focused report for daily standups. Takes <30 seconds to read. No deep analysis - save that for weekly reports.

## Prerequisites Check

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
# Determine script directory with fallback
if [[ -n "${CLAUDE_PLUGIN_ROOT}" ]]; then
  SCRIPT_DIR="${CLAUDE_PLUGIN_ROOT}/scripts"
else
  # Fallback: resolve relative to this command file
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts"
fi

source "${SCRIPT_DIR}/pm-utils.sh"

TEAM_KEY=$(get_team_key)
TODAY=$(date +%Y-%m-%d)
YESTERDAY=$(date -v-1d +%Y-%m-%d)
```

### Step 2: Spawn Research Tasks (Parallel)

Spawn 4 research agents in parallel:

**Task 1 - Yesterday's Completions**:
```
Use Task tool with catalyst-dev:linear-research agent:
Prompt: "Get issues completed yesterday for team ${TEAM_KEY} (completed after ${YESTERDAY} and before ${TODAY})"
Model: haiku
```

**Task 2 - Current In Progress**:
```
Use Task tool with catalyst-dev:linear-research agent:
Prompt: "List all in-progress issues for team ${TEAM_KEY}"
Model: haiku
```

**Task 3 - Blocked Issues**:
```
Use Task tool with catalyst-dev:linear-research agent:
Prompt: "Get all blocked issues for team ${TEAM_KEY}"
Model: haiku
```

**Task 4 - Team Members**:
```
Use Task tool with catalyst-dev:linear-research agent:
Prompt: "List all issues by assignee for team ${TEAM_KEY}"
Model: haiku
```

**Wait for all 4 research tasks to complete**

### Step 3: Analyze Results

Combine research results to identify:
- Team members with no active work
- Stalled issues (in progress >5 days, no recent updates)
- Blocker count and duration

### Step 4: Format Daily Report

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

### Step 5: Save Report

```bash
REPORT_DIR="thoughts/shared/reports/daily"
mkdir -p "$REPORT_DIR"

REPORT_FILE="$REPORT_DIR/$(date +%Y-%m-%d)-team-daily.md"

# Write formatted report to file
cat > "$REPORT_FILE" << EOF
# Team Daily - $(date +%Y-%m-%d)

[... formatted report content ...]
EOF

echo "✅ Report saved: $REPORT_FILE"

# Update workflow context
if [[ -f "${SCRIPT_DIR}/workflow-context.sh" ]]; then
  "${SCRIPT_DIR}/workflow-context.sh" add reports "$REPORT_FILE" null
fi
```

### Step 6: Display Summary

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
