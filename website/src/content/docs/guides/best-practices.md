---
title: Best Practices
description: Proven patterns for effective AI-assisted development with Catalyst.
---

## Context Management

Context is the most important resource in AI-assisted development. Treat it like CPU cache — load only what's needed, when it's needed.

**The 40-60% rule** — Keep context utilization between 40-60% of the window. Check with `/context`. Clear context between workflow phases (research → plan → implement), when context reaches 60%, or when the AI starts repeating errors.

**Warning signs of context pressure:**
- AI repeating information you already discussed
- Forgetting earlier decisions
- Responses becoming less specific
- Missing file:line references

**What to do:** Create a handoff, start a fresh session, or phase the work using plan checkboxes.

### Why Subagents Matter

Subagents aren't just for speed — they're a context management strategy. Each agent gets its own context window, works its specific task, and returns only a summary. Three agents running in parallel use far less main context than doing the same work in a single session.

```
Main context: 30K tokens
Spawn 3 agents (each isolated):
  Locator:  25K tokens → returns 1K summary
  Analyzer: 20K tokens → returns 2K summary
  Patterns: 15K tokens → returns 3K summary

Main context after: 36K tokens
vs doing everything inline: 90K tokens
```

## Planning

### Always Include in Plans

1. **Overview** — What and why
2. **Current state analysis** — What exists now
3. **Desired end state** — Clear success definition
4. **What we're NOT doing** — Explicit scope control
5. **Phases** — Logical, incremental steps
6. **Success criteria** — Separated into automated and manual

### Separate Automated vs Manual Verification

**Automated** — Can be run by agents, deterministic pass/fail:

```markdown
#### Automated Verification
- [ ] Unit tests pass: `make test-unit`
- [ ] Type checking: `npm run typecheck`
- [ ] API returns 429: `curl -X POST http://localhost:8080/api/test`
```

**Manual** — Requires human testing, subjective assessment:

```markdown
#### Manual Verification
- [ ] Error message is user-friendly
- [ ] Performance acceptable with 10,000 requests
- [ ] Mobile app handles 429 gracefully
```

### Resolve Decisions During Planning

No open questions in final plans. Resolve everything before implementation:

```markdown
<!-- Bad -->
- Use Redis or maybe in-memory? Need to decide.

<!-- Good -->
- Use Redis (multi-instance deployment requires shared state)
```

## Implementation

### Follow the Plan's Intent

Plans are guides, not rigid scripts. When reality differs:

- File moved? Adapt to the new location.
- Better pattern found? Use it, document the deviation.
- Core approach invalid? Stop and ask before proceeding.

### Verify Incrementally

Don't wait until the end to verify:

```
Phase 1: Implement → Run tests → Fix issues → Mark complete
Phase 2: Implement → Run tests → Fix issues → Mark complete
```

### Update Progress as You Go

Use plan checkboxes to track completion. This enables resumption from any point and eliminates re-verification.

## Working with Agents

### Be Specific in Requests

```
# Good
@catalyst-dev:codebase-analyzer trace how a webhook request flows
  from receipt to database storage

# Bad
@catalyst-dev:codebase-analyzer look at webhooks
```

### Use Parallel Agents for Independent Research

```
# Parallel (3x faster, better context efficiency)
@catalyst-dev:codebase-locator find payment files
@catalyst-dev:thoughts-locator search payment research
@catalyst-dev:codebase-pattern-finder show payment patterns
```

### Follow Existing Patterns

Always check the codebase for existing implementations before creating new ones. Use `codebase-pattern-finder` to discover established conventions.

## Anti-Patterns

| Anti-Pattern | Better Approach |
|-------------|-----------------|
| Loading entire codebase upfront | Progressive discovery with agents |
| Monolithic research requests | Parallel focused agents |
| Vague success criteria | Separated automated/manual checks |
| Implementing without planning | Research → plan → implement |
| Losing context between sessions | Persist to thoughts, use handoffs |
| Scope creep in plans | Explicit "what we're NOT doing" |
