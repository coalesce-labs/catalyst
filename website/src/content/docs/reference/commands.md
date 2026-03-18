---
title: Command Reference
description: Complete reference for all Catalyst skills across plugins.
---

All Catalyst functionality is delivered as skills, invoked via `/plugin:skill_name`. This page lists every available skill organized by plugin.

## catalyst-dev Skills

### Core Workflow

| Skill | Description |
|-------|-------------|
| `/catalyst-dev:research_codebase` | Parallel codebase research with specialized agents |
| `/catalyst-dev:create_plan` | Interactive implementation planning |
| `/catalyst-dev:iterate_plan` | Revise existing plans with feedback |
| `/catalyst-dev:implement_plan` | Execute plans with phase-by-phase validation |
| `/catalyst-dev:validate_plan` | Verify implementation against success criteria |
| `/catalyst-dev:oneshot` | End-to-end: research, plan, implement in one invocation |

### Development

| Skill | Description |
|-------|-------------|
| `/catalyst-dev:commit` | Conventional commits with Linear integration |
| `/catalyst-dev:create_pr` | Pull request creation with auto-description |
| `/catalyst-dev:describe_pr` | Generate/update PR descriptions |
| `/catalyst-dev:merge_pr` | Safe merge with verification and Linear integration |

### Context Persistence

| Skill | Description |
|-------|-------------|
| `/catalyst-dev:create_handoff` | Save session state for resumption |
| `/catalyst-dev:resume_handoff` | Resume from a handoff document |

### Project Management

| Skill | Description |
|-------|-------------|
| `/catalyst-dev:linear` | Direct ticket operations (create, update, comment). Workflow commands handle state transitions automatically. |
| `/catalyst-dev:create_worktree` | Create git worktree for parallel development |

### Code Quality

| Skill | Description |
|-------|-------------|
| `/catalyst-dev:fix_typescript` | Fix TypeScript errors with strict rules |
| `/catalyst-dev:scan_reward_hacking` | Scan for reward hacking patterns |

## catalyst-pm Skills

| Skill | Description |
|-------|-------------|
| `/catalyst-pm:analyze_cycle` | Cycle health report with recommendations |
| `/catalyst-pm:analyze_milestone` | Milestone progress toward target dates |
| `/catalyst-pm:report_daily` | Daily standup summary |
| `/catalyst-pm:groom_backlog` | Backlog health analysis and cleanup |
| `/catalyst-pm:sync_prs` | GitHub-Linear PR correlation |
| `/catalyst-pm:context_daily` | Context engineering adoption dashboard |

## catalyst-analytics Skills

| Skill | Description |
|-------|-------------|
| `/catalyst-analytics:analyze_user_behavior` | User behavior patterns |
| `/catalyst-analytics:segment_analysis` | Segment and cohort analysis |
| `/catalyst-analytics:product_metrics` | Product KPIs and conversion rates |

## catalyst-debugging Skills

| Skill | Description |
|-------|-------------|
| `/catalyst-debugging:debug_production_error` | Investigate production errors with Sentry data |
| `/catalyst-debugging:error_impact_analysis` | Analyze error impact across users and releases |
| `/catalyst-debugging:trace_analysis` | Trace error paths through the stack |

## catalyst-meta Skills

| Skill | Description |
|-------|-------------|
| `/catalyst-meta:discover_workflows` | Research external repos for workflow patterns |
| `/catalyst-meta:import_workflow` | Import and adapt external workflows |
| `/catalyst-meta:create_workflow` | Create new agents or skills |
| `/catalyst-meta:validate_frontmatter` | Check frontmatter consistency |
| `/catalyst-meta:audit_references` | Audit plugin health and find broken references |
| `/catalyst-meta:reorganize` | Analyze and reorganize directory structures |

## CI/Automation Skills

The `/catalyst-dev:ci_commit` and `/catalyst-dev:ci_describe_pr` skills are designed for CI pipelines:

- Non-interactive (no user prompts)
- Follow the same conventions (conventional commits, PR templates)
- Never commit sensitive files
- No Claude attribution
