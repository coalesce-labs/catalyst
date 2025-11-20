---
description: Generate daily context engineering adoption dashboard
category: reporting
tools: Read, Write, Task, TodoWrite, Bash
model: inherit
version: 1.0.0
---

# Generate Context Engineering Daily Dashboard

You are tasked with generating a daily dashboard that tracks context engineering adoption across the team by cross-referencing code repository activity with thoughts repository activity.

## Purpose

This command identifies developers who have code activity but NO thoughts activity (not using context engineering) and provides actionable insights for improving adoption.

## Prerequisites

Before executing, verify required tools are installed:

```bash
if [[ -f "/Users/ryan/.claude/plugins/marketplaces/catalyst/plugins/dev/scripts/check-prerequisites.sh" ]]; then
  "/Users/ryan/.claude/plugins/marketplaces/catalyst/plugins/dev/scripts/check-prerequisites.sh" || exit 1
fi
```

## Configuration

Read project configuration from `.claude/config.json`:

```bash
CONFIG_FILE=".claude/config.json"

# Required configuration
THOUGHTS_REPO=$(jq -r '.thoughts.repo // "~/thoughts"' "$CONFIG_FILE")
PROJECT_KEY=$(jq -r '.projectKey // "unknown"' "$CONFIG_FILE")

# Code repositories to analyze (comma-separated)
CODE_REPOS=$(jq -r '.contextEngineering.codeRepos // [] | join(",")' "$CONFIG_FILE")

# If no code repos configured, try to detect from git remote
if [[ -z "$CODE_REPOS" || "$CODE_REPOS" == "" ]]; then
  REMOTE_URL=$(git config --get remote.origin.url 2>/dev/null || echo "")
  if [[ -n "$REMOTE_URL" ]]; then
    # Extract org/repo from GitHub URL
    CODE_REPOS=$(echo "$REMOTE_URL" | sed -E 's#.*github\.com[:/]([^/]+/[^/]+)(\.git)?#\1#')
    echo "⚠️  No code repos configured in .claude/config.json"
    echo "📍 Auto-detected from git remote: $CODE_REPOS"
  else
    echo "❌ ERROR: No code repos configured and could not detect from git remote"
    echo "Add to .claude/config.json:"
    echo '  "contextEngineering": {'
    echo '    "codeRepos": ["org/repo-1", "org/repo-2"]'
    echo '  }'
    exit 1
  fi
fi
```

## Process Steps

### Step 1: Initialize Task Tracking

```
Use TodoWrite to create task list:
1. Collect code repository metrics (7-day and 28-day windows)
2. Collect thoughts repository metrics (7-day and 28-day windows)
3. Cross-reference and synthesize adoption insights
4. Generate context engineering dashboard
5. Save report to thoughts repository root
```

### Step 2: Spawn Parallel Data Collection Agents

**CRITICAL**: Spawn BOTH agents in the SAME response for maximum efficiency.

**Agent 1: github-metrics** (Haiku model for speed):
```
Task prompt:
Collect GitHub metrics for the following repositories: {CODE_REPOS}

Analysis windows:
- 7-day window (last 7 calendar days)
- 28-day window (last 28 calendar days)

For each developer, collect:
1. Number of PRs created/merged
2. Number of commits authored
3. Last activity date

Use GitHub API or gh CLI:
gh api "/repos/{org}/{repo}/commits?since={7-days-ago}" --jq '.[].author.login' | sort -u

Return data in this format:
```json
{
  "period": "7-day",
  "developers": [
    {
      "name": "Alice",
      "prs": 4,
      "commits": 12,
      "lastActivity": "2025-01-17"
    }
  ]
}
```

IMPORTANT:
- Use Git author metadata ONLY (%an, author.login)
- Filter out "Claude" from all lists
- Error if "Claude" appears in results
```

**Agent 2: thoughts-metrics** (Haiku model for speed):
```
Task prompt:
Collect thoughts repository metrics from: {THOUGHTS_REPO}

Analysis windows:
- Yesterday (last 24 hours)
- 7-day window (last 7 calendar days)
- 28-day window (last 28 calendar days)

For each developer, collect:
1. Number of files created (by type: research, plans, handoffs, prs)
2. Number of commits
3. Last activity date

Use git log in thoughts repository:
cd {THOUGHTS_REPO}
git log --since="7 days ago" --author="Alice" --name-only --diff-filter=A \
  | grep "^shared/" | wc -l

Classify files by directory:
- shared/research/ → Research
- shared/plans/ → Plans
- shared/handoffs/ → Handoffs
- shared/prs/ → PR Descriptions

Return data in this format:
```json
{
  "period": "7-day",
  "developers": [
    {
      "name": "Alice",
      "files": 22,
      "commits": 24,
      "filesByType": {
        "research": 18,
        "plans": 3,
        "handoffs": 1,
        "prs": 0
      },
      "lastActivity": "2025-01-17"
    }
  ]
}
```

IMPORTANT:
- Use Git author metadata ONLY (%an)
- Filter out "Claude" from all lists
- Error if "Claude" appears in results
- Use --diff-filter=A to count only files CREATED (not modified)
```

**Tool use**:
```
Task(subagent_type=catalyst-pm:github-metrics, description="Collect code repo metrics", prompt=[github-metrics prompt], model=haiku)
Task(subagent_type=catalyst-pm:thoughts-metrics, description="Collect thoughts repo metrics", prompt=[thoughts-metrics prompt], model=haiku)
```

### Step 3: Wait for Both Agents to Complete

**CRITICAL**: Do NOT proceed until BOTH agents return their results.

- Mark task 1 as completed when github-metrics returns
- Mark task 2 as completed when thoughts-metrics returns
- Verify both data sets are valid JSON
- Check for errors or warnings from agents

### Step 4: Spawn Context Analyzer Agent

**Agent 3: context-analyzer** (Sonnet model for synthesis):

```
Task prompt:
Analyze context engineering adoption by cross-referencing code and thoughts repository activity.

You will receive two data sets:

**Code Repository Metrics**:
[Paste github-metrics agent output here]

**Thoughts Repository Metrics**:
[Paste thoughts-metrics agent output here]

Generate a comprehensive context engineering dashboard following the template at:
plugins/pm/templates/reports/CONTEXT_ENGINEERING_DAILY.md

CRITICAL REQUIREMENTS:
1. Identify developers with code activity but NO thoughts activity (not using context engineering)
2. Calculate individual adoption scores (Excellent, Good, Growing, Light, Minimal, Not using)
3. Analyze file type breakdown (Research, Plans, Handoffs, PRs)
4. Calculate trends over 28-day period with week-over-week growth
5. Generate prioritized action items (P1: Immediate, P2: Celebrate, P3: Growth)
6. Ensure NO "Claude" attribution anywhere in the report

Return the complete dashboard report in Markdown format.
```

**Tool use**:
```
Task(subagent_type=catalyst-pm:context-analyzer, description="Synthesize adoption dashboard", prompt=[context-analyzer prompt], model=inherit)
```

**Wait for completion** and mark task 3 as completed.

### Step 5: Save Report to Thoughts Repository Root

```bash
# Get thoughts repo path
THOUGHTS_REPO=$(jq -r '.thoughts.repo // "~/thoughts"' .claude/config.json)
THOUGHTS_REPO="${THOUGHTS_REPO/#\~/$HOME}"  # Expand ~ to home directory

# Create report filename with timestamp
TIMESTAMP=$(TZ="America/Chicago" date "+%Y-%m-%d_%H-%M-%S")
REPORT_FILE="${THOUGHTS_REPO}/context-engineering-daily.md"

# Save the report (agent output will be in memory)
# Use Write tool to save to $REPORT_FILE

# Verify file was created
if [[ -f "$REPORT_FILE" ]]; then
  echo "✅ Report saved: $REPORT_FILE"

  # Create symlink to latest report
  ln -sf "context-engineering-daily.md" "${THOUGHTS_REPO}/context-engineering-latest.md"

  # Optional: Commit to thoughts repo if it's a git repo
  cd "$THOUGHTS_REPO"
  if [[ -d .git ]]; then
    git add context-engineering-daily.md context-engineering-latest.md
    git commit -m "docs: update context engineering dashboard - $TIMESTAMP" --no-verify
    echo "📝 Committed to thoughts repository"
  fi
else
  echo "❌ ERROR: Failed to save report to $REPORT_FILE"
  exit 1
fi
```

Mark task 5 as completed.

### Step 6: Present Summary to User

Show the user:

1. **Report location**: Full path to saved report
2. **Key findings**:
   - Number of developers NOT using context engineering
   - Overall adoption rate (X/Y developers active)
   - Top 3 action items from report
3. **Quick stats**: Yesterday, 7-day avg, 28-day avg
4. **Next steps**: How to view full report and suggested actions

## Example Interaction Flow

```
User: /catalyst-pm:context-daily
Assistant: [Runs prerequisites check]

[Creates task list with TodoWrite]

[Spawns github-metrics and thoughts-metrics agents in parallel]

Waiting for both agents to complete...

[Agents return with data]

[Spawns context-analyzer agent with both data sets]

Analyzing context engineering adoption...

[context-analyzer returns dashboard report]

[Saves report to thoughts repo root]

✅ Context Engineering Dashboard generated\!

**Report location**: ~/thoughts/repos/myproject/context-engineering-daily.md

**Key Findings**:
- 🚨 **2/7 developers** NOT using context engineering (Frank, Grace)
- 📊 **71% adoption rate** (5/7 developers active in last 7 days)
- ↑ **+51% growth** month-over-month

**Top 3 Action Items**:
1. **P1: Onboard Frank & Grace** - No thoughts activity despite code commits
2. **P2: Celebrate Alice's consistency** - 22 research docs in 7 days
3. **P3: Support Emily's growth** - Building habit, needs guidance

**Quick Stats**:
- Yesterday: 12 files, 18 commits
- 7-day avg: 8.6 files/day, 15.3 commits/day
- 28-day avg: 6.2 files/day, 12.1 commits/day

**Next Steps**:
- View full report: `cat ~/thoughts/repos/myproject/context-engineering-daily.md`
- Schedule onboarding sessions with Frank and Grace
- Share adoption wins in team meeting
```

## Important Notes

### Configuration Required

The command requires configuration in `.claude/config.json`:

```json
{
  "projectKey": "myproject",
  "thoughts": {
    "repo": "~/thoughts/repos/myproject"
  },
  "contextEngineering": {
    "codeRepos": [
      "org/repo-1",
      "org/repo-2"
    ]
  }
}
```

### Data Collection Windows

- **Yesterday**: Last 24 hours (since yesterday 9 AM CST)
- **7-day**: Last 7 calendar days
- **28-day**: Last 28 calendar days (4 weeks)

### Attribution Rules

**CRITICAL**: All agents must use Git author metadata only:
- **Code repos**: `git log --format=\"%an\"` or `gh api ... author.login`
- **Thoughts repo**: `git log --format=\"%an\"`
- **Filter**: Remove any "Claude" from all author lists
- **Validate**: Error if "Claude" appears in results

### Report Location

**Dashboard saves to ROOT of thoughts repository**:
- Path: `{THOUGHTS_REPO}/context-engineering-daily.md`
- Latest symlink: `{THOUGHTS_REPO}/context-engineering-latest.md`
- Rationale: Report is ABOUT the thoughts repo, not project docs

### Parallel Agent Execution

**CRITICAL**: github-metrics and thoughts-metrics agents MUST be spawned in the SAME response for maximum efficiency. Do NOT spawn them sequentially.

### Error Handling

If agents fail:
1. **github-metrics fails**: Cannot identify "Not Using" developers - abort
2. **thoughts-metrics fails**: Dashboard will be empty - abort
3. **context-analyzer fails**: Check data format, retry once
4. **Save fails**: Check thoughts repo path, permissions

## Success Criteria

✅ Both data collection agents return valid data
✅ Context analyzer identifies developers NOT using context engineering
✅ Report follows CONTEXT_ENGINEERING_DAILY.md template structure
✅ No "Claude" attribution anywhere in report
✅ Report saved to thoughts repo root
✅ User sees actionable summary with top 3 action items

---

*This command is part of the Catalyst PM Plugin for tracking context engineering adoption.*
