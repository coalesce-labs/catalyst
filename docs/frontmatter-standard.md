# Frontmatter Standard

All skills and agents use YAML frontmatter for configuration.

## Skills (`skills/*/SKILL.md`)

```yaml
---
name: skill-name
description: What this skill does. Include trigger context.
disable-model-invocation: true
allowed-tools: Read, Write, Grep, Glob, Bash
version: 1.0.0
---
```

### Required Fields

| Field | Type | Description |
|---|---|---|
| `name` | string | kebab-case identifier |
| `description` | string | What the skill does, including when to trigger |

### Optional Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `disable-model-invocation` | boolean | `false` | Set `true` for user-invoked skills (prevents auto-triggering) |
| `user-invocable` | boolean | `true` | Set `false` for CI/background skills |
| `allowed-tools` | string | all | Comma-separated list of permitted tools |
| `version` | string | — | Semantic version |

### Do NOT Include

- `model` — Not a SKILL.md field
- `category` — Use directory organization instead
- `tools` — Use `allowed-tools` instead

### CI Skills

CI/automation skills use `user-invocable: false` and omit `disable-model-invocation`:

```yaml
---
name: ci-commit
description: Create git commits autonomously for CI/automation
user-invocable: false
allowed-tools: Bash, Read
version: 1.0.0
---
```

## Agents (`agents/*.md`)

```yaml
---
name: agent-name
description: What this agent does
tools: Grep, Glob, Read
---
```

### Required Fields

| Field | Type | Description |
|---|---|---|
| `name` | string | kebab-case identifier |
| `description` | string | What the agent does |
| `tools` | string | Comma-separated list of available tools |

## Validation

Run `/validate-frontmatter` to check consistency across all skills and agents.
