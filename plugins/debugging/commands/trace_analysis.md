---
description: Analyze distributed traces and performance issues with Sentry
category: debugging
tools: Task, TodoWrite
model: inherit
version: 1.0.0
---

# Trace Analysis

Investigate distributed traces, transaction performance, and slow requests using Sentry.

## Usage

```bash
/trace-analysis <trace-id-or-query>

Examples:
  /trace-analysis "a4d1aae7216b47ff8117cf4e09ce9d0a"
  /trace-analysis "slow API requests to /checkout"
  /trace-analysis "traces with >5 second response time"
  /trace-analysis "performance issues in payment service"
```

## What This Analyzes

### Trace Components

- Transaction spans (API calls, DB queries, external services)
- Timing breakdown per span
- Parent-child span relationships
- Span operations and descriptions

### Performance Metrics

- Total transaction duration
- Time spent in each service
- Database query performance
- External API latency
- Network overhead

### Bottleneck Identification

- Slowest spans in trace
- Sequential vs parallel operations
- N+1 query detection
- Inefficient operations

## Example Analyses

### Specific Trace Investigation

```bash
/trace-analysis "Analyze trace abc123def456: where's the bottleneck?"
```

### Performance Pattern

```bash
/trace-analysis "Why are checkout API requests slow today?"
```

### Service Comparison

```bash
/trace-analysis "Compare performance of payment service vs order service"
```

### Database Performance

```bash
/trace-analysis "Find traces with slow database queries in user service"
```

## Output Format

Analysis includes:

**Trace Overview**:

- Transaction name and operation
- Total duration
- Timestamp
- Environment and release

**Span Breakdown**:

```
Transaction: POST /api/checkout (2.4s)
├─ Authentication (45ms)
├─ Database Query: SELECT users (120ms)
├─ External API: Payment Gateway (1.8s) ⚠️ SLOW
├─ Database Query: INSERT orders (230ms)
└─ Email Service (180ms)
```

**Performance Insights**:

- Slowest operations
- Time distribution (pie chart/percentages)
- Parallel vs sequential execution
- Optimization opportunities

**Recommendations**:

- Cache frequently accessed data
- Optimize specific queries
- Implement async processing
- Add timeouts for external calls

## Advanced Analysis

### Multi-Trace Patterns

```bash
/trace-analysis "Find common bottlenecks across all slow checkout traces today"
```

### Service Dependencies

```bash
/trace-analysis "Map service call chain for failed transactions"
```

### Error Correlation

```bash
/trace-analysis "Traces that resulted in errors: what went wrong before?"
```

## Integration Opportunities

### With Error Debugging

```bash
# Enable debugging plugin (if not already)
/plugin enable catalyst-debugging

# Combine trace and error analysis
> "Show me the trace for the transaction that caused error ISSUE-456"
```

### With Code Changes

After identifying bottleneck:

```bash
/create-plan "Optimize the slow payment gateway call identified in trace analysis"
```

## Performance Optimization Workflow

### 1. Identify Slow Transactions

```bash
/trace-analysis "transactions with >2s response time in last hour"
```

### 2. Analyze Bottlenecks

```bash
> "Drill into the slowest trace: which span is the problem?"
```

### 3. Root Cause

```bash
> "Why is the database query taking 800ms?"
```

### 4. Implement Fix

```bash
/create-plan "Add database index for user lookups based on trace analysis"
```

### 5. Verify Improvement

```bash
> "After deploy, compare trace durations before and after"
```

## Tips

1. **Start with aggregates** - "slow checkouts" before diving into specific traces
2. **Look for patterns** - One slow trace might be an outlier, many indicate systemic issue
3. **Check external dependencies** - Third-party APIs often cause slowdowns
4. **Consider concurrency** - Sequential operations that could be parallel
5. **Database queries** - N+1 queries, missing indexes, inefficient queries

## Context Cost

Plugin uses ~20k tokens. Disable after analysis:

```bash
/plugin disable catalyst-debugging
```

---

**See also**: `/debug-production-error`, `/error-impact-analysis`
