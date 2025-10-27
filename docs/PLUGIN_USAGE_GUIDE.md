# Catalyst Plugin Usage Guide

Complete guide to using Catalyst's 4-plugin architecture for session-aware context management.

## Overview

Catalyst now uses a **use case-based** plugin architecture:

1. **catalyst-dev** - Core workflow (always enabled, ~3.5k context)
2. **catalyst-analytics** - Product analytics (enable when needed, +40k context)
3. **catalyst-debugging** - Error monitoring (enable when needed, +20k context)
4. **catalyst-meta** - Workflow discovery (optional)

**Key insight**: Plugins automatically load/unload their bundled MCPs when enabled/disabled.

## Installation

```bash
# One-time setup
/plugin marketplace add coalesce-labs/catalyst

# Install plugins based on your needs
/plugin install catalyst-dev           # Required
/plugin install catalyst-analytics     # If you use PostHog
/plugin install catalyst-debugging     # If you use Sentry
/plugin install catalyst-meta          # If you want workflow discovery
```

## Daily Usage Patterns

### Pattern 1: Regular Development (90% of sessions)

```bash
# Start Claude - only catalyst-dev is enabled
claude

# Work with full workflow
/research-codebase "authentication system"
/create-plan "Add OAuth support"
/implement-plan
/commit
/describe-pr

# Context stays light (~3.5k MCP tokens)
```

**When to use**: Feature development, refactoring, code review, documentation

---

### Pattern 2: Analytics Session

```bash
# Enable analytics
/plugin enable catalyst-analytics

# Now PostHog MCP is available
/analyze-user-behavior "checkout abandonment last 30 days"
/product-metrics "MAU and conversion rates"
/segment-analysis "power users vs casual users"

# Disable when done
/plugin disable catalyst-analytics
```

**When to use**: Planning features based on usage data, analyzing conversion funnels, understanding
user behavior

**Context impact**: +40k tokens while enabled

---

### Pattern 3: Debugging/Incident Response

```bash
# Enable debugging
/plugin enable catalyst-debugging

# Now Sentry MCP is available
/debug-production-error "TypeError in checkout"
/error-impact-analysis "errors from last deployment"
/trace-analysis "slow API requests"

# Disable when incident resolved
/plugin disable catalyst-debugging
```

**When to use**: Production errors, incident response, performance debugging, release health
monitoring

**Context impact**: +20k tokens while enabled

---

### Pattern 4: Combined Analysis

```bash
# Enable both for comprehensive incident analysis
/plugin enable catalyst-debugging catalyst-analytics

# Analyze error AND user impact
> "Show errors in checkout AND how many users abandoned checkout today"

# Compare error-affected users vs normal users
/segment-analysis "users who hit error X vs users who didn't: did they churn?"

# Disable both when done
/plugin disable catalyst-debugging catalyst-analytics
```

**When to use**: Understanding business impact of errors, correlating errors with user behavior

**Context impact**: +60k tokens while enabled

---

## Plugin Management Commands

### Check What's Installed

```bash
/plugin list
```

Shows all installed plugins and their enabled/disabled status.

### Check Context Usage

```bash
/context
```

Shows token breakdown including MCP tools. Use this to verify plugins loaded correctly.

### Enable Plugin

```bash
/plugin enable <plugin-name>

Examples:
/plugin enable catalyst-analytics
/plugin enable catalyst-debugging
/plugin enable catalyst-analytics catalyst-debugging  # Multiple at once
```

### Disable Plugin

```bash
/plugin disable <plugin-name>

Examples:
/plugin disable catalyst-analytics
/plugin disable catalyst-debugging
/plugin disable catalyst-analytics catalyst-debugging  # Multiple at once
```

### Update Plugins

```bash
/plugin marketplace update catalyst
/plugin update catalyst-dev
/plugin update catalyst-analytics
/plugin update catalyst-debugging
```

## Environment Variables

### For Analytics Plugin

Required before enabling:

```bash
# Add to ~/.zshrc or ~/.bashrc
export POSTHOG_AUTH_HEADER="Bearer phx_YOUR_TOKEN"
```

Get your token from PostHog → Project Settings → API Keys

### For Debugging Plugin

Required before enabling:

```bash
# Add to ~/.zshrc or ~/.bashrc
export SENTRY_AUTH_TOKEN="your_token"
export SENTRY_ORG="your-org-slug"
export SENTRY_PROJECT="your-project-slug"
```

Get these from Sentry → Settings → Auth Tokens

## Decision Guide: Which Plugins to Install?

### catalyst-dev (Required)

**Install if**: You're using Catalyst **Why**: Core workflow, research agents, Linear integration

### catalyst-analytics (Optional)

**Install if**:

- You have a PostHog account
- You analyze product metrics
- You make data-driven product decisions
- You run A/B tests

**Skip if**: You don't use PostHog or don't need analytics in your coding workflow

### catalyst-debugging (Optional)

**Install if**:

- You have a Sentry account
- You debug production errors
- You respond to incidents
- You monitor application health

**Skip if**: You don't use Sentry or handle errors differently

### catalyst-meta (Optional)

**Install if**:

- You want to discover community workflows
- You create custom workflows
- You're interested in workflow patterns

**Skip if**: You just want the core development workflow

## Quick Reference

| Task                   | Plugin Needed              | Command                                                |
| ---------------------- | -------------------------- | ------------------------------------------------------ |
| Regular coding         | catalyst-dev (default)     | Just work normally                                     |
| View user metrics      | catalyst-analytics         | `/plugin enable catalyst-analytics`                    |
| Debug production error | catalyst-debugging         | `/plugin enable catalyst-debugging`                    |
| Incident + impact      | Both analytics & debugging | `/plugin enable catalyst-analytics catalyst-debugging` |
| Create custom workflow | catalyst-meta              | Use meta commands                                      |

## Context Budget Management

### Starting Context (catalyst-dev only)

- System prompt: ~2.4k tokens
- System tools: ~13.5k tokens
- **MCP tools: ~3.5k tokens** (DeepWiki + Context7)
- Memory files: ~6.6k tokens
- **Total baseline**: ~26k tokens
- **Available for conversation**: ~174k tokens

### With Analytics Enabled (+catalyst-analytics)

- MCP tools: ~44k tokens (adds PostHog)
- **Available for conversation**: ~134k tokens

### With Debugging Enabled (+catalyst-debugging)

- MCP tools: ~24k tokens (adds Sentry)
- **Available for conversation**: ~154k tokens

### With Both Enabled

- MCP tools: ~64k tokens (PostHog + Sentry + lightweight)
- **Available for conversation**: ~114k tokens

**Strategy**: Keep plugins disabled by default. Enable only when needed for specific tasks. Disable
immediately after to free context.

## Troubleshooting

### "Plugin not found"

```bash
# Make sure marketplace is added
/plugin marketplace add coalesce-labs/catalyst

# Install the plugin
/plugin install catalyst-analytics
```

### "MCP server not available"

- Check plugin is enabled: `/plugin list`
- Enable it: `/plugin enable catalyst-analytics`
- Verify environment variables are set
- Check `/context` to see if MCP loaded

### "High context usage warning"

- This is expected when analytics/debugging plugins are enabled
- Disable plugins you're not using: `/plugin disable catalyst-analytics`
- Check which plugins are enabled: `/plugin list`

### Environment variables not working

```bash
# Verify they're set
echo $POSTHOG_AUTH_HEADER
echo $SENTRY_AUTH_TOKEN

# Make sure to restart shell after adding to ~/.zshrc
source ~/.zshrc
```

## Tips & Best Practices

1. **Start sessions lightweight** - Don't enable analytics/debugging unless you need them
2. **One task at a time** - Enable plugin, do the task, disable plugin
3. **Check context regularly** - Use `/context` to monitor token usage
4. **Combine when relevant** - Enable both plugins for comprehensive incident analysis
5. **Update regularly** - Keep plugins up to date with `/plugin marketplace update catalyst`

## See Also

- `PLUGIN_MIGRATION.md` - Technical details of the plugin architecture
- `plugins/analytics/README.md` - Analytics plugin documentation
- `plugins/debugging/README.md` - Debugging plugin documentation
- `docs/MCP_MANAGEMENT_STRATEGY.md` - Overall MCP strategy
