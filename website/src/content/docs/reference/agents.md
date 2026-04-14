---
title: Agents
description: Complete reference for research agents, patterns, team configuration, and invoking agents.
sidebar:
  order: 1
---

Agents are specialized roles that skills delegate to. Each agent has a focused job, a dedicated context window, and a specific set of tools. Skills spawn agents in parallel to gather information fast without overloading the main context.

## catalyst-dev Agents

### Research Agents

| Agent | Purpose | Tools | Model | Source |
|-------|---------|-------|-------|--------|
| `codebase-locator` | Find files, directories, and components | Grep, Glob, Bash(ls) | Haiku | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/agents/codebase-locator.md) |
| `codebase-analyzer` | Understand implementation details and patterns | Read, Grep, Glob | Sonnet | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/agents/codebase-analyzer.md) |
| `codebase-pattern-finder` | Find reusable patterns and code examples | Read, Grep, Glob | Sonnet | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/agents/codebase-pattern-finder.md) |
| `thoughts-locator` | Search thoughts repository for relevant documents | Grep, Glob, Bash(ls) | Haiku | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/agents/thoughts-locator.md) |
| `thoughts-analyzer` | Analyze documentation and decisions | Read, Grep, Glob | Sonnet | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/agents/thoughts-analyzer.md) |
| `external-research` | Research external repos and libraries | DeepWiki, Context7, Exa | Sonnet | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/agents/external-research.md) |

### Infrastructure Agents

| Agent | Purpose | Tools | Model | Source |
|-------|---------|-------|-------|--------|
| `linear-research` | Gather Linear data via CLI | Bash(linearis) | Haiku | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/agents/linear-research.md) |
| `github-research` | Research GitHub PRs and issues | Bash(gh) | Haiku | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/agents/github-research.md) |
| `sentry-research` | Research Sentry errors | Bash(sentry-cli) | Haiku | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/agents/sentry-research.md) |

## catalyst-pm Agents

### Research Agents

| Agent | Purpose | Model | Source |
|-------|---------|-------|--------|
| `linear-research` | Gather cycle, issue, and milestone data | Haiku | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/agents/linear-research.md) |

### Analyzer Agents

| Agent | Purpose | Model | Source |
|-------|---------|-------|--------|
| `cycle-analyzer` | Transform cycle data into health insights | Sonnet | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/agents/cycle-analyzer.md) |
| `milestone-analyzer` | Analyze milestone progress toward target dates | Sonnet | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/agents/milestone-analyzer.md) |
| `backlog-analyzer` | Analyze backlog health and organization | Sonnet | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/agents/backlog-analyzer.md) |
| `github-linear-analyzer` | Correlate GitHub PRs with Linear issues | Sonnet | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/agents/github-linear-analyzer.md) |
| `context-analyzer` | Track context engineering adoption | Sonnet | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/agents/context-analyzer.md) |
| `calendar-analyzer` | Summarize calendar data for planning sessions | Sonnet | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/agents/calendar-analyzer.md) |
| `code-classifier` | Classify code changes for release notes and reporting | Sonnet | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/agents/code-classifier.md) |
| `github-metrics` | Aggregate GitHub activity metrics | Sonnet | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/agents/github-metrics.md) |
| `health-scorer` | Score project health across multiple signals | Sonnet | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/agents/health-scorer.md) |
| `linear-metrics` | Aggregate Linear velocity and throughput metrics | Sonnet | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/agents/linear-metrics.md) |
| `thoughts-metrics` | Aggregate thoughts-repo activity metrics | Sonnet | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/agents/thoughts-metrics.md) |

## When to Use Which Agent

Most of the time, **you don't invoke agents directly**. Skills like `/research-codebase` and `/create-plan` spawn the right agents automatically based on what you ask. When you run `/research-codebase`, Catalyst decides which combination of locators, analyzers, and pattern finders to launch in parallel — you just describe what you want to understand.

That said, you can invoke any agent directly when you have a quick, focused question and don't need a full research workflow:

| Agent | Question it Answers | Example |
|-------|-------------------|---------|
| `codebase-locator` | Where is X? | "Find all payment-related files" |
| `codebase-analyzer` | How does X work? | "Trace the authentication flow" |
| `codebase-pattern-finder` | Show me examples of X | "Show me how we handle API errors" |
| `thoughts-locator` | What do we know about X? | "Find research on caching strategy" |
| `thoughts-analyzer` | What were the decisions about X? | "What did we decide about the DB schema?" |
| `external-research` | What do libraries/docs say about X? | "How does React Server Components work?" |

## Invoking Agents

Use the `@` prefix with the plugin name and agent name:

```
@catalyst-dev:codebase-locator find all payment-related files
@catalyst-dev:codebase-analyzer trace the authentication flow in src/auth/
@catalyst-pm:linear-research get current cycle issues
```

Claude Code has auto-complete for this — type `@catalyst` and it will suggest available agents.

### When to Invoke Directly vs Use a Skill

**Use a skill** (`/research-codebase`) when you want a comprehensive, multi-agent research workflow that saves artifacts for later phases. Skills coordinate multiple agents, manage context, and persist results.

**Invoke an agent directly** (`@catalyst-dev:codebase-locator`) when you have a quick, one-off question that doesn't need the full workflow. This is faster and uses less context.

```
# Full research workflow — spawns multiple agents, saves to thoughts/
/research-codebase how does the payment system handle refunds?

# Quick direct question — just the locator agent
@catalyst-dev:codebase-locator find refund handler files
```

### Parallel vs Sequential

**Use parallel** when researching independent aspects:

```
@catalyst-dev:codebase-locator find payment files
@catalyst-dev:thoughts-locator search payment research
@catalyst-dev:codebase-pattern-finder show payment patterns
```

**Use sequential** when each step depends on the previous:

```
@catalyst-dev:codebase-locator find auth files
# Wait for results
@catalyst-dev:codebase-analyzer analyze src/auth/handler.js
```

## Agent Patterns

Agents follow five core patterns:

| Pattern | Purpose | Tools | Model |
|---------|---------|-------|-------|
| **Locator** | Find files and directories without reading contents | Grep, Glob, Bash(ls) | Haiku |
| **Analyzer** | Read specific files and trace data flow | Read, Grep, Glob | Sonnet |
| **Pattern Finder** | Find reusable patterns and examples | Read, Grep, Glob | Sonnet |
| **Validator** | Check correctness against specifications | Read, Bash, Grep | Sonnet |
| **Aggregator** | Collect and summarize from multiple sources | Read, Grep, Glob | Sonnet |

### Design Principles

1. **Documentarians, not critics** — Report what exists without suggesting improvements
2. **Single responsibility** — Each agent answers one type of question
3. **Tool minimalism** — Only the tools needed for the task
4. **Structured output** — Consistent format with file:line references
5. **Explicit boundaries** — Include "What NOT to Do" sections

## Three-Tier Model Strategy

| Tier | Model | Use Case |
|------|-------|----------|
| 1 | **Opus** | Planning, complex analysis, implementation orchestration |
| 2 | **Sonnet** | Code analysis, PR workflows, structured research |
| 3 | **Haiku** | Fast lookups, data collection, file finding |

## Agent Teams

For complex implementations spanning multiple domains, agent teams enable multiple Claude Code instances working in parallel.

### When to Use Teams vs Subagents

| Scenario | Subagents | Agent Teams |
|----------|-----------|-------------|
| Parallel research gathering | Best fit | Overkill |
| Code analysis / file search | Best fit | Overkill |
| Complex multi-file implementation | Can't nest | Best fit |
| Cross-layer features (frontend + backend + tests) | Limited | Best fit |
| Cost-sensitive operations | Best fit | Too expensive |

### Team Structure

```
Lead (Opus) — Coordinates implementation
├── Teammate 1 (Sonnet) — Frontend changes
│   └── Subagents (Haiku/Sonnet)
├── Teammate 2 (Sonnet) — Backend changes
│   └── Subagents (Haiku/Sonnet)
└── Teammate 3 (Sonnet) — Test changes
    └── Subagents (Haiku/Sonnet)
```

Each teammate is a full Claude Code session that can spawn its own subagents — two-level parallelism that subagents alone cannot achieve.

```
/catalyst-dev:implement-plan --team
/catalyst-dev:oneshot --team PROJ-123
```

### Requirements

```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```
