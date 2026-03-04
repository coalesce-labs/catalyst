---
title: catalyst-debugging
description: Debugging plugin — Sentry MCP integration for production error monitoring.
---

Sentry MCP integration for production error monitoring, stack trace analysis, and root cause detection.

## Context Cost

**~20K tokens** when enabled. Enable only when debugging production errors:

```bash
/plugin enable catalyst-debugging    # +20K context
# Debug and investigate errors...
/plugin disable catalyst-debugging   # -20K context
```

## Capabilities

- Production error monitoring and alerting
- Stack trace analysis with source maps
- Root cause detection
- Error pattern identification
- Release health tracking

## Prerequisites

- Sentry account with project access
- Sentry CLI: `npm install -g @sentry/cli`
- Auth token configured in secrets config

## Installation

```bash
/plugin install catalyst-debugging
```
