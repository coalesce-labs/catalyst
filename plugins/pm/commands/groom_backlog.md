---
description: Groom Linear backlog to identify orphaned issues, incorrect project assignments, and health issues
category: pm
tools: Task, Read, Write
model: inherit
version: 1.0.0
---

# Groom Backlog Command

Comprehensive backlog health analysis that identifies:
- Issues without projects (orphaned)
- Issues in wrong projects (misclassified)
- Issues without estimates
- Stale issues (no activity >30 days)
- Duplicate issues (similar titles)

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

### Step 1: Spawn Research Agent

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
```

Use Task tool with `linear-research` agent:

```
Prompt: "Get all backlog issues for team ${TEAM_KEY} including issues with no cycle assignment"
Model: haiku
```

### Step 2: Spawn Analysis Agent

Use Task tool with `backlog-analyzer` agent:

**Input**: Backlog issues JSON from research

**Output**: Structured recommendations with:
- Orphaned issues (no project)
- Misplaced issues (wrong project)
- Stale issues (>30 days)
- Potential duplicates
- Missing estimates

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

```bash
# Save update script
UPDATE_SCRIPT="thoughts/shared/reports/backlog/$(date +%Y-%m-%d)-grooming-updates.sh"
mkdir -p "$(dirname "$UPDATE_SCRIPT")"
# [script contents saved here]
chmod +x "$UPDATE_SCRIPT"
```

### Step 6: Save Report

```bash
REPORT_DIR="thoughts/shared/reports/backlog"
mkdir -p "$REPORT_DIR"

REPORT_FILE="$REPORT_DIR/$(date +%Y-%m-%d)-backlog-grooming.md"

# Write formatted report to file
cat > "$REPORT_FILE" << EOF
# Backlog Grooming Report - $(date +%Y-%m-%d)

[... formatted report content ...]
EOF

echo "✅ Report saved: $REPORT_FILE"

# Update workflow context
if [[ -f "${SCRIPT_DIR}/workflow-context.sh" ]]; then
  "${SCRIPT_DIR}/workflow-context.sh" add reports "$REPORT_FILE" null
fi
```

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
