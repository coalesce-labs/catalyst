# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## What This Repository Is

This is a **portable collection of Claude Code agents, skills, and workflows** for AI-assisted
development distributed as plugins. It's both:

1. A **source repository** for plugin-based agents and skills
2. A **working installation** that uses its own tools (dogfooding)

The workspace uses a plugin-based architecture where agents and skills are organized in
`plugins/*/`, and installed locally via `.claude/` symlinks.

## Agent Philosophy

All agents follow a **documentarian, not critic** approach:

- Document what EXISTS, not what should exist
- NO suggestions for improvements unless explicitly asked
- NO root cause analysis unless explicitly asked
- NO architecture critiques or quality assessments
- Focus on answering "WHERE is X?" and "HOW does X work?"

## Build & Test

This workspace has no build process - it's markdown files and bash scripts.

**Testing changes:**

1. Edit source files in `plugins/*/skills/` or `plugins/*/agents/`
2. Changes are immediately available (symlinks)
3. Restart Claude Code to reload
4. Test by invoking the skill/agent

## Key Principles

- **Read files fully, not partially** — Especially tickets, plans, research
- **Wait for all agents before synthesizing** — Don't proceed until research completes
- **Config drives behavior** — No hardcoded values
- **Single source of truth** — Don't duplicate information across files:
  - CLI syntax lives in skills (e.g., `linearis` skill) — reference it, don't copy
  - Workflow logic lives in skills — each skill owns its own state transitions
  - Config schema lives in `website/src/content/docs/reference/configuration.md`
- **Spawn parallel agents** — Maximize efficiency
- **Agents are documentarians** — Never suggest improvements unless asked
- **Preserve context** — Save to thoughts/, not just memory

## Commit Conventions

- `feat(dev): add new skill` — catalyst-dev minor bump
- `fix(pm): correct cycle calculation` — catalyst-pm patch bump
- `feat(dev)!: breaking change` — catalyst-dev MAJOR bump
- `chore(meta): update docs` — no version bump
- Valid scopes: `dev`, `pm`, `meta`, `analytics`, `debugging`

**How release-please routes version bumps (monorepo):**

- Routing is by **file paths changed**, NOT by commit message scope. A commit touching files in both
  `plugins/dev/` and `plugins/pm/` bumps both plugins regardless of scope.
- The `(scope)` in `fix(dev):` controls **changelog grouping**, not which plugin gets bumped.
- Squash merges work correctly — GitHub API provides the file list to release-please.
- Use the scope that best describes the primary intent (e.g., `fix(dev):` for a dev-led change that
  also touches pm files). Both plugins still get their version bumps.

## Version Control

This workspace tracks: agent definitions, skills, documentation, scripts, configuration templates.

**Do NOT commit**: Specific ticket prefixes (keep "PROJ"), Linear team/project IDs (keep null),
personal thoughts user (keep null).

## CI/Automation

CI skills (`ci-commit`, `ci-describe-pr`) follow the same conventions but skip all interactive
prompts. They never commit sensitive files or add Claude attribution.

## Configuration

Two-layer config system:

- **Layer 1**: `.catalyst/config.json` (safe to commit) — project key, ticket prefix, state map
- **Layer 2**: `~/.config/catalyst/config-{projectKey}.json` (NEVER committed) — API tokens, secrets

## Dependencies

**Required**: Claude Code, Git, Bash

**Optional**: HumanLayer CLI (`humanlayer`) for the thoughts persistence system, Linearis CLI (`linearis`), GitHub CLI (`gh`), `catalyst-session` CLI (`plugins/dev/scripts/catalyst-session.sh`), `sqlite3`

## Plugin Development

Edit plugin files in `plugins/*/`, test locally (symlinks make changes immediate), restart Claude
Code to reload. Changes are distributed via the Claude Code plugin marketplace.

@import docs/architecture.md

@import docs/adrs.md

@import docs/releases.md
