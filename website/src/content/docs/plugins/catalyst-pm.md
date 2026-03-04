---
title: catalyst-pm
description: Project management plugin — cycle analysis, milestone tracking, backlog grooming, PR sync.
---

AI-powered project management workflows that integrate Linear issue tracking with GitHub pull requests. Every report includes specific recommendations, not just metrics.

## Commands

| Command | Description |
|---------|-------------|
| `/pm:analyze-cycle` | Cycle health report with risk analysis and recommendations |
| `/pm:analyze-milestone` | Milestone progress toward target dates |
| `/pm:report-daily` | Quick daily standup summary |
| `/pm:groom-backlog` | Backlog health analysis and cleanup |
| `/pm:sync-prs` | GitHub-Linear PR correlation and gap identification |
| `/pm:context-daily` | Context engineering adoption dashboard |

## Cycle Analysis

Spawns parallel research agents to gather cycle data, then produces a health assessment:

```
/pm:analyze-cycle
```

Example output:

```
Cycle Health: Sprint 2025-W04 - At Risk

Takeaway: 45% complete with 3 days remaining. Projected 63%
completion. Main risks: 2 blocked issues and Dave has no work.

Priority Actions:
  1. Escalate TEAM-461 blocker (external dependency, 6 days)
  2. Pair Bob with senior dev on TEAM-462
  3. Assign 2 backlog issues to Dave
```

## Daily Standup

Quick report designed to be read in under 30 seconds:

```
/pm:report-daily
```

Shows yesterday's deliveries, current work, team availability, and blockers.

## Backlog Grooming

Identifies orphaned issues, misplaced assignments, stale items, and potential duplicates:

```
/pm:groom-backlog
```

Generates batch update commands for cleanup actions.

## GitHub-Linear Sync

Correlates PRs to issues and identifies gaps:

```
/pm:sync-prs
```

Finds orphaned PRs, orphaned issues, merge candidates, and stale PRs.

## Architecture

- **Research-first**: Haiku agents collect data fast, Sonnet/Opus agents analyze
- **Parallel research**: Multiple data sources queried simultaneously
- **Actionable output**: Every report includes specific next steps

## Prerequisites

- Linearis CLI: `npm install -g linearis`
- jq: `brew install jq`
- GitHub CLI (optional): `brew install gh`

## Installation

```bash
/plugin install catalyst-pm
```
