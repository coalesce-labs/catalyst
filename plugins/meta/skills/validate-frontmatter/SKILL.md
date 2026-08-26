---
name: validate-frontmatter
description:
  "Validates YAML frontmatter on plugins/*/skills/*/SKILL.md and plugins/*/agents/*.md against
  docs/frontmatter-standard.md and .claude/rules/plugin-editing.md: required fields, the
  disable-model-invocation/user-invocable polarity, allowed-tools vs tools, and skill-only fields
  that must not leak (model, category). Use when adding or editing a skill or agent, before opening
  a PR that touches plugins/**, or paired with audit-references to confirm a plugin cleanup's
  frontmatter didn't drift."
disable-model-invocation: true
allowed-tools: Read, Edit, Glob, Grep
version: 1.0.0
---

# Validate Frontmatter

Checks every skill and agent in the repo against the current frontmatter standard and reports (or
fixes) drift.

## The standard

Field tables are the single source in
[`docs/frontmatter-standard.md`](../../../../docs/frontmatter-standard.md) — don't restate them
here. The skills-only shape rule (`no commands/ directories — skills only`) is in
[`.claude/rules/plugin-editing.md`](../../../../.claude/rules/plugin-editing.md).

## The rule everyone gets backwards

`disable-model-invocation: true` marks a **user-invoked** skill — a human runs it explicitly via
`/plugin:skill`, and the model is *disabled* from auto-triggering it off its description.
`user-invocable: false` (a different key) marks a CI/background skill nobody explicitly invokes.
Getting this backwards tells authors to set every user-invoked skill to the value that lets the
model auto-trigger it — the opposite of what "user-invoked" means. Full table:
[references/checklist.md](references/checklist.md).

## Process

1. **Glob** `plugins/*/skills/*/SKILL.md` and `plugins/*/agents/*.md`.
2. For each skill: required fields present; `disable-model-invocation`/`user-invocable` polarity
   matches how it's actually invoked; `allowed-tools` used (never bare `tools`); no `model` or
   `category` field (skills-only prohibition — agents may carry either).
3. For each agent: `name`, `description`, `tools` present; `name` matches the filename (kebab-case).
4. Report issues grouped by file. For mechanically safe fixes (`tools:` → `allowed-tools:` rename,
   `vX.Y` → semver, a missing `version: 1.0.0`), propose the edit and apply with `Edit` after
   confirmation. Never auto-fix `disable-model-invocation`/`user-invocable` or `description` — both
   need a human call on intent. Full catalogue: [references/checklist.md](references/checklist.md).

## Pairs with audit-references

After a plugin-wide cleanup (skill removals, shape rewrites), run this alongside
`/catalyst-meta:audit-references` — that catches broken path references, this catches frontmatter a
cleanup left inconsistent (a rewrite that forgot to drop a stray `category` field, or flipped
`disable-model-invocation` the wrong way).
