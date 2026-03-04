---
title: Best Practices
description: Proven patterns for effective AI-assisted development with Catalyst.
---

These best practices are derived from Anthropic's context engineering principles and tested across real-world projects.

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

### No Open Questions in Final Plans

Resolve all decisions during planning, not during implementation:

```markdown
<!-- Bad -->
- Use Redis or maybe in-memory? Need to decide.

<!-- Good -->
- Use Redis (multi-instance deployment requires shared state)
```

### Explicit Scope Control

```markdown
## What We're NOT Doing

- Not implementing per-endpoint rate limits (global only)
- Not adding a configuration UI (code config only)
- Not handling distributed rate limiting across regions
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

## Agent Usage

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
# Parallel (3x faster)
@catalyst-dev:codebase-locator find payment files
@catalyst-dev:thoughts-locator search payment research
@catalyst-dev:codebase-pattern-finder show payment patterns
```

### Follow Existing Patterns

Always check the codebase for existing implementations before creating new ones. Use `codebase-pattern-finder` to discover established conventions.

## Anti-Patterns to Avoid

| Anti-Pattern | Why It's Bad | Better Approach |
|-------------|-------------|-----------------|
| Loading entire codebase upfront | Wastes context, includes irrelevant files | Progressive discovery with agents |
| Monolithic research requests | No parallelization, unclear scope | Parallel focused agents |
| Vague success criteria | Can't verify completion | Separated automated/manual checks |
| Implementing without planning | Misses existing patterns, duplicates code | Research → plan → implement |
| Losing context between sessions | Must re-research everything | Persist to thoughts system |
| Scope creep in plans | Never finishes, delays delivery | Explicit "what we're NOT doing" |

## Thoughts System

### When to Create Documents

- **New plan**: Starting a feature, refactoring, or complex bug fix
- **Research doc**: Evaluating options, investigating patterns, documenting decisions
- **Append to existing**: Updating based on new findings or progress

### Naming Conventions

```
Research:  YYYY-MM-DD-PROJ-XXXX-description.md
Plans:     YYYY-MM-DD-PROJ-XXXX-description.md
Handoffs:  YYYY-MM-DD_HH-MM-SS_description.md
PRs:       pr_{number}_{description}.md
```

### Sync Regularly

Run `humanlayer thoughts sync` after creating or updating plans, completing research, finishing implementation, and making architectural decisions.
