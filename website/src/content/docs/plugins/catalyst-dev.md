---
title: catalyst-dev
description: Core development workflow plugin — research, plan, implement, validate, ship.
---

The core plugin that powers all Catalyst development workflows. Always install this one.

## What's Included

- **10 research agents** for codebase and infrastructure analysis
- **22 commands** covering the full development lifecycle
- **3 skills** for browser automation, code prototyping, and Linear CLI reference
- **Automatic workflow context tracking** via hooks
- **~3.5K context** footprint (lightweight MCPs: DeepWiki, Context7)

## Commands

### Core Workflow

| Command | Description |
|---------|-------------|
| `/catalyst-dev:research_codebase` | Parallel codebase research with specialized agents |
| `/catalyst-dev:create_plan` | Interactive implementation planning |
| `/catalyst-dev:iterate_plan` | Revise existing plans with feedback |
| `/catalyst-dev:implement_plan` | Execute plans with validation |
| `/catalyst-dev:validate_plan` | Verify implementation completeness |
| `/catalyst-dev:oneshot` | All-in-one: research, plan, and implement with context isolation |

### Development

| Command | Description |
|---------|-------------|
| `/catalyst-dev:commit` | Conventional commits with Linear integration |
| `/catalyst-dev:ci_commit` | CI-aware commits with pre-flight checks |
| `/catalyst-dev:create_pr` | Pull requests with auto-description |
| `/catalyst-dev:describe_pr` | Generate/update PR descriptions |
| `/catalyst-dev:ci_describe_pr` | CI-aware PR descriptions |
| `/catalyst-dev:merge_pr` | Safe merge with verification |

### Context Persistence

| Command | Description |
|---------|-------------|
| `/catalyst-dev:create_handoff` | Save session context for later |
| `/catalyst-dev:resume_handoff` | Resume from a handoff document |

### Project Management

| Command | Description |
|---------|-------------|
| `/catalyst-dev:linear` | Ticket management and workflow |
| `/catalyst-dev:create_worktree` | Isolated workspace creation |

## Research Agents

| Agent | Purpose | Model |
|-------|---------|-------|
| `codebase-locator` | Find files and patterns | Haiku |
| `codebase-analyzer` | Deep code analysis | Sonnet |
| `codebase-pattern-finder` | Find reusable patterns | Sonnet |
| `thoughts-locator` | Search thoughts repository | Haiku |
| `thoughts-analyzer` | Analyze documentation | Sonnet |
| `external-research` | External repos and docs | Sonnet |

## Skills

| Skill | Description |
|-------|-------------|
| `agent-browser` | Browser automation CLI reference — use instead of Playwright MCP tools |
| `code-first-draft` | Initial feature implementation guidance |
| `linearis` | Linearis CLI reference for Linear ticket management |

See the [Skills Reference](/reference/skills/) for full details.

## Hooks

| Hook | Event | Purpose |
|------|-------|---------|
| `inject-plan-template` | `UserPromptSubmit` | Injects plan structure in plan mode |
| `sync-plan-to-thoughts` | `ExitPlanMode` | Copies plans to thoughts with frontmatter |
| `update-workflow-context` | Write/Edit | Tracks documents in workflow context |

See the [Hooks Reference](/reference/hooks/) for full details.

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
