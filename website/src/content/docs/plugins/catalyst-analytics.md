---
title: catalyst-analytics
description: Product analytics plugin via PostHog MCP integration.
---

PostHog integration for user behavior analysis, conversion funnels, and cohort analysis.

## Context Cost

**~40K tokens** when enabled. Enable only when analyzing user behavior, then disable to free context.

```bash
/plugin enable catalyst-analytics    # +40K context
# Do your analysis work...
/plugin disable catalyst-analytics   # -40K context
```

## Skills

| Skill | Description |
|-------|-------------|
| `/catalyst-analytics:analyze_user_behavior` | User behavior patterns and cohorts |
| `/catalyst-analytics:segment_analysis` | User segment analysis for targeted insights |
| `/catalyst-analytics:product_metrics` | Key product metrics and conversion rates |

## Prerequisites

- PostHog account with API access
- API key configured in `~/.config/catalyst/config-{projectKey}.json`

## Installation

```bash
/plugin install catalyst-analytics
```
