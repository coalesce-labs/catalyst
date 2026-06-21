# AGENTS.md

Guidance for AI coding agents working in this repository. This file is the
portable, tool-agnostic source of truth. Tool-specific agents may keep their own
thin bridge file that imports this one and adds tool-specific notes — keep that
detail out of here.

## What This Repository Is

A **portable collection of agents, skills, and workflows** for AI-assisted
development, distributed as plugins. It is both:

1. A **source repository** for plugin-based agents and skills
2. A **working installation** that uses its own tools (dogfooding)

Agents and skills are organized in `plugins/*/` and surfaced to the agent via
local symlinks.

## Agent Philosophy

All agents follow a **documentarian, not critic** approach:

- Document what EXISTS, not what should exist
- NO suggestions for improvements unless explicitly asked
- NO root cause analysis unless explicitly asked
- NO architecture critiques or quality assessments
- Focus on answering "WHERE is X?" and "HOW does X work?"

## Build & Test

No build process — this is markdown files and bash scripts.

**Testing changes:**

1. Edit source files in `plugins/*/skills/` or `plugins/*/agents/`
2. Changes are immediately available (symlinks)
3. Reload by restarting your agent session
4. Test by invoking the skill/agent

## Key Principles

- **Read files fully, not partially** — Especially tickets, plans, research
- **Wait for all agents before synthesizing** — Don't proceed until research completes
- **Config drives behavior** — No hardcoded values
- **Single source of truth** — Don't duplicate information across files:
  - CLI syntax lives in skills (e.g., the `linearis` skill) — reference it, don't copy
  - Workflow logic lives in skills — each skill owns its own state transitions
  - Config schema lives in `website/src/content/docs/reference/configuration.md`
- **Spawn parallel agents** — Maximize efficiency
- **Agents are documentarians** — Never suggest improvements unless asked
- **Preserve context** — Save to thoughts/, not just memory

## Skill & Agent References

Skills are namespaced `plugin-name:skill-name` (e.g. `catalyst-dev:create-plan`,
`catalyst-pm:prd-draft`). When instructing a reader to invoke a skill, use the
fully-qualified name; bare names are acceptable in explanatory prose describing
workflow relationships. Agent (subagent) references always use the full
`plugin-name:agent-name` form.

## Knowledge Store

- `thoughts/shared/learnings/` — past problem→solution entries (grep by component/tags/problem_type).
  Search before implementing or debugging in a known area. Curated by `catalyst-dev:ticket-compound`.
- `thoughts/shared/CONCEPTS.md` — shared domain vocabulary (reclaim, revive-budget, orphan, signal ownership…).
- `thoughts/shared/retros/` — compound-loop outputs, written automatically at every merge
  (CTL-831): `ticket/<date>.md` cross-ticket retros (`catalyst-dev:ticket-retro`);
  `estimate/<YYYY-WW>-compound-log.md` per-PR estimation actuals (`catalyst-dev:compound-estimate`).

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
- Squash merges work correctly — the GitHub API provides the file list to release-please.
- Use the scope that best describes the primary intent. Both plugins still get their version bumps.

## Version Control

This workspace tracks: agent definitions, skills, documentation, scripts, configuration templates.

**Do NOT commit**: Specific ticket prefixes (keep "PROJ"), Linear team/project IDs (keep null),
personal thoughts user (keep null).

## CI/Automation

CI skills (`ci-commit`, `ci-describe-pr`) follow the same conventions but skip all interactive
prompts. They never commit sensitive files or add self-attribution.

## Configuration

Two-layer config system:

- **Layer 1**: `.catalyst/config.json` (safe to commit) — project key, ticket prefix, state map
- **Layer 2**: `~/.config/catalyst/config-{projectKey}.json` (NEVER committed) — API tokens, secrets

## Dependencies

**Required**: Git, Bash, and an AI coding agent

**Optional**: HumanLayer CLI (`humanlayer`) for the thoughts persistence system, Linearis CLI
(`linearis`), GitHub CLI (`gh`), `catalyst-session` CLI
(`plugins/dev/scripts/catalyst-session.sh`), `sqlite3`

## Plugin Development

Edit plugin files in `plugins/*/`, test locally (symlinks make changes immediate), reload by
restarting your agent session.

## Orchestration

Catalyst's **execution-core daemon** ships work as **phase-agent workers** — one short-lived
background agent job per phase, walking a 9-phase pipeline (triage → research → plan → implement →
verify → review → pr → monitor-merge → monitor-deploy). The legacy wave-orchestration model is
preserved in the **catalyst-legacy** plugin as a fallback; the mode is selected by
`.catalyst/config.json → catalyst.orchestration.dispatchMode`.

Cross-process communication is built on a **single unified event log** at
`~/catalyst/events/YYYY-MM.jsonl`. Workers, the phase dispatcher, the broker, the webhook
receiver, and `catalyst-comms send` all append; the broker daemon, the HUD, the orch-monitor web
dashboard, and `catalyst-events wait-for` all read.

## Reference Docs

Read these on demand:

- **Architecture & data flow** — `docs/architecture.md`
- **Run lifecycle** — `docs/orchestrator-overview.md`
- **Decision records (ADRs)** — `docs/adrs.md`
- **Release process** — `docs/releases.md`
