# Catalyst Dev Plugin

Complete development workflow: research → plan → implement → validate → ship. 25 skills and 9 research agents covering the full Level 1 (single-skill) and Level 2 (guided-workflow) stack, plus Level 3 orchestration.

See the [Skills Reference](https://catalyst.coalescelabs.ai/reference/skills/) and [Agents Reference](https://catalyst.coalescelabs.ai/reference/agents/) for detailed per-skill documentation. The list below is the current inventory only.

## Skills (25)

### Research & Planning

- `/catalyst-dev:research-codebase` — Parallel codebase research with specialized agents
- `/catalyst-dev:create-plan` — Interactive TDD implementation planning
- `/catalyst-dev:iterate-plan` — Revise existing plans after feedback

### Implementation

- `/catalyst-dev:implement-plan` — Execute plans phase by phase using TDD (supports `--team`)
- `/catalyst-dev:validate-plan` — Verify implementation against plan success criteria
- `/catalyst-dev:oneshot` — End-to-end autonomous Level 2 workflow (supports `--team`, `--auto-merge`)
- `/catalyst-dev:orchestrate` — Level 3 multi-ticket coordinator (wave-based parallelism + adversarial verification)
- `/catalyst-dev:setup-orchestrate` — Bootstrap an orchestrator worktree and print the launch command
- `/catalyst-dev:code-first-draft` — Initial feature implementation from a PRD
- `/catalyst-dev:fix-typescript` — Fix TypeScript errors with strict anti-reward-hacking rules
- `/catalyst-dev:scan-reward-hacking` — Scan for forbidden patterns (`as any`, `@ts-ignore`, etc.)
- `/catalyst-dev:validate-type-safety` — 5-step type safety gate (typecheck + scan + tests + lint)

### Shipping

- `/catalyst-dev:commit` — Conventional commits with Linear integration
- `/catalyst-dev:create-pr` — Full PR creation: commit, rebase, push, description, Linear update
- `/catalyst-dev:describe-pr` — Generate or incrementally update PR descriptions
- `/catalyst-dev:merge-pr` — Safe squash merge with CI verification and branch cleanup
- `/catalyst-dev:review-comments` — Process PR review comments, fix, push, resolve threads

### Session & Workspace

- `/catalyst-dev:create-handoff` — Save session context for continuation
- `/catalyst-dev:resume-handoff` — Resume from a handoff document
- `/catalyst-dev:create-worktree` — Create git worktree for parallel development

### Integrations & References (model-invocable)

- `/catalyst-dev:linear` — Linear ticket operations (user-invocable)
- `/catalyst-dev:linearis` — Linearis CLI reference (activates on ticket IDs)
- `/catalyst-dev:agent-browser` — Browser automation CLI reference

### CI / Automation (non-interactive)

- `/catalyst-dev:ci-commit` — Non-interactive commit variant
- `/catalyst-dev:ci-describe-pr` — Non-interactive PR description variant

## Agents (9)

### Research

- `@catalyst-dev:codebase-locator` — Find files and directories (Haiku)
- `@catalyst-dev:codebase-analyzer` — Understand implementation details (Sonnet)
- `@catalyst-dev:codebase-pattern-finder` — Find reusable patterns and examples (Sonnet)
- `@catalyst-dev:thoughts-locator` — Search thoughts repository (Haiku)
- `@catalyst-dev:thoughts-analyzer` — Analyze documentation and decisions (Sonnet)
- `@catalyst-dev:external-research` — Research external repos and libraries (Sonnet)

### Infrastructure

- `@catalyst-dev:linear-research` — Gather Linear data via CLI (Haiku)
- `@catalyst-dev:github-research` — Research GitHub PRs and issues (Haiku)
- `@catalyst-dev:sentry-research` — Research Sentry errors (Haiku)

## Automatic Workflow Context Tracking

The plugin ships Claude Code hooks that keep `.catalyst/.workflow-context.json` up to date automatically. See [HOOKS.md](./HOOKS.md) and [WORKFLOW_CONTEXT.md](./WORKFLOW_CONTEXT.md) for the full mechanism.

Summary:

- Writes to `thoughts/shared/{research,plans,handoffs,prs}/*.md` are tracked
- Ticket IDs are extracted from filenames and directories
- Plan Mode hooks inject Catalyst's plan-structure guidance and sync plans to thoughts
- Skills read workflow context to discover prior artifacts without explicit paths

## Installation

```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-dev
```

## Configuration

Reads `.catalyst/config.json` (safe to commit) and `~/.config/catalyst/config-{projectKey}.json` (never committed — secrets). See the [Configuration Reference](https://catalyst.coalescelabs.ai/reference/configuration/) for the full schema.

Quick setup:

```bash
curl -fsSL https://raw.githubusercontent.com/coalesce-labs/catalyst/main/setup-catalyst.sh | bash
```

## Requirements

- **Required**: Git, Bash
- **Optional**: HumanLayer CLI (`pip install humanlayer`) for the thoughts persistence system
- **Optional**: Linearis CLI (`npm install -g linearis`) for Linear integration
- **Optional**: GitHub CLI (`brew install gh`) for PR workflows

## Scripts

Runtime utilities under `scripts/`:

- `catalyst-db.sh` — SQLite session store CRUD and schema migrations (see ADR-008)
- `catalyst-monitor.sh` — On-demand orch-monitor server management (`start`, `stop`, `status`, `open`, `url`)
- `catalyst-session.sh` — Lifecycle CLI for agent sessions (`start`, `phase`, `metric`, `tool`, `pr`, `end`, `heartbeat`, `list`, `read`, `history`). Writes to SQLite via `catalyst-db.sh` and dual-writes JSONL events for backward compatibility
- `catalyst-state.sh` — Writes to `~/catalyst/state.json` and `~/catalyst/events/YYYY-MM.jsonl`
- `check-prerequisites.sh` — Validate tool availability
- `check-project-setup.sh` — Validate workspace has thoughts system, config, etc.
- `create-worktree.sh` — Worktree creation with setup hooks
- `frontmatter-utils.sh` — Parse and update markdown frontmatter
- `orch-monitor/` — React SPA + Bun server dashboard (default port 7400, configurable via `MONITOR_PORT`). Reads `~/catalyst/catalyst.db` (SQLite, WAL mode) and watches `~/catalyst/wt/`. Start with `cd plugins/dev/scripts/orch-monitor && bun run server.ts`, or use `catalyst-monitor.sh open`
- `orchestrate-fixup` — Fix issues found during orchestration verification
- `orchestrate-followup` — Handle follow-up tasks after orchestration completes
- `orchestrate-verify.sh` — Adversarial verification checks (test existence, reward-hacking patterns)
- `pre-assign-migrations.sh` — Pre-assign database migration numbers to avoid conflicts
- `resolve-ticket.sh` — Extract ticket IDs from various contexts
- `workflow-context.sh` — Read/write `.catalyst/.workflow-context.json`

Hooks under `hooks/`:

- `update-workflow-context.sh` — PostToolUse hook that tracks thoughts writes
- `sync-plan-to-thoughts.sh` — Plan mode exit hook
- `inject-plan-template.sh` — Plan mode enter hook

## Philosophy

1. **Agents are documentarians** — Report what exists, don't critique
2. **Skills orchestrate** — Spawn parallel agents, manage processes
3. **Context is precious** — Use thoughts system for persistence between sessions
4. **Automation via hooks** — Track automatically, not manually
5. **Worker-side work has a boundary** — Workers exit at PR creation; polling-until-merged is the orchestrator's job

## Documentation

- [Architecture](../../docs/architecture.md)
- [ADRs](../../docs/adrs.md)
- [Releases](../../docs/releases.md)
- [Documentation Site](https://catalyst.coalescelabs.ai)

## License

MIT
