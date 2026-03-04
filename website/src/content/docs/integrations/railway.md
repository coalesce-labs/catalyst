---
title: Railway
description: Railway integration for deployment logs, service health, and environment management.
---

Catalyst integrates with Railway via the `railway` CLI for deployment investigation, log analysis, and service health checks.

## Capabilities

- Deployment log analysis
- Service health monitoring
- Environment variable inspection
- Runtime debugging

## Research Agent

The `catalyst-dev` plugin includes a Railway research agent that can investigate deployment issues, analyze logs, and check service configuration.

## Setup

1. Install Railway CLI: `npm install -g @railway/cli`
2. Authenticate: `railway login`
3. Add to secrets config: `~/.config/catalyst/config-{projectKey}.json`

```json
{
  "railway": {
    "token": "...",
    "projectId": "..."
  }
}
```
