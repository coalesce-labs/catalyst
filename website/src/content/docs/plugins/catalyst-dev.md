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
| `/research-codebase` | Parallel codebase research with specialized agents |
| `/create-plan` | Interactive implementation planning |
| `/iterate-plan` | Revise existing plans with feedback |
| `/implement-plan` | Execute plans with validation |
| `/validate-plan` | Verify implementation completeness |
| `/oneshot` | All-in-one: research, plan, and implement with context isolation |

### Development

| Command | Description |
|---------|-------------|
| `/commit` | Conventional commits with Linear integration |
| `/ci-commit` | CI-aware commits with pre-flight checks |
| `/create-pr` | Pull requests with auto-description |
| `/describe-pr` | Generate/update PR descriptions |
| `/ci-describe-pr` | CI-aware PR descriptions |
| `/merge-pr` | Safe merge with verification |

### Context Persistence

| Command | Description |
|---------|-------------|
| `/create-handoff` | Save session context for later |
| `/resume-handoff` | Resume from a handoff document |

### Project Management

| Command | Description |
|---------|-------------|
| `/linear` | Ticket management and workflow |
| `/create-worktree` | Isolated workspace creation |

## Research Agents

| Agent | Purpose | Model |
|-------|---------|-------|
| `codebase-locator` | Find files and patterns | Haiku |
| `codebase-analyzer` | Deep code analysis | Sonnet |
| `codebase-pattern-finder` | Find reusable patterns | Sonnet |
| `thoughts-locator` | Search thoughts repository | Haiku |
| `thoughts-analyzer` | Analyze documentation | Sonnet |
| `external-research` | External repos and docs | Sonnet |

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
