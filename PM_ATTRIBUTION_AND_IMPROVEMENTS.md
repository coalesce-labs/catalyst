# PM Reporting: Attribution Fixes & Template Improvements

**Date**: 2025-11-19
**Status**: Implementation Plan

---

## Problem Statement

### 1. Claude Attribution Issue

**Problem**: PRs and commits sometimes get attributed to "Claude" instead of the actual human developer because:
- Some commands/workflows add "Generated with Claude Code" or "Co-Authored-By: Claude" to commits/PRs
- Analysis agents may incorrectly attribute work based on PR descriptions rather than actual Git metadata

**Impact**:
- Skews contributor metrics
- Makes reports inaccurate
- Claude appears as a "team member" in dashboards

### 2. Report Template Improvements Needed

Based on user feedback, reports need:
- **Story points → Issue counts** (not all teams use story points)
- **Date/time stamps** (Central Time) at top of every report
- **Hyperlinks** to all Linear issues and GitHub PRs
- **Project grouping** for deliverables with completion %
- **Cycle goals/narrative** section (from project descriptions)
- **Context Engineering dashboard** (separate daily report)

---

## Solution: Attribution Fixes

### A. Commands That Create PRs/Commits

**Files to update**:
1. `plugins/dev/commands/commit.md` - ✅ Already correct (line 181-185)
2. `plugins/dev/commands/create_pr.md` - ✅ No Claude attribution found
3. `plugins/dev/commands/describe_pr.md` - ✅ No Claude attribution found

**Action**: Add explicit "NO CLAUDE ATTRIBUTION" section to create_pr and describe_pr commands.

### B. Analysis Agents That Read Git Data

**Critical instruction to add**:

```markdown
## Author Attribution Rules (CRITICAL)

When collecting PR and commit data:

1. **ALWAYS use Git commit author** (`%an`) NOT co-author tags
2. **IGNORE any "Co-Authored-By: Claude" lines** in commit messages
3. **IGNORE any "Generated with Claude" text** in PR descriptions
4. **Attribute to the GitHub user** who created the PR, not description text
5. **Claude should NEVER appear** as a contributor in any report
6. **Every PR/commit must be attributed** to a human team member

### Correct Attribution Sources

✅ **Use these**:
- Git commit author: `git log --format='%an'`
- GitHub PR author: `gh pr list --json author -q '.[].author.login'`
- GitHub commit API: `/repos/{org}/{repo}/commits` → `author.login`

❌ **DO NOT use these**:
- PR/commit description text mentioning Claude
- Co-Authored-By trailer lines
- Any attribution in comments or notes
```

**Files to update**:
- `plugins/pm/agents/github-metrics.md` - Strengthen existing section (line 138-149)
- All other agents that analyze GitHub/Git data

### C. Context Engineering Analysis

**Special consideration**: When analyzing thoughts repo activity:
- Look for Git authors in thoughts repo
- Cross-reference with code repo activity
- Identify devs with code commits but NO thoughts commits (not using context engineering)

---

## Solution: Report Template Improvements

### 1. Use Issue Counts (Not Story Points)

**Change**:
```markdown
<!-- BEFORE -->
Progress: 87/150 story points (58%)

<!-- AFTER -->
Progress: 33/57 issues (58%)
Optional: 87/150 story points (58%) if team uses points
```

**Files to update**:
- `plugins/pm/templates/reports/CYCLE_EXAMPLE.md`
- `plugins/pm/templates/reports/MONTHLY_EXAMPLE.md`
- `plugins/pm/templates/reports/DASHBOARD_EXAMPLE.md`

### 2. Add Date/Time Stamps (Central Time)

**Add to every report**:
```markdown
# [Report Title]

**Generated**: January 17, 2025 at 9:15 AM CST
**Team**: Platform Team (7 developers)
**Cycle/Period**: [...]
```

**Files to update**: ALL report examples

### 3. Hyperlink All Issues & PRs

**Change**:
```markdown
<!-- BEFORE -->
- TEAM-461 OAuth provider support (Alice)

<!-- AFTER -->
- **[TEAM-461](https://linear.app/team/issue/TEAM-461)** OAuth provider support (Alice)
```

**Implementation**: All examples + agent instructions

### 4. Group Deliverables by Project

**Change**:
```markdown
<!-- BEFORE -->
### ✅ Shipped (5 issues)
- TEAM-461 OAuth provider support
- TEAM-462 Auth race condition fix
- TEAM-470 Button component refactor

<!-- AFTER -->
### ✅ Shipped (5 issues)

#### **API Platform v2** (3 issues, 72% complete, 8 remaining)
- **[TEAM-461](...)** OAuth provider support (Alice)
- **[TEAM-462](...)** Auth race condition fix (Bob)
- **[TEAM-463](...)** API documentation (Carol)

#### **Component Library** (2 issues, 80% complete, 2 remaining)
- **[TEAM-470](...)** Button component refactor (Dave)
- **[TEAM-471](...)** Form validation (Emily)
```

**Files to update**:
- `plugins/pm/templates/reports/DAILY_EXAMPLE.md`
- `plugins/pm/templates/reports/WEEKLY_EXAMPLE.md`

### 5. Add Cycle Goals Section

**New section** (after cycle metadata):
```markdown
## 🎯 Cycle Goals & Narrative

**Primary Objective**: Launch API Platform v2 with OAuth support

**Key Results**:
1. Complete OAuth integration (all 4 providers)
2. Achieve 80% test coverage on new endpoints
3. Ship developer documentation

**Project Context**:
- **API Platform v2**: Enterprise-ready authentication (72% complete, 8 issues remaining)
- **Component Library**: Foundation for Dashboard v3 (80% complete, 2 issues remaining)

*Goals derived from Linear project descriptions and milestone objectives*
```

**Source data**:
- Linear projects: `linearis projects list` → read `description` field
- Linear milestones: Read milestone objectives
- Manual input at report generation time (prompt user)

**Files to update**:
- `plugins/pm/templates/reports/CYCLE_EXAMPLE.md`
- `plugins/pm/templates/reports/MONTHLY_EXAMPLE.md`

---

## Solution: Context Engineering Dashboard

### New Report: `CONTEXT_ENGINEERING_DAILY.md`

**Location**: Root of thoughts repository (not in subdirectories)

**Purpose**: Track context engineering adoption across team

**Structure**:

```markdown
# Context Engineering Adoption - Daily Dashboard

**Generated**: January 17, 2025 at 9:15 AM CST
**Team**: Platform Team (7 developers)
**Thoughts Repo**: ~/thoughts/repos/myproject
**Code Repos**: org/repo-1, org/repo-2

---

## 📊 Quick Stats

| Metric | Yesterday | 7-Day Avg | 28-Day Avg | Trend |
|--------|-----------|-----------|------------|-------|
| **Active Contributors** | 5/7 devs | 4.2/7 devs | 3.8/7 devs | ↑ +10% |
| **Files Created** | 12 files | 8.6/day | 6.2/day | ↑ +39% |
| **Commits w/ Context** | 18 commits | 15.3/day | 12.1/day | ↑ +26% |
| **Avg Files/Commit** | 1.5 files | 1.8 files | 1.6 files | ↔ Stable |

---

## 👥 Individual Adoption

| Developer | Yesterday | 7-Day | 28-Day | Status |
|-----------|-----------|-------|--------|--------|
| Alice | 4 files, 6 commits | 3.2/day | 2.8/day | 🟢 Excellent |
| Bob | 3 files, 4 commits | 2.1/day | 1.9/day | 🟢 Good |
| Carol | 2 files, 3 commits | 1.4/day | 1.2/day | 🟢 Good |
| Dave | 2 files, 3 commits | 0.9/day | 0.7/day | 🟡 Growing |
| Emily | 1 file, 2 commits | 0.6/day | 0.4/day | 🟡 Light |
| Frank | 0 files, 0 commits | 0.2/day | 0.1/day | 🔴 Minimal |
| Grace | 0 files, 0 commits | 0.0/day | 0.0/day | 🔴 Not using |

---

## 🚨 Not Using Context Engineering

**Developers with code activity but NO thoughts activity**:

| Developer | Code Repo Activity (7-day) | Thoughts Activity (7-day) | Status |
|-----------|----------------------------|---------------------------|--------|
| **Frank** | 3 PRs, 8 commits | 0 files | 🔴 Not using |
| **Grace** | 2 PRs, 5 commits | 0 files | 🔴 Not using |

**Action**: Onboard Frank and Grace to context engineering workflow

---

## 👥 Full List - Thoughts Contributors (7-Day)

All developers who committed to thoughts repo in last 7 days:

| Developer | Files | Commits | Most Active Type | Last Activity |
|-----------|-------|---------|------------------|---------------|
| Alice | 18 files | 24 commits | Research (12) | Today |
| Bob | 12 files | 16 commits | Plans (8) | Today |
| Carol | 8 files | 11 commits | Research (5) | Yesterday |
| Dave | 6 files | 8 commits | Plans (4) | Yesterday |
| Emily | 3 files | 4 commits | Handoffs (2) | 2 days ago |

---

## 📁 File Type Breakdown (7-Day)

| Type | Count | % of Total | Top Contributors |
|------|-------|------------|------------------|
| **Research** | 42 files | 45% | Alice (18), Bob (12), Carol (8) |
| **Plans** | 28 files | 30% | Alice (12), Bob (8), Dave (6) |
| **Handoffs** | 15 files | 16% | Alice (6), Carol (5), Emily (3) |
| **PRs** | 8 files | 9% | Bob (4), Alice (2), Carol (2) |

---

## 🎯 Top Actions

1. **Onboard Frank & Grace** - No thoughts activity despite code commits (Priority: P1)
2. **Celebrate Alice's consistency** - 18 research docs in 7 days
3. **Dave's momentum** - 3x usage vs 28-day avg (growing!)

---

## 📈 Trends (28-Day)

```
Daily Files Created:
Week 1: ████████░░░░░░░░░░░░ 4.2/day
Week 2: ██████████░░░░░░░░░░ 5.8/day
Week 3: ████████████░░░░░░░░ 6.9/day
Week 4: ██████████████░░░░░░ 8.6/day ← Current

Adoption Rate: ↑ +51% month-over-month
```

---

*Auto-generated by Catalyst PM Plugin • [View Daily Reports](./context-engineering/daily/)*
```

### Data Collection Logic

**Cross-repo analysis**:

1. **Get code repo contributors** (7-day window):
```bash
gh api "/repos/{org}/{repo}/commits?since={7-days-ago}" \
  --jq '.[].author.login' | sort -u
```

2. **Get thoughts repo contributors** (same window):
```bash
cd ~/thoughts/repos/myproject
git log --since="7 days ago" --format='%an' | sort -u
```

3. **Find missing** (code activity but NO thoughts activity):
```bash
comm -23 <(code_contributors) <(thoughts_contributors)
```

4. **Count thoughts activity**:
```bash
# Files created per person
git log --since="7 days ago" --author="Alice" --name-only --diff-filter=A \
  | grep "^shared/" | wc -l

# Classify by type
grep "shared/research/" → research
grep "shared/plans/" → plans
grep "shared/handoffs/" → handoffs
grep "shared/prs/" → pr descriptions
```

### New Command: `/pm:context-daily`

**File**: `plugins/pm/commands/context_daily.md`

**Architecture**:
```
User: /pm:context-daily

Step 1: Spawn 2 parallel agents (Haiku)
  ├─ github-metrics (code repo activity, last 7/28 days)
  └─ thoughts-metrics (thoughts repo activity, last 7/28 days)

Step 2: Wait for both to complete

Step 3: Spawn context-analyzer (Sonnet) → Cross-reference & synthesize

Step 4: Generate report from CONTEXT_ENGINEERING_DAILY.md template

Step 5: Save to ROOT of thoughts repo (not in subdirectories)
   → ~/thoughts/repos/myproject/context-engineering-daily.md
```

---

## Implementation Order

### Phase 1: Attribution Fixes (1 hour)
1. Update `github-metrics.md` agent - strengthen attribution rules
2. Add "NO CLAUDE ATTRIBUTION" section to `create_pr.md`
3. Add "NO CLAUDE ATTRIBUTION" section to `describe_pr.md`
4. Create `thoughts-metrics.md` agent (similar to github-metrics)

### Phase 2: Report Template Updates (2-3 hours)
1. Update all 5 example reports with:
   - Date/time stamps (Central Time)
   - Hyperlinks to issues/PRs
   - Project grouping in daily/weekly
   - Issue counts (not story points)
   - Cycle goals section in cycle/monthly
2. Update `README.md` in templates/ to reflect changes

### Phase 3: Context Engineering Dashboard (3-4 hours)
1. Create `CONTEXT_ENGINEERING_DAILY.md` template
2. Create `thoughts-metrics.md` agent (collect thoughts repo data)
3. Create `context-analyzer.md` agent (cross-repo synthesis)
4. Create `/pm:context-daily` command (orchestration)
5. Test cross-repo analysis logic

### Phase 4: GitHub Actions Integration (2-3 hours)
1. Create `context-daily.yml.template` workflow
2. Update `setup.sh` to generate context engineering workflow
3. Add to `config.yml.example` (schedules, repos)
4. Document setup process

---

## Testing Plan

### Attribution Testing
1. Create test PR with "Generated with Claude" in description
2. Run `github-metrics` agent
3. Verify author is GitHub user, not "Claude"
4. Check that Claude doesn't appear in contributor lists

### Context Engineering Testing
1. Create commits in both code repo and thoughts repo
2. Create commits in code repo only (no thoughts)
3. Run `/pm:context-daily` command
4. Verify "Not Using" section correctly identifies devs with code-only activity
5. Verify file type classification (research/plans/handoffs/prs)
6. Verify report saves to root of thoughts repo

### Template Testing
1. Generate all 5 reports with real data
2. Verify hyperlinks work (Linear issues, GitHub PRs)
3. Verify project grouping shows completion %
4. Verify timestamps are in Central Time
5. Verify issue counts (not story points) are primary metric

---

## Documentation Updates Needed

1. **Plugin README** - Add Context Engineering dashboard section
2. **Templates README** - Document new template structure
3. **Setup Guide** - Add context-daily workflow setup steps
4. **Config Example** - Add context engineering schedule options

---

## Success Criteria

✅ Claude NEVER appears as a contributor in any report
✅ All PRs/commits attributed to actual human developers
✅ All report templates updated with improvements
✅ Context Engineering dashboard working end-to-end
✅ GitHub Actions workflow template created
✅ Setup instructions documented
✅ All tests passing

---

*Next step: Begin Phase 1 implementation*
