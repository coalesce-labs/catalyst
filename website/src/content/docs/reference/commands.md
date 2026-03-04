---
title: Command Reference
description: Complete reference for all Catalyst commands across plugins.
---

## catalyst-dev Commands

### Core Workflow

| Command | Description | Model |
|---------|-------------|-------|
| `/research-codebase` | Parallel codebase research with specialized agents | Opus |
| `/create-plan` | Interactive implementation planning | Opus |
| `/iterate-plan` | Revise existing plans with feedback | Opus |
| `/implement-plan` | Execute plans with phase-by-phase validation | Opus |
| `/validate-plan` | Verify implementation against success criteria | Opus |
| `/oneshot` | End-to-end: research, plan, implement in one invocation | Opus |

### Development

| Command | Description | Model |
|---------|-------------|-------|
| `/commit` | Conventional commits with Linear integration | Sonnet |
| `/ci-commit` | CI-aware commits (non-interactive) | Sonnet |
| `/create-pr` | Pull request creation with auto-description | Sonnet |
| `/describe-pr` | Generate/update PR descriptions | Sonnet |
| `/ci-describe-pr` | CI-aware PR descriptions (non-interactive) | Sonnet |
| `/merge-pr` | Safe merge with verification and Linear integration | Sonnet |

### Context Persistence

| Command | Description | Model |
|---------|-------------|-------|
| `/create-handoff` | Save session state for resumption | Sonnet |
| `/resume-handoff` | Resume from a handoff document | Sonnet |

### Project Management

| Command | Description | Model |
|---------|-------------|-------|
| `/linear` | Ticket management and workflow automation | Sonnet |
| `/create-worktree` | Create git worktree for parallel development | Sonnet |

## catalyst-pm Commands

| Command | Description | Model |
|---------|-------------|-------|
| `/pm:analyze-cycle` | Cycle health report with recommendations | Opus |
| `/pm:analyze-milestone` | Milestone progress toward target dates | Opus |
| `/pm:report-daily` | Daily standup summary | Sonnet |
| `/pm:groom-backlog` | Backlog health analysis and cleanup | Sonnet |
| `/pm:sync-prs` | GitHub-Linear PR correlation | Sonnet |
| `/pm:context-daily` | Context engineering adoption dashboard | Sonnet |

## catalyst-analytics Commands

| Command | Description | Model |
|---------|-------------|-------|
| `/analytics:analyze-user-behavior` | User behavior patterns | Sonnet |
| `/analytics:segment-analysis` | Segment and cohort analysis | Sonnet |
| `/analytics:product-metrics` | Product KPIs and conversion rates | Sonnet |

## catalyst-meta Commands

| Command | Description | Model |
|---------|-------------|-------|
| `/discover-workflows` | Research external repos for workflow patterns | Opus |
| `/import-workflow` | Import and adapt external workflows | Opus |
| `/create-workflow` | Create new agents or commands | Opus |
| `/validate-frontmatter` | Check frontmatter consistency | Sonnet |
| `/workflow-help` | Interactive workflow guidance | Sonnet |

## CI/Automation Commands

The `/ci-commit` and `/ci-describe-pr` commands are designed for CI pipelines:

- Non-interactive (no user prompts)
- Follow the same conventions (conventional commits, PR templates)
- Never commit sensitive files
- No Claude attribution
