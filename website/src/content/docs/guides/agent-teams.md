---
title: Agent Teams
description: Multi-agent collaboration for complex implementations spanning multiple domains.
---

Agent teams enable multiple Claude Code instances to work in parallel on a shared codebase. This is useful for complex implementations that span distinct domains like frontend, backend, and tests.

## When to Use Agent Teams

| Scenario | Subagents | Agent Teams |
|----------|-----------|-------------|
| Parallel research gathering | Best fit | Overkill |
| Code analysis / file search | Best fit | Overkill |
| Complex multi-file implementation | Can't nest | Best fit |
| Cross-layer features (frontend + backend + tests) | Limited | Best fit |
| Cost-sensitive operations | Best fit | Too expensive |

Use agent teams when:

- The plan has phases that can be implemented in parallel
- Changes span distinct domains
- Each domain's changes don't overlap in files
- The total scope is 10+ files across 3+ domains

## Team Structure

```
Lead (Opus) — Coordinates implementation
├── Teammate 1 (Sonnet) — Frontend changes
│   ├── Subagent: codebase-locator (Haiku)
│   └── Subagent: codebase-analyzer (Sonnet)
├── Teammate 2 (Sonnet) — Backend changes
│   ├── Subagent: codebase-locator (Haiku)
│   └── Subagent: external-research (Sonnet)
└── Teammate 3 (Sonnet) — Test changes
    └── Subagent: codebase-pattern-finder (Sonnet)
```

Each teammate is a full Claude Code session that can spawn its own subagents — this is **two-level parallelism** that subagents alone cannot achieve.

## Using Agent Teams

```
/catalyst-dev:implement_plan --team thoughts/shared/plans/my-plan.md
/catalyst-dev:oneshot --team PROJ-123
```

The lead agent:

1. Analyzes plan phases to identify parallelizable work
2. Assigns distinct file ownership to each teammate
3. Creates a task list with dependencies
4. Launches teammates with focused instructions
5. Reviews teammate work before proceeding
6. Verifies all changes integrate correctly

## Best Practices

1. **Lead on Opus, teammates on Sonnet** — the lead needs complex coordination skills
2. **Size tasks at 5-6 per teammate** — enough to be meaningful, not overwhelming
3. **Each teammate owns distinct files** — no two teammates edit the same file
4. **Use plan approval gates** — the lead reviews before proceeding
5. **Fallback gracefully** — if teams are unavailable, execute sequentially

## Cost Considerations

Agent teams use significantly more tokens than subagents. Each teammate is a full Claude Code session with its own context window. Use them only when the task genuinely benefits from parallel implementation across multiple domains.

## Requirements

Agent teams require the experimental flag:

```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```
