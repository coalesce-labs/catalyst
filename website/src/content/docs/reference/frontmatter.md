---
title: Frontmatter Standard
description: YAML frontmatter specification for agents and commands.
---

All Catalyst agents and commands use YAML frontmatter for metadata. This standard ensures consistency and enables validation with `/catalyst-meta:validate_frontmatter`.

## Agent Frontmatter

### Required Fields

```yaml
---
name: agent-name           # kebab-case, must match filename
description: |             # Multi-line with use cases
  What this agent does.

  Use this agent when:
  - Scenario 1
  - Scenario 2
tools: Grep, Glob, Read    # Allowed Claude Code tools
model: sonnet              # opus | sonnet | haiku
category: analysis         # See categories below
version: 1.0.0             # Semantic version
---
```

### Optional Fields

```yaml
source: https://github.com/...    # If imported from external source
adapted: 2025-01-08               # Date of adaptation
original-author: Jane Doe         # Original creator credit
```

### Agent Categories

- **research** — Finding and gathering information
- **analysis** — Deep code/data analysis
- **search** — Locating files/patterns/content
- **execution** — Running commands or operations
- **validation** — Checking and verifying
- **general** — Multi-purpose

## Command Frontmatter

### Required Fields

```yaml
---
description: One-line summary    # Concise purpose
category: workflow               # See categories below
tools: Read, Write, Task         # Allowed Claude Code tools
model: opus                      # opus | sonnet | haiku
version: 1.0.0                   # Semantic version
---
```

### Optional Fields

```yaml
argument-hint: [ticket-file]     # Hint for command arguments
```

### Command Categories

- **workflow** — Development workflows and processes
- **planning** — Planning and design
- **implementation** — Code changes and features
- **validation** — Testing and verification
- **linear** — Linear ticket integration
- **git** — Version control operations
- **workflow-discovery** — Meta-workflows
- **general** — Miscellaneous

## Key Differences

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

### File Operations
`Read`, `Write`, `Edit`

### Search & Discovery
`Grep`, `Glob`

### Execution
`Bash`, `Task`, `TodoWrite`

### Web & External
`WebFetch`, `WebSearch`, `mcp__deepwiki__ask_question`, `mcp__deepwiki__read_wiki_structure`

## Validation

```bash
/catalyst-meta:validate_frontmatter              # Check all workflows
/catalyst-meta:validate_frontmatter --fix        # Auto-fix issues
```
