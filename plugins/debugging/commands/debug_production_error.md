---
description: Debug production errors using Sentry error tracking and analysis
category: debugging
tools: Task, TodoWrite
model: inherit
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

1. Search for relevant errors
2. Retrieve stack traces and context
3. Analyze error patterns and frequency
4. Identify affected users and environments
5. Suggest root causes and fixes

## Available Sentry Capabilities

When this plugin is enabled, you have access to ~19 Sentry tools:

**Error Search & Analysis**:

- Search issues by query
- Filter by status, assignment, date
- View error trends and patterns
- Identify new vs recurring errors

**Stack Trace Analysis**:

- Full stack traces with source context
- Source map resolution
- Frame-by-frame analysis
- Variable inspection

**Context & Metadata**:

- User context (who was affected)
- Environment details
- Release/deployment information
- Breadcrumb trail (user actions leading to error)

**Issue Management**:

- Update issue status
- Assign to team members
- Link to tickets/PRs
- Add comments and notes

**Root Cause Analysis** (Seer AI):

- AI-powered root cause identification
- Code-level explanations
- Specific fix recommendations
- Related error patterns

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

## Output Format

Analysis typically includes:

**Error Overview**:

- Error message and type
- Frequency and trend
- First seen / last seen
- Number of users affected

**Stack Trace**:

- Full call stack
- Source code context
- File paths and line numbers
- Variable values (if available)

**User Context**:

- User ID and properties
- Browser/device information
- URL and user actions (breadcrumbs)

**Root Cause** (when Seer analysis available):

- Likely cause explanation
- Relevant code snippets
- Specific fix recommendations
- Related issues

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
/create-plan "Fix the TypeError in checkout.ts based on Sentry analysis"
```

## Context Cost

**This plugin adds ~20,670 tokens** to your context window. Disable when debugging is complete:

```bash
/plugin disable catalyst-debugging
```

---

**See also**: `/error-impact-analysis`, `/trace-analysis`
