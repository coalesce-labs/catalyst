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
  - CLI syntax lives in skills (e.g., the `linearis` skill, which also defines the two-mode rule for agent Linear reads — standard vs. Catalyst Cloud node) — reference it, don't copy
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

## Observability (OpenTelemetry: Loki · Tempo · Prometheus · Grafana)

The Catalyst daemons and the underlying AI coding agent emit OpenTelemetry signals through a shared
OTel Collector that fans out to three backends, all visualized and alerted in Grafana. **Traces
EXPLAIN; metrics DETECT + LOCALIZE** — and the scheduler-health (RED) metrics are derived from the
*unsampled* Tier-1 logs (via Collector connectors), so never wire health metrics off the
tail-sampled spans. Other metrics (the native `catalyst.agent` host gauges, the agent's own native
counters) are emitted *directly* to the OTLP metrics pipeline, not log-derived.

- **Logs & events → Loki (LogQL).** Catalyst events (forwarded by the `otel-forward` service) and the
  Tier-1 daemon `.log` lines (shipped by Alloy) both land in Loki — confirm a given event/field is
  present before alerting on it. Only `service_name` and `service_namespace` are stream labels
  (the cheap selectors and the
  cross-signal join key); every other field (`host_name`, `event_*`, `catalyst_node_name`, …) is
  **structured metadata** — filter with `| field="x"`, aggregate with `sum by (field)`;
  `label_values(field)` returns empty for it. The log body is a plain string — do **not** `| json` it
  unless the line is a full-JSON daemon `.log`. Use `absent_over_time` for silence detection
  (a fully-dead daemon is a missing series, which `count_over_time == 0` cannot assert).
- **Traces → Tempo (TraceQL).** Daemon spans are live: `scheduler.tick` (root) with threshold-gated
  `scheduler.pass` children and `liveness.refresh`, plus per-run `install` and context-engine
  `index.run` traces. Tempo serves the per-tick/per-run flame graph that explains a wedge after the
  metrics localize it; the metrics-generator is off and trace↔log correlation does not fully
  round-trip yet (disjoint id spaces).
- **Metrics → Prometheus (PromQL).** OTel dotted names become underscores and counters gain a
  `_total` suffix; counters need `rate()`/`increase()` **innermost** then `sum by (...)` outermost —
  never graph the raw counter. `signal_to_metrics` gauges are last-value and expire ~15m at rest.
  Cross-signal joins go through the normalized labels `service_name`/`service_namespace` (underscore
  form — the dotted `service.name` is the semantic-convention name, not the Prometheus label); host
  identity is only reliable within `catalyst.*` (short `host_name`).
- **Alerting → Grafana.** Alert rules are **file-provisioned** (`provisioning/alerting/*.yaml`) and
  **upsert-only** — a malformed rule file crash-loops the *shared* Grafana, so validate any change
  against a throwaway Grafana before deploying. Active rules cover the scheduler wedge
  (tick / recovery-pass / liveness-timeout), needs-human pileup, slot starvation, and install/updater
  failures.

**Signal catalog — the data dictionary.** The authoritative, signal-by-signal reference (every
metric, log/event, trace span, and alert — with dimensions, gotchas, and copy-pasteable query
patterns) lives in the sister repo **`catalyst-otel`** at `docs/data-dictionary.md`. **Read it before
designing telemetry or trusting a query.** That repo (`collector-config.yaml`,
`grafana-datasources.yml`, `tempo.yaml`, `dashboards/`, `provisioning/alerting/`) is the authoritative
stack topology. For a copy-paste-runnable diagnose→unstick→file playbook against the live stack, see
the `sensing-substrate` skill.

**Endpoints are environment-specific.** Backend addresses are resolved from environment variables —
`OTEL_EXPORTER_OTLP_ENDPOINT` / `CATALYST_OTLP_ENDPOINT` for the daemons (collector ingest), and
`CATALYST_AGENT_OTLP_ENDPOINT` / `CATALYST_AGENT_METRICS_ENDPOINT` for the standalone `catalyst-agent`
emitter (which stays silent if those are unset). The concrete addresses for a given deployment live in
that deployment's config and the team's notes, not in this repository.

## Pull requests

A pull request is **not mergeable** until BOTH are true:

- **All CI checks pass.** A failing or pending required check blocks the merge.
- **Every review is resolved.** If the PR has any review (automated code review or human), each review thread/conversation must be addressed and marked resolved. An unresolved review blocks the merge even when checks are green.

So after opening a PR: watch the checks to green, then address every review comment (push fixes), reply, and resolve each thread before considering the PR done.

**Reading the automated reviewer's signal.** When the automated code reviewer finds nothing, it
signals a clean pass with a 👍 reaction (or a brief "no major issues" note) **instead of** opening
review threads — that counts as a resolved review with nothing to address, not a missing one. The
clean-pass result may arrive as a reaction or a plain comment rather than a structured review
object, so detect it via reactions/comments, not only the reviews API. A re-review after a fix
push may need to be requested explicitly rather than firing automatically.

## Reference Docs

Read these on demand:

- **Architecture & data flow** — `docs/architecture.md`
- **Run lifecycle** — `docs/orchestrator-overview.md`
- **Decision records (ADRs)** — `docs/adrs.md`
- **Release process** — `docs/releases.md`
- **Observability signal catalog** — `catalyst-otel/docs/data-dictionary.md` (sister repo: every
  metric, log/event, trace, and alert; see the Observability section above)
