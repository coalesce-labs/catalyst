---
title: catalyst-dev
description: Core development workflow plugin — research, plan, implement, validate, ship.
---

The core plugin that powers all Catalyst development workflows. Always install this one.

## What's Included

- **10 research agents** for codebase and infrastructure analysis
- **21 skills** covering the full development lifecycle
- **Automatic workflow context tracking** via hooks
- **~3.5K context** footprint (lightweight MCPs: DeepWiki, Context7)

## Skills

### Core Workflow

| Skill | Description |
|-------|-------------|
| `/catalyst-dev:research_codebase` | Parallel codebase research with specialized agents |
| `/catalyst-dev:create_plan` | Interactive implementation planning |
| `/catalyst-dev:iterate_plan` | Revise existing plans with feedback |
| `/catalyst-dev:implement_plan` | Execute plans with validation |
| `/catalyst-dev:validate_plan` | Verify implementation completeness |
| `/catalyst-dev:oneshot` | All-in-one: research, plan, and implement with context isolation |

### Development

| Skill | Description |
|-------|-------------|
| `/catalyst-dev:commit` | Conventional commits with Linear integration |
| `/catalyst-dev:ci_commit` | CI-aware commits with pre-flight checks |
| `/catalyst-dev:create_pr` | Pull requests with auto-description |
| `/catalyst-dev:describe_pr` | Generate/update PR descriptions |
| `/catalyst-dev:ci_describe_pr` | CI-aware PR descriptions |
| `/catalyst-dev:merge_pr` | Safe merge with verification |

### Context Persistence

| Skill | Description |
|-------|-------------|
| `/catalyst-dev:create_handoff` | Save session context for later |
| `/catalyst-dev:resume_handoff` | Resume from a handoff document |

### Project Management

| Skill | Description |
|-------|-------------|
| `/catalyst-dev:linear` | Ticket management and workflow |
| `/catalyst-dev:create_worktree` | Isolated workspace creation |

### Code Quality

| Skill | Description |
|-------|-------------|
| `/catalyst-dev:fix_typescript` | Fix TypeScript errors with strict rules |
| `/catalyst-dev:scan_reward_hacking` | Scan for reward hacking patterns |

### Reference Skills

| Skill | Description |
|-------|-------------|
| `agent-browser` | Browser automation CLI reference — use instead of Playwright MCP tools |
| `code-first-draft` | Initial feature implementation guidance |
| `linearis` | Linearis CLI reference for Linear ticket management |

See the [Skills Reference](/reference/skills/) for full details.

## Research Agents

| Agent | Purpose | Model |
|-------|---------|-------|
| `codebase-locator` | Find files and patterns | Haiku |
| `codebase-analyzer` | Deep code analysis | Sonnet |
| `codebase-pattern-finder` | Find reusable patterns | Sonnet |
| `thoughts-locator` | Search thoughts repository | Haiku |
| `thoughts-analyzer` | Analyze documentation | Sonnet |
| `external-research` | External repos and docs | Sonnet |

## Hooks

Catalyst includes three Claude Code hooks that run automatically:

**inject-plan-template** — When Claude Code is in plan mode, this hook injects Catalyst's plan structure guidance so plans come out in the phased format that `/implement_plan` expects. Outside plan mode, it exits immediately (under 10ms overhead).

**sync-plan-to-thoughts** — When you exit plan mode, this hook copies the plan to `thoughts/shared/plans/` with frontmatter (date, branch, commit) and updates workflow context so `/implement_plan` can auto-discover it.

**update-workflow-context** — After any file write to `thoughts/shared/`, this hook records it in `.claude/.workflow-context.json`. This is what enables command chaining — research saves, then `/create_plan` finds it automatically.

## Workflow Context Tracking

The plugin includes Claude Code hooks that automatically track documents written to `thoughts/shared/`:

- Research documents → tracked as `research` type
- Plans → tracked as `plans` type
- Handoffs → tracked as `handoffs` type
- PR descriptions → tracked as `prs` type

Ticket numbers are auto-extracted from filenames and directory names.

## Installation

```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-dev
```

## Requirements

- **Required**: HumanLayer CLI (thoughts system)
- **Optional**: Linearis CLI (`npm install -g linearis`)
- **Optional**: GitHub CLI (`gh`)
