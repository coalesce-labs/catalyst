---
title: Command Reference
description: Complete reference for all Catalyst commands across plugins.
---

## catalyst-dev Commands

### Core Workflow

| Command | Description | Model |
|---------|-------------|-------|
| `/catalyst-dev:research_codebase` | Parallel codebase research with specialized agents | Opus |
| `/catalyst-dev:create_plan` | Interactive implementation planning | Opus |
| `/catalyst-dev:iterate_plan` | Revise existing plans with feedback | Opus |
| `/catalyst-dev:implement_plan` | Execute plans with phase-by-phase validation | Opus |
| `/catalyst-dev:validate_plan` | Verify implementation against success criteria | Opus |
| `/catalyst-dev:oneshot` | End-to-end: research, plan, implement in one invocation | Opus |

### Development

| Command | Description | Model |
|---------|-------------|-------|
| `/catalyst-dev:commit` | Conventional commits with Linear integration | Sonnet |
| `/catalyst-dev:ci_commit` | CI-aware commits (non-interactive) | Sonnet |
| `/catalyst-dev:create_pr` | Pull request creation with auto-description | Sonnet |
| `/catalyst-dev:describe_pr` | Generate/update PR descriptions | Sonnet |
| `/catalyst-dev:ci_describe_pr` | CI-aware PR descriptions (non-interactive) | Sonnet |
| `/catalyst-dev:merge_pr` | Safe merge with verification and Linear integration | Sonnet |

### Context Persistence

| Command | Description | Model |
|---------|-------------|-------|
| `/catalyst-dev:create_handoff` | Save session state for resumption | Sonnet |
| `/catalyst-dev:resume_handoff` | Resume from a handoff document | Sonnet |

### Project Management

| Command | Description | Model |
|---------|-------------|-------|
| `/catalyst-dev:linear` | Direct ticket operations (create, update, comment). Workflow commands handle state transitions automatically. | Sonnet |
| `/catalyst-dev:create_worktree` | Create git worktree for parallel development | Sonnet |

## catalyst-pm Commands

| Command | Description | Model |
|---------|-------------|-------|
| `/catalyst-pm:analyze_cycle` | Cycle health report with recommendations | Opus |
| `/catalyst-pm:analyze_milestone` | Milestone progress toward target dates | Opus |
| `/catalyst-pm:report_daily` | Daily standup summary | Sonnet |
| `/catalyst-pm:groom_backlog` | Backlog health analysis and cleanup | Sonnet |
| `/catalyst-pm:sync_prs` | GitHub-Linear PR correlation | Sonnet |
| `/catalyst-pm:context_daily` | Context engineering adoption dashboard | Sonnet |

## catalyst-analytics Commands

| Command | Description | Model |
|---------|-------------|-------|
| `/catalyst-analytics:analyze_user_behavior` | User behavior patterns | Sonnet |
| `/catalyst-analytics:segment_analysis` | Segment and cohort analysis | Sonnet |
| `/catalyst-analytics:product_metrics` | Product KPIs and conversion rates | Sonnet |

## catalyst-meta Commands

| Command | Description | Model |
|---------|-------------|-------|
| `/catalyst-meta:discover_workflows` | Research external repos for workflow patterns | Opus |
| `/catalyst-meta:import_workflow` | Import and adapt external workflows | Opus |
| `/catalyst-meta:create_workflow` | Create new agents or commands | Opus |
| `/catalyst-meta:validate_frontmatter` | Check frontmatter consistency | Sonnet |
| `/catalyst-meta:workflow_help` | Interactive workflow guidance | Sonnet |

## CI/Automation Commands

The `/catalyst-dev:ci_commit` and `/catalyst-dev:ci_describe_pr` commands are designed for CI pipelines:

- Non-interactive (no user prompts)
- Follow the same conventions (conventional commits, PR templates)
- Never commit sensitive files
- No Claude attribution
