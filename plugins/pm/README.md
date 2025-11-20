# Catalyst PM Plugin

Linear-focused project management plugin with cycle management, backlog grooming, GitHub-Linear correlation, and team analytics.

## Overview

The Catalyst PM plugin provides AI-powered project management workflows that integrate Linear issue tracking with GitHub pull requests. It focuses on actionable insights rather than raw data dumps.

**Philosophy**: Every report includes specific recommendations, not just metrics. PMs should know exactly what action to take after reading any report.

## Features

### Cycle Management
- **Health Scoring**: Progress vs time, blocker impact, at-risk issue detection
- **Capacity Analysis**: Team workload distribution and availability
- **Risk Identification**: Blocked issues, stalled work, scope creep
- **Actionable Recommendations**: Prioritized next steps

### Backlog Health
- **Orphan Detection**: Issues without project assignments
- **Project Classification**: AI-powered project recommendations
- **Staleness Tracking**: Issues inactive >30 days
- **Duplicate Detection**: Similar issue identification

### GitHub-Linear Sync
- **PR Correlation**: Match PRs to Linear issues via branch names, descriptions, attachments
- **Gap Identification**: Orphaned PRs, orphaned issues
- **Merge Automation**: Auto-close candidates with generated commands
- **Stale PR Detection**: PRs open >14 days

### Daily Standups
- **Yesterday's Deliveries**: Completed issues and merged PRs
- **Current Work**: Team member assignments and progress
- **Availability**: Who needs work assigned
- **Quick Blockers**: Immediate attention items

### Context Engineering Adoption
- **Cross-Repo Analysis**: Compare code activity vs thoughts activity
- **Non-Adopter Detection**: Identify developers coding without documentation
- **Adoption Scoring**: 6-level status (Excellent → Not using)
- **Trend Tracking**: 28-day week-over-week growth metrics
- **Automated Reporting**: Daily dashboards via GitHub Actions

## Commands

### Cycle Management
- `/pm:analyze-cycle` - Analyze cycle health with actionable insights
  - Health assessment (🟢/🟡/🔴)
  - Risk identification (blockers, at-risk issues)
  - Team capacity analysis
  - Specific recommendations

### Milestone Management
- `/pm:analyze-milestone` - Analyze milestone health toward target date
  - Target date feasibility assessment
  - Progress tracking (actual vs expected)
  - Risk identification (behind schedule, blockers)
  - Specific recommendations (adjust timeline, reduce scope)

### `/pm:analyze-cycle`
Generate comprehensive cycle health report with recommendations.

**What it does**:
- Spawns linear-research agent to fetch active cycle data (Haiku)
- Spawns cycle-analyzer agent for health assessment (Sonnet)
- Generates progress metrics, risk factors, capacity analysis
- Provides specific, prioritized recommendations

**Output**: Health report saved to `thoughts/shared/reports/cycles/`

**Example**:
```
🟡 Cycle Health: Sprint 2025-W04 - At Risk

Takeaway: Cycle is 45% complete with 3 days remaining. We're tracking
slightly behind (projected 63% completion). Main risks: 2 blocked issues
and Dave has no assigned work.

Priority Actions:
  1. Escalate TEAM-461 blocker (external dependency, 6 days)
  2. Pair Bob with senior dev on TEAM-462 (dependency conflict)
  3. Assign 2 backlog issues to Dave (no active work)
```

### Daily Operations
- `/pm:report-daily` - Quick daily standup report
  - Yesterday's deliveries
  - Current work in progress
  - Team members needing assignments
  - Quick blockers/risks

### `/pm:report-daily`
Quick daily standup report (scannable in <30 seconds).

**What it does**:
- Spawns 4 parallel research agents for fast data gathering (Haiku)
- Lists current work in progress by team member
- Identifies team members needing work assignments
- Flags quick blockers and stalled issues

**Output**: Daily report saved to `thoughts/shared/reports/daily/`

**Example**:
```
📅 Team Daily - 2025-01-27

✅ Delivered yesterday: 3 issues, 2 PRs merged
🔄 In progress: 5 issues, 3 PRs open
👥 Need work: Dave, Emily (2 team members)
⚠️  Blockers: 1 issue (TEAM-461)
```

### Backlog Health
- `/pm:groom-backlog` - Analyze backlog health
  - Orphaned issues (no project)
  - Misplaced issues (wrong project)
  - Stale issues (>30 days inactive)
  - Potential duplicates
  - Missing estimates

### `/pm:groom-backlog`
Analyze backlog health and generate cleanup recommendations.

**What it does**:
- Spawns linear-research agent to fetch backlog issues (Haiku)
- Spawns backlog-analyzer agent for analysis (Sonnet)
- Identifies orphaned, misplaced, stale, and duplicate issues
- Generates batch update commands

**Output**: Grooming report saved to `thoughts/shared/reports/backlog/`

**Options**:
1. Review detailed report
2. Apply high-confidence recommendations automatically
3. Generate Linear update commands for manual execution
4. Skip (report saved for later)

### GitHub-Linear Sync
- `/pm:sync-prs` - Correlate GitHub PRs with Linear issues
  - Orphaned PRs (no Linear issue)
  - Orphaned issues (no PR)
  - Ready to close (PR merged, issue open)
  - Stale PRs (>14 days)

### `/pm:sync-prs`
Correlate GitHub PRs with Linear issues and identify gaps.

**What it does**:
- Spawns parallel research for GitHub PRs and Linear issues (Haiku)
- Spawns github-linear-analyzer agent for correlation analysis (Sonnet)
- Identifies orphaned PRs, orphaned issues, merge candidates
- Generates auto-close commands

**Output**: Correlation report saved to `thoughts/shared/reports/pr-sync/`

**Example**:
```
🔗 PR-Linear Sync Report

Health Score: 75/100
  ✅ 8 properly linked PRs
  ⚠️ 4 orphaned PRs need Linear issues
  ⚠️ 2 orphaned issues need PRs
  ✅ 2 ready to close
```

### Context Engineering
- `/pm:context-daily` - Generate daily context engineering adoption dashboard
  - Cross-repo analysis (code vs thoughts activity)
  - Identify developers NOT using context engineering
  - Individual adoption scores
  - 28-day trend analysis

### `/pm:context-daily`
Track context engineering adoption by cross-referencing code and thoughts repository activity.

**What it does**:
- Spawns parallel research for GitHub and thoughts metrics (Haiku)
- Spawns context-analyzer agent for cross-repo synthesis (Sonnet)
- Identifies developers with code activity but NO thoughts activity
- Calculates adoption scores (🟢 Excellent → 🔴 Not using)
- Generates 28-day trend analysis with week-over-week growth
- Provides prioritized action items (P1: Immediate, P2: Celebrate, P3: Growth)

**Output**: Dashboard saved to `{thoughts_repo}/context-engineering-daily.md` (root)

**Example**:
```
📊 Context Engineering Adoption - Daily Dashboard

Quick Stats (7-Day):
  Active contributors: 5/7 devs (71%)
  Files created: 8.6/day (↑ +39% vs 28-day avg)
  Adoption trend: ↑ +51% month-over-month

🚨 Not Using Context Engineering:
  • Frank: 3 PRs, 8 commits → 0 thoughts files (🔴 Not using)
  • Grace: 2 PRs, 5 commits → 0 thoughts files (🔴 Not using)

Priority Actions:
  1. P1: Onboard Frank & Grace (no thoughts activity)
  2. P2: Celebrate Alice (22 research docs in 7 days!)
  3. P3: Support Emily (building habit, needs guidance)
```

**GitHub Actions**: Automate daily reporting in your thoughts repository.
See: `plugins/pm/templates/github-actions/SETUP.md`

## Agents

### Research Agents
- `linear-research` (Haiku) - Gathers Linear data via CLI
  - Cycles, issues, milestones, projects
  - Natural language interface
  - Returns structured JSON
  - Optimized for speed

### Analyzer Agents (Sonnet)

### `cycle-analyzer`
**Purpose**: Transform raw cycle data into actionable health insights

**Responsibilities**:
- Calculate health scores (progress, blockers, at-risk issues)
- Identify risk factors with specific details
- Analyze team capacity and workload distribution
- Generate prioritized, actionable recommendations

**Returns**: Structured markdown with health assessment, risks, capacity, recommendations

### `milestone-analyzer`
**Purpose**: Analyze project milestone progress toward target dates

**Responsibilities**:
- Calculate health scores based on target date feasibility
- Identify risk factors (behind schedule, blockers, scope creep)
- Analyze velocity and projected completion
- Generate timeline/scope recommendations

**Returns**: Structured markdown with target date assessment, risks, velocity, recommendations

### `backlog-analyzer`
**Purpose**: Maintain healthy, well-organized Linear backlog

**Responsibilities**:
- Project assignment analysis (orphaned, misplaced issues)
- Staleness detection (>30 days inactive)
- Duplicate detection (similar titles/descriptions)
- Estimation gap identification

**Returns**: Structured markdown with categorized recommendations and confidence scores

### `context-analyzer`
**Purpose**: Track context engineering adoption across the team

**Responsibilities**:
- Cross-reference code repository activity vs thoughts repository activity
- Identify developers with code commits but NO thoughts activity
- Calculate individual adoption scores (Excellent → Not using)
- Analyze file type breakdown (research, plans, handoffs, PRs)
- Generate 28-day trend analysis with week-over-week growth
- Provide prioritized action items (P1: Immediate, P2: Celebrate, P3: Growth)

**Returns**: Structured markdown dashboard with adoption metrics, non-adopters, trends, recommendations

**Key Feature**: Identifies team members NOT using context engineering (code-only developers)

### `github-linear-analyzer`
**Purpose**: Ensure proper GitHub-Linear correlation

**Responsibilities**:
- Match PRs to Linear issues via multiple methods
- Identify orphaned PRs and issues
- Flag stale PRs (>14 days open)
- Detect merge candidates (PR merged, issue open)

**Returns**: Correlation report with health score and actionable commands

## Prerequisites

### Required Tools

1. **Linearis CLI** (with PR #4 cycle features)
   ```bash
   npm install -g --install-links czottmann/linearis
   ```
   See: https://github.com/czottmann/linearis/pull/4

2. **jq** (JSON parsing)
   ```bash
   brew install jq  # macOS
   apt install jq   # Ubuntu/Debian
   ```

3. **GitHub CLI** (optional, for PR sync)
   ```bash
   brew install gh  # macOS
   ```
   See: https://cli.github.com

### Configuration

PM commands read from two config sources:

**1. Project metadata** (`.claude/config.json` - safe to commit):
```json
{
  "catalyst": {
    "projectKey": "acme",
    "project": {
      "ticketPrefix": "ACME"
    }
  }
}
```

**2. Secrets** (`~/.config/catalyst/config-acme.json` - NEVER committed):
```json
{
  "linear": {
    "apiToken": "lin_api_...",
    "teamKey": "ACME"
  }
}
```

**Setup**: Run `./scripts/setup-catalyst-config.sh` to configure your project

## Installation

### Via Claude Code Marketplace (Coming Soon)

```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-pm
```

### Local Development

```bash
# Clone the repository
git clone https://github.com/coalesce-labs/catalyst.git

# Create symlink in your project
mkdir -p .claude/plugins
ln -s /path/to/catalyst/plugins/pm .claude/plugins/pm

# Restart Claude Code
```

## Verification

Check that the plugin is installed:

```bash
/plugin list
# Should show: catalyst-pm

# Run prerequisite check
cd /path/to/your/project
./plugins/pm/scripts/check-prerequisites.sh
```

## Usage Patterns

### Daily Workflow

**Morning Standup**:
```bash
/pm:team-daily
```
- See what shipped yesterday
- Review current work
- Identify blockers
- Assign work to available team members

### Weekly Review

**Start of Week**:
```bash
/pm:cycle-status
```
- Assess cycle health
- Review capacity
- Address blockers
- Plan capacity adjustments

**Mid-Week**:
```bash
/pm:pr-sync
```
- Check GitHub-Linear correlation
- Close merged issues
- Create missing Linear issues

**End of Week**:
```bash
/pm:backlog-groom
```
- Clean up orphaned issues
- Categorize new issues
- Remove stale issues
- Prepare next cycle

## Configuration Options

Default settings in `.claude/config.json`:

```json
{
  "pm": {
    "defaultCycleView": "active",
    "cycleProgressThreshold": 80,
    "staleIssueDays": 30,
    "atRiskIssueDays": 5,
    "teamAnalyticsEnabled": true,
    "backlogGrooming": {
      "autoDetectProjects": true,
      "duplicateSimilarityThreshold": 0.85,
      "requireEstimates": true
    }
  }
}
```

## Troubleshooting

### "Linearis CLI not found"

Install linearis:
```bash
npm install -g --install-links czottmann/linearis
```

Verify installation:
```bash
linearis --version
```

### "LINEAR_API_TOKEN not set"

Export your Linear API token:
```bash
export LINEAR_API_TOKEN=your_token_here
```

Get token from: https://linear.app/settings/api

### "Configuration file not found"

Ensure `.claude/config.json` exists:
```bash
cat .claude/config.json
```

Create if missing:
```bash
mkdir -p .claude
echo '{"linear": {"teamKey": "TEAM"}}' > .claude/config.json
```

### "No active cycle found"

Verify you have an active cycle in Linear:
```bash
linearis cycles list --team TEAM
```

Create a cycle in Linear UI or via API.

## Contributing

Contributions welcome! See the main Catalyst repository for contribution guidelines.

## License

MIT License - see LICENSE file in main repository

## Support

- GitHub Issues: https://github.com/coalesce-labs/catalyst/issues
- Documentation: https://catalyst.dev/docs
- Community: https://catalyst.dev/community
