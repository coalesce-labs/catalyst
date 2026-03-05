---
title: PostHog
description: PostHog integration for product analytics and user behavior analysis.
---

Catalyst integrates with PostHog via the `catalyst-analytics` plugin MCP for user behavior analysis, conversion funnels, and cohort analysis.

## Context Cost

**~40K tokens** when enabled. Enable only when analyzing user behavior:

```bash
/plugin enable catalyst-analytics    # +40K context
# Analyze user data...
/plugin disable catalyst-analytics   # -40K context
```

## Commands

| Command | Description |
|---------|-------------|
| `/analytics:analyze-user-behavior` | Analyze user behavior patterns and cohorts |
| `/analytics:segment-analysis` | Segment and cohort analysis for targeted insights |
| `/analytics:product-metrics` | Key product metrics, KPIs, and conversion rates |

## Setup

1. Get a PostHog API key from your project settings
2. Add to secrets config: `~/.config/catalyst/config-{projectKey}.json`

```json
{
  "catalyst": {
    "posthog": {
      "apiKey": "phc_...",
      "projectId": "12345"
    }
  }
}
```

## Installation

```bash
/plugin install catalyst-analytics
```
