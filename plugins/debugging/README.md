# Catalyst Debugging Plugin

Production error monitoring and debugging powered by Sentry MCP integration.

## What This Plugin Provides

**Sentry MCP Integration**: ~20,670 tokens, 19 tools for comprehensive error monitoring

**Commands**:

- `/debug-production-error` - Investigate errors with stack traces
- `/error-impact-analysis` - Assess error severity and scope
- `/trace-analysis` - Distributed tracing and performance debugging

## When to Enable This Plugin

Enable `catalyst-debugging` when you need to:

- ✅ Debug production errors and exceptions
- ✅ Investigate error spikes or incidents
- ✅ Analyze stack traces and user context
- ✅ Assess error impact on users
- ✅ Trace performance bottlenecks
- ✅ Root cause analysis with Seer AI

Disable when you're doing regular development work to save ~20k tokens of context.

## Installation

```bash
# Install from marketplace
/plugin install catalyst-debugging@catalyst

# Enable for current session
/plugin enable catalyst-debugging

# Disable when done
/plugin disable catalyst-debugging
```

## Prerequisites

### Environment Variables

Set your Sentry configuration:

```bash
# Add to ~/.zshrc or ~/.bashrc
export SENTRY_AUTH_TOKEN="your_auth_token_here"
export SENTRY_ORG="your-org-slug"
export SENTRY_PROJECT="your-project-slug"
```

To get these values:

1. Log into Sentry
2. Go to Settings → Auth Tokens
3. Create a token with `project:read` and `event:read` permissions
4. Note your organization and project slugs from URLs

### Sentry Access

- Must have access to a Sentry project
- Recommended: Member or Admin role for full error access

## Usage Examples

### Debug Specific Error

```bash
# Enable plugin
/plugin enable catalyst-debugging

# Investigate error
/catalyst-dev:debug-production-error "MYAPP-456"

# View stack trace and context
> "Show me the full stack trace and user actions that led to this error"

# Get fix recommendations
> "Use Seer to analyze root cause and suggest fixes"

# Disable when done
/plugin disable catalyst-debugging
```

### Assess Error Impact

```bash
/plugin enable catalyst-debugging

/error-impact-analysis "payment gateway errors last 7 days"

/plugin disable catalyst-debugging
```

### Performance Investigation

```bash
/plugin enable catalyst-debugging

/trace-analysis "slow API requests in checkout service"

/plugin disable catalyst-debugging
```

### Combined with Analytics

Enable both plugins for comprehensive incident analysis:

```bash
/plugin enable catalyst-debugging
/plugin enable catalyst-analytics

# Analyze error impact on user behavior
> "How many users who hit error X today went on to complete checkout vs abandon?"

/plugin disable catalyst-debugging catalyst-analytics
```

## Context Management

**Context cost**: ~20,670 tokens (~10% of 200k window)

**Best practice**: Enable only during incidents/debugging, disable immediately after.

**Check context usage**:

```bash
/context  # Shows MCP token breakdown
```

## Available Sentry Tools

When enabled, this plugin provides access to:

**Error Tracking**:

- Search and filter issues
- View error details and stack traces
- Get issue statistics and trends
- Find recent errors and spikes

**Root Cause Analysis**:

- Seer AI-powered analysis
- Code-level explanations
- Specific fix recommendations
- Pattern identification

**Context & Metadata**:

- User information and context
- Breadcrumb trails (user actions)
- Environment and release data
- Device and browser details

**Issue Management**:

- Update issue status (resolve, ignore)
- Assign to team members
- Add comments and notes
- Link to external tickets

**Performance Monitoring**:

- Distributed trace analysis
- Transaction performance
- Span breakdown and timing
- Bottleneck identification

**Release Health**:

- Compare error rates across releases
- Identify regressions
- Track deployment impact
- Monitor release stability

## Tips

1. **Start with searches** - Use natural language queries to find relevant errors
2. **Check recent errors first** - "last hour" or "last 24 hours" for incidents
3. **Use Seer for complex issues** - AI analysis provides code-level fixes
4. **Enable analytics too** - Understand user impact of errors
5. **Update issue status** - Mark errors as resolved after fixing

## Troubleshooting

### "Sentry MCP not available"

- Plugin may not be enabled: `/plugin enable catalyst-debugging`
- Check environment variables: `echo $SENTRY_AUTH_TOKEN`
- Verify token permissions include `project:read` and `event:read`

### "Organization/Project not found"

- Check `SENTRY_ORG` matches your organization slug (from Sentry URL)
- Check `SENTRY_PROJECT` matches your project slug
- Ensure you have access to the project

### "Insufficient permissions"

- Auth token needs appropriate scopes
- Check user role in Sentry project
- Regenerate token with correct permissions

### High context usage warning

- This is expected (~20k tokens)
- Disable plugin when not debugging: `/plugin disable catalyst-debugging`
- Check `/context` to see breakdown

## Related Plugins

- **catalyst-dev** - Core development workflow (always enabled)
- **catalyst-analytics** - PostHog product analytics (enable for user impact analysis)
- **catalyst-meta** - Workflow discovery and creation

## Version

1.0.0

## License

MIT

## Support

Issues: https://github.com/coalesce-labs/catalyst/issues Docs:
https://github.com/coalesce-labs/catalyst
