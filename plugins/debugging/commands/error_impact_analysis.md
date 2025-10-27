---
description: Analyze the impact and scope of production errors
category: debugging
tools: Task, TodoWrite
model: inherit
version: 1.0.0
---

# Error Impact Analysis

Assess the severity, reach, and business impact of production errors.

## Usage

```bash
/error-impact-analysis <error-or-timeframe>

Examples:
  /error-impact-analysis "ISSUE-789"
  /error-impact-analysis "checkout errors last 7 days"
  /error-impact-analysis "critical errors this week"
  /error-impact-analysis "impact of recent deployment"
```

## What This Analyzes

### Quantitative Impact

- Number of occurrences
- Number of users affected
- Error rate over time
- Affected environments/releases

### Qualitative Impact

- Error severity (critical, high, medium, low)
- Affected user workflows
- Business function impact (checkout, signup, etc.)
- User experience degradation

### Trend Analysis

- Is it increasing or decreasing?
- When did it start?
- Related to specific release?
- Correlation with traffic/usage

## Example Analyses

### Single Issue Impact

```bash
/error-impact-analysis "What's the impact of MYAPP-123? How many users, revenue impact?"
```

### Category Impact

```bash
/error-impact-analysis "Overall impact of all payment-related errors this month"
```

### Release Health

```bash
/error-impact-analysis "Error impact comparison: current release vs previous release"
```

### Critical Errors

```bash
/error-impact-analysis "Show all critical errors and their combined user impact"
```

## Output Format

Analysis includes:

**Scope**:

- Total occurrences
- Unique users affected
- Affected countries/regions
- Browser/device breakdown

**Severity Assessment**:

- Error frequency
- User impact score
- Business criticality
- Blocking vs non-blocking

**Trends**:

- Occurrence over time (chart/data)
- Peak times
- Growth rate
- Comparison to baseline

**Business Impact**:

- Affected revenue-generating flows
- Customer support tickets related
- SLA implications
- Reputation risk

**Prioritization**:

- Recommendation on urgency
- Comparison with other errors
- ROI of fixing

## Integration with Analytics

Enable both plugins for deeper impact analysis:

```bash
/plugin enable catalyst-debugging
/plugin enable catalyst-analytics

/error-impact-analysis "How many users who hit error X churned vs users who didn't?"
```

This combines:

- Sentry error data (who hit the error)
- PostHog behavior data (did they churn)

## Incident Response Workflow

### 1. Assess Impact

```bash
/error-impact-analysis "new spike in errors at 3pm"
```

### 2. Determine Severity

Based on output:

- **Critical**: >1000 users, blocking checkout/signup
- **High**: >100 users, degraded experience
- **Medium**: <100 users, minor inconvenience
- **Low**: <10 users, edge case

### 3. Prioritize Response

```bash
> "Based on this impact, should we rollback or hotfix?"
```

### 4. Track Resolution

```bash
> "After fix, compare error rates before and after"
```

## Tips for Impact Analysis

1. **Consider timeframe** - "last hour" for incidents, "last week" for trends
2. **Segment users** - Impact on paid vs free users may differ
3. **Check related errors** - One root cause may affect multiple error types
4. **Compare releases** - Pinpoint when impact started
5. **Business context** - Impact during peak hours is more severe

## Context Cost

Plugin uses ~20k tokens. Disable after analysis:

```bash
/plugin disable catalyst-debugging
```

---

**See also**: `/debug-production-error`, `/trace-analysis`
