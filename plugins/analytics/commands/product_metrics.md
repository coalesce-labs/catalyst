---
description: View key product metrics, KPIs, and conversion rates from PostHog
category: analytics
tools: Task, TodoWrite
model: inherit
version: 1.0.0
---

# Product Metrics Dashboard

Query PostHog for key product metrics, KPIs, and performance indicators.

## Usage

```bash
/product-metrics [metric-type] [time-range]

Examples:
  /product-metrics "overall KPIs last 30 days"
  /product-metrics "conversion rates this quarter"
  /product-metrics "feature usage breakdown this week"
```

## Available Metrics

### Conversion Metrics

- Signup conversion rate
- Trial to paid conversion
- Checkout completion rate
- Feature activation rate

### Engagement Metrics

- Daily/Weekly/Monthly Active Users (DAU/WAU/MAU)
- Session duration
- Feature usage frequency
- User retention rates

### Business Metrics

- Revenue per user
- Customer acquisition cost
- Lifetime value
- Churn rate

### Feature Metrics

- Feature adoption rate
- Time to first use
- Feature retention
- Power user identification

## Example Queries

### Overall Dashboard

```bash
/product-metrics "Show me our key metrics for last month: MAU, conversion rates, and top features"
```

### Conversion Funnel

```bash
/product-metrics "Breakdown of our signup to paid funnel with drop-off rates at each step"
```

### Feature Performance

```bash
/product-metrics "Compare usage of our top 5 features over the last quarter"
```

### Cohort Performance

```bash
/product-metrics "How do our December signups compare to November in terms of activation and retention?"
```

## Output Format

Results typically include:

- **Metric values** with trend indicators (↑↓)
- **Comparisons** to previous periods
- **Breakdowns** by segment when relevant
- **Top performers** and bottom performers
- **Recommendations** based on data

## Time Range Options

- `today`, `yesterday`
- `last 7 days`, `last 30 days`, `last 90 days`
- `this week`, `last week`
- `this month`, `last month`, `this quarter`
- Custom: `2024-01-01 to 2024-03-31`

## Segmentation

Add segmentation to any query:

```bash
/product-metrics "MAU by country"
/product-metrics "conversion rates by traffic source"
/product-metrics "feature usage by plan type"
```

## Context Management

This plugin consumes ~40k tokens. Disable after viewing metrics:

```bash
/plugin disable catalyst-analytics
```

---

**See also**: `/analyze-user-behavior`, `/segment-analysis`
