# Catalyst Analytics Plugin

Product analytics and user behavior analysis powered by PostHog MCP integration.

## What This Plugin Provides

**PostHog MCP Integration**: ~40,645 tokens, 43 tools for comprehensive product analytics

**Commands**:

- `/analyze-user-behavior` - User behavior patterns and cohorts
- `/product-metrics` - Key metrics, KPIs, and dashboards
- `/segment-analysis` - Deep-dive into user segments

## When to Enable This Plugin

Enable `catalyst-analytics` when you need to:

- ✅ Analyze user behavior and conversion funnels
- ✅ View product metrics and KPIs
- ✅ Compare user segments or cohorts
- ✅ Understand feature adoption
- ✅ Make data-driven product decisions

Disable when you're doing regular development work to save ~40k tokens of context.

## Installation

```bash
# Install from marketplace
/plugin install catalyst-analytics@catalyst

# Enable for current session
/plugin enable catalyst-analytics

# Disable when done
/plugin disable catalyst-analytics
```

## Prerequisites

### Environment Variable

Set your PostHog authentication header:

```bash
# Add to ~/.zshrc or ~/.bashrc
export POSTHOG_AUTH_HEADER="Bearer phx_YOUR_TOKEN_HERE"
```

To get your token:

1. Log into PostHog
2. Go to Project Settings → API Keys
3. Create or copy a Personal API Key
4. Use format: `Bearer phx_...`

### PostHog Access

- Must have access to a PostHog project
- Recommended: Admin or Analyst role for full query capabilities

## Usage Examples

### View Key Metrics

```bash
# Enable plugin
/plugin enable catalyst-analytics

# Query metrics
/product-metrics "Show MAU, conversion rates, and retention for last 30 days"

# Disable when done
/plugin disable catalyst-analytics
```

### Analyze User Segments

```bash
/plugin enable catalyst-analytics

/segment-analysis "Compare engagement between free and paid users"

/plugin disable catalyst-analytics
```

### Investigate Behavior Patterns

```bash
/plugin enable catalyst-analytics

/analyze-user-behavior "What's causing checkout abandonment?"

/plugin disable catalyst-analytics
```

## Context Management

**Context cost**: ~40,645 tokens (~20% of 200k window)

**Best practice**: Enable only when analyzing metrics, disable immediately after.

**Check context usage**:

```bash
/context  # Shows MCP token breakdown
```

## Available PostHog Tools

When enabled, this plugin provides access to:

**User Analytics**:

- Query user properties and events
- Cohort analysis
- User journey tracking
- Segment identification

**Product Metrics**:

- Event trends
- Conversion funnels
- A/B test results
- Feature flags

**Engagement Analysis**:

- Session analysis
- Retention curves
- Feature usage
- Power user identification

**Advanced Features**:

- Custom dashboards
- Insight queries
- Trend analysis
- Correlation detection

## Tips

1. **Be specific with queries** - Include time ranges and specific metrics
2. **Use natural language** - Commands translate to PostHog API calls
3. **Ask for comparisons** - "vs last month" or "by traffic source"
4. **Combine with other plugins** - Can enable alongside catalyst-debugging for error impact
   analysis

## Troubleshooting

### "PostHog MCP not available"

- Plugin may not be enabled: `/plugin enable catalyst-analytics`
- Check environment variable is set: `echo $POSTHOG_AUTH_HEADER`
- Verify token format: `Bearer phx_...`

### "Authentication failed"

- Token may be expired or invalid
- Check PostHog project access
- Regenerate Personal API Key in PostHog

### High context usage warning

- This is expected (~40k tokens)
- Disable plugin when not analyzing: `/plugin disable catalyst-analytics`
- Check `/context` to see breakdown

## Related Plugins

- **catalyst-dev** - Core development workflow (always enabled)
- **catalyst-debugging** - Sentry error monitoring (enable for debugging)
- **catalyst-meta** - Workflow discovery and creation

## Version

1.0.0

## License

MIT

## Support

Issues: https://github.com/coalesce-labs/catalyst/issues Docs:
https://github.com/coalesce-labs/catalyst
