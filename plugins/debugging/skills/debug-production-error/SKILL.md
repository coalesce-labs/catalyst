---
name: debug-production-error
description: "Debug production errors using Sentry MCP tools. Searches issues, analyzes stack traces, identifies root causes, and suggests fixes. Use when the user mentions a Sentry error, production exception, stack trace, error monitoring, crash report, or unhandled exception."
disable-model-invocation: true
allowed-tools: Task, TodoWrite
version: 1.0.0
---

# Debug Production Error

Investigate production errors using Sentry's error tracking, stack traces, and context.

## Prerequisites

- Sentry MCP must be enabled (this plugin should be enabled)
- Environment variables configured:
  - `SENTRY_AUTH_TOKEN`
  - `SENTRY_ORG`
  - `SENTRY_PROJECT`

## Usage

```bash
/debug-production-error <error-description-or-id>

Examples:
  /debug-production-error "TypeError in checkout flow"
  /debug-production-error "ISSUE-123"
  /debug-production-error "errors from last deployment"
  /debug-production-error "unhandled exceptions this week"
```

## What This Command Does

Uses Sentry MCP tools to:

1. **Search** — Find matching issues via `sentry_search_issues` filtered by query, status, or date range
2. **Retrieve** — Pull stack traces, breadcrumbs, and user context via `sentry_get_issue_details`
3. **Analyze** — Examine error patterns, frequency, and affected releases
4. **Diagnose** — Use Seer AI root cause analysis when available; fall back to manual stack trace analysis
5. **Recommend** — Suggest specific code fixes with file paths and line numbers

**Checkpoints:** If no issues match the query, broaden search terms or check the project/environment filter. If Seer analysis is unavailable, proceed with manual analysis.

## Example Debugging Sessions

### Investigate Specific Error

```bash
/debug-production-error "Show me details for MYAPP-456 including stack trace and user context"
```

### Search by Error Type

```bash
/debug-production-error "Find all TypeError exceptions in the last 24 hours"
```

### Deployment Issues

```bash
/debug-production-error "What new errors appeared after release v2.3.0?"
```

### High-Impact Errors

```bash
/debug-production-error "Show unresolved errors affecting more than 100 users"
```

## Advanced Queries

### Filter by Environment

```bash
/debug-production-error "production errors in payment service"
```

### Time-Based Analysis

```bash
/debug-production-error "spike in errors between 2pm-3pm today"
```

### User-Specific

```bash
/debug-production-error "errors for user@example.com"
```

### Integration with Analytics

If you have both plugins enabled:

```bash
# Enable both
/plugin enable catalyst-debugging
/plugin enable catalyst-analytics

# Combined analysis
> "Show me errors in checkout AND how many users abandoned checkout today"
```

## Workflow Integration

### With Issue Tracking

After identifying root cause:

```bash
> "Create a GitHub issue for this error with the stack trace and fix recommendations"
```

### With Code Changes

After finding the bug:

```bash
/catalyst-dev:create-plan "Fix the TypeError in checkout.ts based on Sentry analysis"
```

## Context Cost

**This plugin adds ~20,670 tokens** to your context window. Disable when debugging is complete:

```bash
/plugin disable catalyst-debugging
```

---

**See also**: `/catalyst-debugging:error-impact-analysis`, `/catalyst-debugging:trace-analysis`
