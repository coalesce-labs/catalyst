---
title: Plugin System
description: Catalyst's modular plugin architecture — install what you need.
sidebar:
  order: 0
---

Catalyst is distributed as independent Claude Code plugins. Install only the ones you need to keep your context lean and focused.

## Available Plugins

| Plugin | Description | Context Cost |
|--------|------------|--------------|
| **catalyst-dev** | Core development workflow — research, plan, implement, validate, ship | ~3.5K tokens |
| **catalyst-pm** | Project management — cycle analysis, backlog grooming, PR sync | Minimal (CLI-based) |
| **catalyst-analytics** | Product analytics via PostHog MCP | ~40K tokens |
| **catalyst-debugging** | Error monitoring via Sentry MCP | ~20K tokens |
| **catalyst-meta** | Workflow discovery, creation, and management | Minimal |

## Installation

```bash
# Add the marketplace
/plugin marketplace add coalesce-labs/catalyst

# Install plugins
/plugin install catalyst-dev          # Required
/plugin install catalyst-pm           # Optional
/plugin install catalyst-analytics    # Optional
/plugin install catalyst-debugging    # Optional
/plugin install catalyst-meta         # Optional
```

## Session-Based MCP Management

Plugins load and unload MCPs dynamically to manage context:

```bash
# Enable when needed
/plugin enable catalyst-analytics    # +40K context
/plugin enable catalyst-debugging    # +20K context

# Disable to free context
/plugin disable catalyst-analytics   # -40K context
```

Most sessions start with just `catalyst-dev` (~3.5K tokens) and enable heavier plugins only when needed.

## Updating

```bash
# Fetch latest from marketplace
claude plugin marketplace update catalyst

# Restart Claude Code to load updates
```

## Architecture

Each plugin contains:

- **agents/** — Specialized research agents
- **skills/** — Workflow skills (invoked via `/catalyst-dev:skill_name`)
- **scripts/** — Runtime utilities
- **hooks/** — Automatic triggers (e.g., workflow context tracking)
- **plugin.json** — Manifest with metadata and dependencies
