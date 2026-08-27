# Frontmatter Standard

All skills and agents use YAML frontmatter for configuration.

The packaging pipeline (`scripts/packaging/providers/local.mjs`) is the enforcement point: every frontmatter key on every `SKILL.md`/agent `*.md` must be classified here, or `render` fails with an "unrecognized frontmatter key" error naming the file and the key — there is no silent pass-through. Each key below is also either **portable** (survives into the `codex`, `agentsSkills`, and other non-Claude targets) or **Claude-only** (dropped when rendering those targets, and counted in the pipeline's loss report as an acknowledged, cosmetic loss — never a silent one). That portable/Claude-only split, not the required/optional split, is the distinction a skill or agent author actually needs to reason about. See `docs/skill-authoring.md` for the full packaging pipeline — the `agents/portability.yaml` sidecar, the `effects`/`exposure`/`invocation` vocabularies, and the invocation-parity rule.

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

| Field | Type | Portability | Description |
|---|---|---|---|
| `name` | string | Portable | kebab-case identifier |
| `description` | string | Portable | What the skill does, including when to trigger |

### Optional Fields

| Field | Type | Default | Portability | Description |
|---|---|---|---|---|
| `disable-model-invocation` | boolean | `false` | Claude-only | Set `true` for user-invoked skills (prevents auto-triggering) |
| `user-invocable` | boolean | `true` | Claude-only | Set `false` for CI/background skills |
| `allowed-tools` | string | all | Claude-only | Comma-separated list of permitted tools |
| `argument-hint` | string | — | Claude-only | Hint text shown for slash-command arguments |
| `modifies-workspace` | boolean | `false` | Claude-only | Marks a skill that writes to the working tree, for tooling that needs to know before invoking it |
| `version` | string | — | Claude-only | Decorative per-file metadata — see the note below. Not required; most skills omit it |

`version` is deliberately Claude-only rather than a portable field: a plugin's real version is owned exclusively by `plugin.json` via release-please (see `docs/releases.md`), so a per-`SKILL.md` `version:` is decorative metadata about that one file, not a second, competing version source. The packaging pipeline classifies it the same way it classifies `model`/`color` on agents below — a cosmetic field the loss report drops without treating it as a defect.

### Do NOT Include (skills)

These are recognized on **agents**, not skills — putting them on a `SKILL.md` is an unrecognized-key render error:

- `model` — an agent-only field (see Agents below)
- `tools` — use `allowed-tools` instead
- `color` — an agent-only field

`category` is also not a recognized key on either shape; use directory organization instead.

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
model: sonnet
color: blue
---
```

### Required Fields

| Field | Type | Portability | Description |
|---|---|---|---|
| `name` | string | Portable | kebab-case identifier |
| `description` | string | Portable | What the agent does |

### Optional Fields

| Field | Type | Portability | Description |
|---|---|---|---|
| `tools` | string | Claude-only | Comma-separated list of available tools |
| `model` | string | Claude-only | Model override for this agent (e.g. `sonnet`, `opus`, `haiku`) — recognized here even though it is rejected on a `SKILL.md` |
| `color` | string | Claude-only | Display color hint |
| `version` | string | Claude-only | Same decorative-metadata rationale as skills' `version` above |

## Validation

Run `/validate-frontmatter` to check consistency across all skills and agents.
