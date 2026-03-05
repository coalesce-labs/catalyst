---
title: catalyst-pm
description: Project management plugin — cycle analysis, milestone tracking, backlog grooming, PR sync.
---

AI-powered project management workflows that integrate Linear issue tracking with GitHub pull requests. Every report includes specific recommendations, not just metrics.

## Commands

| Command | Description |
|---------|-------------|
| `/catalyst-pm:analyze_cycle` | Cycle health report with risk analysis and recommendations |
| `/catalyst-pm:analyze_milestone` | Milestone progress toward target dates |
| `/catalyst-pm:report_daily` | Quick daily standup summary |
| `/catalyst-pm:groom_backlog` | Backlog health analysis and cleanup |
| `/catalyst-pm:sync_prs` | GitHub-Linear PR correlation and gap identification |
| `/catalyst-pm:context_daily` | Context engineering adoption dashboard |

## Cycle Analysis

Spawns parallel research agents to gather cycle data, then produces a health assessment:

```
/catalyst-pm:analyze_cycle
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
/catalyst-pm:report_daily
```

Shows yesterday's deliveries, current work, team availability, and blockers.

## Backlog Grooming

Identifies orphaned issues, misplaced assignments, stale items, and potential duplicates:

```
/catalyst-pm:groom_backlog
```

Generates batch update commands for cleanup actions.

## GitHub-Linear Sync

Correlates PRs to issues and identifies gaps:

```
/catalyst-pm:sync_prs
```

Finds orphaned PRs, orphaned issues, merge candidates, and stale PRs.

## Architecture

- **Research-first**: Haiku agents collect data fast, Sonnet/Opus agents analyze
- **Parallel research**: Multiple data sources queried simultaneously
- **Actionable output**: Every report includes specific next steps

## Skills

The PM plugin includes 40 skills covering the full product management workflow — from strategy and research to meetings, planning, and prototyping. All skills are user-invocable via `/catalyst-pm:{skill_name}`.

See the [Skills Reference](/reference/skills/#catalyst-pm-skills) for the complete inventory organized by category.

## Prerequisites

- Linearis CLI: `npm install -g linearis`
- jq: `brew install jq`
- GitHub CLI (optional): `brew install gh`

## Installation

```bash
/plugin install catalyst-pm
```
