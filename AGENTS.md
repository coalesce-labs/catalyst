# AGENTS.md

Guidance for AI coding agents working in this repository. This file is the portable, tool-agnostic source of truth. Tool-specific agents may keep their own thin bridge file that imports this one and adds tool-specific notes — keep that detail out of here.

## What This Repository Is

A **portable collection of agents, skills, and workflows** for AI-assisted development, distributed as plugins. It is both:

1. A **source repository** for plugin-based agents and skills
2. A **working installation** that uses its own tools (dogfooding)

Agents and skills are organized in `plugins/*/` and surfaced to the agent via local symlinks.

## Agent Philosophy

All agents follow a **documentarian, not critic** approach:

- Document what EXISTS, not what should exist
- NO suggestions for improvements unless explicitly asked
- NO root cause analysis unless explicitly asked
- NO architecture critiques or quality assessments
- Focus on answering "WHERE is X?" and "HOW does X work?"

<!-- catalyst-house-rules:begin -->
## Working the Loop (every agent — interactive too, not just skills)

These are house rules for anyone touching this repo's dev / PR / ticket workflow — whether you are running a slash-command skill **or** working interactively and ad-hoc. They are **default reflexes, not skill internals**: reach for them without being told, even on a one-off PR you opened by hand. They defer their mechanism to the `catalyst-dev` plugin, available in every Catalyst-managed repo. If that plugin is somehow unavailable, that is a broken environment — repair it (reload the plugin) rather than routing around it. For GitHub state only, a single **bounded** `gh` check is an acceptable last resort while you do; never a poll loop, and never a raw Linear API read (the replica-read rule below is absolute).

- **Reporting a negative → run a positive control first, or report inconclusive.** A negative result is only evidence if you can state what a positive one would have looked like **and you ran the same instrument against a case known to be present and saw it come back non-zero.** Before you report "zero", "absent", "unrelated", "clean", or "not owned", ask the question that separates *the thing is not there* from *I could not look* — and if you cannot separate them, say **inconclusive**. The five mechanisms that have actually produced a false clean result here, all of them silent: (1) an unstructured match over structured data — a substring `grep` for an event name counted the name where it appeared inside a commit message, reporting events that did not exist; (2) a malformed call returning a falsy sentinel — an ownership helper invoked with its arguments transposed returned `undefined` for every ticket, which reads as "not owned"; (3) an empty input set feeding a loop, so the body never ran and the trailing all-clear line printed on the strength of zero iterations (`[].every(p)` is `true`); (4) the right question asked of the wrong surface — counting a bot's issue comments returned zero while an unresolved *review thread* was the thing blocking the merge; (5) **the search tool skipping files it never says it skipped** — in the agent shell `grep` is a wrapper around `ugrep --ignore-files`, which honours `.gitignore`, and `~/.config/catalyst/.gitignore` excludes `config*.json`, so **a recursive grep never reads any live Catalyst config** and answers "not configured anywhere" for a value sitting in `config.json`. It is convincing because the `.bak-*` copies do NOT match that pattern, so you get plausible hits from stale backups while the live file is skipped. A recursive-grep zero over config, secrets, or build output is **inconclusive** until re-run with `/usr/bin/grep` or an explicit file list. (Sibling traps in the same family: `find` does not follow symlinks, so it misses what `cat`/`readFileSync` read straight through — e.g. bun's `.bun` store entries; and zsh kills an unquoted `--include=*.mjs` with "no matches found", returning nothing, which also reads as a real zero.) Prefer the verified helpers in `plugins/dev/scripts/lib/verified-checks.mjs` (count events by exact `event.name`, resolve ticket ownership under named rosters, enumerate every merge blocker) — each returns a verdict that can be explicitly **inconclusive** and throws on malformed input rather than degrading to a falsy answer. This rule governs the bullets below: a check that cannot fail loudly is not evidence for any of them.
- **Waiting on GitHub / CI / Linear state → subscribe to the event log when it exists, bounded-poll otherwise; never an unbounded poll loop.** To block on a state change (a PR merged, CI turning green, a review posted, a push to a branch, a ticket transition), wait instead of re-querying in a loop. Where the unified Catalyst event log is live (`~/catalyst/events/YYYY-MM.jsonl`), `catalyst-events wait-for` blocks on it without polling. Where that substrate is absent — the relay default since the daemon's retirement — use the **bounded-poll** pattern: a foreground, single-session, quota-conscious loop with a fixed interval and a hard ceiling, documented in `catalyst-dev`'s `merge-pr` skill (`plugins/dev/skills/merge-pr/references/bounded-poll.md`). An unbounded `gh` / `linearis` poll loop burns shared-quota API budget and silently misses reaction-only signals (next bullet).
- **Judging an automated code review → a clean pass is a reaction, not a review object.** The automated PR reviewer signals "no issues" with a 👍 reaction (or a terse "no major issues" comment) **instead of** opening review threads — detect it via the PR's reactions and issue comments, not only the reviews API. Recognizing the clean pass does **not** waive the rule that a PR is mergeable only once **every** review thread has been addressed and resolved.
- **Reading one Linear ticket → the freshness-gated local replica, not bare `linearis`.** Invoke the `catalyst-dev:linearis` skill and follow its "Reading Linear" contract — it reads the local replica behind a freshness gate (via its `linear_read_ticket` helper, run in the plugin's skill context) and does the loud stale/absent fallback for you. Don't hand-roll the read yourself: an **un-gated** `sqlite3` of the replica skips the freshness check (you may read stale data or create an empty DB), and a bare `linearis issues read <ID>` hits the rate-limited API and 429s the shared fleet quota — don't reach for it even as a fallback; the skill's helper owns the loud stale/absent path. Writes and list/search go through `linearis`.
- **Spawning a background process → make the LOOP ITSELF self-limiting; never let cleanup be load-bearing.** A background process must not be able to outlive the command that started it. Give it its own deadline so it dies on its own **even if every cleanup line you wrote is broken** — an unbounded `while :; do :; done` has no place in this repo. Prefer a self-limiting loop; it needs no external command and is portable — but it must **sleep**, not spin: `end=$((SECONDS+120)); while [ $SECONDS -lt $end ]; do sleep 1; done`. An empty body (`do :; done`) re-evaluates `$SECONDS` as fast as the CPU allows and burns a whole core for the duration — which is the very incident this rule exists to prevent, so do not write the deadline loop that way even though it terminates. If the background work is a real command rather than a keep-alive, prefer a watchdog that sleeps and then signals: `cmd & p=$!; (sleep 120; kill "$p" 2>/dev/null) & w=$!; wait "$p"; kill "$w" 2>/dev/null`. (`timeout` / `gtimeout` are a convenience *if* present — stock macOS, the fleet's primary launchd environment, ships neither and GNU coreutils is not a dependency, so never depend on them.) This is not hypothetical — four such spinners leaked out of one test run and burned ~4 CPU cores for 16.5 hours while the script that spawned them reported `cleanup verified`. Three traps, all of which fired in that incident:
  - **The shell here is `zsh`, which does NOT word-split an unquoted parameter.** `PIDS="$PIDS $!"; for p in $PIDS; do kill $p; done` iterates **once**, with the whole string as a single argument, and dies with `illegal pid`. Collect into an array (`pids+=($!)`) and iterate that, or write the ids to a file and read them back with `while read`.
  - **Never verify with a probe that fails open.** `kill -0 "$p" 2>/dev/null && echo STILL_ALIVE` prints nothing when the probe *itself* errors, so the script self-certifies success whether or not anything actually died. Assert positively and fail closed — `ps -p "$p" >/dev/null 2>&1 && { echo "LEAKED: $p"; exit 1; }` — the same discipline the worktree-safety gates already use.
  - **Backgrounded children survive a normal exit.** When your command returns, `&` children reparent to PID 1 and run forever, which is precisely why the deadline has to live inside the child rather than in the parent's cleanup.

  Before reporting a background task complete, prove the machine is clean (e.g. `pgrep -fl 'while :'`). Scoping applies too: write only inside your own worktree, and chain with `cd <dir> && <cmd>` — a bare `cd` on its own line that silently fails will apply your edits to whichever worktree the shell happened to be in.
- **Coordination has THREE roles, and "orchestrator" is not one of them.** Long-running coordination is done by single-threaded owners: a **concierge** (the one agent a human talks to — owns the status board, the ask inbox, routing and project scaffolding, and holds **no authority over stewards**), a **steward** (owns ONE initiative or project end-to-end until it closes; makes work ready and visible, the fleet does it), and **workers** (one phase of one ticket, driven by the pipeline). Invoke the `concierge` and `steward` skills by name; the phase pipeline's shared contract is `phase-agent-contract`. ⚠️ Reserve **"orchestrator"** for the pipeline MACHINERY — never for an agent or a person: this repo already calls the phase runners *workers* in code (`workers/<ticket>/`, `worker.session.started`), so a role by that name reads as the scheduler. Three rules bind you even when you are none of these roles:
  - **Reply where the message arrived, threaded, and never as the human.** A comment inside a scope is answered by that scope's **steward**, in-thread and tagged. Anything only a human can decide becomes an **ask ticket** (`catalyst-dev:ask`) with Options + a Default if silent — and you **proceed on the default**. Never answer someone else's ask, and never post as the human.
  - **Escalate inward, never outward:** instrument → steward → concierge → human (as an ask). An agent or instrument that pages a human directly is a defect, and a bare label in a human's queue is a defect.
  - **A stuck agent is a request for help, NOT an escalation — and the steward's job is to answer it.** The steward holds the broader context and has the standing mandate to *unblock*, not to relay. ⛔ **Gate zero — do you even know WHY it is stuck?** "Why has this not moved?" is **never** an escalation; it is a diagnosis job you **dispatch yourself, automatically**, the moment you notice a stall, a no-pickup, a phase that will not advance, or a PR that will not merge. Never file an ask whose options amount to *investigate vs don't investigate* or *wait vs look* — that spends a human's attention authorising work the agent could simply have done. When you do escalate afterwards, lead with **the cause**: an ask carrying a diagnosis is worth a human's time, an ask carrying a question mark usually is not. (Ryan, 2026-08-21, on an ask that offered him "leave it — it will pick up on its own" versus "investigate", and then held a P1 as his top blocking item for ~13h.) Only once the cause is known do the next three questions apply: **can I decide this myself?** (technical calls — which approach, retry-or-abandon, rebase-or-re-cut — are theirs, not the human's); **does this need to block at all?** (if a sane default exists, take it and record it — see the ask rule above); and **who else can move this?** They may pull in another agent, another steward, or the human, and pulling in a peer is the preferred move. Only a genuine product/priority/approval decision — or an action only a human can physically take — survives to become an ask. ⛔ **A system-level failure is never a per-ticket human block.** Provider overloaded, out of capacity, rate-limited, connectivity down: that is ONE fleet alert, and the affected tickets retry and resume by themselves. Measured 2026-08-21: of 86 items flagged as waiting on a human, **3** genuinely were — 41 were the model provider being overloaded, escalated one ticket at a time as if each were a priority call.
  - **Rank what does reach the human by blast radius, not by age.** An ask must record what it `blocks`, and the ordering the human sees is *how much open work is held, weighted by that work's priority* — `catalyst-dev:ask` → `references/triage.md`, with `scripts/ask-triage.sh` ready-made. Search for an existing ask before filing a new one and attach to it instead of duplicating: duplicates split one decision's urgency across several rows and sink it below trivia.
  - **Cite an identifier only after `create` returned it.** A guessed ticket number is usually a real, unrelated ticket — worse than no number at all.
- **Skills here use progressive disclosure — read the reference you need, not all of them.** A skill is a short `SKILL.md` covering the common path, plus `references/*.md` loaded **on demand**; the SKILL.md names which reference answers which situation. Follow that table rather than reading the whole tree. `plugins/dev/skills/__tests__/skill-shape.test.sh` enforces the shape and `skills-gate` runs it on every PR, so the budget is real.
- **Never hard-wrap markdown prose — semantic breaks only.** Let paragraph lines run long; break only at paragraph, list-item, or code-block boundaries, never mid-sentence at a fixed column. This applies to every markdown file you write — thoughts docs, Linear comments, AGENTS.md/SKILL.md prose, all of it. A hard-wrapped seed file is not a style footnote: agents imitate the shape of what they read before writing their own words, so a wrapped template propagates its wrap habit into every doc written in its image (CTL-2216).
<!-- catalyst-house-rules:end -->

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
- **Linear reads → local replica** — for a single-ticket read call `linear_read_ticket <ID>` (it gates freshness and falls back loudly); never a bare `linearis issues read <ID>` (it 429s the shared-quota fleet). Writes and list/search stay on `linearis`. See the `linearis` skill's "Reading Linear".

## Skill & Agent References

Skills are namespaced `plugin-name:skill-name` (e.g. `catalyst-dev:create-plan`, `catalyst-pm-ops:groom-backlog`). When instructing a reader to invoke a skill, use the fully-qualified name; bare names are acceptable in explanatory prose describing workflow relationships. Agent (subagent) references always use the full `plugin-name:agent-name` form.

## Knowledge Store

- `thoughts/shared/learnings/` — past problem→solution entries (grep by component/tags/problem_type). Search before implementing or debugging in a known area. Curated by `catalyst-dev:ticket-compound`.
- `thoughts/shared/CONCEPTS.md` — shared domain vocabulary (reclaim, revive-budget, orphan, signal ownership…).
- `thoughts/shared/retros/` — compound-loop outputs, written automatically at every merge (CTL-831): `ticket/<date>.md` cross-ticket retros (`catalyst-dev:ticket-retro`); `estimate/<YYYY-WW>-compound-log.md` per-PR estimation actuals (`catalyst-dev:compound-estimate`).

## Code Understanding (Serena)

Coding agents orient on this codebase through **Serena** — a self-hosted, local, LSP-backed MCP server that provides semantic code retrieval (the replacement for the removed DeepWiki MCP). It lets agents answer "where does X live / how is Y wired / who calls Z" in a few precise calls instead of many broad `Grep`s, getting up to speed with far fewer tool calls and tokens.

- **Install (per machine):** `uv tool install -p 3.13 serena-agent`, then register it as a **user-scope MCP server** that runs `serena start-mcp-server`. Use the absolute path to the `serena` binary so background worker jobs with a restricted `PATH` can launch it, and run it headless on servers. It connects with no startup project and activates lazily. The exact per-agent registration command lives in the bridge file.
- **Versioned config (committed):** `.serena/project.yml` (languages `typescript` + `bash`, `read_only: true`, ignores the harness worktree dir / `thoughts` / build output, plus an `initial_prompt` pointer) and `.serena/memories/codebase_map.md` (the directory map agents read via `read_memory("codebase_map")`). The per-machine symbol cache `.serena/cache/` is gitignored; build it with `serena project index`.
- **Wiring:** the research/analysis agents (`codebase-analyzer`, `codebase-locator`, `codebase-pattern-finder`) and skills (`research-codebase`, `create-plan`) grant the read-only `mcp__serena__*` tools; `research-codebase` Step 0 activates the project, reads the `codebase_map` memory, and maps symbols before spawning sub-agents.
- **Use it:** `activate_project` (repo root / `.`) → `list_memories` / `read_memory` → `get_symbols_overview`, `find_symbol`, `find_referencing_symbols`, `search_for_pattern`. It is read-only — editing stays with the implement agents' `Edit`/`Write`.

## Commit Conventions

- `feat(dev): add new skill` — catalyst-dev minor bump
- `fix(pm-ops): correct cycle calculation` — catalyst-pm-ops patch bump
- `feat(dev)!: breaking change` — catalyst-dev MAJOR bump
- `chore(meta): update docs` — no version bump
- Valid scopes (one per plugin): `dev`, `meta`, `pm-ops`, `foundry`

**Versioning (CTL-2263):** release-please auto-bumps `version.txt` and both `plugin.json` files, writes each `CHANGELOG.md`, and cuts a GitHub release — but only after a conventional-commit PR merges to `main`, via its own release PR, never inside the PR that changed the plugin. Do **not** hand-bump the version in the same PR as the change — a hand bump plus release-please's own bump on the next release PR is a double bump. Just use a conventional commit message; `scripts/check-plugin-version.sh` (the `check-versions` PR check) is what enforces the format, and it is a gate on the message, not a bumper itself. See `docs/releases.md` → "Versioning" for the full mechanism.

## Version Control

This workspace tracks: agent definitions, skills, documentation, scripts, configuration templates.

**Do NOT commit**: Specific ticket prefixes (keep "PROJ"), Linear team/project IDs (keep null), personal thoughts user (keep null).

## Configuration

Two-layer config system:

- **Layer 1**: `.catalyst/config.json` (safe to commit) — project key, ticket prefix, state map
- **Layer 2**: `~/.config/catalyst/config-{projectKey}.json` (NEVER committed) — API tokens, secrets

## Dependencies

**Required**: Git, Bash, and an AI coding agent

**Optional**: HumanLayer CLI (`humanlayer`) for the thoughts persistence system, Linearis CLI (`linearis`), GitHub CLI (`gh`), `catalyst-session` CLI (`plugins/dev/scripts/catalyst-session.sh`), `sqlite3`

## Plugin Development

Edit plugin files in `plugins/*/`, test locally (symlinks make changes immediate), reload by restarting your agent session.

## Orchestration

Catalyst's **execution-core daemon** ships work as **phase-agent workers** — one short-lived background agent job per phase, walking a 10-phase pipeline (triage → research → plan → implement → verify → review → pr → monitor-merge → monitor-deploy → teardown). The pre-phase-agent wave-orchestration model (the **catalyst-legacy** plugin: `oneshot`, `orchestrate`, `god`, `setup-orchestrate`) was removed once the daemon it served was retired (CTL-2241); dispatch today is relay-based (`/relay-ticket <TICKET>`, see the `relay-ticket` skill), not a resident daemon.

Cross-process communication is built on a **single unified event log** at `~/catalyst/events/YYYY-MM.jsonl`. Workers, the phase dispatcher, the broker, the webhook receiver, and `catalyst-comms send` all append; the broker daemon, the HUD, the orch-monitor web dashboard, and `catalyst-events wait-for` all read.

## Observability (OpenTelemetry: Loki · Tempo · Prometheus · Grafana)

The Catalyst daemons and the underlying AI coding agent emit OpenTelemetry signals through a shared OTel Collector that fans out to three backends, all visualized and alerted in Grafana. **Traces EXPLAIN; metrics DETECT + LOCALIZE** — and the scheduler-health (RED) metrics are derived from the *unsampled* Tier-1 logs (via Collector connectors), so never wire health metrics off the tail-sampled spans. Other metrics (the native `catalyst.agent` host gauges, the agent's own native counters) are emitted *directly* to the OTLP metrics pipeline, not log-derived.

- **Logs & events → Loki (LogQL).** Catalyst events (forwarded by the `otel-forward` service) and the Tier-1 daemon `.log` lines (shipped by Alloy) both land in Loki — confirm a given event/field is present before alerting on it. Only `service_name` and `service_namespace` are stream labels (the cheap selectors and the cross-signal join key); every other field (`host_name`, `event_*`, `catalyst_node_name`, …) is **structured metadata** — filter with `| field="x"`, aggregate with `sum by (field)`; `label_values(field)` returns empty for it. The log body is a plain string — do **not** `| json` it unless the line is a full-JSON daemon `.log`. Use `absent_over_time` for silence detection (a fully-dead daemon is a missing series, which `count_over_time == 0` cannot assert).
- **Traces → Tempo (TraceQL).** Daemon spans are live: `scheduler.tick` (root) with threshold-gated `scheduler.pass` children and `liveness.refresh`, plus per-run `install` and context-engine `index.run` traces. Tempo serves the per-tick/per-run flame graph that explains a wedge after the metrics localize it; the metrics-generator is off and trace↔log correlation does not fully round-trip yet (disjoint id spaces).
- **Metrics → Prometheus (PromQL).** OTel dotted names become underscores and counters gain a `_total` suffix; counters need `rate()`/`increase()` **innermost** then `sum by (...)` outermost — never graph the raw counter. `signal_to_metrics` gauges are last-value and expire ~15m at rest. Cross-signal joins go through the normalized labels `service_name`/`service_namespace` (underscore form — the dotted `service.name` is the semantic-convention name, not the Prometheus label); host identity is only reliable within `catalyst.*` (short `host_name`).
- **Alerting → Grafana.** Alert rules are **file-provisioned** (`provisioning/alerting/*.yaml`) and **upsert-only** — a malformed rule file crash-loops the *shared* Grafana, so validate any change against a throwaway Grafana before deploying. Active rules cover the scheduler wedge (tick / recovery-pass / liveness-timeout), system trouble (CTL-2156), slot starvation, and install/updater failures.

**Signal catalog — the data dictionary.** The authoritative, signal-by-signal reference (every metric, log/event, trace span, and alert — with dimensions, gotchas, and copy-pasteable query patterns) lives in the sister repo **`catalyst-otel`** at `docs/data-dictionary.md`. **Read it before designing telemetry or trusting a query.** That repo (`collector-config.yaml`, `grafana-datasources.yml`, `tempo.yaml`, `dashboards/`, `provisioning/alerting/`) is the authoritative stack topology.

**Endpoints are environment-specific.** Backend addresses are resolved from environment variables — `OTEL_EXPORTER_OTLP_ENDPOINT` / `CATALYST_OTLP_ENDPOINT` for the daemons (collector ingest), and `CATALYST_AGENT_OTLP_ENDPOINT` / `CATALYST_AGENT_METRICS_ENDPOINT` for the standalone `catalyst-agent` emitter (which stays silent if those are unset). The concrete addresses for a given deployment live in that deployment's config and the team's notes, not in this repository.

## Pull requests

A pull request is **not mergeable** until BOTH are true:

- **All CI checks pass.** A failing or pending required check blocks the merge.
- **Every review is resolved.** If the PR has any review (automated code review or human), each review thread/conversation must be addressed and marked resolved. An unresolved review blocks the merge even when checks are green.

So after opening a PR: wait for the checks to go green (subscribe to the event log — see **Working the Loop**, don't poll `gh` in a loop), then address every review comment (push fixes), reply, and resolve each thread before considering the PR done.

**Reading the automated reviewer's signal.** When the automated code reviewer finds nothing, it signals a clean pass with a 👍 reaction (or a brief "no major issues" note) **instead of** opening review threads — that counts as a resolved review with nothing to address, not a missing one. The clean-pass result may arrive as a reaction or a plain comment rather than a structured review object, so detect it via reactions/comments, not only the reviews API. A re-review after a fix push may need to be requested explicitly rather than firing automatically.

**Deferring lower-priority findings after round one.** Fix every P0/P1 finding immediately, on every review round — that severity is never deferred. On a PR's *first* round of review-driven fixes, use judgment on P2-and-lower findings: fix the ones that are real, cheap, and clearly correct; defer the rest. On any later round (a re-review after a remediation push), P2-and-lower is always deferred, no exceptions — even a trivial one-liner goes to a follow-up ticket, not an inline fix: file the ticket, reply on the thread linking it, and resolve the thread. This still satisfies "every review thread resolved" above — deferral resolves the thread via that reply, it does not leave it open. The point is to stop chasing progressively finer findings across many review↔fix rounds; see `catalyst-dev:review-comments` for the mechanism.

**Queue-merge (Mergify, CTL-2266).** `.mergify.yml` extends the catalyst-cloud merge-queue trial to this repo. Once the queue is activated (a one-time dashboard step, not automatic), applying the `queue:ready` label **is** the merge instruction and the review attestation in one (CTC-1200 — the label substitutes for a structured review object because the automated reviewer's clean pass is sometimes only a 👍 reaction). Apply it only on positive review evidence — every thread resolved, no outstanding P0/P1 — never preemptively; Mergify then enqueues, waits out the required checks, and squash-merges as `mergify[bot]` with no coordinator update-branch/CI-wait cycle. `hold:hand-steps` is the escape hatch for a PR that still needs a manual step — applying it (or simply not applying `queue:ready`) keeps a PR on the hand-merge path above. Hand-merge stays mandatory, regardless of label, for anything the config excludes by path or branch: `.github/workflows/publish-*`, `plugins/dev/scripts/db-migrations/`, `.mergify.yml` itself, and `release-please--*` branches.

## Reference Docs

Read these on demand:

- **Architecture & data flow** — `docs/architecture.md`
- **Run lifecycle** — `docs/orchestrator-overview.md`
- **Decision records (ADRs)** — `docs/adrs.md`
- **Specs & mockups** — `docs/specs/` (durable `draft → accepted` home for specs, requirements, and mockups; distinct from ADRs and `thoughts/` — see `docs/specs/README.md`)
- **smee retirement + rollback** — `docs/runbooks/cloud-feed-cutover.md` (CTL-1928 retired the Linear half 2026-08-17; CTL-1929 retired the **GitHub** half 2026-08-18 — both ingestion legs are now the cloud feed, all 15 webhooks are disabled-not-deleted, and the runbook holds the four per-host verify-by-content checks and both rollback lever pairs)
- **Release process** — `docs/releases.md`
- **Observability signal catalog** — `catalyst-otel/docs/data-dictionary.md` (sister repo: every metric, log/event, trace, and alert; see the Observability section above)
