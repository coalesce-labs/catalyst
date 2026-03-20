---
title: Agents
description: Complete reference for research agents, patterns, team configuration, and creating custom agents.
sidebar:
  order: 1
---

Agents are specialized roles that skills delegate to. Each agent has a focused job, a dedicated context window, and a specific set of tools. Skills spawn agents in parallel to gather information fast without overloading the main context.

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

## When to Use Which Agent

| Agent | Question it Answers |
|-------|-------------------|
| `codebase-locator` | Where is X? |
| `codebase-analyzer` | How does X work? |
| `codebase-pattern-finder` | Show me examples of X |
| `thoughts-locator` | What do we know about X? |
| `thoughts-analyzer` | What were the decisions about X? |
| `external-research` | What do libraries/docs say about X? |

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

## Invoking Agents

Agents are invoked via the `@` prefix:

```
@catalyst-dev:codebase-locator find payment files
@catalyst-dev:codebase-analyzer trace authentication flow
@catalyst-dev:external-research query React Server Components patterns
```

Skills spawn agents automatically — you rarely need to invoke them directly.

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
/catalyst-dev:implement_plan --team
/catalyst-dev:oneshot --team PROJ-123
```

### Requirements

```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

## Creating Custom Agents and Skills

### Agent Template

Agents are markdown files in `plugins/<plugin>/agents/` with YAML frontmatter:

```yaml
---
name: my-agent
description: |
  What this agent does.

  Use this agent when:
  - Scenario 1
  - Scenario 2
tools: Read, Grep
---

# My Agent

You are a specialized agent for [purpose].

## Process

1. Step one
2. Step two

## Output

Return findings in this format:
- `path/to/file:line` — Description

## What NOT to Do

- Don't [boundary 1]
- Don't [boundary 2]
```

#### Agent Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | kebab-case, must match filename (without `.md`) |
| `description` | Yes | Multi-line with use cases |
| `tools` | Yes | Comma-separated list of allowed Claude Code tools |
| `source` | No | URL if imported from external source |

### Skill Template

Skills are markdown files at `plugins/<plugin>/skills/<skill-name>/SKILL.md`:

```yaml
---
name: my-skill
description: One-line summary of what this skill does
disable-model-invocation: true
allowed-tools: Read, Write
version: 1.0.0
---

# Skill Name

You are tasked with [purpose].

## Process

1. Step one
2. Step two
```

#### Skill Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | kebab-case, must match directory name |
| `description` | Yes | One-line summary |
| `disable-model-invocation` | Conditional | Set `true` for user-invoked-only skills |
| `user-invocable` | Conditional | Set `false` for CI/background skills |
| `allowed-tools` | No | Comma-separated list of allowed Claude Code tools |
| `version` | No | Semantic version |

Do **not** include `model`, `category`, or `tools` (use `allowed-tools` instead).

### Testing

1. Edit files in the appropriate `plugins/<plugin>/` directory
2. Restart Claude Code to reload
3. Invoke with `@catalyst-dev:{agent-name}` or `/catalyst-dev:{skill-name}`
4. Validate with `/catalyst-meta:validate_frontmatter`
