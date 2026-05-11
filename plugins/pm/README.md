# Catalyst PM Plugin

Product strategy plugin — 34 skills covering strategy, PRDs, user research, metrics, interviews, prototyping, and decision-making.

> **Operational PM workflows** (cycle health, backlog grooming, cadence, status updates, Slack) moved to the companion [catalyst-pm-ops](../pm-ops/README.md) plugin.

> **Complete inventory:** the full list of skills and agents (with trigger contexts) lives in the website's [Skills Reference](https://catalyst.coalescelabs.ai/reference/skills/#catalyst-pm) and [Agents Reference](https://catalyst.coalescelabs.ai/reference/agents/#catalyst-pm-agents). The sections below highlight the most commonly-used feature groups; they are not exhaustive.

## Overview

The Catalyst PM plugin provides AI-powered project management workflows that integrate Linear issue
tracking with GitHub pull requests. It focuses on actionable insights rather than raw data dumps.

**Philosophy**: Every report includes specific recommendations, not just metrics. PMs should know
exactly what action to take after reading any report.

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

> **Operational skills moved to [catalyst-pm-ops](../pm-ops/README.md)**:
> `/catalyst-pm-ops:analyze-cycle`, `/catalyst-pm-ops:analyze-milestone`, `/catalyst-pm-ops:groom-backlog`,
> `/catalyst-pm-ops:sync-prs`, `/catalyst-pm-ops:report-daily`, `/catalyst-pm-ops:daily-plan`,
> `/catalyst-pm-ops:weekly-plan`, `/catalyst-pm-ops:weekly-review`, `/catalyst-pm-ops:status-update`,
> `/catalyst-pm-ops:create-tickets`, `/catalyst-pm-ops:slack-message`, `/catalyst-pm-ops:connect-mcps`

### Context Engineering

- `/catalyst-pm:context-daily` - Generate daily context engineering adoption dashboard
  - Cross-repo analysis (code vs thoughts activity)
  - Identify developers NOT using context engineering
  - Individual adoption scores
  - 28-day trend analysis

### `/catalyst-pm:context-daily`

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

**GitHub Actions**: Automate daily reporting in your thoughts repository. See:
`plugins/pm/templates/github-actions/SETUP.md`

## Agents

### Research Agents

- `linear-research` (Haiku) - Gathers Linear data via CLI
  - Cycles, issues, milestones, projects
  - Natural language interface
  - Returns structured JSON
  - Optimized for speed

> **Analyzer agents moved to [catalyst-pm-ops](../pm-ops/README.md)**:
> `cycle-analyzer`, `milestone-analyzer`, `backlog-analyzer`, `github-linear-analyzer`

## Prerequisites

### Required Tools

1. **Linearis CLI**

   ```bash
   npm install -g linearis
   ```

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

**1. Project metadata** (`.catalyst/config.json` - safe to commit):

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
  "catalyst": {
    "linear": {
      "apiToken": "lin_api_...",
      "teamKey": "ACME"
    }
  }
}
```

**Setup**: Create both files manually, or use the `setup-catalyst.sh` script from the project root:
```bash
curl -fsSL https://raw.githubusercontent.com/coalesce-labs/catalyst/main/setup-catalyst.sh | bash
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
# Should show: catalyst-pm, catalyst-pm-ops
```

## Usage Patterns

> For daily standup, cycle review, backlog grooming, and PR sync workflows, see [catalyst-pm-ops](../pm-ops/README.md).

## Configuration Options

Default settings in `.catalyst/config.json`:

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
npm install -g linearis
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

Ensure `.catalyst/config.json` exists:

```bash
cat .catalyst/config.json
```

Create if missing:

```bash
mkdir -p .catalyst
echo '{"catalyst": {"linear": {"teamKey": "TEAM"}}}' > .catalyst/config.json
```

### "No active cycle found"

Verify you have an active cycle in Linear:

```bash
# Run `linearis cycles usage` for exact syntax
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
