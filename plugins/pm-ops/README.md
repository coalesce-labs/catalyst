# Catalyst PM Ops Plugin

Linear / GitHub project-management mechanics — cycle health, backlog grooming, PR-to-issue sync, daily and weekly cadence, status updates, and Slack drafting.

> **Companion to [catalyst-pm](../pm/README.md)** which focuses on strategy, PRDs, priorities, and release sequencing. This plugin handles the day-to-day operational tooling that runs *on top of* the strategy.

## Skills (12)

### Linear cycle / backlog
- `/catalyst-pm-ops:analyze-cycle` — Cycle health with risk + recommendations
- `/catalyst-pm-ops:analyze-milestone` — Milestone health with target-date feasibility
- `/catalyst-pm-ops:groom-backlog` — Orphan / stale / duplicate detection

### GitHub ↔ Linear
- `/catalyst-pm-ops:create-tickets` — PRD → tickets via Linear MCP
- `/catalyst-pm-ops:sync-prs` — PR ↔ issue correlation gaps

### Cadence
- `/catalyst-pm-ops:daily-plan` — Forward-looking PM day plan
- `/catalyst-pm-ops:report-daily` — Backward-looking standup snapshot
- `/catalyst-pm-ops:weekly-plan` — OKR-tied weekly priorities
- `/catalyst-pm-ops:weekly-review` — Plan-vs-actual retro
- `/catalyst-pm-ops:status-update` — Audience-shaped stakeholder updates

### Comms / setup
- `/catalyst-pm-ops:slack-message` — PM-voice Slack drafting
- `/catalyst-pm-ops:connect-mcps` — MCP setup for Linear/PostHog/Gmail/Calendar

## Agents (4)

Registered globally via `plugin.json`:
- `cycle-analyzer` — sonnet
- `milestone-analyzer` — sonnet
- `backlog-analyzer` — sonnet
- `github-linear-analyzer` — sonnet

## Prerequisites

- `linearis` CLI (`npm install -g linearis`) for Linear integration
- `gh` CLI for GitHub PR queries
- `jq` for JSON processing

## Installation

```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-pm-ops
```

## License

MIT
