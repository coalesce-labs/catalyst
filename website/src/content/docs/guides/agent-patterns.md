---
title: Agent Patterns
description: How to create and use specialized agents — locators, analyzers, pattern finders, validators.
---

Agents are specialized AI experts that Claude Code delegates tasks to. Each has a focused responsibility, restricted tool access, and returns structured findings to the main conversation.

## Agent File Structure

Agents are markdown files with YAML frontmatter:

```yaml
---
name: agent-name
description: Brief description shown in agent list
tools: Grep, Glob, Read
model: sonnet
---

# Agent Instructions

You are a specialist at [specific task]...
```

### Frontmatter Fields

- **name** — kebab-case identifier, invoked as `@catalyst-dev:{name}`
- **description** — Shown in agent list; explains when to use this agent
- **tools** — Comma-separated list of allowed tools (restricts scope)
- **model** — `opus` for complex analysis, `sonnet` for general research, `haiku` for fast lookups

## Built-in Agent Types

### When to Use Which Agent

| Agent | Question it Answers | Tools |
|-------|-------------------|-------|
| `codebase-locator` | Where is X? | Grep, Glob, Bash(ls) |
| `codebase-analyzer` | How does X work? | Read, Grep, Glob |
| `codebase-pattern-finder` | Show me examples of X | Read, Grep, Glob |
| `thoughts-locator` | What do we know about X? | Grep, Glob, Bash(ls) |
| `thoughts-analyzer` | What were the decisions about X? | Read, Grep, Glob |
| `external-research` | What do libraries/docs say about X? | DeepWiki, Context7, Exa |

## Agent Patterns

### Pattern 1: Locator

Find files and directories without reading contents. Uses `Grep, Glob, Bash(ls only)` and runs on Haiku for speed.

### Pattern 2: Analyzer

Understand implementation details by reading specific files and tracing data flow. Uses `Read, Grep, Glob` and runs on Sonnet.

### Pattern 3: Pattern Finder

Find reusable patterns and examples across the codebase. Uses `Read, Grep, Glob` and runs on Sonnet.

### Pattern 4: Validator

Check correctness against specifications. Uses `Read, Bash, Grep` and runs on Sonnet.

### Pattern 5: Aggregator

Collect and summarize information from multiple sources. Uses `Read, Grep, Glob` and runs on Sonnet.

## Design Principles

### Single Responsibility

Each agent should answer one type of question. A `codebase-locator` finds files — it doesn't analyze them. A `codebase-analyzer` understands implementation — it doesn't suggest improvements.

### Tool Minimalism

Grant only the tools needed. Research agents get read-only tools; implementation commands get full access. Fewer tools means faster decisions and prevents accidental modifications.

### Explicit Boundaries

Always include a "What NOT to Do" section:

```markdown
## What NOT to Do

- Don't read file contents (just report locations)
- Don't analyze what the code does
- Don't suggest improvements
```

### Structured Output

Define the expected output format so results are consistent and parseable:

```markdown
## Output Format

### [Category]
- `path/to/file.ext:line` — Description
```

## Parallel vs Sequential Usage

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

## Creating Custom Agents

1. Create a markdown file in `plugins/dev/agents/`
2. Add frontmatter with name, description, tools, and model
3. Write clear instructions with responsibilities, strategy, output format, and boundaries
4. Restart Claude Code to load the agent
5. Test with `@catalyst-dev:{name} task description`

See [Contributing](/contributing/) for the complete agent template.
