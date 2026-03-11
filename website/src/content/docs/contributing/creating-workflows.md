---
title: Creating Workflows
description: Guide to creating new agents and commands for Catalyst, including the frontmatter standard.
---

## Creating an Agent

Agents are markdown files in `plugins/<plugin>/agents/` with YAML frontmatter.

### Template

```yaml
---
name: my-agent
description: |
  What this agent does.

  Use this agent when:
  - Scenario 1
  - Scenario 2
tools: Read, Grep
model: sonnet
category: general
version: 1.0.0
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

### Agent Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | kebab-case, must match filename (without `.md`) |
| `description` | Yes | Multi-line with use cases |
| `tools` | Yes | Comma-separated list of allowed Claude Code tools |
| `model` | Yes | `opus`, `sonnet`, or `haiku` |
| `category` | Yes | `research`, `analysis`, `search`, `execution`, `validation`, `general` |
| `version` | Yes | Semantic version |
| `source` | No | URL if imported from external source |
| `adapted` | No | Date of adaptation |
| `original-author` | No | Original creator credit |

## Creating a Command

Commands are markdown files in `plugins/<plugin>/commands/`.

### Template

```yaml
---
description: One-line summary of what this command does
category: general
tools: Read, Write
model: sonnet
version: 1.0.0
---

# Command Name

You are tasked with [purpose].

## Process

1. Step one
2. Step two
```

### Command Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `description` | Yes | One-line summary |
| `category` | Yes | `workflow`, `planning`, `implementation`, `validation`, `linear`, `git`, `general` |
| `tools` | Yes | Comma-separated list of allowed Claude Code tools |
| `model` | Yes | `opus`, `sonnet`, or `haiku` |
| `version` | Yes | Semantic version |
| `argument-hint` | No | Hint for command arguments |

### Key Differences from Agents

| Field | Agents | Commands |
|-------|--------|----------|
| `name` | Required (must match filename) | Not allowed |
| `description` | Multi-line with use cases | One-line summary |
| `argument-hint` | Not applicable | Optional |

## Model Selection

| Model | Use For |
|-------|---------|
| **opus** | Planning, complex analysis, orchestration |
| **sonnet** | Code analysis, PR workflows, structured research |
| **haiku** | Fast lookups, data collection, file finding |

## Available Tools

**File Operations**: `Read`, `Write`, `Edit`

**Search & Discovery**: `Grep`, `Glob`

**Execution**: `Bash`, `Task`, `TodoWrite`

**Web & External**: `WebFetch`, `WebSearch`, `mcp__deepwiki__ask_question`, `mcp__deepwiki__read_wiki_structure`

## Testing

1. Edit the file in the appropriate `plugins/<plugin>/` directory
2. Restart Claude Code to reload
3. Invoke with `@catalyst-dev:{agent-name}` or `/command-name`
4. Verify output matches expectations

## Validation

```bash
/catalyst-meta:validate_frontmatter              # Check all workflows
/catalyst-meta:validate_frontmatter --fix        # Auto-fix issues
```
