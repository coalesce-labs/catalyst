# Frontmatter validation checklist

Field tables live in
[`docs/frontmatter-standard.md`](../../../../../docs/frontmatter-standard.md) — this file covers
checks that table doesn't, plus the common mistakes.

## Skills (`plugins/*/skills/*/SKILL.md`)

- `name` and `description` present. `description` is third person, states both what the skill does
  and when to use it, with concrete trigger phrases — not a summary of the internal steps (that
  invites acting on the description alone instead of reading the skill).
- `disable-model-invocation`/`user-invocable` polarity matches how the skill is actually invoked:

  | Invocation | `disable-model-invocation` | `user-invocable` |
  |---|---|---|
  | User runs it via `/plugin:skill`, model never auto-triggers | `true` | (omit, default `true`) |
  | CI/background only, nobody explicitly invokes | (omit) | `false` |
  | Either — model may auto-trigger off the description, and a user can also run it | (omit or `false`) | (omit) |

  A skill with neither field set is invocable both ways — that's a deliberate default, not a gap;
  don't flag it as missing.
- `allowed-tools`, never bare `tools` (that key is agent-only frontmatter).
- No `model` field, no `category` field — both are skills-only prohibitions. Agents may carry
  either.
- `version`, if present, is semver (`X.Y.Z`), not `vX.Y` or bare `X.Y`.
- No `commands/` shape. **This repo has none** — every user-facing workflow is a skill under
  `plugins/<plugin>/skills/<name>/SKILL.md`. A "Command Frontmatter" section describing a `category`
  field, `argument-hint`, or a no-`name`-field rule scoped to "commands" is validating a shape this
  repo retired before this skill was written; delete it on sight rather than re-deriving it.

## Agents (`plugins/*/agents/*.md`)

- `name`, `description`, `tools` present.
- `name` matches the filename (kebab-case) — `codebase-analyzer.md` → `name: codebase-analyzer`.
- `tools` is a comma-separated list of real Claude Code tool names. Grepping the repo for the tool
  name is the fastest way to confirm it isn't a typo — `SearchFiles`/`FindFile` are the recurring
  wrong ones; they mean `Grep`/`Glob`.
- `model` and `version`, if present, are free-form on agents (the skills-only prohibition above does
  not apply here) — just check they're not obviously wrong (e.g. `model: gpt-4`, which isn't a
  Claude Code model alias).

## Common mistakes

| Wrong | Right | Why |
|---|---|---|
| `disable-model-invocation: false` on a skill only ever run via `/plugin:skill` | `disable-model-invocation: true` | `false` leaves the model free to auto-trigger it off the description — the opposite of "user-invoked" |
| `tools: Read, Grep` on a **skill** | `allowed-tools: Read, Grep` | `tools` is the agent-frontmatter key; skills use `allowed-tools` |
| `category: validation` on a skill | (omit) | skills organize by directory, not a frontmatter field |
| `version: v1.0` | `version: 1.0.0` | semver, not a `v`-prefixed tag |
| A `commands/` directory, or a doc section validating one | skills under `skills/<name>/SKILL.md` | this repo has no commands shape |

## Auto-fix scope

Safe to apply without asking: `tools:` → `allowed-tools:` rename on a skill, `vX.Y` → `X.Y.Z`
version rewrite, adding a missing `version: 1.0.0`. Ask first: anything touching
`disable-model-invocation` or `user-invocable` — that's an intent question (is this skill meant to
be user-invoked?), not a mechanical fix. Never auto-fix `description` content — a short description
needs a human decision about what the trigger phrases should be, not generated filler.
