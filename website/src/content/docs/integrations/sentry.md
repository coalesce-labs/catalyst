---
title: Sentry
description: Sentry integration for production error monitoring and debugging.
---

Catalyst integrates with Sentry via the `catalyst-debugging` plugin for production error monitoring, stack trace analysis, and root cause detection.

## Context Cost

**~20K tokens** when enabled. Enable only during debugging sessions:

```bash
/plugin enable catalyst-debugging    # +20K context
# Debug production errors...
/plugin disable catalyst-debugging   # -20K context
```

## Capabilities

- Production error monitoring
- Stack trace analysis
- Root cause detection
- Error pattern identification
- Release health tracking

## Setup

1. Install Sentry CLI: `npm install -g @sentry/cli`
2. Add to secrets config: `~/.config/catalyst/config-{projectKey}.json`

```json
{
  "sentry": {
    "org": "your-org",
    "project": "your-project",
    "authToken": "sntrys_..."
  }
}
```

## Installation

```bash
/plugin install catalyst-debugging
```
