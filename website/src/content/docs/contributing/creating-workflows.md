---
title: Creating Workflows
description: Guide to creating new agents and commands for Catalyst.
---

## Creating an Agent

Agents are markdown files in `plugins/<plugin>/agents/` with YAML frontmatter.

### Minimal Template

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
```

### Key Requirements

- **name** must be kebab-case and match the filename (without `.md`)
- **tools** must be valid Claude Code tools
- **model** must be `opus`, `sonnet`, or `haiku`
- Include a "What NOT to Do" section for clear boundaries

## Creating a Command

Commands are markdown files in `plugins/<plugin>/commands/`.

### Minimal Template

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

### Key Differences from Agents

- Commands do **not** have a `name` field (filename is the identifier)
- Commands use a one-line `description` (not multi-line)
- Commands can use `argument-hint` for parameter documentation

## Testing

1. Edit the file in the appropriate `plugins/<plugin>/` directory
2. Restart Claude Code to reload
3. Invoke with `@catalyst-dev:{agent-name}` or `/command-name`
4. Verify output matches expectations

## Validation

Run frontmatter validation to check your workflow:

```bash
/validate-frontmatter plugins/dev/agents/my-agent.md
```

See the [Frontmatter Standard](/reference/frontmatter/) for the complete specification.
