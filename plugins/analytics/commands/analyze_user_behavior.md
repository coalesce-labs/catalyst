---
description: Analyze user behavior patterns and cohorts using PostHog
category: analytics
tools: Task, TodoWrite
model: inherit
version: 1.0.0
---

# Analyze User Behavior

Query PostHog to understand user behavior patterns, cohorts, and product usage.

## Prerequisites

- PostHog MCP must be enabled (this plugin should be enabled)
- `POSTHOG_AUTH_HEADER` environment variable configured
- Access to PostHog project

## Usage

```bash
/analyze-user-behavior <query>

Examples:
  /analyze-user-behavior "checkout abandonment last 30 days"
  /analyze-user-behavior "feature adoption for new dashboard"
  /analyze-user-behavior "user retention cohorts by signup month"
```

## What This Command Does

Uses PostHog MCP tools to:

1. Query user events and properties
2. Analyze cohorts and segments
3. Calculate conversion metrics
4. Identify behavior patterns
5. Generate insights with charts/data

## Available PostHog Capabilities

When this plugin is enabled, you have access to ~43 PostHog tools:

**User Analysis**:

- Query user properties and events
- Segment users by behavior
- Track user journeys
- Analyze cohort retention

**Product Metrics**:

- Feature usage tracking
- Conversion funnel analysis
- A/B test results
- Session replay analysis

**Trends & Insights**:

- Event trends over time
- User engagement metrics
- Feature adoption rates
- Custom dashboard queries

## Example Queries

### Conversion Analysis

```bash
/analyze-user-behavior "Show conversion rate from signup to first purchase, broken down by traffic source"
```

### Feature Adoption

```bash
/analyze-user-behavior "How many users adopted the new search feature in the last week?"
```

### Retention Cohorts

```bash
/analyze-user-behavior "Show weekly retention for users who signed up in December 2024"
```

### User Journey

```bash
/analyze-user-behavior "What's the typical path users take before upgrading to paid plan?"
```

## Output Format

The command will:

1. Translate your natural language query to PostHog API calls
2. Fetch relevant data
3. Present findings with:
   - Key metrics and numbers
   - Trends and patterns
   - Visualizations (when possible)
   - Actionable insights

## Tips

- Be specific about time ranges ("last 30 days", "this quarter")
- Mention specific events or features by name
- Ask for comparisons ("vs last month", "broken down by...")
- Request segmentation ("by country", "by plan type")

## Context Cost

**This plugin adds ~40,645 tokens** to your context window. Disable when not analyzing metrics:

```bash
/plugin disable catalyst-analytics
```

---

**See also**: `/product-metrics`, `/segment-analysis`
