# Architecture Decision Records

Decision log. Each entry: Decision + key rationale/consequences. ADR numbers and outcomes are
load-bearing — do not renumber or drop.

> Code-anchored note (verified 2026-06-21): the broker was refactored from a single ~1300-line
> `broker/index.mjs` into modules. `index.mjs` (~635 lines) is now a barrel that re-exports.
> Canonical homes: `PHASE_EVENT_PATTERN` → `broker/namespace-contract.mjs`; `phase_lifecycle`
> interest → `broker/config.mjs`; `shouldSkipEvent`, `handleRegister/Deregister`, routing →
> `broker/router.mjs`; projection helpers → `broker/projection.mjs`. Older ADRs cite
> `index.mjs:<line>`; trust the module names over the line numbers.

---

## ADR-001: Plugin-Based Distribution

Distribute Catalyst as Claude Code plugins (not git clone). Updates via `/plugin update`;
marketplace discoverability; local `.catalyst/config.json` preserved. Cost: plugin structure in
`plugins/*/` must be maintained; breaking changes need version management; users install only what
they need (dev/meta/pm/…).

## ADR-002: HumanLayer Profile-Based Configuration

Use HumanLayer's native `profile`/`repoMappings` to auto-select the thoughts repo per working
directory — no manual `configName`. Init with `humanlayer thoughts init --profile <name>`; scripts
discover the current repo via `humanlayer thoughts status`. Projects stay isolated.

## ADR-003: Three-Layer Memory Architecture

Separate **config** (project settings, committable), **long-term** (thoughts, git-backed, synced via
`humanlayer thoughts sync`), and **short-term** (workflow-context, session state, gitignored).
Skills update workflow-context when creating docs.

## ADR-004: Workflow-Context for Session State

Store recent doc references in `.catalyst/.workflow-context.json` so skills chain
(`research → plan → implement`) without users tracking paths. Local per-worktree, never committed,
no secrets. Managed via `scripts/workflow-context.sh`. Lost on worktree delete (by design).

## ADR-005: Configurable Worktree Convention

Organize repos/worktrees via `GITHUB_SOURCE_ROOT`. Main: `${ROOT}/<org>/<repo>`; worktrees:
`${ROOT}/<org>/<repo>-worktrees/<feature>`. `create-worktree.sh` detects org from git remote; falls
back to `~/wt/<repo>`. No hardcoded paths.

## ADR-006: Global Orchestrator State

Single `~/catalyst/state.json` global registry of active orchestrators + append-only event log
`~/catalyst/events/YYYY-MM.jsonl` (rotated monthly) + completed snapshots in
`~/catalyst/history/<id>--<startedAt>.json`. Layout also includes `~/catalyst/catalyst.db` (SQLite,
WAL) and `~/catalyst/wt/`.

- Global state is a denormalized query summary; per-worktree `state.json` still serves crash
  recovery.
- Writes go through `catalyst-state.sh` (mkdir-based locking, no flock dep). Events append lock-free
  (POSIX atomic). `cat *.jsonl | jq` queries across months.
- Heartbeat: orchestrators write `lastHeartbeat` each poll; `catalyst-state.sh gc` archives entries
  stale >10 min as `abandoned`.
- Contract schemas: `plugins/dev/templates/global-state.json`, `global-event.json`.

## ADR-008: SQLite Session Store

Add `~/catalyst/catalyst.db` (SQLite, WAL) as the durable store for **session analytics** (not a
replacement for the event log, which remains the live cross-process bus per ADR-006/018). Managed by
`catalyst-db.sh` (schema/migrate/CRUD) and `catalyst-session.sh` (sub-50ms write CLI:
`start|phase|metric|tool|pr|end|emit-context`).

Schema (`db-migrations/001_initial_schema.sql`): `sessions`, `session_events`, `session_metrics`,
`session_tools`, `session_prs`, `schema_migrations`. (Migrations dir now runs 001–006.)
`orch-monitor` reads the DB directly (WAL concurrent readers). Dual-write to the JSONL stream is
retained for tools that consume it. `sqlite3` is an optional dep.

## ADR-009: Daily Release Cadence

Cut one release/day via scheduled merge at 05:00 UTC instead of auto-merging the release-please
Release PR on every push to `main` — avoids per-merge point releases and mid-wave `update-branch`
rebase cascades.

- `release-please.yml` opens/updates the Release PR + runs `enhance-release-notes.sh` on every push.
- `release-please-scheduled-merge.yml` (05:00 UTC) finds the `autorelease: pending` PR, verifies
  mergeability, merges; exits 0 on empty day; `workflow_dispatch` = manual "cut now".
  Blocked/conflicted PR → dedup'd `release-health` issue.
- **Intraday channel (deferred):** marketplace auto-update gates on `plugin.json.version`, which
  moves once/day. MVP for early access = install from a commit SHA on `main` (zero plumbing).
  Designed-but-deferred: a `next` branch fast-forwarding `main` with `-rc.<n>` version bumps + a
  second marketplace entry. `check-release-health.sh` check #2 unchanged. Rollback = revert the two
  workflow changes.

## ADR-010: Catalyst CLI Install via `~/.catalyst/bin/`

Install `catalyst-*` CLIs as symlinks in `~/.catalyst/bin/` with one `$PATH` entry — works across
zsh/bash/fish without shell-specific alias blocks; `ls` is a discoverable inventory; symlinks strip
`.sh`. `install-cli.sh` is authoritative for the exposed-CLI allowlist (update it when adding a
CLI). Plugin updates move scripts to a version-stamped cache path, staling symlinks; re-run
`setup-catalyst`/`install-cli.sh` to repair (`check-setup.sh` surfaces broken links). Uninstall:
`install-cli.sh --uninstall`.

## ADR-011: Hybrid SQLite + Filesystem Archive for Orchestrator Artifacts

Persist orchestrator artifacts out of runs/worktrees into a two-layer store: **blobs** at
`~/catalyst/archives/{orchId}/` (summaries, briefings, signals, phase logs, comms, metadata.json) +
**index** in three SQLite tables (`orchestrators`, `archived_workers` PK `(orch_id,worker_id)`,
`archived_artifacts` UNIQUE `(orch_id,path)`; `db-migrations/003_archives.sql`). Written by
`orch-monitor/catalyst-archive.ts sweep`; served read-only via `/api/archive/*`.

- Rationale: pure-SQLite balloons on text blobs; pure-FS loses query speed. Hybrid = indexed
  metadata + unbounded blobs.
- **Filesystem-first invariant**: blobs written via atomic tmp+rename BEFORE SQLite rows; on SQLite
  failure `catalyst-archive sync` rebuilds the index from disk.
- Teardown refuses to delete unless the sweep succeeded (or `--force`). File serving is
  path-traversal safe (`realpathSync` must resolve within `archive_path`; rel segments
  regex-validated). Subcommands: `sweep|sync|prune|list|show` (prune respects
  `archive.retentionDays`).

## ADR-012: Webhook-Driven orch-monitor with smee.io Tunnel

Migrate orch-monitor from 30s poll-everything to webhook-driven ingestion via a smee.io tunnel,
polling kept as a 10-min fallback. The 30s loop ran ~26.6k GraphQL calls/hr (222 PRs, ~3 active),
draining the 5k/hr GitHub bucket in ~11 min (CTL-209). Webhooks deliver in seconds at zero budget.
smee.io = least-resistance local delivery (no public ingress/Worker); `gh webhook forward` rejected
(CLI-session-oriented). Repo-level subscriptions via lazy `ensureSubscribed(repo)`. Hard cutover (no
feature flag); worst case = 10-min poll fallback.

- New dep `smee-client@^5.0.0`; `lib/webhook-*.ts` modules; `POST /api/webhook`. Config adds
  `catalyst.monitor.github.smeeChannel` + `webhookSecretEnv` (HMAC secret in env);
  `setup-webhooks.sh` is the idempotent helper.
- Startup replay: 1-hr delivery window from `gh api repos/{repo}/hooks/{id}/deliveries` replayed
  through the live handler (synthetic signing) to reconcile downtime.
- Every accepted event fans out to `~/catalyst/events/YYYY-MM.jsonl` with topic
  `<source>.<noun>.<verb>` (e.g. `github.pr.merged`) — seeded the unified event bus that CTL-210
  (Linear webhooks + `catalyst-events` CLI, shipped) and CTL-211 (worker DoD = deploy success,
  shipped) build on. Steady state: well under the 5k/hr ceilings.

## ADR-013: Event-Driven Worker Waits (`wait-for-github` two-phase)

Replace `gh pr view --json` (GraphQL) poll loops in worker skills with a `catalyst-events wait-for`
blocking call over the unified event log, plus a REST-authoritative re-check after each wake.
GraphQL polling exhausted the 5k/hr budget (CTL-209). REST (`gh api repos/{repo}/pulls/{n}`) is
cheaper and returns `.mergeable_state`.

Two-phase: (1) `wait-for --timeout 180` for any relevant event → REST check; on timeout run
diagnostics. (2) Diagnostics: count heartbeats in last 500 lines, re-check tunnel; healthy → extend,
else REST fallback. (3) `--timeout 7200` (2-hr) when infra confirmed healthy. (4) REST fallback
`sleep 300` loop when tunnel down. Filter jq must cover v1 (`.event`) and v2
(`.attributes."event.name"`) envelopes. Never use `.mergeable_state` as sole signal
(eventually-consistent) — always REST re-check.

## ADR-014: Worker Owns Full PR Lifecycle (CTL-252)

Remove `gh pr merge --auto` from all worker skills. After opening a PR the worker enters the ADR-013
listen loop, resolves blockers inline, runs `gh pr merge --squash --delete-branch` directly when
CLEAN, and writes `status:"done"`. Orchestrator Phase 4 becomes a safety net for crashed workers
only (poll relaxed to 10-min). `autoMergeArmedAt` removed from the `pr` signal subobject. State
machine shrinks to `pr-created → done`.

## ADR-015: Bidirectional catalyst-comms (CTL-249)

Add inbound reads to workers: poll the shared comms channel at each phase boundary for
`--filter-to <ticket-id>` messages, using a `COMMS_LAST_READ` cursor (initialized to line count at
join) to skip pre-join history. Recognized inbound: `abort` (immediate exit); others TBD. **ACK
gap**: no delivery guarantee (CTL-253 tracks ACK). `catalyst-comms send` emits
`comms.message.posted` (v2 envelope) so tools observe traffic without reading the channel file. ~5
poll calls/run added.

## ADR-016: Claude Code metadata on the canonical envelope (CTL-374)

**Accepted 2026-05-13.** Claude Code per-session telemetry (context %, cost, turns, model) is
exposed only via the statusLine pipeline, not hooks. Add five typed attributes —
`claude.session.id`, `claude.model`, `claude.context.used_pct`, `claude.context.tokens`,
`claude.turn` — plus a `session.context` event emitted by `catalyst-statusline.sh` per tick, and
`attention.context_pressure` when context crosses 70% upward.

Migration `005_claude_session_metadata.sql` adds `claude_session_id` (bound via
`catalyst-session.sh start --claude-session-id`, fallback `CLAUDE_CODE_SESSION_ID`; indexed) and
`last_context_pct` (threshold bookkeeping; read/written by `emit-context`).

**PII boundary**: `cost_usd` is intentionally NOT a typed attribute — it rides in
`body.payload.cost_usd`, which the OTLP forwarder (`otel-forward/lib/destinations/otlp.ts`) does NOT
forward (it forwards `attributes` + `body.message` only). Payload stays on-machine. **Install**:
point `statusLine.command` at `catalyst-statusline.sh` (renders via `ccstatusline` /
`$CATALYST_STATUSLINE_CMD`; emit runs detached so failures never break the status bar). Single 70%
threshold matches the implement-plan handoff rule; more thresholds deferred.

## ADR-017: Phase-Agent Dispatch Architecture (CTL-447 → CTL-470)

**Accepted 2026-05-17.** Pre-CTL-452 dispatched one long-lived
`claude -p /catalyst-legacy:oneshot <TICKET>` per ticket, running the full lifecycle in one context
window → context rot, one worst-case turn cap for all phases, crash-recovery from a saturated state.

**Decision**: dispatch one short-lived
`claude --bg --resume /catalyst-dev:phase-<name> <TICKET> --orch-dir <ORCH_DIR>` per phase. The
orchestrator walks the canonical **10-phase** sequence
`triage → research → plan → implement → verify → review → pr → monitor-merge → monitor-deploy → teardown`
(teardown split out as the dedicated terminal phase in CTL-703) via `orchestrate-phase-advance`,
waking on `phase.<name>.complete.<TICKET>` routed by the broker `phase_lifecycle` interest. Selected
by `.catalyst/config.json → catalyst.orchestration.dispatchMode`: `"phase-agents"` is the template
default; `"oneshot-legacy"` is the fallback.

- Per-phase turn caps (`phase-agent-dispatch` `phase_default_turn_cap`, overridable via
  `catalyst.orchestration.phaseAgents.turnCaps`) — e.g. triage ~10, implement ~75. Per-phase model
  selection (`phaseAgents`) lets cheap phases (monitor-deploy defaults to Haiku) skip Opus cost.
- `phase_lifecycle` is a deterministic regex match (`broker/namespace-contract.mjs`:
  `^phase\.([^.]+)\.(complete|failed|turn-cap-exhausted|skipped)\.([A-Za-z][A-Za-z0-9_]*-\d+)$`) —
  no LLM classification; one interest per ticket. All four orchestrator interests (`pr_lifecycle`,
  `ticket_lifecycle`, `comms_lifecycle`, `phase_lifecycle`) fire back as `filter.wake.<ORCH_NAME>`.

**Consequences**:

- Signal layout splits: flat `workers/<TICKET>.json` plus per-phase
  `workers/<TICKET>/phase-<name>.json`.
- `--bg` healthcheck (`orchestrate-healthcheck`) stats `${JOBS_ROOT}/<bg>/state.json` (default
  `~/.claude/jobs/<bg>/state.json`); files older than `--stale-bg-seconds` (default 900) with
  `.state` not in `{done,failed,errored,stopped}` = stalled. PID liveness still covers
  `oneshot-legacy`.
- Intermediate Linear states (CTL-454): `triaged`, `researching`, `planning`, `verifying`,
  `reviewing` (+ existing `inProgress`/`inReview`), mapped via `stateMap` (opt-in).
- Revive budget at the top-level signal (`reviveCount`); `>= MAX_REVIVES` (default 10) → `stalled`,
  `attentionReason="revive-budget-exhausted"`. Once-per-phase; second `failed` for the same phase
  escalates.
- Legacy `oneshot-legacy` preserved (catalyst-legacy plugin); cutover is per-project.
- Built across CTL-447 (broker interest), 452 (state-machine rewrite + `--bg` cutover), 454 (Linear
  states), 455 (session_metrics fix) → 470. Internal reference: `docs/orchestrator-overview.md`.
  Related: ADR-006, ADR-008, ADR-014.

## ADR-018: Event-Sourced Worker Signal Files via Broker Projection (CTL-483)

**Accepted 2026-05-17. Phase 1 mechanism retired 2026-08-03 (CTL-1628) — see "What actually
shipped" below.** `workers/<TICKET>.json` is written by seven racing code paths (dispatch-next,
followup, the worker agent, healthcheck, revive, auto-fixup, auto-rebase) with no inter-process
locking — cross-script races silent. The broker already event-sources `broker-interests.json` from
`filter.register/deregister`.

**Original decision**: move worker-state mutations to "emit a `worker.state_changed` command event;
broker projects to disk". Event carries the FULL new state in `body.payload.state` (not a patch).
Dual-write in three phases (mirrors ADR-008):

- **Phase 1**: writers keep direct `jq>tmp&&mv` AND emit the event; broker projects to a **shadow
  path** `workers/<TICKET>.json.projected` (never races direct writes). `orchestrate-shadow-diff`
  reports drift. PoC writer: `orchestrate-auto-rebase`; the other six migrate one at a time.
- **Phase 2 (cutover)**: at zero drift across a full cycle for all seven, remove direct writes;
  broker becomes sole writer at the canonical path.
- **Phase 3 (optional)**: mirror to SQLite `worker_state` `(orch_id,ticket)` (ADR-011 hybrid).

**What actually shipped**: only `orchestrate-auto-rebase` ever migrated to Phase 1 (1 of 7 writers);
the migration stalled there from 2026-05-17. Phase 1's only reader was the manual
`orchestrate-shadow-diff` verification CLI (a human-run drift check) — nothing operational or
automated ever consumed the `.json.projected` shadow files. CTL-1628 removed the Phase 1
shadow-write **scaffolding** as dead weight — the broker's
`handleWorkerStateChanged`/`getProjectedWorkerStatePath`/`writeProjectedWorkerState`, the dedicated
`lib/emit-worker-state-changed.sh` emitter, and `orchestrate-shadow-diff` itself. **Phase 2's plan**
(cut over to broker-sole-writer once Phase 1 reached zero drift) **is dead** — it depended on the
now-retired Phase 1 drift-check pipeline, so that specific implementation can no longer execute; the
canonical `workers/<TICKET>.json` files are still written exactly as before, by the same seven
racing scripts. The *problem* Phase 2 was meant to solve — the seven-script single-writer race — is
still open, but it is no longer tracked as this ADR's Phase 2: **CTL-1631** now owns it as a
standalone ticket, replacing the retired Phase-2 plan rather than continuing it. **Phase 3** — as
originally scoped, a `(orch_id,ticket)` SQLite mirror — **did ship**, as CTL-532 below; both
`projection.mjs:291` and `broker-state.mjs:194` label it in-code as `(ADR-018 Phase 3)`.

The `worker.state_changed` **event name and wire schema are not gone**, only the dedicated producer
and shadow-file consumer: `reduceWorkerStateEvent` (below) still treats it as valid input, both (a)
on every broker restart within the same calendar month — `replayWorkerStateProjection` folds the
*entire* current-month event log, so any `worker.state_changed` record already on disk from before
this change remains live replay input — and (b) as a defensive compat-consume in the broker router
(`if (name === "worker.state_changed") return;`, CTL-1628) for an un-upgraded `orchestrate-auto-rebase`
still emitting it during a mixed-version fleet rollout. The wire schema stays documented in
`references/event-schema.md`, marked as a retired producer retained for replay/compat.

**CTL-532 shipped this ADR's Phase 3.** `processEvent` folds every event (not just
`worker.state_changed`) into `projectWorkerStateEvent` unconditionally, above all routing gates; the
pure `reduceWorkerStateEvent` reducer normalizes `worker.state_changed`, `phase.<name>.<status>.<TICKET>`,
and a specific subset of `orchestrator.worker.*` actions into a patch. For the phase family, only
`status` ∈ `{complete, failed, turn-cap-exhausted}` matches `WORKER_PHASE_EVENT_PATTERN`;
`phase.<name>.skipped.<TICKET>` (e.g. `phase-monitor-deploy`'s no-deploy-observed outcome) is a real,
separately-routed event but is **not** in that pattern's alternation, so it is not folded here. For
the `orchestrator.worker.*` family it is **not** a wildcard: `revived`, `pr_created`, and
`status_terminal` are special-cased, and `dispatched`/`done`/`failed`/`launch_failed` map through
`WORKER_LIFECYCLE_STATUS`; `pr_merged` and `phase_advanced` are real, separately-routed
`orchestrator.worker.*` events that hit no branch and are silently dropped (`return null`).
`upsertWorkerState` gates `phase`, `status`, and the `last_event_id`/`last_event_ts` watermark itself
on an order-independent watermark — an incoming event's `last_event_ts` must be `>=` (not `>`) the
row's current watermark to apply, so on an exact timestamp tie the later-*processed* event wins, not
the later-*occurring* one (pinned by `worker-state-projection.test.mjs:1140-1163`). `pr_number`
(`COALESCE(excluded.pr_number, worker_state.pr_number)`) and `revive_count`
(`MAX(excluded.revive_count, worker_state.revive_count)`) are **not** watermark-gated — every upsert
applies them unconditionally regardless of event order (revive_count's `MAX` can't regress either
way; pr_number's `COALESCE` can be clobbered by an out-of-order event supplying a different non-null
value). The result lands in the broker SQLite `worker_state` table — one row per
`(orchestrator, ticket)` holding phase/status/PR-number/revive-count — plus `worker_revive_events`
(idempotency ledger) and `projection_meta` (single-row watermark), all defined in
`broker/broker-state.mjs:194-232` and shipped in #936. This was previously undocumented against this
ADR.

**CTL-532 is observational, not a fix for the single-writer-race problem.**
`upsertWorkerState` only inserts/updates the SQLite `worker_state` row; it never reads or writes the
canonical `workers/<TICKET>.json` file. That problem — originally Phase 2's remit — is CTL-1631's to
close, not this ADR's.

**No supersession happened.** Phase 2 — the only phase that would have replaced the direct-write
`workers/<TICKET>.json` design (from ADR-017's signal layout) with a broker-sole-writer path — was
never built. The original seven-script write path, races included, is unchanged from before this
ADR. Global state + event log (ADR-006) were never in scope here and stay in force regardless.

## ADR-019: Turn-cap exhaustion → automated handoff continuation (CTL-484)

Phase agents have turn caps (default 75 for implement). Before CTL-484, `orchestrate-revive` treated
a turn-cap stop as a failure, burning the revive budget on successful forward progress; tickets
needing >75 turns silently hit `revive-budget-exhausted`.

**Decision**: introduce `turn-cap-exhausted` as a distinct non-terminal status in `phase_lifecycle`
routing. A worker nearing the cap writes a handoff to
`thoughts/shared/handoffs/<TICKET>/<ts>_turn-cap-continuation.md` and emits
`phase.<name>.turn-cap-exhausted.<TICKET>` (handoff path in payload). `orchestrate-revive`: detects
it → spawns `claude --bg --resume <session_id>` with `CATALYST_IS_CONTINUATION=true`,
`CATALYST_HANDOFF_PATH`, `CATALYST_CONTINUATION_COUNT` → bumps `.continuationCount` on a
**separate** budget (`MAX_CONTINUATIONS`, default 3) → exhaustion = `stalled`,
`attentionReason="continuation-budget-exhausted"`. Resumed worker reads the handoff and trusts the
summary.

Lives in: `phase-agent-emit-complete` / `lib/phase-emit-complete.sh`
(`--status turn-cap-exhausted --handoff-path`); broker `PHASE_EVENT_PATTERN`
(`namespace-contract.mjs`, tests `phase-lifecycle.test.mjs`); `templates/worker-signal.json`
(`continuationCount`, `continuations[]`, `handoffPath`) + `signal-schema.ts` + `state-reader.ts`;
`orchestrate-revive` (`spawn_continuation_bg`, `--max-continuations`); `resume-handoff/SKILL.md`;
`phase-implement/SKILL.md` (producer). Rationale: distinct routable status (not a payload
discriminator); separate budget (reviveCount ≠ continuationCount); worker self-detection (no
external watchdog); bash-templated handoff (background path can't run interactive `create-handoff`);
non-terminal (omits `completedAt`, off `TERMINAL_STATUSES`). Rejected: raise MAX_REVIVES, bump caps
in config, external watchdog. Scope = `phase-implement` for v1; reusable infra.

## ADR-020: Phase-mode turn-cap continuation lives in `orchestrate-revive`, not the daemon (CTL-613)

ADR-019's loop ran against the legacy top-level signal; phase-mode workers (ADR-017 default) write
only per-phase `workers/<TICKET>/phase-<name>.json`, so it's a no-op for them. The CTL-493 per-phase
loop only consumed `stalled` and silently skipped `turn-cap-exhausted` → handoff sat unused, ticket
hung (incident ADV-1134). The daemon's `execution-core/signal-reader.mjs` correctly classifies
`turn-cap-exhausted` as terminal (continuation ≠ reclaim).

**Decision**: add a branch to `orchestrate-revive`'s CTL-493 per-phase loop that consumes
`P_STATUS=="turn-cap-exhausted"` directly: budget-check `.phaseContinuationCount` (shares
`MAX_CONTINUATIONS`=3 with ADR-019's counter, tracked separately), resolve session id + worktree,
spawn via `spawn_continuation_bg`, set per-phase signal back to `running`, emit
`phase.<name>.dispatched` to re-arm the broker. Resolve the prior session id from
`~/.claude/jobs/<bg>/state.json::linkScanPath` (basename minus `.jsonl`) rather than plumbing it
into the signal — keeps the dispatcher's single-write contract intact. Daemon terminal
classification stays; recovery is the script's job, invoked by the daemon sweep. New
`resolve_phase_session_id` coexists with the legacy `resolve_session_id`.

## ADR-021: Workspace-level type-label taxonomy (CTL-995)

All six type labels (`bug`, `feature`, `refactor`, `docs`, `chore`, `test`) live at **workspace**
scope under a `type` label group, with canonical colors: bug `#e5484d`, feature `#8b5cf6`, refactor
`#14b8a6`, docs `#3b82f6`, chore `#8d8d8d`, test `#22c55e`. Pre-migration, four were per-team
duplicates (color drift, per-team ID lists). `issueLabelUpdate(teamId:null)` was rejected by the API
→ used rename-create-relabel-delete. Tooling must filter by the workspace IDs in
`thoughts/shared/research/2026-06-10-ctl-995-label-taxonomy-migration.md`. Component labels
(orchestrator/broker/phase-agent/monitor/cli/ci/website/estimation/worktree) remain team-scoped;
only the type axis is workspace-level.

## ADR-022: Belief engine is a derivation layer; "log → projection" is the directional target, not the shipped reality

**Accepted (direction) 2026-06-14.** Track A active; Track B is a deliberate un-started bet.
Sources: `thoughts/shared/research/2026-06-14-resilience-and-peer-platform-learnings.md`,
`…/2026-06-13-catalyst-patentability-and-open-core-strategy.md`.

The conceptual fit is exact — Datalog EDB→IDB closure **is** event-sourcing's `state=fold(log)`. The
engine (`execution-core/beliefs/`, CTL-962→967, CTL-1063) gets determinism right: `now` captured
once/tick (`collector.mjs`), EDB frozen in one SQLite txn during eval, and a differential shadow
oracle (`advance-shadow.mjs`) comparing Datalog `advance_to` vs procedural `deriveAdvancement`. But
three facts bound the claim:

1. **EDB is fed from mutable live state, not the log.** 8 of 9 `obs_*` tables are live probes; the
   one log-sourced table `obs_heartbeat` is permanently empty (no `worker.heartbeat` emitter,
   `collector.mjs`). As shipped = "the filesystem is the agent, observed through Datalog," not a log
   projection.
2. **The `rules.dl` compiler compiles only 3 of 18 rules** (`compiler/index.mjs`); load-bearing
   logic (recursive S5 deps, S6 `advance_to`/`cycle_exhausted`) is `extern` hand-written SQL with a
   61 KB hand-synced generated artifact.
3. **Advancement is graded against the 33-line procedural `deriveAdvancement` as ground truth** —
   porting to Datalog can at best equal it (low standalone ROI).

The engine has been shadow/dark its whole life; graduation is blocked on prerequisites that don't
exist (a log-sourced EDB; `caused_by` + monotonic `seq` on the envelope, both verified absent).

**Decision**: (1) Affirm "immutable log → deterministic projection" as the target; keep the engine
as the projection substrate — don't rip it out. (2) Stop calling the EDB a "log projection" in docs
until its authoritative tables come from the log. (3) Split the ambition: **Track A** —
derivation/health/provenance/absence-detection (S5 deps, `catalyst why`, negation-over-time); keep,
invest, graduate. **Track B** — Datalog owns the control path (R16/R17 replace `deriveAdvancement`,
log-sourced EDB, `signal.json` demoted to regeneratable projection); a deliberate bet gated by the
`advance-shadow` zero-disagreement oracle. (4) First graduation = the resilience absence-detector
("no `github.*`/`linear.*` event in N min → `ingestion_stale`"), which forces emitting
heartbeat/webhook-freshness events (fixes empty `obs_heartbeat`) — all Track A.

Rationale: decide/act seam stays a bright line (Datalog derives; an imperative executor acts —
`escalate.mjs`, gated `CATALYST_INTENTS_ENFORCE=1`, sits outside the rule engine). Datalog not
Prolog (guaranteed termination for a control plane; bounded `WITH RECURSIVE` only). Per-tick EDB
checkpoints = the snapshot half of event sourcing. Consequences: `caused_by` + monotonic `seq` are
prerequisites (`EVENT_SCHEMA_CAUSAL_SEQ` gap, near-free). The 3/18 compiler's fate is decided by
Track-B intent (migrate `extern` rules or retire the compiler). Do NOT "fix" `REVIVE_BUDGET=1` (dead
code; CTL-736 progress-gate is live). Complements ADR-018 / ADR-006/008. Rejected: rip out the
engine; promote `advance_to` now; full "log is the agent" rewrite now (= Track B).

## ADR-023: Shadow→Enforce Rollout Discipline for Autonomous Actuators

**Accepted 2026-06-16.** The fleet has many autonomous actuators (session reaper CTL-649/657,
proc-reaper CTL-1165, stall-janitor CTL-1004/1064, unstuck-sweep CTL-1064, belief executors
CTL-962→967, fleet-health self-heal CTL-1165 D5), each able to take a hard-to-reverse action. The
1,798-job / 17 GB-swap reap-leak (CTL-1165) is the cautionary case. Verified 2026-06-16: every
recovery actuator runs on its conservative default (shadow/off).

**Decision** — one discipline for every actuator:

1. **Rules DERIVE, executors ACT** — decide/act bright line (mirrors ADR-022).
2. **Dark by default** — ships `off`/`shadow`, gated by one knob (env flag
   `CATALYST_INTENTS_ENFORCE` / `CATALYST_STALL_JANITOR` / `CATALYST_UNSTUCK_SWEEP` /
   `CATALYST_DIAGNOSTICIAN` / `EXECUTION_CORE_FLEET_SELF_HEAL`, or Layer-1 mode
   `orphanReaper.procReaper.mode`).
3. **Three-state `off → shadow → enforce`** — shadow emits a "would-X" twin
   (`procOrphans.would-reap`, `unstuck.would.push`, `janitor.would.kill`, the `advance-shadow`
   comparator).
4. **Gated criteria flips** — shadow→enforce needs written criteria verified on real hosts over a
   real window (CTL-1165 proc-reaper criteria = template: ≥3–5 days of real candidates, each
   spot-checked, no false spared/reaped, steady-state bounded).
5. **Reversible by unset** — flip reverts by unsetting + restart; gates fail closed.
6. **One at a time** — independent knobs; never a blanket on.

Rationale: shadow-first + gated criteria makes harm observable before possible. **Known
coarseness**: `CATALYST_INTENTS_ENFORCE` is today a single flag arming four belief executors at once
— safety rests on each being idempotent/bounded (`labelOnce`, bgJobId-pinned kill, max-attempts)
until per-intent granularity exists. This is the deterministic-vs-flexible boundary (flexible LLM
layer = ADR-025). Consequences: new actuators MUST ship `off|shadow|enforce` + `would-X` + written
criteria; modes instantiated in `website/.../reference/configuration.md` + schema enum; flips
operator-owned (no auto-promotion) — the **ownerless-gate risk** (clean shadow evidence with nobody
flipping) is itself an operator concern (ADR-025/CTL-1176). Rejected: enable-on-merge; single global
enforce flag.

## ADR-024: Mechanical Fleet Hygiene — Reapers, Janitors, GC (Thread 1)

**Accepted 2026-06-16.** Each phase-agent worker leaves durable state: a `~/.claude/jobs/<id>` dir,
an `execution-core/workers/<TICKET>/` signal dir, a `~/catalyst/wt/` worktree, reparented
`node`/`bun` children. Two incidents: the reap-leak (1,798 dirs / 17 GB, CTL-1165) and a 2026-06-16
incident where 137 `execution-core/workers/` dirs cold the CTL-731 liveness snapshot
(`inFlightCount:0` while workers live) → daemon held all new-work dispatch incl Urgent.

**Decision** — one named layer of bounded deterministic cleaners, each governed by ADR-023:

1. **Session/bg-worker reaper** (CTL-649/657) — `claude stop` + `reap-complete`. Enforce.
2. **proc-reaper** (CTL-1165 D2, `orphanReaper.procReaper.mode`) — kills reparented grandchildren.
   Shadow; flip gated on CTL-1165 criteria.
3. **job-dir GC** (CTL-1165 D3) — removes aged `~/.claude/jobs` past 24 h.
4. **worker-dir GC** (CTL-1205, NEW) — removes `execution-core/workers/<TICKET>/` on pipeline
   completion (reaper `pr.merged` cleanup, after worktree removal) + periodic Done/merged sweep.
   Nothing reaped these before; the per-tick `readdirSync` over the pile cold the CTL-731 snapshot.
5. **stall-janitor** (CTL-1004/1064, `CATALYST_STALL_JANITOR`) — J1 reaps orphan worktrees, J2 kills
   idle ghost sessions, J3 re-dispatches the narrow `prior-artifact-retry-exhausted` stall.
   Shadow→enforce.
6. **unstuck-sweep** (CTL-1064, `CATALYST_UNSTUCK_SWEEP`) — category-aware rescuer; `actByCategory`
   seams intentionally unwired (`{}`).
7. **fleet-health probe** (CTL-1165 D5) — alerts `fleet.health.degraded` on jobs/swap/procs
   thresholds; self-heal default-off.

**Boundary (load-bearing)**: these operate on fleet _state_, not ticket content (= ADR-025). Not
interchangeable: the stall-janitor reaps worktrees+sessions but NOT worker-state dirs (= worker-dir
GC). A cold liveness snapshot is a worker-dir-GC problem, not a stall-janitor one (misdiagnosed the
2026-06-16 incident). Rationale: liveness depends on hygiene (CTL-731 guard pressured by per-tick
I/O over accumulated dirs); single clear target per cleaner; the event log is source of truth so
removing a completed ticket's dir is safe (daemon restores on boot). Consequences: worker-dir GC
(CTL-1205) is the durable fix for the cold-snapshot class; each cleaner follows ADR-023. Rejected:
let state accumulate; one mega-reaper.

## ADR-025: Pre-Human Reasoning-Recovery Sweep and Operator Surfacing (Thread 3)

**Accepted (direction) 2026-06-16.** Surfacing shipped (CTL-1180/1182/1181); the reasoning sweep
(CTL-1176) is proposed, not built. When a ticket stalls/fails/needs a decision, it must **surface**
to the operator and ideally something should try to **unstick** it first. Both were broken:
ADV-1392's `pr` phase failed (`push_rejected_no_workflow_scope`) and surfaced nowhere (`needs-human`
was applied only for `stalled`, never `failed`); CTL-1167 stalled with no comment; a scan found **31
silently-stuck tickets/month vs 6 `escalate.human` events**. Nothing reasons over the queue
(diagnostician CTL-937/828 evidence-only/dark; janitor J3 narrow; `phase-remediate` CTL-653
in-pipeline only; unstuck-sweep seams unwired).

**Decision** — a flexible LLM-reasoning recovery layer in front of the human inbox (distinct from
ADR-024 hygiene and ADR-022 belief):

1. **Reasoning recovery sweep (CTL-1176)** — periodic LLM pass over the stuck/failed/needs-human
   queue; per item, reconstruct from log + belief store + worktree/PR/CI and ask "human-decision or
   can I unblock?". Resolves mechanical cases via existing deterministic seams; escalates only true
   human-decisions **with a written reason**. Unifies diagnostician + janitor + sweeper +
   remediator. **Guardrail (CTL-828 three-panel)**: NOT a general fixer — DETERMINISTIC when
   stuck-type is typed and fix mechanical; LLM only with a structured brief + downstream
   deterministic re-check + hard cycle cap; HUMAN otherwise. No open-ended re-dispatch authority
   (reopens CTL-736 revive-storm). Every decision → log + Linear comment.
2. **Surfacing model (CTL-1180, shipped)** — a terminally-`failed` phase surfaces like `stalled`:
   `needs-human` for `status ∈ {failed, stalled}` when not pipeline-done (scheduler terminal sweep),
   plus a `phaseFailed`/`escalationType` trigger in the monitor's `deriveAttention` → Needs-You
   inbox + nav dot + `/queue`. Closes the `failed ≠ stalled` gap.
3. **Always-record comment policy (CTL-1182, shipped)** — every phase, including failed, records its
   outcome on the ticket; codified `linearis` fallback when the app-actor mirror fails.
4. **Registered deterministic act-seams the sweep invokes** — workflow-scope push detour (CTL-1181),
   sibling-conflict resolve (CTL-855), orphan-PR detect/adopt (CTL-1175/1159/1160), ADR-024
   cleaners. The LLM _selects among_ registered seams; it never invents mutations.

Rationale: the fleet only alerts + escalates then stops; the "try to clean it up first" step was
scaffolding only (31:6 quantifies the cost). Deterministic-vs-flexible boundary (ADR-023): hygiene
stays gated; LLM judgment is bounded to "human-or-not + which seam." Surfacing is the floor — inbox
membership keys on worker-dir/event status (`failed`/`stalled`/`needs-human`), not just
`gh pr list`, so failed-but-no-PR cases surface. Consequences: CTL-1176 needs its own scoping doc
(becomes this ADR's implementation vehicle); belief executors (ADR-022) and this sweep are
complementary; this is the "supervisor" record previously split across CTL-780/828/937. Rejected: a
general open-ended re-dispatch agent (CTL-828 panel — reopens CTL-736); surfacing-only (leaves
resolvable stalls consuming attention); leave re-engagement to the inference engine's lease rules
(CTL-780 — that's the deterministic complement, held).

## ADR-026: Two-Axis Worker State Model + worker-status Label Group (CTL-764)

**Decision** — worker state transitions **that the scheduler records** are consolidated behind a
single chokepoint and a workspace-scoped, single-valued `worker-status` Linear label group carrying
worker _disposition_ independently of _pipeline stage_ (known gaps in that coverage are listed
below). The live chokepoint is the **inline
`recordTransition`** function inside `scheduler.mjs`'s `schedulerTick` — not the standalone
`recordWorkerTransition` module (`record-worker-transition.mjs`) named in this ADR's original
design: that module's own doc comment declared only three of the eventual five sinks (Sink 1 Linear
workflow status via `applyPhaseStatus`, Sink 2 the disposition label via `convergeLabel`, Sink 3 the
unified event log via `appendWorkerTransitionEvent`) and flagged itself as unfinished — "Phase 5 will
wire the production defaults... and route all call sites here." That Phase 5 wiring never happened;
the scheduler's live path never called the module. Of the two sinks the module never reached, only
sink 4 (OTLP via `otel-forward`) is actually live — it rides automatically on sink 3's event-log
write. Sink 5 (a broker `ticket_state_transitions` table, CTL-764 Phase 10) was **never
implemented** anywhere, live path or otherwise — no schema, no writer, no broker consumer exist in
the codebase. CTL-1628 removed the retired module as consumer-free.

**The chokepoint is not the only `worker.transition` emitter.** The daemon's `handleCommentWake`
(CTL-768, `execution-core/daemon.mjs`) calls `appendWorkerTransitionEvent` directly at two
structurally distinct sites, both bypassing `recordTransition` but for different reasons:
- The **`needs-input` clear** (a per-signal branch gated on `status === "needs-input"`) removes the
  label, emits the clear, and redispatches the parked worker in the same block. Its own code comment
  explains the bypass: "scheduler.mjs owns the park/apply emission; the clear is emitted here (the
  daemon removes the durable label out-of-band and redispatches — the scheduler never observes this
  edge)."
- The **`needs-human` clear** runs once per comment-wake call, gated on positive human provenance
  and a managed ticket, with **no redispatch** in that block. It bypasses `recordTransition` because
  the scheduler's own needs-human handling is STICKY-by-design (never clears it itself on a
  steady-state admission pass, per the `recordTransition` suppression logic above) — the
  "redispatches" half of the quoted rationale does not apply to this site.

Both are deliberate, self-documented second-producer sites.

**A separate escalation path emits no `worker.transition` for its disposition change.** Pass 0w's
hung-worker escalation (`killHungWorker` in `watchdog-action.mjs`, invoked from `scheduler.mjs`'s
progress-watchdog pass) does emit `phase.terminal.reap-requested` (via `emitReapIntent`, when
`bgJobId` exists) for the kill/reap side of the sequence — that part of the path is observable. But
it applies the `needs-human` label via `labelNeedsHumanUnlessBeliefOwner` (`label-guard.mjs`) and
never calls `recordTransition`, `appendWorkerTransitionEvent`, or any other `worker.transition`
emitter anywhere in that path — a real Axis-2 transition with no `worker.transition` record. Unlike
the daemon's comment-wake sites above, this is a genuine coverage gap in the transition stream
specifically, not an alternate producer. See "Two-axis worker state & the recordWorkerTransition
chokepoint (CTL-764)" in `docs/architecture.md` for the live mechanism.

**Two orthogonal axes (never blurred):**

- **Axis 1 — Pipeline stage** (where the ticket is in the pipeline): Linear workflow Status, written
  through the single `applyPhaseStatus` chokepoint.
- **Axis 2 — Worker disposition** (how the worker is doing): four mutually exclusive values in the
  `worker-status` label group (`queued`, `blocked`, `needs-input`, `needs-human`).

**Single-valued workspace group** — workspace scope (shared by CTL and ADV teams) ensures the label
is always readable regardless of which team's ticket is in flight. Exclusive group enforces
single-value; the daemon removes stale members before applying a new one.

**Precedence** — `needs-human > needs-input > blocked > queued > none`. `needs-human` is sticky
(applied by `labelOnce`, NOT tick-converged) and cleared only at explicit resolution.
`queued`/`blocked`/`needs-input` are tick-converged (re-derived on diff each tick).

**Resolution-gated clearing — TWO removal paths (Codex #2970 round 5).** `needs-human` is removed
only by an explicit, confirmed-removal signal, and there are two: (1) `clearStalledLabel`'s
`onRemoved` callback, fired only on confirmed Linear label removal at scheduler-side resolution
points (Done / terminal-sweep / no-stall-clear), preventing false-positive "cleared" events on API
failures; and (2) the daemon's `handleCommentWake` needs-human clear on a managed ticket's confirmed
human reply — a write-gated, emission-carrying removal via `removeLabel` directly (not
`clearStalledLabel`), documented in the producer-split paragraph above.

**`waiting` → `queued` rename** — the prior `waiting` label was renamed to `queued` to align with
the disposition vocabulary. Back-compat: legacy `waiting` labels map to `queued` in the HUD and
`heldFor`. CTL-755 team-level `blocked`/`waiting` labels are superseded by the workspace group.

**Rationale** — scattered label writes produced observable drift (needs-human in the event log but
healthy in Linear, or vice versa). One chokepoint, one group, one canonical `worker.transition`
event per genuine change eliminates the coordination problem without per-site reasoning.

**Alternatives considered** — per-site label writes (rejected: coordination problem persists);
merged axes into a single status enum (rejected: pipeline stage and disposition are independent and
both need independent observability); async `recordWorkerTransition` only (rejected: `schedulerTick`
is sync; async would require a separate flush loop with new failure modes).

**Consequences** — four sinks are **live** (Linear Status, label, event log, OTLP via otel-forward);
all fail-open. No single transition reaches all four — each recordTransition call is either
stage-only or disposition-only (`toDisposition === undefined` means "no disposition guard, always
emit" for a pure stage move; omitting `toStage`/`fromStage` means no Linear-Status write for a pure
disposition move), so a transition reaches at most three: a stage move touches Linear Status + event
log + OTLP (skips the label sink); a disposition move touches the label + event log + OTLP (skips
Linear Status) — e.g. the dependency-cycle escalation (`scheduler.mjs` ~5666-5678) calls
`labelNeedsHumanUnlessBeliefOwner` (label) and `recordTransition({ toDisposition: "needs-human" })`
(event log + OTLP) with no stage touched at all. Only a call that sets both `toStage` and
`toDisposition` together would reach all four. A fifth sink (an optional broker
`ticket_state_transitions` table, CTL-764 Phase 10) was designed but never implemented — no schema,
writer, or broker consumer exist for it. The HUD capacity header gains per-disposition buckets and
triage is carved out of `maxParallel` counting. AGENTS.md / architecture.md carry the two-axis model
as first-class concepts.

## ADR-027: Browser automation stays local — cloud browser backends rejected (2026-07-25)

**Decision** — Catalyst's browser automation continues to run **local Chromium** via
`agent-browser`'s default backend. A hosted browser provider (Browserbase, and by extension Kernel /
Browserless-cloud / BrowserStack) is **not** adopted. Recorded because the proposal is superficially
attractive and will otherwise be re-proposed.

**Killer 1 — a cloud browser cannot reach a local dev server.** Every browser target Catalyst cares
about is loopback or tailnet: `mini:7400` (orch-monitor SPA), `localhost:3000/4000/8080` (dev
servers in worktrees), `127.0.0.1:<rand>` (gstack control plane). Browserbase ships **no tunnel** —
no BrowserStack-Local / Sauce-Connect equivalent; verified as a documented absence across
`docs.browserbase.com` (`llms.txt` index, `remote-browser-versus-local-browser`,
`building-automated-tests`, `allowed-domains`), and stated affirmatively in
`platform/browser/files/uploads`: the remote browser "can't access files on your local machine". The
adjacent `platform/identity/vpn` feature runs the **opposite** direction (routes the cloud browser's
_egress_ through a proxy you deploy) and validates proxies eagerly at session creation, so a
local-only proxy fails the session outright. `agent-browser` ships no tunneling either — navigation
executes as CDP `Page.navigate` **inside the remote container**, so `localhost` resolves there.
Adopting a cloud backend is a capability deletion.

**Killer 2 — the stated motive was false.** The proposal's premise was relieving pressure from local
headless Chromium. Measured live on 2026-07-25: **0 headless Chromium processes on mini and 0 on
mini-2**; mini-2 has no browser binary installed at all and still swaps. No skill in
`plugins/*/skills/` invokes `agent-browser` on the fleet — every fleet-side reference is
provisioning (`install-cli.sh:242`, `check-setup.sh:106`), env injection
(`phase-agent-dispatch:863,944`), or leak containment (`orphan-sweep.sh:779`). Actual memory
pressure is exec-core (3.7–6 GB), orch-monitor (2.5 GB), an 826 MB monthly event log, and 101
worktrees on mini. Offloading browsers reclaims ~0 MB of a 15 GB problem.

**Do not solve Killer 1 with a reverse tunnel.** `orphan-sweep.sh` has five vectors and zero tunnel
coverage, so a tunnel spawned in a `claude --bg` worker is a new unreapable orphan class — and a
leaked tunnel is not a wasted process but persistent public ingress. Critically,
`orch-monitor/server.ts:795` binds `0.0.0.0` with no auth across ~80 routes including actuation
(`POST /api/ec-worker/<T>/stop`, `POST /api/ticket/<T>/respond` → re-dispatches an autonomous agent
holding repo-write and PR-merge authority), and `/debug/heap-snapshot` (~server.ts:4632) is gated on
`server.requestIP(req)?.address === 127.0.0.1`. Tunnel daemons dial the origin over loopback, so
**every tunneled request presents as 127.0.0.1 and that gate fails open to the internet.** A tunnel
converts the localhost trust boundary into a fail-open one. (The webhook routes are properly
HMAC-verified with `timingSafeEqual`; the actuation routes are not.)

**Cost inversion** — even inside the included tier, the economics fail on leak behavior, not price.
A leaked session goes **free → metered**: CTL-1500's exact failure shape (worker dies, browser
survives) costs $0 today and is reaped hourly; on a hosted provider it bills to the 6-hour session
cap, and `orphan-sweep.sh` vector 5 cannot see — let alone reap — a remote session.
`AGENT_BROWSER_IDLE_TIMEOUT_MS` becomes a billing floor stacked on the 1-minute session minimum
rather than a safety net.

**BrowserStack specifically is structurally incompatible**, independent of price. Its endpoint
`wss://cdp.browserstack.com/playwright?caps=…` speaks Playwright's proprietary **server** protocol
despite the `cdp.` hostname; `agent-browser` speaks **raw CDP** (`connectOverCDP`). Compounding:
credentials must ride inside a URL-encoded caps JSON (no header auth), caps must carry a
`client.playwrightVersion` matching the caller's bundled Playwright, and a **90-second idle
timeout** would kill sessions during normal LLM reasoning pauses. Noted because BrowserStack Local
is ironically the only mature localhost tunnel in the comparison — it solves the exact blocker, on
the one vendor we cannot drive.

**Alternatives considered** — _Kernel / Browser Use / AgentCore_: same localhost blocker.
_Cloudflare Browser Rendering_: same, plus always bot-identified. _Browserless self-hosted_: viable
on reachability but SSPL-1.0-or-commercial, a license decision plain Chrome sidesteps. **If browser
consolidation is ever genuinely wanted**, the correct shape is plain headless Chrome on the `home`
OTel box (100.65.193.30, Linux) + `agent-browser connect ws://<ip>:9222` — raw CDP, $0, no license
question, and unlike any hosted provider it can reach `mini:7400`. Requires
`--remote-debugging-address=0.0.0.0`, addressing by **IP not hostname** (Chrome host-header
validation, CVE-2018-6101), and `--user-data-dir` on Chrome 136+. Note this yields _tailnet_
reachability, not literal localhost: dev servers must bind `0.0.0.0`. Do not site it on mini.

**Consequences** — no vendor dependency, no subscription, no new orphan class, and the localhost
trust boundary is preserved. `orphan-sweep.sh` vector 5 remains the correct and sufficient
containment for browser leaks. Revisit only if a _stated_ driver appears that local Chrome cannot
serve — parallel session isolation, execution on non-Mac hosts, IP diversity, or stealth — and note
that for stealth or persistent auth, Kernel (`KERNEL_STEALTH`, `KERNEL_PROFILE_NAME`) and
Browserless (`BROWSERLESS_STEALTH`) expose knobs the Browserbase create path in `agent-browser` does
not send at all.

**Verification caveat** — provider internals were established against `agent-browser 0.27.2`
(laptop); the fleet runs **0.32.4**. Re-verify binary-level claims (that the Browserbase create path
sends no `projectId` / `keepAlive` / `browserSettings` / `advancedStealth`) against 0.32.4 before
relying on them.

**Follow-up, independent of this decision** — the unauthenticated orch-monitor control plane on
`0.0.0.0` is a standing finding, currently contained only by the tailnet perimeter. Untickted as of
this ADR.

## ADR-029: Catalyst self-hosts its CAT backlog via a separate fork clone (CAT-52)

**Decision.** The CAT team is registered in `execution-core/registry.json`, allowing the fleet to
work Catalyst's own self-healing findings. Its `repoRoot` is a **separate clone of the fork**
(`thagale/catalyst`), never the live `plugin-source` checkout from which the fleet loads its
plugins. This is CAT-52's option 2.

**Why not option 1** (register `plugin-source` itself): phase agents would edit the execution-core
currently executing them, and `plugin-source` has no `/github/<owner>/<repo>` path segment, so
`ownerRepoFromRepoRoot` cannot resolve it and board-health falls back to number-only ambiguous
skips for CAT tickets.

**Why not option 3** (exclude CAT and work it by hand): recovery-pass findings are routed into CAT
so the system learns and recurring wedge classes disappear. A queue that only fills re-derives
defects already filed and unread. No exclusion primitive exists and none is introduced here.

**A correct CAT `repoRoot` must satisfy all three:**

1. It is a checkout of the fork (`thagale/catalyst`), whose main carries CAT-numbered history.
2. Its Layer-1 `catalyst.linear.teamKey` is `CAT`, matching the registry schema's contract and the
   warn-only enforcement added in CAT-52.
3. Its path contains `/github/<owner>/<repo>` so `ownerRepoFromRepoRoot` resolves
   `thagale/catalyst`. The canonical path is `~/code-repos/github/thagale/catalyst`.

**Deploy story.** Merged CAT pull requests land on `thagale/catalyst` main. Because
`plugin-source`'s `origin` is that fork, the updater pulls those changes into the running plugins,
closing the self-hosting loop.

**Consequences.** The registry's `team` ↔ `teamKey` contract is observable through a
`registry.mjs` warning and the advisory `registry-team-identity` doctor check. A mismatched entry
is still dispatched so a typo cannot silently stop fleet work. Nothing yet detects a Linear team
with Todo work that is wholly absent from the registry; that requires a workspace-wide Linear team
sweep and remains outside CAT-52. The `coalesce-labs/catalyst` clone remains the CTL project and
keeps its `CTL` Layer-1 declaration; it is not a valid CAT `repoRoot`.

## ADR-028: Deterministic resolvable-conflict sweep (`phase-resolve-conflict`, #1461)

**Proposed 2026-08-02.** Sibling-PR-merge source conflicts stall a ticket with `stalledReason:
source_conflict_ctl708_unavailable` — written generically at dispatch-time pre-flight rebase, for
whichever phase (implement/verify/review) was about to run. Two existing mechanisms only partially
cover this. The CTL-855 `sourceConflictActSeam` (`unstuck-sweep`, ADR-024) force-pushes an
already-clean branch past a stale flag but throws on any genuine conflict — it was never a resolver.
`recovery-pass` (ADR-025, CTL-1176, shadow fleet-wide since 2026-08-01) tells its LLM to "resolve it
yourself" ad hoc on rc=2 — no `classifyMergeTree` gate, no dedicated typed phase, no cycle cap,
violating ADR-025's own guardrail ("DETERMINISTIC when stuck-type is typed and fix mechanical...
LLM only with a structured brief + downstream deterministic re-check + hard cycle cap"). Separately,
`isTicketInFlight` excludes any `stalled` ticket, so `deriveAdvancement`'s verify⇄remediate-style
detour (CTL-653) never sees these tickets at all — a `deriveAdvancement` branch, as #1461 originally
proposed, cannot reach them without threading the in-flight gate itself.

**Decision** — a new dedicated tick-loop sweep, `resolve-conflict-sweep.mjs`, structurally mirroring
`stall-janitor`/`unstuck-sweep` (ADR-024) and governed by ADR-023 (off/shadow/enforce, default
`off`, every tick — candidates are rare and the classify step is cheap):

1. Scan for phase signals `status:"stalled"`, `stalledReason:"source_conflict_ctl708_unavailable"`,
   not already marked `source_conflict_resolvable`, under cap.
2. Classify live: re-run `git merge-tree`, reuse the existing, untouched `classifyMergeTree` from
   `stale-pr-rescue.mjs` (no reimplementation). Not resolvable → leave for the existing needs-human
   surfacing (ADR-025 pt. 2). Resolvable → mark `source_conflict_resolvable` (new, non-colliding
   reason) and dispatch.
3. Dispatch through the standard `dispatch.mjs → phase-agent-dispatch` envelope (the one recovery-pass
   already uses) to a new skill, `phase-resolve-conflict`, cloned from `phase-remediate`'s envelope but
   reading a `resolve-conflict-brief.json` (mirrors `recovery-pass.json` v2 shape) instead of
   `verify.json`. Rebases additively per the brief's conflict files/types, runs targeted gates,
   commits, emits `phase.resolve-conflict.complete.<ticket>`.
4. Once complete, the sweep — not the skill — mechanically clears the original phase's stalled
   signal, mirroring `maybeResetForRemediateCycle`, dropping the ticket back into `isTicketInFlight`
   so the ordinary dispatch loop redispatches the phase that stalled. **No `deriveAdvancement` /
   `resolveReapPredecessor` changes needed**: because the stall reason is already written generically
   at dispatch time for whichever phase is about to run, the sweep covers implement/verify/review
   uniformly by construction — the three-predecessor generalization #1461 asked for turns out not to
   require touching the FSM's predecessor logic at all.
5. Capped via `RESOLVE_CONFLICT_CYCLE_CAP` (env override, default 3), event-counted via a new
   `countResolveConflictCycles` mirroring `countRecoveryPassCycles` — a standalone-sweep cap, not a
   `workflow.default.json` FSM-cycle entry, since this isn't a bidirectional FSM edge like
   verify⇄remediate. Cap exhausted → `stalledReason: resolve-conflict-cycle-cap-exhausted` (new),
   escalation comment in the `🔼 **phase-resolve-conflict** escalated...` header convention (visual
   style only — `orch-monitor/lib/inbox-ask.mjs`'s header regexes are hardcoded to the literal string
   `recovery-pass`, so this does not parse into the structured inbox without a separate follow-up
   generalizing those regexes; not attempted here given the file's own documented history of subtle
   parsing regressions).

Two small, targeted edits to shared files (not a redesign of either): `unstuck-sweep.mjs`'s
`STALL_CATEGORY_MAP` gets a `source_conflict_resolvable → skip` entry so CTL-855's seam doesn't fight
over a ticket this sweep already owns; the terminal-label sweep (`scheduler.mjs`) exempts
`source_conflict_resolvable` from immediate `needs-human` labeling, so a ticket isn't flagged
needs-human on the same tick the fix is already in flight.

**Rationale** — matches ADR-025's own deterministic-vs-flexible boundary better than the status quo
(recovery-pass currently freelances this without the structured-brief/cycle-cap/deterministic-recheck
guardrail its own ADR requires); reuses `classifyMergeTree` and the standard phase-agent-dispatch
envelope rather than inventing new conflict-classification or dispatch machinery; sidesteps the
in-flight gate rather than widening it, per #1461's own scoping comment
(`#1461#issuecomment-5155144010`).

**Consequences** — `recovery-pass/SKILL.md`'s "resolve it yourself" instruction for rc=2 should
eventually defer to this sweep's typed path instead of ad hoc LLM resolution; noted here as a
follow-up, not blocking, since recovery-pass ships shadow-only today and this sweep ships
independently at `off`. **Rejected**: widening CTL-855's `sourceConflictActSeam` into a real resolver
(solves a structurally narrower problem — force-push-past-staleness, not merge-conflict resolution);
a `deriveAdvancement` detour as #1461 originally described (unreachable — stalled tickets are excluded
from `isTicketInFlight` before `deriveAdvancement` ever runs).
