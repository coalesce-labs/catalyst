---
title: Agent Reference
description: Complete reference for all research agents across Catalyst plugins.
---

## catalyst-dev Agents

### Research Agents

| Agent | Purpose | Tools | Model |
|-------|---------|-------|-------|
| `codebase-locator` | Find files, directories, and components | Grep, Glob, Bash(ls) | Haiku |
| `codebase-analyzer` | Understand implementation details and patterns | Read, Grep, Glob | Sonnet |
| `codebase-pattern-finder` | Find reusable patterns and code examples | Read, Grep, Glob | Sonnet |
| `thoughts-locator` | Search thoughts repository for relevant documents | Grep, Glob, Bash(ls) | Haiku |
| `thoughts-analyzer` | Analyze documentation and decisions | Read, Grep, Glob | Sonnet |
| `external-research` | Research external repos and libraries | DeepWiki, Context7, Exa | Sonnet |

### Infrastructure Agents

| Agent | Purpose | Tools | Model |
|-------|---------|-------|-------|
| `linear-research` | Gather Linear data via CLI | Bash(linearis) | Haiku |
| `github-research` | Research GitHub PRs and issues | Bash(gh) | Haiku |
| `railway-research` | Investigate Railway deployments | Bash(railway) | Haiku |
| `sentry-research` | Research Sentry errors | Bash(sentry-cli) | Haiku |

## catalyst-pm Agents

### Research Agents

| Agent | Purpose | Model |
|-------|---------|-------|
| `linear-research` | Gather cycle, issue, and milestone data | Haiku |

### Analyzer Agents

| Agent | Purpose | Model |
|-------|---------|-------|
| `cycle-analyzer` | Transform cycle data into health insights | Sonnet |
| `milestone-analyzer` | Analyze milestone progress toward target dates | Sonnet |
| `backlog-analyzer` | Analyze backlog health and organization | Sonnet |
| `github-linear-analyzer` | Correlate GitHub PRs with Linear issues | Sonnet |
| `context-analyzer` | Track context engineering adoption | Sonnet |

## Three-Tier Model Strategy

| Tier | Model | Use Case |
|------|-------|----------|
| 1 | **Opus** | Planning, complex analysis, implementation orchestration |
| 2 | **Sonnet** | Code analysis, PR workflows, structured research |
| 3 | **Haiku** | Fast lookups, data collection, file finding |

## Invoking Agents

Agents are invoked via the `@` prefix:

```
@catalyst-dev:codebase-locator find payment files
@catalyst-dev:codebase-analyzer trace authentication flow
@catalyst-dev:external-research query React Server Components patterns
```

Commands spawn agents automatically — you rarely need to invoke them directly.

## Agent Design Principles

1. **Documentarians, not critics** — Report what exists without suggesting improvements
2. **Tool minimalism** — Only the tools needed for the task
3. **Structured output** — Consistent format with file:line references
4. **Single responsibility** — Each agent answers one type of question
