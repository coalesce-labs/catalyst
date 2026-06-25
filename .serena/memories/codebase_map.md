# Catalyst — codebase map

Orientation for coding agents. Canonical detail lives in `AGENTS.md` and `docs/architecture.md`;
read those for depth. This map is the fast "where is X" index.

## What this repo is
A portable collection of AI dev **agents / skills / workflows** shipped as **plugins**, *and* a
working orchestration runtime that dogfoods them. Source is markdown + bash + TypeScript/JS. There is
no build step for the plugins themselves; the orchestration runtime under
`plugins/dev/scripts/` is real code.

## Top-level layout
- `plugins/` — plugin source (edit here; surfaced to agents via `.claude/` symlinks)
  - `plugins/dev/` — the core dev plugin
    - `agents/` — subagent definitions (codebase-locator, codebase-analyzer, codebase-pattern-finder, external-research, …)
    - `skills/` — workflow skills (research-codebase, create-plan, implement-plan, validate-*, and the `phase-*` orchestrator phases)
    - `scripts/` — the runtime (see below)
    - `templates/` — global-state.json, global-event.json schemas
  - `plugins/pm/`, `plugins/meta/`, `plugins/legacy/`, `plugins/analytics/`, `plugins/debugging/`, `plugins/foundry/` — other plugins
- `docs/` — `architecture.md`, `orchestrator-overview.md`, `adrs.md`, `releases.md`
- `AGENTS.md` — portable, tool-agnostic source of truth (CLAUDE.md is a thin `@AGENTS.md` bridge)
- `website/` — Astro docs site (`website/src/content/docs/…`, esp. `reference/configuration.md`)
- `thoughts/` — knowledge store (learnings, retros, plans, research); git-backed, not source
- `.catalyst/` — project config (`config.json`) + per-worktree workflow state

## The runtime (`plugins/dev/scripts/`)
- `broker/` — broker daemon. `router.mjs` (event routing, `shouldSkipEvent` self-filter),
  `namespace-contract.mjs` (the `filter.*` / `broker.daemon.*` / `phase.*` namespace rules)
- `execution-core/` — the scheduling daemon. `daemon.mjs` (tick loop, Linear mirror), `registry.mjs`
  (team→repo→eligibleQuery), `hrw.mjs` + `cluster-claim.mjs` (multi-host ownership), reaper, worktree-refresh
- `orch-monitor/` — web dashboard + node-aware read-model. `filter-state.db` (webhook-synced Linear
  read replica — use for reads, not linearis), `ui/` (React app), `__tests__/` (contract suites)
- `lib/` — shared bash libs: `worktree-rebase.sh`, `phase-sequence.sh`, `draft-pr.sh`, `emit-reap-intent.sh`, …
- `phase-agent-dispatch` — dispatches one `claude --bg` job per pipeline phase
- `catalyst-*.sh` — CLIs: `catalyst-state.sh`, `catalyst-db.sh`, `catalyst-session.sh`, `catalyst-comms`, `catalyst-events`

## Key concepts (see `thoughts/shared/CONCEPTS.md`)
- **Unified event log** `~/catalyst/events/YYYY-MM.jsonl` — append-only backbone; all processes read/write it (NOT in repo)
- **Phase-agent pipeline** — 10 phases: triage → research → plan → implement → verify → review → pr → monitor-merge → monitor-deploy → teardown
- **dispatchMode** — `phase-agents` (default) / `execution-core` (daemon) / `oneshot-legacy` (fallback); set in `.catalyst/config.json`
- **Signal files** — `workers/<TICKET>/phase-*.json` are authoritative per-worker state
- **Durable state** — `~/catalyst/catalyst.db` (SQLite, WAL), `~/catalyst/state.json` (active-orchestrator summary) — runtime, not in repo

## Build / test / verify
- Plugins (markdown/bash): no build. Reload by restarting the agent session.
- orch-monitor: `cd plugins/dev/scripts/orch-monitor && bun test` (verify BOTH `ui/` and parent package)
- TypeScript changes: the `/catalyst-dev:validate-type-safety` gate (tsc + reward-hacking scan + tests + lint)
- CI gates on `main`: agents-md-gate, docs-gate, audit-references, gitleaks, quality (bun test), CodeQL, Cloudflare Pages

## Conventions
- Commits: `feat(dev):` / `fix(pm):` / `chore(meta):` etc. (scopes: dev, pm, meta, analytics, debugging, …)
- main stays on main; every change via worktree → PR. `main` is gated by a ruleset that requires
  all review threads (incl. the `chatgpt-codex-connector` Codex bot) resolved.
- Agents are documentarians: describe what EXISTS, don't critique or suggest unless asked.
