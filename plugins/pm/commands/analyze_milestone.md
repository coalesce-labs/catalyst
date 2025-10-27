---
description: Analyze project milestone health with actionable insights, target date assessment, risk analysis, and specific recommendations
category: pm
tools: Task, Read, Write, TodoWrite
model: inherit
version: 1.0.0
---

# Analyze Milestone Command

Generates a comprehensive **health report** for a project milestone.

**Reports Include**:
- 🟢🟡🔴 Health assessment with target date feasibility
- 📊 Progress metrics toward target date
- 🎯 Actionable takeaways (what needs attention NOW)
- ⚠️ Risk identification (behind schedule, blocked, at-risk)
- 💡 Specific recommendations (adjust timeline, reduce scope, etc.)

**Philosophy**: Provide insights and recommendations for milestone planning, not just data dumps.

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

### Step 1: Gather Configuration and Milestone Identifier

**Option A: User provides milestone name**
```bash
MILESTONE_NAME="Q1 Launch"
PROJECT_NAME="Mobile App"
```

**Option B: Interactive prompt**
```
Which milestone would you like to analyze?
- Milestone name: [user input]
- Project name (optional, helps scope lookup): [user input]
```

### Step 2: Spawn Research Agent

Use Task tool with `linear-research` agent:

```
Prompt: "Get milestone '${MILESTONE_NAME}' details for project '${PROJECT_NAME}' with all issues (limit 100)"
Model: haiku (fast data gathering)
```

If milestone not found or ambiguous, report error and ask user to clarify.

### Step 3: Spawn Analysis Agent

Use Task tool with `milestone-analyzer` agent:

**Input**:
- Milestone data JSON from research task
- Current date: $(date +%Y-%m-%d)
- Project configuration (if available)

**Agent returns**:
Structured markdown with:
- Health score and target date feasibility
- Progress tracking (actual vs expected)
- Risk factors (target date, blockers, at-risk)
- Issue distribution
- Specific recommendations

### Step 4: Format Report

Format the analyzer output into final report:

```markdown
# Milestone Health Report: [Milestone Name]

**Project**: [Project Name]
**Target Date**: [YYYY-MM-DD] ([X] days remaining)
**Generated**: [YYYY-MM-DD HH:MM]

---

## 🟢/🟡/🔴 Health Assessment

**Takeaway**: [One-sentence summary with target date assessment]

**Current State**:
- Progress: X% complete (Y/Z issues done)
- Target: [YYYY-MM-DD] ([N] days remaining)
- Projected completion: [YYYY-MM-DD] (based on current velocity)
- Risk level: [On track / Behind by N days / Critical]

---

## 📊 Progress Tracking

[Progress bars, velocity, time remaining]

---

## ⚠️ Risks & Blockers

[Target date risks, blockers, at-risk issues]

---

## 💡 Recommendations

[Priority-ordered actions]

---

**Next Review**: [Suggested date based on target date proximity]
```

### Step 5: Save Report

```bash
REPORT_DIR="thoughts/shared/reports/milestones"
mkdir -p "$REPORT_DIR"

# Sanitize milestone name for filename
MILESTONE_SLUG=$(echo "$MILESTONE_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
REPORT_FILE="$REPORT_DIR/$(date +%Y-%m-%d)-${MILESTONE_SLUG}.md"

# Write formatted report
# ...

echo "✅ Report saved: $REPORT_FILE"

# Update workflow context
if [[ -f "${SCRIPT_DIR}/workflow-context.sh" ]]; then
  "${SCRIPT_DIR}/workflow-context.sh" add reports "$REPORT_FILE" "${TICKET_ID:-null}"
fi
```

### Step 6: Display Summary

```
🎯 Milestone Health: [Milestone Name] - [🟢/🟡/🔴]

Target Date: [YYYY-MM-DD] ([X] days remaining)
Progress: ████████░░ [X]% ([Y]/[Z] issues)
Status: [On track / Behind by N days]

Priority Actions:
  1. [Action 1]
  2. [Action 2]
  3. [Action 3]

Full report: thoughts/shared/reports/milestones/YYYY-MM-DD-milestone.md
```

## Success Criteria

### Automated Verification:
- [ ] Research agent fetches milestone data successfully
- [ ] Analyzer agent produces structured output
- [ ] Report file created in expected location
- [ ] No errors when milestone exists

### Manual Verification:
- [ ] Health score accurately reflects milestone state
- [ ] Target date feasibility is realistic
- [ ] Recommendations are specific and actionable
- [ ] Report guides PM to adjust timeline or scope if needed
- [ ] Works with different projects and milestone names
