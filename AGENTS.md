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

## Code Understanding (Serena)

Coding agents orient on this codebase through **Serena** — a self-hosted, local, LSP-backed MCP
server that provides semantic code retrieval (the replacement for the removed DeepWiki MCP). It lets
agents answer "where does X live / how is Y wired / who calls Z" in a few precise calls instead of
many broad `Grep`s, getting up to speed with far fewer tool calls and tokens.

- **Install (per machine):** `uv tool install -p 3.13 serena-agent`, then register it as a
  **user-scope MCP server** that runs `serena start-mcp-server`. Use the absolute path to the
  `serena` binary so background worker jobs with a restricted `PATH` can launch it, and run it
  headless on servers. It connects with no startup project and activates lazily. The exact
  per-agent registration command lives in the bridge file.
- **Versioned config (committed):** `.serena/project.yml` (languages `typescript` + `bash`,
  `read_only: true`, ignores the harness worktree dir / `thoughts` / build output, plus an
  `initial_prompt` pointer) and
  `.serena/memories/codebase_map.md` (the directory map agents read via `read_memory("codebase_map")`).
  The per-machine symbol cache `.serena/cache/` is gitignored; build it with `serena project index`.
- **Wiring:** the research/analysis agents (`codebase-analyzer`, `codebase-locator`,
  `codebase-pattern-finder`) and skills (`research-codebase`, `create-plan`, `phase-research`,
  `phase-plan`) grant the read-only `mcp__serena__*` tools; `research-codebase` Step 0 activates the
  project, reads the `codebase_map` memory, and maps symbols before spawning sub-agents.
- **Use it:** `activate_project` (repo root / `.`) → `list_memories` / `read_memory` →
  `get_symbols_overview`, `find_symbol`, `find_referencing_symbols`, `search_for_pattern`. It is
  read-only — editing stays with the implement agents' `Edit`/`Write`.

## Commit Conventions

- `feat(dev): add new skill` — catalyst-dev minor bump
- `fix(pm): correct cycle calculation` — catalyst-pm patch bump
- `feat(dev)!: breaking change` — catalyst-dev MAJOR bump
- `chore(meta): update docs` — no version bump
- Valid scopes (one per plugin): `dev`, `pm`, `meta`, `analytics`, `debugging`, `pm-ops`, `meeting-hygiene`, `discovery`, `legacy`, `foundry`

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
background agent job per phase, walking a 10-phase pipeline (triage → research → plan → implement →
verify → review → pr → monitor-merge → monitor-deploy → teardown). The legacy wave-orchestration model is
preserved in the **catalyst-legacy** plugin as a fallback; the mode is selected by
`.catalyst/config.json → catalyst.orchestration.dispatchMode`.

Cross-process communication is built on a **single unified event log** at
`~/catalyst/events/YYYY-MM.jsonl`. Workers, the phase dispatcher, the broker, the webhook
receiver, and `catalyst-comms send` all append; the broker daemon, the HUD, the orch-monitor web
dashboard, and `catalyst-events wait-for` all read.

## Pull requests

A pull request is **not mergeable** until BOTH are true:

- **All CI checks pass.** A failing or pending required check blocks the merge.
- **Every review is resolved.** If the PR has any review (automated code review or human), each review thread/conversation must be addressed and marked resolved. An unresolved review blocks the merge even when checks are green.

So after opening a PR: watch the checks to green, then address every review comment (push fixes), reply, and resolve each thread before considering the PR done.

## Reference Docs

Read these on demand:

- **Architecture & data flow** — `docs/architecture.md`
- **Run lifecycle** — `docs/orchestrator-overview.md`
- **Decision records (ADRs)** — `docs/adrs.md`
- **Release process** — `docs/releases.md`
