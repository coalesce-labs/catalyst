---
description: Analyze user segments and cohorts for targeted insights
category: analytics
tools: Task, TodoWrite
model: inherit
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

## What This Analyzes

### User Segments

- By plan type (free, pro, enterprise)
- By geography (country, region)
- By acquisition source (organic, paid, referral)
- By behavior (power users, casual users, at-risk)

### Cohort Analysis

- By signup date (monthly, weekly cohorts)
- By first feature used
- By activation milestone reached
- By engagement level

### Comparison Analysis

- Segment A vs Segment B
- Before/after feature launch
- Treatment vs control (A/B tests)
- Time period comparisons

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

## Segmentation Criteria

You can segment by:

- **Demographics**: Country, language, device type
- **Behavior**: Feature usage, session frequency, engagement score
- **Business**: Plan type, payment history, LTV
- **Temporal**: Signup date, last active, tenure
- **Custom**: Any event or property in PostHog

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

## Tips for Better Analysis

1. **Be specific** - Define your segment clearly
2. **Ask for comparisons** - "vs" between segments reveals insights
3. **Look for patterns** - What makes segments different?
4. **Consider time** - Trends over time matter
5. **Combine criteria** - Multi-dimensional segments can be revealing

## Context Cost

Plugin uses ~40k tokens. Disable when analysis is complete:

```bash
/plugin disable catalyst-analytics
```

---

**See also**: `/analyze-user-behavior`, `/product-metrics`
