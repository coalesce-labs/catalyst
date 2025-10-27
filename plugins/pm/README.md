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

## Commands

### `/pm:cycle-status`
Generate comprehensive cycle health report with recommendations.

**What it does**:
- Fetches active cycle data from Linear
- Spawns cycle-analyzer agent for health assessment
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

### `/pm:team-daily`
Quick daily standup report (scannable in <30 seconds).

**What it does**:
- Fetches yesterday's completed issues and merged PRs
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

### `/pm:backlog-groom`
Analyze backlog health and generate cleanup recommendations.

**What it does**:
- Fetches all backlog issues
- Spawns backlog-groomer agent for analysis
- Identifies orphaned, misplaced, stale, and duplicate issues
- Generates batch update commands

**Output**: Grooming report saved to `thoughts/shared/reports/backlog/`

**Options**:
1. Review detailed report
2. Apply high-confidence recommendations automatically
3. Generate Linear update commands for manual execution
4. Skip (report saved for later)

### `/pm:pr-sync`
Correlate GitHub PRs with Linear issues and identify gaps.

**What it does**:
- Fetches open and recently merged PRs from GitHub
- Extracts Linear ticket IDs from branch names
- Spawns pr-correlator agent for analysis
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

## Agents

### `cycle-analyzer`
**Purpose**: Transform raw cycle data into actionable health insights

**Responsibilities**:
- Calculate health scores (progress, blockers, at-risk issues)
- Identify risk factors with specific details
- Analyze team capacity and workload distribution
- Generate prioritized, actionable recommendations

**Returns**: Structured markdown with health assessment, risks, capacity, recommendations

### `backlog-groomer`
**Purpose**: Maintain healthy, well-organized Linear backlog

**Responsibilities**:
- Project assignment analysis (orphaned, misplaced issues)
- Staleness detection (>30 days inactive)
- Duplicate detection (similar titles/descriptions)
- Estimation gap identification

**Returns**: Structured markdown with categorized recommendations and confidence scores

### `pr-correlator`
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

Add Linear team configuration to `.claude/config.json`:

```json
{
  "linear": {
    "teamKey": "TEAM",
    "apiToken": "[your-token]"
  }
}
```

Set Linear API token:
```bash
export LINEAR_API_TOKEN=your_token_here
```

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
