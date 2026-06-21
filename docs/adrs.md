# Architecture Decision Records

Decision log. Each entry: Decision + key rationale/consequences. ADR numbers and outcomes are load-bearing — do not renumber or drop.

> Code-anchored note (verified 2026-06-21): the broker was refactored from a single ~1300-line `broker/index.mjs` into modules. `index.mjs` (~635 lines) is now a barrel that re-exports. Canonical homes: `PHASE_EVENT_PATTERN` → `broker/namespace-contract.mjs`; `phase_lifecycle` interest → `broker/config.mjs`; `shouldSkipEvent`, `handleRegister/Deregister`, routing → `broker/router.mjs`; projection helpers → `broker/projection.mjs`. Older ADRs cite `index.mjs:<line>`; trust the module names over the line numbers.

---

## ADR-001: Plugin-Based Distribution
Distribute Catalyst as Claude Code plugins (not git clone). Updates via `/plugin update`; marketplace discoverability; local `.catalyst/config.json` preserved. Cost: plugin structure in `plugins/*/` must be maintained; breaking changes need version management; users install only what they need (dev/meta/pm/…).

## ADR-002: HumanLayer Profile-Based Configuration
Use HumanLayer's native `profile`/`repoMappings` to auto-select the thoughts repo per working directory — no manual `configName`. Init with `humanlayer thoughts init --profile <name>`; scripts discover the current repo via `humanlayer thoughts status`. Projects stay isolated.

## ADR-003: Three-Layer Memory Architecture
Separate **config** (project settings, committable), **long-term** (thoughts, git-backed, synced via `humanlayer thoughts sync`), and **short-term** (workflow-context, session state, gitignored). Skills update workflow-context when creating docs.

## ADR-004: Workflow-Context for Session State
Store recent doc references in `.catalyst/.workflow-context.json` so skills chain (`research → plan → implement`) without users tracking paths. Local per-worktree, never committed, no secrets. Managed via `scripts/workflow-context.sh`. Lost on worktree delete (by design).

## ADR-005: Configurable Worktree Convention
Organize repos/worktrees via `GITHUB_SOURCE_ROOT`. Main: `${ROOT}/<org>/<repo>`; worktrees: `${ROOT}/<org>/<repo>-worktrees/<feature>`. `create-worktree.sh` detects org from git remote; falls back to `~/wt/<repo>`. No hardcoded paths.

## ADR-006: Global Orchestrator State
Single `~/catalyst/state.json` global registry of active orchestrators + append-only event log `~/catalyst/events/YYYY-MM.jsonl` (rotated monthly) + completed snapshots in `~/catalyst/history/<id>--<startedAt>.json`. Layout also includes `~/catalyst/catalyst.db` (SQLite, WAL) and `~/catalyst/wt/`.

- Global state is a denormalized query summary; per-worktree `state.json` still serves crash recovery.
- Writes go through `catalyst-state.sh` (mkdir-based locking, no flock dep). Events append lock-free (POSIX atomic). `cat *.jsonl | jq` queries across months.
- Heartbeat: orchestrators write `lastHeartbeat` each poll; `catalyst-state.sh gc` archives entries stale >10 min as `abandoned`.
- Contract schemas: `plugins/dev/templates/global-state.json`, `global-event.json`.

## ADR-008: SQLite Session Store
Add `~/catalyst/catalyst.db` (SQLite, WAL) as the durable store for **session analytics** (not a replacement for the event log, which remains the live cross-process bus per ADR-006/018). Managed by `catalyst-db.sh` (schema/migrate/CRUD) and `catalyst-session.sh` (sub-50ms write CLI: `start|phase|metric|tool|pr|end|emit-context`).

Schema (`db-migrations/001_initial_schema.sql`): `sessions`, `session_events`, `session_metrics`, `session_tools`, `session_prs`, `schema_migrations`. (Migrations dir now runs 001–006.) `orch-monitor` reads the DB directly (WAL concurrent readers). Dual-write to the JSONL stream is retained for tools that consume it. `sqlite3` is an optional dep.

## ADR-009: Daily Release Cadence
Cut one release/day via scheduled merge at 05:00 UTC instead of auto-merging the release-please Release PR on every push to `main` — avoids per-merge point releases and mid-wave `update-branch` rebase cascades.

- `release-please.yml` opens/updates the Release PR + runs `enhance-release-notes.sh` on every push.
- `release-please-scheduled-merge.yml` (05:00 UTC) finds the `autorelease: pending` PR, verifies mergeability, merges; exits 0 on empty day; `workflow_dispatch` = manual "cut now". Blocked/conflicted PR → dedup'd `release-health` issue.
- **Intraday channel (deferred):** marketplace auto-update gates on `plugin.json.version`, which moves once/day. MVP for early access = install from a commit SHA on `main` (zero plumbing). Designed-but-deferred: a `next` branch fast-forwarding `main` with `-rc.<n>` version bumps + a second marketplace entry. `check-release-health.sh` check #2 unchanged. Rollback = revert the two workflow changes.

## ADR-010: Catalyst CLI Install via `~/.catalyst/bin/`
Install `catalyst-*` CLIs as symlinks in `~/.catalyst/bin/` with one `$PATH` entry — works across zsh/bash/fish without shell-specific alias blocks; `ls` is a discoverable inventory; symlinks strip `.sh`. `install-cli.sh` is authoritative for the exposed-CLI allowlist (update it when adding a CLI). Plugin updates move scripts to a version-stamped cache path, staling symlinks; re-run `setup-catalyst`/`install-cli.sh` to repair (`check-setup.sh` surfaces broken links). Uninstall: `install-cli.sh --uninstall`.

## ADR-011: Hybrid SQLite + Filesystem Archive for Orchestrator Artifacts
Persist orchestrator artifacts out of runs/worktrees into a two-layer store: **blobs** at `~/catalyst/archives/{orchId}/` (summaries, briefings, signals, phase logs, comms, metadata.json) + **index** in three SQLite tables (`orchestrators`, `archived_workers` PK `(orch_id,worker_id)`, `archived_artifacts` UNIQUE `(orch_id,path)`; `db-migrations/003_archives.sql`). Written by `orch-monitor/catalyst-archive.ts sweep`; served read-only via `/api/archive/*`.

- Rationale: pure-SQLite balloons on text blobs; pure-FS loses query speed. Hybrid = indexed metadata + unbounded blobs.
- **Filesystem-first invariant**: blobs written via atomic tmp+rename BEFORE SQLite rows; on SQLite failure `catalyst-archive sync` rebuilds the index from disk.
- Teardown refuses to delete unless the sweep succeeded (or `--force`). File serving is path-traversal safe (`realpathSync` must resolve within `archive_path`; rel segments regex-validated). Subcommands: `sweep|sync|prune|list|show` (prune respects `archive.retentionDays`).

## ADR-012: Webhook-Driven orch-monitor with smee.io Tunnel
Migrate orch-monitor from 30s poll-everything to webhook-driven ingestion via a smee.io tunnel, polling kept as a 10-min fallback. The 30s loop ran ~26.6k GraphQL calls/hr (222 PRs, ~3 active), draining the 5k/hr GitHub bucket in ~11 min (CTL-209). Webhooks deliver in seconds at zero budget. smee.io = least-resistance local delivery (no public ingress/Worker); `gh webhook forward` rejected (CLI-session-oriented). Repo-level subscriptions via lazy `ensureSubscribed(repo)`. Hard cutover (no feature flag); worst case = 10-min poll fallback.

- New dep `smee-client@^5.0.0`; `lib/webhook-*.ts` modules; `POST /api/webhook`. Config adds `catalyst.monitor.github.smeeChannel` + `webhookSecretEnv` (HMAC secret in env); `setup-webhooks.sh` is the idempotent helper.
- Startup replay: 1-hr delivery window from `gh api repos/{repo}/hooks/{id}/deliveries` replayed through the live handler (synthetic signing) to reconcile downtime.
- Every accepted event fans out to `~/catalyst/events/YYYY-MM.jsonl` with topic `<source>.<noun>.<verb>` (e.g. `github.pr.merged`) — seeded the unified event bus that CTL-210 (Linear webhooks + `catalyst-events` CLI, shipped) and CTL-211 (worker DoD = deploy success, shipped) build on. Steady state: well under the 5k/hr ceilings.

## ADR-013: Event-Driven Worker Waits (`wait-for-github` two-phase)
Replace `gh pr view --json` (GraphQL) poll loops in worker skills with a `catalyst-events wait-for` blocking call over the unified event log, plus a REST-authoritative re-check after each wake. GraphQL polling exhausted the 5k/hr budget (CTL-209). REST (`gh api repos/{repo}/pulls/{n}`) is cheaper and returns `.mergeable_state`.

Two-phase: (1) `wait-for --timeout 180` for any relevant event → REST check; on timeout run diagnostics. (2) Diagnostics: count heartbeats in last 500 lines, re-check tunnel; healthy → extend, else REST fallback. (3) `--timeout 7200` (2-hr) when infra confirmed healthy. (4) REST fallback `sleep 300` loop when tunnel down. Filter jq must cover v1 (`.event`) and v2 (`.attributes."event.name"`) envelopes. Never use `.mergeable_state` as sole signal (eventually-consistent) — always REST re-check.

## ADR-014: Worker Owns Full PR Lifecycle (CTL-252)
Remove `gh pr merge --auto` from all worker skills. After opening a PR the worker enters the ADR-013 listen loop, resolves blockers inline, runs `gh pr merge --squash --delete-branch` directly when CLEAN, and writes `status:"done"`. Orchestrator Phase 4 becomes a safety net for crashed workers only (poll relaxed to 10-min). `autoMergeArmedAt` removed from the `pr` signal subobject. State machine shrinks to `pr-created → done`.

## ADR-015: Bidirectional catalyst-comms (CTL-249)
Add inbound reads to workers: poll the shared comms channel at each phase boundary for `--filter-to <ticket-id>` messages, using a `COMMS_LAST_READ` cursor (initialized to line count at join) to skip pre-join history. Recognized inbound: `abort` (immediate exit); others TBD. **ACK gap**: no delivery guarantee (CTL-253 tracks ACK). `catalyst-comms send` emits `comms.message.posted` (v2 envelope) so tools observe traffic without reading the channel file. ~5 poll calls/run added.

## ADR-016: Claude Code metadata on the canonical envelope (CTL-374)
**Accepted 2026-05-13.** Claude Code per-session telemetry (context %, cost, turns, model) is exposed only via the statusLine pipeline, not hooks. Add five typed attributes — `claude.session.id`, `claude.model`, `claude.context.used_pct`, `claude.context.tokens`, `claude.turn` — plus a `session.context` event emitted by `catalyst-statusline.sh` per tick, and `attention.context_pressure` when context crosses 70% upward.

Migration `005_claude_session_metadata.sql` adds `claude_session_id` (bound via `catalyst-session.sh start --claude-session-id`, fallback `CLAUDE_CODE_SESSION_ID`; indexed) and `last_context_pct` (threshold bookkeeping; read/written by `emit-context`).

**PII boundary**: `cost_usd` is intentionally NOT a typed attribute — it rides in `body.payload.cost_usd`, which the OTLP forwarder (`otel-forward/lib/destinations/otlp.ts`) does NOT forward (it forwards `attributes` + `body.message` only). Payload stays on-machine. **Install**: point `statusLine.command` at `catalyst-statusline.sh` (renders via `ccstatusline` / `$CATALYST_STATUSLINE_CMD`; emit runs detached so failures never break the status bar). Single 70% threshold matches the implement-plan handoff rule; more thresholds deferred.

## ADR-017: Phase-Agent Dispatch Architecture (CTL-447 → CTL-470)
**Accepted 2026-05-17.** Pre-CTL-452 dispatched one long-lived `claude -p /catalyst-legacy:oneshot <TICKET>` per ticket, running the full lifecycle in one context window → context rot, one worst-case turn cap for all phases, crash-recovery from a saturated state.

**Decision**: dispatch one short-lived `claude --bg --resume /catalyst-dev:phase-<name> <TICKET> --orch-dir <ORCH_DIR>` per phase. The orchestrator walks the canonical **10-phase** sequence `triage → research → plan → implement → verify → review → pr → monitor-merge → monitor-deploy → teardown` (teardown split out as the dedicated terminal phase in CTL-703) via `orchestrate-phase-advance`, waking on `phase.<name>.complete.<TICKET>` routed by the broker `phase_lifecycle` interest. Selected by `.catalyst/config.json → catalyst.orchestration.dispatchMode`: `"phase-agents"` is the template default; `"oneshot-legacy"` is the fallback.

- Per-phase turn caps (`phase-agent-dispatch` `phase_default_turn_cap`, overridable via `catalyst.orchestration.phaseAgents.turnCaps`) — e.g. triage ~10, implement ~75. Per-phase model selection (`phaseAgents`) lets cheap phases (monitor-deploy defaults to Haiku) skip Opus cost.
- `phase_lifecycle` is a deterministic regex match (`broker/namespace-contract.mjs`: `^phase\.([^.]+)\.(complete|failed|turn-cap-exhausted|skipped)\.([A-Za-z][A-Za-z0-9_]*-\d+)$`) — no LLM classification; one interest per ticket. All four orchestrator interests (`pr_lifecycle`, `ticket_lifecycle`, `comms_lifecycle`, `phase_lifecycle`) fire back as `filter.wake.<ORCH_NAME>`.

**Consequences**:
- Signal layout splits: flat `workers/<TICKET>.json` plus per-phase `workers/<TICKET>/phase-<name>.json`.
- `--bg` healthcheck (`orchestrate-healthcheck`) stats `${JOBS_ROOT}/<bg>/state.json` (default `~/.claude/jobs/<bg>/state.json`); files older than `--stale-bg-seconds` (default 900) with `.state` not in `{done,failed,errored,stopped}` = stalled. PID liveness still covers `oneshot-legacy`.
- Intermediate Linear states (CTL-454): `triaged`, `researching`, `planning`, `verifying`, `reviewing` (+ existing `inProgress`/`inReview`), mapped via `stateMap` (opt-in).
- Revive budget at the top-level signal (`reviveCount`); `>= MAX_REVIVES` (default 10) → `stalled`, `attentionReason="revive-budget-exhausted"`. Once-per-phase; second `failed` for the same phase escalates.
- Legacy `oneshot-legacy` preserved (catalyst-legacy plugin); cutover is per-project.
- Built across CTL-447 (broker interest), 452 (state-machine rewrite + `--bg` cutover), 454 (Linear states), 455 (session_metrics fix) → 470. Internal reference: `docs/orchestrator-overview.md`. Related: ADR-006, ADR-008, ADR-014.

## ADR-018: Event-Sourced Worker Signal Files via Broker Projection (CTL-483)
**Accepted 2026-05-17.** Phase 1 (dual-write) shipped; Phases 2–3 tracked separately. `workers/<TICKET>.json` is written by seven racing code paths (dispatch-next, followup, the worker agent, healthcheck, revive, auto-fixup, auto-rebase) with no inter-process locking — cross-script races silent. The broker already event-sources `broker-interests.json` from `filter.register/deregister`.

**Decision**: move worker-state mutations to "emit a `worker.state_changed` command event; broker projects to disk". Event carries the FULL new state in `body.payload.state` (not a patch). Dual-write in three phases (mirrors ADR-008):
- **Phase 1 (this ADR)**: writers keep direct `jq>tmp&&mv` AND emit the event; broker projects to a **shadow path** `workers/<TICKET>.json.projected` (never races direct writes). `orchestrate-shadow-diff` reports drift. PoC writer: `orchestrate-auto-rebase`; the other six migrate one at a time.
- **Phase 2 (cutover)**: at zero drift across a full cycle for all seven, remove direct writes; broker becomes sole writer at the canonical path.
- **Phase 3 (optional)**: mirror to SQLite `worker_state` `(orch_id,ticket)` (ADR-011 hybrid).

Event attrs: `catalyst.orchestrator.id`, `catalyst.worker.ticket`, `catalyst.writer`, `body.payload.state`. Envelope in `references/event-schema.md`; name registered in `event-name-allowlist.md` under `worker_lifecycle`. Broker handler `handleWorkerStateChanged` (exported from `broker/index.mjs`, defined in router/projection modules) derives the shadow path via `getProjectedWorkerStatePath` and writes atomically via `writeProjectedWorkerState` (adds `_projected {writer,ts}`); honors `CATALYST_RUNS_DIR`. Writer helper `lib/emit-worker-state-changed.sh` (best-effort, silent failure). Feedback-loop safe: broker never emits `worker.state_changed`, so no `shouldSkipEvent` rule needed.

**Supersedes** ADR-006's `workers/<TICKET>.json` design only; global state + event log stay in force. Cost: ~5–10 extra events/run; double signal disk in Phase 1 (files <2 KB).

## ADR-019: Turn-cap exhaustion → automated handoff continuation (CTL-484)
Phase agents have turn caps (default 75 for implement). Before CTL-484, `orchestrate-revive` treated a turn-cap stop as a failure, burning the revive budget on successful forward progress; tickets needing >75 turns silently hit `revive-budget-exhausted`.

**Decision**: introduce `turn-cap-exhausted` as a distinct non-terminal status in `phase_lifecycle` routing. A worker nearing the cap writes a handoff to `thoughts/shared/handoffs/<TICKET>/<ts>_turn-cap-continuation.md` and emits `phase.<name>.turn-cap-exhausted.<TICKET>` (handoff path in payload). `orchestrate-revive`: detects it → spawns `claude --bg --resume <session_id>` with `CATALYST_IS_CONTINUATION=true`, `CATALYST_HANDOFF_PATH`, `CATALYST_CONTINUATION_COUNT` → bumps `.continuationCount` on a **separate** budget (`MAX_CONTINUATIONS`, default 3) → exhaustion = `stalled`, `attentionReason="continuation-budget-exhausted"`. Resumed worker reads the handoff and trusts the summary.

Lives in: `phase-agent-emit-complete` / `lib/phase-emit-complete.sh` (`--status turn-cap-exhausted --handoff-path`); broker `PHASE_EVENT_PATTERN` (`namespace-contract.mjs`, tests `phase-lifecycle.test.mjs`); `templates/worker-signal.json` (`continuationCount`, `continuations[]`, `handoffPath`) + `signal-schema.ts` + `state-reader.ts`; `orchestrate-revive` (`spawn_continuation_bg`, `--max-continuations`); `resume-handoff/SKILL.md`; `phase-implement/SKILL.md` (producer). Rationale: distinct routable status (not a payload discriminator); separate budget (reviveCount ≠ continuationCount); worker self-detection (no external watchdog); bash-templated handoff (background path can't run interactive `create-handoff`); non-terminal (omits `completedAt`, off `TERMINAL_STATUSES`). Rejected: raise MAX_REVIVES, bump caps in config, external watchdog. Scope = `phase-implement` for v1; reusable infra.

## ADR-020: Phase-mode turn-cap continuation lives in `orchestrate-revive`, not the daemon (CTL-613)
ADR-019's loop ran against the legacy top-level signal; phase-mode workers (ADR-017 default) write only per-phase `workers/<TICKET>/phase-<name>.json`, so it's a no-op for them. The CTL-493 per-phase loop only consumed `stalled` and silently skipped `turn-cap-exhausted` → handoff sat unused, ticket hung (incident ADV-1134). The daemon's `execution-core/signal-reader.mjs` correctly classifies `turn-cap-exhausted` as terminal (continuation ≠ reclaim).

**Decision**: add a branch to `orchestrate-revive`'s CTL-493 per-phase loop that consumes `P_STATUS=="turn-cap-exhausted"` directly: budget-check `.phaseContinuationCount` (shares `MAX_CONTINUATIONS`=3 with ADR-019's counter, tracked separately), resolve session id + worktree, spawn via `spawn_continuation_bg`, set per-phase signal back to `running`, emit `phase.<name>.dispatched` to re-arm the broker. Resolve the prior session id from `~/.claude/jobs/<bg>/state.json::linkScanPath` (basename minus `.jsonl`) rather than plumbing it into the signal — keeps the dispatcher's single-write contract intact. Daemon terminal classification stays; recovery is the script's job, invoked by the daemon sweep. New `resolve_phase_session_id` coexists with the legacy `resolve_session_id`.

## ADR-021: Workspace-level type-label taxonomy (CTL-995)
All six type labels (`bug`, `feature`, `refactor`, `docs`, `chore`, `test`) live at **workspace** scope under a `type` label group, with canonical colors: bug `#e5484d`, feature `#8b5cf6`, refactor `#14b8a6`, docs `#3b82f6`, chore `#8d8d8d`, test `#22c55e`. Pre-migration, four were per-team duplicates (color drift, per-team ID lists). `issueLabelUpdate(teamId:null)` was rejected by the API → used rename-create-relabel-delete. Tooling must filter by the workspace IDs in `thoughts/shared/research/2026-06-10-ctl-995-label-taxonomy-migration.md`. Component labels (orchestrator/broker/phase-agent/monitor/cli/ci/website/estimation/worktree) remain team-scoped; only the type axis is workspace-level.

## ADR-022: Belief engine is a derivation layer; "log → projection" is the directional target, not the shipped reality
**Accepted (direction) 2026-06-14.** Track A active; Track B is a deliberate un-started bet. Sources: `thoughts/shared/research/2026-06-14-resilience-and-peer-platform-learnings.md`, `…/2026-06-13-catalyst-patentability-and-open-core-strategy.md`.

The conceptual fit is exact — Datalog EDB→IDB closure **is** event-sourcing's `state=fold(log)`. The engine (`execution-core/beliefs/`, CTL-962→967, CTL-1063) gets determinism right: `now` captured once/tick (`collector.mjs`), EDB frozen in one SQLite txn during eval, and a differential shadow oracle (`advance-shadow.mjs`) comparing Datalog `advance_to` vs procedural `deriveAdvancement`. But three facts bound the claim:
1. **EDB is fed from mutable live state, not the log.** 8 of 9 `obs_*` tables are live probes; the one log-sourced table `obs_heartbeat` is permanently empty (no `worker.heartbeat` emitter, `collector.mjs`). As shipped = "the filesystem is the agent, observed through Datalog," not a log projection.
2. **The `rules.dl` compiler compiles only 3 of 18 rules** (`compiler/index.mjs`); load-bearing logic (recursive S5 deps, S6 `advance_to`/`cycle_exhausted`) is `extern` hand-written SQL with a 61 KB hand-synced generated artifact.
3. **Advancement is graded against the 33-line procedural `deriveAdvancement` as ground truth** — porting to Datalog can at best equal it (low standalone ROI).

The engine has been shadow/dark its whole life; graduation is blocked on prerequisites that don't exist (a log-sourced EDB; `caused_by` + monotonic `seq` on the envelope, both verified absent).

**Decision**: (1) Affirm "immutable log → deterministic projection" as the target; keep the engine as the projection substrate — don't rip it out. (2) Stop calling the EDB a "log projection" in docs until its authoritative tables come from the log. (3) Split the ambition: **Track A** — derivation/health/provenance/absence-detection (S5 deps, `catalyst why`, negation-over-time); keep, invest, graduate. **Track B** — Datalog owns the control path (R16/R17 replace `deriveAdvancement`, log-sourced EDB, `signal.json` demoted to regeneratable projection); a deliberate bet gated by the `advance-shadow` zero-disagreement oracle. (4) First graduation = the resilience absence-detector ("no `github.*`/`linear.*` event in N min → `ingestion_stale`"), which forces emitting heartbeat/webhook-freshness events (fixes empty `obs_heartbeat`) — all Track A.

Rationale: decide/act seam stays a bright line (Datalog derives; an imperative executor acts — `escalate.mjs`, gated `CATALYST_INTENTS_ENFORCE=1`, sits outside the rule engine). Datalog not Prolog (guaranteed termination for a control plane; bounded `WITH RECURSIVE` only). Per-tick EDB checkpoints = the snapshot half of event sourcing. Consequences: `caused_by` + monotonic `seq` are prerequisites (`EVENT_SCHEMA_CAUSAL_SEQ` gap, near-free). The 3/18 compiler's fate is decided by Track-B intent (migrate `extern` rules or retire the compiler). Do NOT "fix" `REVIVE_BUDGET=1` (dead code; CTL-736 progress-gate is live). Complements ADR-018 / ADR-006/008. Rejected: rip out the engine; promote `advance_to` now; full "log is the agent" rewrite now (= Track B).

## ADR-023: Shadow→Enforce Rollout Discipline for Autonomous Actuators
**Accepted 2026-06-16.** The fleet has many autonomous actuators (session reaper CTL-649/657, proc-reaper CTL-1165, stall-janitor CTL-1004/1064, unstuck-sweep CTL-1064, belief executors CTL-962→967, fleet-health self-heal CTL-1165 D5), each able to take a hard-to-reverse action. The 1,798-job / 17 GB-swap reap-leak (CTL-1165) is the cautionary case. Verified 2026-06-16: every recovery actuator runs on its conservative default (shadow/off).

**Decision** — one discipline for every actuator:
1. **Rules DERIVE, executors ACT** — decide/act bright line (mirrors ADR-022).
2. **Dark by default** — ships `off`/`shadow`, gated by one knob (env flag `CATALYST_INTENTS_ENFORCE` / `CATALYST_STALL_JANITOR` / `CATALYST_UNSTUCK_SWEEP` / `CATALYST_DIAGNOSTICIAN` / `EXECUTION_CORE_FLEET_SELF_HEAL`, or Layer-1 mode `orphanReaper.procReaper.mode`).
3. **Three-state `off → shadow → enforce`** — shadow emits a "would-X" twin (`procOrphans.would-reap`, `unstuck.would.push`, `janitor.would.kill`, the `advance-shadow` comparator).
4. **Gated criteria flips** — shadow→enforce needs written criteria verified on real hosts over a real window (CTL-1165 proc-reaper criteria = template: ≥3–5 days of real candidates, each spot-checked, no false spared/reaped, steady-state bounded).
5. **Reversible by unset** — flip reverts by unsetting + restart; gates fail closed.
6. **One at a time** — independent knobs; never a blanket on.

Rationale: shadow-first + gated criteria makes harm observable before possible. **Known coarseness**: `CATALYST_INTENTS_ENFORCE` is today a single flag arming four belief executors at once — safety rests on each being idempotent/bounded (`labelOnce`, bgJobId-pinned kill, max-attempts) until per-intent granularity exists. This is the deterministic-vs-flexible boundary (flexible LLM layer = ADR-025). Consequences: new actuators MUST ship `off|shadow|enforce` + `would-X` + written criteria; modes instantiated in `website/.../reference/configuration.md` + schema enum; flips operator-owned (no auto-promotion) — the **ownerless-gate risk** (clean shadow evidence with nobody flipping) is itself an operator concern (ADR-025/CTL-1176). Rejected: enable-on-merge; single global enforce flag.

## ADR-024: Mechanical Fleet Hygiene — Reapers, Janitors, GC (Thread 1)
**Accepted 2026-06-16.** Each phase-agent worker leaves durable state: a `~/.claude/jobs/<id>` dir, an `execution-core/workers/<TICKET>/` signal dir, a `~/catalyst/wt/` worktree, reparented `node`/`bun` children. Two incidents: the reap-leak (1,798 dirs / 17 GB, CTL-1165) and a 2026-06-16 incident where 137 `execution-core/workers/` dirs cold the CTL-731 liveness snapshot (`inFlightCount:0` while workers live) → daemon held all new-work dispatch incl Urgent.

**Decision** — one named layer of bounded deterministic cleaners, each governed by ADR-023:
1. **Session/bg-worker reaper** (CTL-649/657) — `claude stop` + `reap-complete`. Enforce.
2. **proc-reaper** (CTL-1165 D2, `orphanReaper.procReaper.mode`) — kills reparented grandchildren. Shadow; flip gated on CTL-1165 criteria.
3. **job-dir GC** (CTL-1165 D3) — removes aged `~/.claude/jobs` past 24 h.
4. **worker-dir GC** (CTL-1205, NEW) — removes `execution-core/workers/<TICKET>/` on pipeline completion (reaper `pr.merged` cleanup, after worktree removal) + periodic Done/merged sweep. Nothing reaped these before; the per-tick `readdirSync` over the pile cold the CTL-731 snapshot.
5. **stall-janitor** (CTL-1004/1064, `CATALYST_STALL_JANITOR`) — J1 reaps orphan worktrees, J2 kills idle ghost sessions, J3 re-dispatches the narrow `prior-artifact-retry-exhausted` stall. Shadow→enforce.
6. **unstuck-sweep** (CTL-1064, `CATALYST_UNSTUCK_SWEEP`) — category-aware rescuer; `actByCategory` seams intentionally unwired (`{}`).
7. **fleet-health probe** (CTL-1165 D5) — alerts `fleet.health.degraded` on jobs/swap/procs thresholds; self-heal default-off.

**Boundary (load-bearing)**: these operate on fleet *state*, not ticket content (= ADR-025). Not interchangeable: the stall-janitor reaps worktrees+sessions but NOT worker-state dirs (= worker-dir GC). A cold liveness snapshot is a worker-dir-GC problem, not a stall-janitor one (misdiagnosed the 2026-06-16 incident). Rationale: liveness depends on hygiene (CTL-731 guard pressured by per-tick I/O over accumulated dirs); single clear target per cleaner; the event log is source of truth so removing a completed ticket's dir is safe (daemon restores on boot). Consequences: worker-dir GC (CTL-1205) is the durable fix for the cold-snapshot class; each cleaner follows ADR-023. Rejected: let state accumulate; one mega-reaper.

## ADR-025: Pre-Human Reasoning-Recovery Sweep and Operator Surfacing (Thread 3)
**Accepted (direction) 2026-06-16.** Surfacing shipped (CTL-1180/1182/1181); the reasoning sweep (CTL-1176) is proposed, not built. When a ticket stalls/fails/needs a decision, it must **surface** to the operator and ideally something should try to **unstick** it first. Both were broken: ADV-1392's `pr` phase failed (`push_rejected_no_workflow_scope`) and surfaced nowhere (`needs-human` was applied only for `stalled`, never `failed`); CTL-1167 stalled with no comment; a scan found **31 silently-stuck tickets/month vs 6 `escalate.human` events**. Nothing reasons over the queue (diagnostician CTL-937/828 evidence-only/dark; janitor J3 narrow; `phase-remediate` CTL-653 in-pipeline only; unstuck-sweep seams unwired).

**Decision** — a flexible LLM-reasoning recovery layer in front of the human inbox (distinct from ADR-024 hygiene and ADR-022 belief):
1. **Reasoning recovery sweep (CTL-1176)** — periodic LLM pass over the stuck/failed/needs-human queue; per item, reconstruct from log + belief store + worktree/PR/CI and ask "human-decision or can I unblock?". Resolves mechanical cases via existing deterministic seams; escalates only true human-decisions **with a written reason**. Unifies diagnostician + janitor + sweeper + remediator. **Guardrail (CTL-828 three-panel)**: NOT a general fixer — DETERMINISTIC when stuck-type is typed and fix mechanical; LLM only with a structured brief + downstream deterministic re-check + hard cycle cap; HUMAN otherwise. No open-ended re-dispatch authority (reopens CTL-736 revive-storm). Every decision → log + Linear comment.
2. **Surfacing model (CTL-1180, shipped)** — a terminally-`failed` phase surfaces like `stalled`: `needs-human` for `status ∈ {failed, stalled}` when not pipeline-done (scheduler terminal sweep), plus a `phaseFailed`/`escalationType` trigger in the monitor's `deriveAttention` → Needs-You inbox + nav dot + `/queue`. Closes the `failed ≠ stalled` gap.
3. **Always-record comment policy (CTL-1182, shipped)** — every phase, including failed, records its outcome on the ticket; codified `linearis` fallback when the app-actor mirror fails.
4. **Registered deterministic act-seams the sweep invokes** — workflow-scope push detour (CTL-1181), sibling-conflict resolve (CTL-855), orphan-PR detect/adopt (CTL-1175/1159/1160), ADR-024 cleaners. The LLM *selects among* registered seams; it never invents mutations.

Rationale: the fleet only alerts + escalates then stops; the "try to clean it up first" step was scaffolding only (31:6 quantifies the cost). Deterministic-vs-flexible boundary (ADR-023): hygiene stays gated; LLM judgment is bounded to "human-or-not + which seam." Surfacing is the floor — inbox membership keys on worker-dir/event status (`failed`/`stalled`/`needs-human`), not just `gh pr list`, so failed-but-no-PR cases surface. Consequences: CTL-1176 needs its own scoping doc (becomes this ADR's implementation vehicle); belief executors (ADR-022) and this sweep are complementary; this is the "supervisor" record previously split across CTL-780/828/937. Rejected: a general open-ended re-dispatch agent (CTL-828 panel — reopens CTL-736); surfacing-only (leaves resolvable stalls consuming attention); leave re-engagement to the inference engine's lease rules (CTL-780 — that's the deterministic complement, held).
