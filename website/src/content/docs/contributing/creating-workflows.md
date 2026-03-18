---
title: Creating Workflows
description: Guide to creating new agents and skills for Catalyst, including the frontmatter standard.
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
| `source` | No | URL if imported from external source |
| `adapted` | No | Date of adaptation |
| `original-author` | No | Original creator credit |

## Creating a Skill

Skills are markdown files at `plugins/<plugin>/skills/<skill-name>/SKILL.md`.

### Template

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

### Skill Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | kebab-case, must match directory name |
| `description` | Yes | One-line summary |
| `disable-model-invocation` | Conditional | Set `true` for user-invoked skills |
| `user-invocable` | Conditional | Set `false` for CI/background skills |
| `allowed-tools` | No | Comma-separated list of allowed Claude Code tools |
| `version` | No | Semantic version |

### Key Differences from Agents

| Field | Agents | Skills |
|-------|--------|--------|
| Location | `agents/*.md` | `skills/*/SKILL.md` |
| `name` | Must match filename | Must match directory name |
| `description` | Multi-line with use cases | One-line summary |
| Tool field | `tools` | `allowed-tools` |
| `model` / `category` | Not used | Not used |

### Do NOT Include

- `model` — Skills inherit the model from the session
- `category` — Not used in skills format
- `tools` — Use `allowed-tools` instead

## Available Tools

**File Operations**: `Read`, `Write`, `Edit`

**Search & Discovery**: `Grep`, `Glob`

**Execution**: `Bash`, `Task`, `TodoWrite`

**Web & External**: `WebFetch`, `WebSearch`, `mcp__deepwiki__ask_question`, `mcp__deepwiki__read_wiki_structure`

## Testing

1. Edit the file in the appropriate `plugins/<plugin>/` directory
2. Restart Claude Code to reload
3. Invoke with `@catalyst-dev:{agent-name}` or `/catalyst-dev:{skill-name}`
4. Verify output matches expectations

## Validation

```bash
/catalyst-meta:validate_frontmatter              # Check all workflows
/catalyst-meta:validate_frontmatter --fix        # Auto-fix issues
```
