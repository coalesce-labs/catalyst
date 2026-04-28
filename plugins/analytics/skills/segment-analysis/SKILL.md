---
name: segment-analysis
description: "Analyze user segments, cohorts, and customer groups using PostHog data. Creates retention tables, compares segment behavior, and generates group breakdowns. Use when the user asks about customer segmentation, cohort retention, user group comparison, churn analysis, or funnel analysis by segment."
disable-model-invocation: true
allowed-tools: Task, TodoWrite
version: 1.0.0
---

# Segment Analysis

Deep-dive into specific user segments, cohorts, or customer groups using PostHog data.

## Usage

```bash
/segment-analysis <segment-description>

Examples:
  /segment-analysis "users from paid plans vs free plans"
  /segment-analysis "power users who use feature X daily"
  /segment-analysis "users who churned in last 30 days"
  /segment-analysis "cohort: signed up in Q4 2024"
```

## Workflow

1. **Define segments** — Identify segment criteria using PostHog properties (plan type, behavior, signup date, or any custom event property)
2. **Query PostHog** — Retrieve segment data via PostHog MCP tools or HogQL queries
3. **Compute metrics** — Calculate retention, conversion, engagement, and LTV per segment
4. **Compare segments** — Generate side-by-side comparisons with statistical significance
5. **Present findings** — Deliver segment profiles, key differences, and actionable recommendations

## Example Analyses

### Plan Comparison

```bash
/segment-analysis "Compare engagement patterns between free and paid users: session frequency, feature usage, retention"
```

### Power User Identification

```bash
/segment-analysis "Identify our power users: who are they, what features do they use, what's their profile?"
```

### Churn Analysis

```bash
/segment-analysis "Analyze users who churned: what were their last actions, which features didn't they use?"
```

### Geographic Performance

```bash
/segment-analysis "Compare conversion rates and engagement across our top 5 countries"
```

### Cohort Retention

```bash
/segment-analysis "Show retention curves for each monthly signup cohort in 2024"
```

## Output Format

Analysis typically includes:

- **Segment characteristics** (size, demographics, behavior)
- **Key metrics** for each segment
- **Comparative insights** between segments
- **Behavior patterns** unique to segment
- **Recommendations** for targeting or improvement

## Advanced Analysis

### Multi-dimensional Segmentation

```bash
/segment-analysis "Power users (5+ sessions/week) from enterprise plans who use feature X"
```

### Funnel by Segment

```bash
/segment-analysis "Compare signup to activation funnel for organic vs paid traffic"
```

### Retention by Segment

```bash
/segment-analysis "30-day retention by initial feature used"
```

## Context Cost

Plugin uses ~40k tokens. Disable when analysis is complete:

```bash
/plugin disable catalyst-analytics
```

---

**See also**: `/catalyst-analytics:analyze-user-behavior`, `/catalyst-analytics:product-metrics`
