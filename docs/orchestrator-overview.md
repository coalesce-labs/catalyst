<!-- CTL tracer bullet: 2026-05-25 — verifies execution-core pickup -->
# Orchestrator Overview

How a Catalyst orchestrator runs today (post-CTL-452, post-2026-05-17 ship). This doc
describes what exists in `origin/main` — it is not a roadmap.

## Why this exists

Catalyst orchestrates AI engineering work under the constraints of LLM agents. Every
design choice — phases, background dispatch, broker interests, the immutable event
log — is in service of these:

- **Context engineering.** Per-turn cost compounds, and long contexts hit diminishing
  then negative returns as attention degrades ("context rot"). Breaking ticket-sized
  work into bounded phases (research → plan → implement → verify → review → ship)
  keeps each agent in a focused context where sharp decisions stay cheap.

- **Background continuity.** Agents should keep working while the operator is away
  from the keyboard. Phase workers run as `claude --bg` jobs and emit events when
  they finish; the orchestrator wakes on those events and dispatches the next phase
  asynchronously. Work does not stop when the human stops looking.

- **Human-in-the-loop oversight.** When something stalls, needs a design call, or
  surfaces a finding, observability — HUD, web dashboard, comms channel, event tail
  — makes worker state visible without forcing the operator to reconstruct context
  from raw logs.

- **Cost-aware parallelism.** Running tickets in parallel waves multiplies throughput,
  and it also multiplies the risk of conflicts, rework, and tokens spent on doomed
  work. Wave scheduling lets unblocked work advance independently; revive budgets,
  healthchecks, and turn caps cap the blast radius of any single stuck worker.

- **Signal-routed IPC.** Background agents share no memory. They communicate by
  appending to an immutable event log (`~/catalyst/events/YYYY-MM.jsonl`) and
  registering broker interests that describe which subset of events should wake
  them. Each agent's context loads only signals relevant to its task — no inbox
  sweeping, no low-value polling, no spam.

## TL;DR

A single operator command (`/catalyst-legacy:orchestrate …`) launches an interactive
Claude Code session that schedules tickets into waves and dispatches **phase-agent
workers** (or legacy `oneshot` workers, depending on `dispatchMode`) into one git
worktree per ticket.

> **Note (v11.0.0, CTL-726):** The wave-based orchestration skills (`orchestrate`, `oneshot`, etc.)
> moved to the `catalyst-legacy` plugin. The *current* multi-ticket model is the execution-core
> daemon — see [architecture.md](architecture.md) for the end-to-end phase-agent pipeline. Phase-agent workers run as `claude --bg` jobs and walk a
**10-phase pipeline** — one `--bg` job per phase — emitting `phase.<name>.complete.<TICKET>`
events the orchestrator wakes on via the broker. The orchestrator advances each
ticket through the pipeline, opens a PR, waits for CI and merge, runs teardown,
and archives the run.

## User flow

```mermaid
flowchart TD
  A[Operator runs<br/>/catalyst-legacy:orchestrate …] --> B[Phase 1: Intake<br/>resolve tickets + read details]
  B --> C[Phase 2: Plan waves<br/>build DAG → topo sort → wave queue]
  C --> D{Operator<br/>approves<br/>plan?}
  D -- no --> Z[exit]
  D -- yes --> E[Phase 3: Dispatch wave N<br/>provision worktrees +<br/>spawn workers]
  E --> F[Phase 4: Monitor<br/>register broker interests<br/>catalyst-events tail --filter]
  F --> G{All workers<br/>in wave N<br/>terminal?}
  G -- no --> F
  G -- yes --> H{More<br/>waves?}
  H -- yes --> E
  H -- no --> I[Phase 5: Archive<br/>SUMMARY.md +<br/>catalyst-archive.ts sweep]
  I --> J[~/catalyst/archives/&lt;orchId&gt;/<br/>+ catalyst.db rows]
```

The orchestrator itself runs as a normal Claude Code session — there is no `--bg`
flag on the `orchestrate` skill. Only its workers are backgrounded.

## Dispatch mode

Selected by `.catalyst/config.json → catalyst.orchestration.dispatchMode`:

| Value | Worker spawn | Notes |
|---|---|---|
| `"phase-agents"` | `claude --bg --resume /catalyst-dev:phase-<name> <TICKET> --orch-dir <ORCH_DIR>` via `phase-agent-dispatch` | Template default. One `--bg` job per phase. State at `~/.claude/jobs/<bg_job_id>/state.json`. |
| `"oneshot-legacy"` | `claude -p /catalyst-legacy:oneshot <TICKET> --auto-merge` (long-lived, streaming JSON) | Runtime default when key missing. Pre-CTL-452 model. |

Dispatch-mode resolution lives in `plugins/dev/scripts/orchestrate-dispatch-next`.
Without `--config <path>`, the dispatcher always uses `oneshot-legacy`; the
`orchestrate` skill passes `--config "${REPO_ROOT}/.catalyst/config.json"` so the
project config wins.

### Config drift detection (CTL-489)

When `plugins/dev/templates/config.template.json` gains a new key (e.g. CTL-452's
`orchestration.dispatchMode`), existing projects' `.catalyst/config.json` files do not
automatically receive it. To prevent the silent-fallback class of bug (CTL-487 — catalyst itself
ran in `oneshot-legacy` mode for two months because the new key was absent),
`plugins/dev/scripts/check-config-drift.sh` walks the template and emits one warning per missing
leaf key. The drift script is wired into `check-project-setup.sh`, so every workflow that runs
the prereq check (`/orchestrate`, `/oneshot`, `/research-codebase`, etc.) prints drift warnings
until the user runs `/catalyst-foundry:setup-catalyst`, which offers a `jq` deep-merge that adds the
missing keys while preserving every existing user value (jq's `*` recursive merge with project
on the right). Allow-listed roots (`projectKey`, `project.ticketPrefix`, `linear.teamKey`,
`linear.stateMap`, `linear.stateIds`) are suppressed to avoid double-warning — those are already
checked individually by `check-project-setup.sh`.

### Execution-core entry triggers (two-state monitor)

In `execution-core` dispatch mode the daemon's monitor reacts to Linear
`state_changed` events:

- **`→Triage`** one-shot-dispatches the triage phase agent (the ticket is not
  scheduler-pulled).
- **`→Todo`** is the scheduler-eligible entry. New work enters the pipeline at
  the `research` phase on the contract that a Todo ticket has already been
  triaged.

A user may move a ticket **Backlog → Todo directly**, skipping `→Triage`
(an intentional human shortcut). When this happens and no `triage.json` exists
for the ticket, the monitor **auto-dispatches the triage phase agent** rather
than reconciling the ticket into the eligible set — triage then runs and its
completion advances the ticket to `research` normally. This makes "Todo" a
valid manual entry point: the system transparently runs the missing triage
instead of dead-locking the research prior-artifact gate. (CTL-625)

**Linear app-actor self-echo guard.** `catalyst.monitor.linear.botUserId` (Layer-1
`.catalyst/config.json`, the Linear user UUID of the Catalyst app-actor) is the
self-echo guard the daemon uses to tell the agent's *own* mirror comments from a
human reply, so bot-authored issue events don't feed back as a false "human
replied" signal or a write loop. Required for the Linear app-actor comms channel —
i.e. when the daemon mirrors phase-agent output to Linear and wakes on human
replies (CTL-550 / CTL-549 / CTL-749). Set it via `/catalyst-foundry:setup-catalyst`;
distributed templates ship `null`.

## The 10-phase pipeline (phase-agents mode)

Canonical sequence is defined in `plugins/dev/scripts/orchestrate-phase-advance`
and mirrored in the orchestrate skill's pipeline reference table.

| # | Phase | Sub-skill / agent | Linear state | Signal file | Default model | Turn cap |
|---|---|---|---|---|---|---|
| 1 | `triage` | (none — inline) | `triaged` label | `triage.json` | Opus | 10 |
| 2 | `research` | `/catalyst-dev:research-codebase` | `researching` | `thoughts/shared/research/<date>-<ticket>.md` | Opus | 35 |
| 3 | `plan` | `/catalyst-dev:create-plan` | `planning` | `thoughts/shared/plans/<date>-<ticket>.md` | Opus | 25 |
| 4 | `implement` | `/catalyst-dev:implement-plan` | `inProgress` | commits + `phase-implement.json` | Opus (configurable Sonnet) | 75 |
| 5 | `verify` | code-reviewer + pr-test-analyzer + silent-failure-hunter sub-agents | `verifying` | `verify.json` | Opus | 20 |
| 6 | `review` | `/review` (gstack) | `reviewing` | `review.json` + remediation commit | Opus | 25 |
| 7 | `pr` | `/catalyst-dev:create-pr` | `inReview` | `phase-pr.json` (PR# + URL) | Opus (configurable Sonnet) | 12 |
| 8 | `monitor-merge` | `catalyst-events wait-for` loop → `gh pr merge --squash` | — | `phase-monitor-merge.json` | Opus | 50 |
| 9 | `monitor-deploy` | `/canary` (gstack) | — | `phase-monitor-deploy.json` | Haiku | 30 |
| 10 | `teardown` | `/catalyst-dev:teardown` | `done` | `phase-teardown.json` | Sonnet | 15 |

**Teardown is the terminal phase.** It owns all end-of-ticket housekeeping that
previously had no clear owner:

- Posts the final Linear comment summarising the completed run.
- Transitions the Linear ticket to `Done`.
- Removes the git worktree (non-force `git worktree remove`, gated on a
  merge-confirmation check + worktree presweep liveness check).
- Deletes the local branch (`git branch -D`; the remote branch was already
  deleted by monitor-merge's `gh pr merge --delete-branch`).
- Archives the worker directory under `~/catalyst/archives/<TICKET>/`.

**monitor-merge no longer writes Done or removes the worktree.** It merges the PR
and emits `phase.monitor-merge.complete`, then hands off to monitor-deploy and
subsequently teardown for all cleanup.

**Ancillary phase — `remediate` (CTL-653).** Not a member of the linear
sequence: it is a *router-orchestrated conditional detour* the scheduler takes
when `verify` produces a verdict-fail (`verify.json.regression_risk ≥ 5` OR any
`severity:"high"` finding). It reads `verify.json.findings[]` as its brief, fixes
the code, commits, emits `phase.remediate.complete`, and the router cycles back
to a fresh `verify`. The loop repeats up to **3** times (a counter distinct from
the revive budget, event-counted via `phase.remediate.complete.<ticket>`); only a
verdict-fail *after* the budget is spent escalates to `stalled` → `needs-human`.

| Phase | Sub-skill / agent | Linear state | Prior artifact | Default model | Turn cap |
|---|---|---|---|---|---|
| `remediate` | (none — fixes findings inline via Edit/Write) | `remediating` (→ Remediate) | `verify.json` | Opus | 40 |

The conditional routing lives entirely in `deriveAdvancement`
(`execution-core/scheduler.mjs`); the pure FSM (`lib/phase-fsm.mjs`) keeps
`verify → review` as its single happy-path edge, so `remediate` is added only as
a *known ancillary phase* (`isKnownPhase`, `ANCILLARY_PHASES`,
`REMEDIATE_CYCLE_CAP = 3`). Re-entry past the `next.phase in sig` guard is done by
deleting the verify+remediate cycle signals (`maybeResetForRemediateCycle`); the
cap escalation stalls the verify signal (`maybeEscalateRemediateExhausted`).

Each phase writes its signal file at
`~/catalyst/runs/<orchId>/workers/<TICKET>/phase-<name>.json`. Per-phase turn-cap
defaults live in `plugins/dev/scripts/phase-agent-dispatch` (functions
`phase_default_turn_cap` and `resolve_turn_cap`, which honors a CLI flag override
and the `catalyst.orchestration.phaseAgents.turnCaps[<phase>]` config key in that
order). The prior-artifact gate — which file must already exist before a phase
launches — sits alongside in the same script.

**Dispatch-time rebase (CTL-667).** On a **fresh** dispatch of a **build** phase
(`research`, `plan`, `implement`, `verify`, `review`), `phase-agent-dispatch`
rebases the ticket's worktree onto current `origin/main` *before* launching the
worker, so each build phase starts current with merged sibling work and a
divergence surfaces at dispatch instead of riding all the way to `monitor-merge`.
It is local-only (never pushes, never touches the PR) and mechanical: a clean
rebase falls through to the normal launch; a textual **conflict** aborts, parks
the ticket (`status:"stalled"` + `failureReason:"rebase_conflict_with_origin_main"`,
`phase.<phase>.failed` emitted) and routes it to `needs-human` without launching a
worker — conflicts are never auto-resolved. Resume dispatches (CTL-658) and the
non-build phases (`triage`/`pr`/`remediate`/`monitor-merge`/`monitor-deploy`/`teardown`) skip
the rebase; the `monitor-*` and `teardown` phases operate on the PR / merged SHA and keep their
own `BEHIND` handling. Git logic lives in `lib/worktree-rebase.sh`; the build-phase
set is `is_rebase_phase` in `lib/phase-sequence.sh`.

### State machine for one worker

```mermaid
stateDiagram-v2
  [*] --> triage
  triage --> research: phase.triage.complete
  research --> plan: phase.research.complete
  plan --> implement: phase.plan.complete
  implement --> verify: phase.implement.complete
  verify --> review: verdict-pass (risk<5, no high finding)
  verify --> remediate: verdict-fail & cycle<3 (CTL-653)
  remediate --> verify: re-verify (reset signals, cycle++)
  verify --> stalled: verdict-fail & cycle≥3 → needs-human
  review --> pr: phase.review.complete
  pr --> monitor_merge: phase.pr.complete
  monitor_merge --> monitor_deploy: phase.monitor-merge.complete
  monitor_deploy --> teardown: phase.monitor-deploy.complete
  teardown --> [*]: phase.teardown.complete

  triage --> revived_triage: phase.triage.failed (≤1)
  research --> revived_research: phase.research.failed (≤1)
  implement --> revived_implement: phase.implement.failed (≤1)
  revived_triage --> triage
  revived_research --> research
  revived_implement --> implement
  revived_implement --> stalled: 2nd failure → escalate
  stalled --> [*]
```

Revives are once-per-phase; on the second `phase.<name>.failed` for the same phase
the orchestrator marks the worker `stalled`, posts `attention`, and stops advancing.
The `verify ⇄ remediate` cycle (CTL-653) is the one exception to the
"escalate on second failure" rule: a verify *verdict*-fail (a `complete` event
with a high `regression_risk`, distinct from a verify *crash* `failed` event)
self-heals through `remediate` up to 3 times before stalling — so a fixable
verify failure no longer needs a human on the first try.

## Phase 4 monitor — broker interests + event flow

The orchestrator registers four broker interests at Phase 4 start. All four route
back as `filter.wake.<ORCH_NAME>` so the orchestrator only watches one event stream:

| Interest | Type | Cardinality | Source |
|---|---|---|---|
| `${ORCH_NAME}-pr-lifecycle` | `pr_lifecycle` | 1 per orchestrator | always |
| `${ORCH_NAME}-ticket-lifecycle` | `ticket_lifecycle` | 1 per orchestrator | always |
| `${ORCH_NAME}-comms-lifecycle` | `comms_lifecycle` | 1 per orchestrator | always |
| `${ORCH_NAME}-phase-lifecycle-<TICKET>` | `phase_lifecycle` | 1 per ticket | only when `dispatchMode = "phase-agents"` |

The `phase_lifecycle` interest carries `{ticket, phase_names[10]}`. The broker's
`tryPhaseLifecycleRoute` function in `plugins/dev/scripts/broker/index.mjs` matches
incoming events against
`^phase\.([^.]+)\.(complete|failed)\.([A-Za-z][A-Za-z0-9_]*-\d+)$`
deterministically (no Groq).

```mermaid
sequenceDiagram
  autonumber
  participant W as Worker (claude --bg)
  participant B as catalyst-broker
  participant O as Orchestrator
  participant D as orchestrate-phase-advance
  participant P as phase-agent-dispatch

  W->>B: emit phase.research.complete.CTL-101
  B->>B: match against phase_lifecycle<br/>(ticket=CTL-101, phase_names⊇{research})
  B->>O: fire filter.wake.<ORCH_NAME><br/>reason="Phase research complete on CTL-101"
  O->>D: orchestrate-phase-advance --ticket CTL-101 --completed-phase research
  D->>D: next_phase = "plan" (from canonical sequence)
  D->>D: check idempotency<br/>(skip if phase-plan.json exists)
  D->>P: orchestrate-dispatch-next --phase plan --ticket CTL-101
  P->>P: claude --bg /catalyst-dev:phase-plan CTL-101
  P->>P: capture bg_job_id from stdout
  P->>P: write phase-plan.json with bg_job_id, status=running
  P->>B: emit phase.plan.dispatched (re-arms phase_lifecycle interest)
```

## Healthcheck + revive

`orchestrate-healthcheck` does two passes:

1. **Legacy PID liveness** — for `workers/*.json` at `status=dispatched`, after a
   `--grace-seconds` (default 15s) wait, checks `kill -0 $PID`. Dead PIDs →
   `status=failed` + `worker-launch-failed` event.
2. **Phase-mode `--bg` state-file mtime** — for each `workers/*/phase-*.json` with a
   `bg_job_id`, stats `${JOBS_ROOT}/<bg>/state.json` (where `JOBS_ROOT` defaults
   to `$HOME/.claude/jobs`). Stalled if:
   - file missing → `STALL_REASON="state-json-missing"`, OR
   - mtime older than `--stale-bg-seconds` (default 900s) AND `.state` not in
     `{done, failed, errored, stopped}` → `STALL_REASON="state-json-stale"`

   A **git-activity liveness guard** (CTL-509) protects the `state-json-stale`
   branch: before flagging, it reads the worker worktree's most-recent commit
   timestamp and, if it is newer than `--git-activity-seconds` (defaults to
   `--stale-bg-seconds`), suppresses the stall (signal left `running`, a
   `worker-phase-stale-suppressed` event logged, `gitActiveSuppressed` bumped in
   the summary). This mirrors the execution-core `stalled-detector.mjs` guard
   (inactive in phase-agents mode) so a live worker blocked in one long tool call
   is not falsely re-dispatched. It never guards `state-json-missing` and is
   opt-out via `--no-git-guard` / `CATALYST_HEALTHCHECK_GIT_GUARD=0`.

Revive budget: the top-level `workers/<TICKET>.json` carries `.reviveCount`. When
`reviveCount >= MAX_REVIVES` (default 10), the worker is marked `stalled` with
`attentionReason="revive-budget-exhausted"`.

Phase-mode workers that emit `phase.<name>.turn-cap-exhausted.<TICKET>` are
continued via `orchestrate-revive`'s per-phase loop (CTL-613): the loop reads
`.handoffPath` off the per-phase signal, resolves the prior Claude session id
from `${JOBS_ROOT}/<bg_job_id>/state.json`'s `linkScanPath` field, resolves the
worktree from the orchestrator's `state.json`, and spawns a `claude --bg --resume`
worker with `CATALYST_IS_CONTINUATION=true` + `CATALYST_HANDOFF_PATH=<path>` +
`CATALYST_CONTINUATION_COUNT=<n>`. The per-phase signal flips back to `running`
with the new `bg_job_id`, `phaseContinuationCount` bumps, and a
`phase.<name>.dispatched` event re-arms the broker. `phaseContinuationCount` is
budgeted separately from `phaseReviveCount` (which counts hard-error
re-dispatches) and shares `MAX_CONTINUATIONS` with the legacy top-level
continuation branch.

## The events JSONL is the unified log

Everything Catalyst does — worker dispatch, phase transitions, PR lifecycle,
GitHub/Linear webhooks, broker wakes — flows through one append-only file at
`~/catalyst/events/YYYY-MM.jsonl` (monthly rotation, canonical OTel-style envelope).
This is the single source of cross-process truth.

```mermaid
flowchart LR
  subgraph Producers
    direction TB
    SESSION["catalyst-session.sh<br/>service.name=catalyst.session"]
    STATE["catalyst-state.sh +<br/>emit-worker-status-change.sh<br/>service.name=catalyst.orchestrator"]
    PHASE["phase-agent-emit-complete<br/>service.name=catalyst.phase-agent"]
    COMMS["catalyst-comms<br/>service.name=catalyst.comms"]
    GH["orch-monitor webhook (GitHub)<br/>service.name=catalyst.github"]
    LIN["orch-monitor webhook (Linear)<br/>service.name=catalyst.linear"]
    BROKER["catalyst-broker daemon<br/>service.name=catalyst.broker"]
  end

  EL[("events JSONL<br/>~/catalyst/events/YYYY-MM.jsonl<br/>append-only")]

  SESSION ==> EL
  STATE ==> EL
  PHASE ==> EL
  COMMS ==> EL
  GH ==> EL
  LIN ==> EL
  BROKER -- "emits filter.wake.*<br/>+ broker.daemon.*" --> EL

  EL -- "tail<br/>+ shouldSkipEvent<br/>(skip catalyst.broker)" --> BROKER

  subgraph Consumers
    direction TB
    TAIL["catalyst-events tail<br/>--filter jq"]
    WAIT["catalyst-events wait-for<br/>--filter jq"]
    OM["orch-monitor server<br/>SSE → web UI"]
    HUD["catalyst-hud<br/>(Ink TUI)"]
    FWD["catalyst-otel-forward<br/>→ OTLP/PostHog/CFAE"]
    ANL["analyze-events.ts<br/>(offline query)"]
    REAPER["execution-core daemon reaper<br/>service.name=catalyst.execution-core"]
  end

  EL --> TAIL
  EL --> WAIT
  EL --> OM
  EL --> HUD
  EL --> FWD
  EL --> ANL
  EL -- "tail *.reap-requested<br/>(boot-replay + byte-cursor)" --> REAPER
  REAPER -- "re-emits *.reap-complete<br/>/ *.reap-failed echoes (CTL-649)" --> EL
```

**The broker is both a producer and a consumer** — it tails the same log it writes
into. The `shouldSkipEvent` function (in `broker/index.mjs`) prevents the feedback
loop: events whose `resource."service.name"` equals `"catalyst.broker"` are dropped
on read (belt-and-suspenders fallback also drops names prefixed `filter.` or
`broker.daemon.`). A separate `_emittedWakeCache` (60s TTL on
`(source_event_id, interest_id)`) deduplicates wakes when `fs.watch` fires twice
on the same append.

**The broker is also the ingestion-silence detector (CTL-1122).** Because it tails
every event, the broker is the surviving process that can judge whether an upstream
ingestion source has gone quiet — the out-of-process check the monitor can't do for
itself (the SPOF behind a 2026-06-14 11h silent outage). Each watchdog tick it
evaluates per-source event recency and edge-triggers `catalyst.ingestion.{stale,recovered}`
(emit-only; CTL-1123 consumes them). The `catalyst.monitor` heartbeat is judged on a
tight fixed cadence (3m/10m, ungated). The `catalyst.github` webhook source is judged
on a wide threshold (15m/30m) **gated on fleet activity** — github silence only alarms
while a worker is in-flight (a fresh non-terminal `worker_state` row), so an idle fleet
never false-alarms. Linear is deferred (its bot-skip guard makes the source quiet even
during active work). See the configuration reference for the env knobs.

**The execution-core daemon reaper (CTL-649) is the second producer-and-consumer.**
It consumes the reap-intent requests appended by the reap-intent producers
(`lib/emit-reap-intent.sh`, `execution-core/reap-intent.mjs`) — `phase.<kind>.reap-requested`,
`worktree.presweep.reap-requested`, `pr.merged.cleanup-requested`, `orphans.reap-requested` — by
boot-replaying any request with no matching `*-complete` echo on daemon start, then following new
appends via an `fs.watch` + byte-cursor tail. For each it runs the matching local executor
(`claude stop`, `git worktree remove`, `git branch -D`) and re-emits a `*.reap-complete` /
`*.reap-failed` echo back into the same log; `orphans.reap-requested` fans out to one
`phase.abort.reap-requested` per orphaned session. An in-memory dedupe window (keyed on
`event:bg_job_id|worktree_path`) suppresses duplicate intents.

## Where you observe a running orchestration

Five operator surfaces — four read structured state, one reads diagnostic logs:

| Surface | Reads | Where it lives | When to use |
|---|---|---|---|
| **`catalyst-hud`** (Ink TUI) | `~/catalyst/runs/<id>/{state.json,workers/*.json}` + `~/catalyst/broker-interests.json` + `broker.state.json` | `plugins/dev/scripts/orch-monitor/cli/` | Live operator dashboard — workers, interests, broker key-health |
| **orch-monitor web dashboard** | file-watches `DASHBOARD.md` → SSE; also `/api/archive/*` from `catalyst.db` | `plugins/dev/scripts/orch-monitor/` | Shareable browser view; archive replay |
| **`catalyst-events tail --filter`** | append-only JSONL at `~/catalyst/events/YYYY-MM.jsonl` | `plugins/dev/scripts/catalyst-events` | Raw semantic event stream, jq-filterable |
| **`catalyst-execution-core sessions/worktrees/branches list`** | live `claude agents` inventory + git worktree/branch state (read path of the CTL-649 audit CLI) | `plugins/dev/scripts/catalyst-execution-core` → `execution-core/cli/{sessions,worktrees,branches}.mjs` | Inventory and classify live sessions, worktrees, and branches — what the reaper sees before it acts |
| **`catalyst broker logs`** | tails `~/catalyst/broker.log` (pino-structured daemon stdout) | `plugins/dev/scripts/catalyst-broker` | Broker daemon diagnostics — Groq errors, routing traces, key-missing warnings |

**Broker logs vs events JSONL — these are different things.** The events log is the
system's semantic fact record (sparse, structured, durable); `broker.log` is the
daemon's operational diary (verbose, diagnostic). A `broker.daemon.startup` event
appears in the events log specifically so orchestrators know to re-register their
interests — not for human debugging. Broker errors that surface a named event go
to both; ordinary daemon noise goes only to `broker.log`.

`catalyst-hud` surfaces both layouts: flat `workers/*.json` and per-phase
`workers/<TICKET>/phase-<name>.json`. The reader
(`worker-signals-reader.ts::scanOrchestratorWorkersDir`) descends one level into
per-ticket subdirectories, picks the most recent non-terminal phase, and overlays
its `phaseName`/`status` onto the flat signal so the PHASE column shows the live
phase (e.g. `implement`, `monitor-merge`).

## Cost capture

Both dispatch modes write the same four cost surfaces — `signal.cost`,
`state.workers[ticket].usage`, `state.usage`, and the `session_metrics` SQLite
mirror — but the USAGE source differs by mode. `orchestrate-roll-usage.sh`,
invoked by `update-dashboard.sh --roll-usage` on every monitor wake-up,
abstracts the difference.

**Legacy (`oneshot-legacy` dispatch).** Workers run as `claude -p
--output-format stream-json`. The CLI streams a final `"type":"result"` event
carrying `total_cost_usd`, `usage`, `num_turns`, and `duration_ms` into
`workers/output/<TICKET>-stream.jsonl`. roll-usage parses that event into a
USAGE record.

**Phase-agent (`phase-agents` dispatch, CTL-496).** Workers run as `claude
--bg` jobs. There is no `result` event because there is no `--output-format
stream-json` flag on the bg invocation; instead the CLI writes the full
conversation to `~/.claude/projects/<wt>/<sessionId>.jsonl`. roll-usage
resolves the JSONL path via `~/.claude/jobs/<bg_job_id>/state.json
-> linkScanPath` and shells `extract-cost-from-jsonl.sh --jsonl <path>
--pricing claude-pricing.json` to aggregate per-assistant-event `usage` by
model, split cache_creation by 5m / 1h TTL, and apply the per-model rates
from a versioned `plugins/dev/scripts/claude-pricing.json`. The four
downstream writes are then unchanged from legacy.

Phase mode aggregates `state.workers[ticket].usage` across phases (`+=`),
not overwriting, so `state.workers[T].usage.costUSD == sum(phase.cost.costUSD)`
for that ticket. The `session_metrics` mirror finds the right row via
`signal.catalystSessionId` (persisted by the phase-agent prelude) or, for
in-flight runs that predate that persistence, a DB lookup keyed on
`ticket_key + skill_name = 'phase-<name>'`.

The sweep loop in `update-dashboard.sh` iterates both layouts on every
wake-up. Killed-worker sidecars (`workers/<T>/phase-<name>.json.dead-<id>.json`)
are skipped so booked cost is never double-counted.

## On Claude Code's "agent view" / agents sidebar

Phase-agent workers run as `claude --bg` jobs and live under
`~/.claude/jobs/<bg_job_id>/`. **Catalyst does not integrate with Claude Code's
native UI surfaces.** Specifically:

- The Claude CLI **writes** `~/.claude/jobs/<id>/state.json`; Catalyst only reads
  it (for healthcheck mtime / staleness detection).
- Catalyst ships no UI that hooks into Claude Code's agents sidebar.
- Whether Claude Code's agents sidebar displays `--bg` jobs is a **Claude Code
  question**, not a Catalyst question, and is not described in any catalyst source.

If you want to monitor a running orchestration, use `catalyst-hud`, the
orch-monitor web dashboard, `catalyst-events tail`, the
`catalyst-execution-core sessions/worktrees/branches list` audit CLI, or
`catalyst broker logs` — those are the surfaces Catalyst owns. If you want to see
backgrounded Claude jobs directly, consult the Claude CLI's own documentation for
whatever inventory it exposes.

## Canonical artifact / state locations

| Path | Written by | Purpose |
|---|---|---|
| `~/catalyst/runs/<id>/state.json` | orchestrator + `catalyst-state.sh` | per-run state |
| `~/catalyst/runs/<id>/DASHBOARD.md` | `update-dashboard.sh` (every Phase 4 wake) | human-readable dashboard |
| `~/catalyst/runs/<id>/SUMMARY.md` | orchestrator at Phase 5 | end-of-run summary |
| `~/catalyst/runs/<id>/wave-N-briefing.md` | orchestrator before dispatching Wave N+1 | wave context |
| `~/catalyst/runs/<id>/workers/<TICKET>.json` | `orchestrate-dispatch-next` + worker | top-level worker signal |
| `~/catalyst/runs/<id>/workers/<TICKET>/phase-<name>.json` | `phase-agent-dispatch` | per-phase signal (phase-agents mode only) |
| `~/catalyst/runs/<id>/workers/output/<TICKET>-{stream.jsonl,bg-stdout.log,stderr.log}` | spawned worker | worker stdio capture |
| `~/catalyst/runs/<id>/.roll-usage.log` | `orchestrate-roll-usage.sh -v` (via `update-dashboard.sh --roll-usage`) | per-sweep audit trail of cost rollups (action codes: `wrote-cost`, `already-rolled`, `bg-state-missing`, `jsonl-missing`, `wrote-metric`, etc.) |
| `plugins/dev/scripts/claude-pricing.json` | manual edit (version-pinned, see file header) | per-model token pricing table consumed by `extract-cost-from-jsonl.sh` in phase mode |
| `~/catalyst/runs/<id>/findings.jsonl` | both | shared findings queue |
| `~/catalyst/state.json` | `catalyst-state.sh` register/update/worker/heartbeat | global active-runs registry |
| `~/catalyst/catalyst.db` | `catalyst-archive.ts sweep` + skill instrumentation | SQLite sessions + metrics + archive index |
| `~/catalyst/events/YYYY-MM.jsonl` | seven producers (see "events JSONL" section) | append-only event log |
| `~/catalyst/broker.log` | broker daemon stdout/stderr | diagnostic log (view with `catalyst broker logs`) |
| `~/catalyst/broker.state.json` | broker daemon | liveness + key-health snapshot |
| `~/catalyst/archives/<id>/` | `catalyst-archive.ts sweep` (filesystem-first) | post-run archived artifacts |
| `~/catalyst/broker-interests.json` | broker daemon | live broker interest registry |
| `~/.claude/jobs/<bg_job_id>/state.json` | **Claude CLI** (not Catalyst) | `--bg` job liveness |
| `thoughts/shared/handoffs/<orchId>/<ts>_…-{summary,dashboard}.md` | orchestrator at Phase 5 | thoughts handoff copy |

## What changed from pre-CTL-452

| | Before | After |
|---|---|---|
| Worker spawn | one `claude -p /oneshot <TICKET>` per ticket (long-lived, streaming JSON) | ten `claude --bg /phase-<name>` jobs per ticket (short-lived) — when `dispatchMode = "phase-agents"` |
| Signal layout | flat `workers/<TICKET>.json` | flat top-level + per-phase `workers/<TICKET>/phase-<name>.json` |
| Phase advance | wait for `orchestrator.worker.status_terminal` from long oneshot | wait for `phase.<name>.complete.<TICKET>` → `orchestrate-phase-advance` walks canonical 10-step sequence |
| Broker interests | 3 (`pr_lifecycle`, `ticket_lifecycle`, `comms_lifecycle`) | 4 (above + `phase_lifecycle` per ticket — gated on `dispatchMode`) |
| Healthcheck | PID liveness only | PID liveness + `~/.claude/jobs/<bg>/state.json` mtime (`--stale-bg-seconds`, default 900s) |
| Linear states | Backlog / In Progress / In Review / Done / Canceled | + intermediate `triaged`, `researching`, `planning`, `verifying`, `reviewing`, `inReview` (CTL-454) |

Legacy `oneshot-legacy` mode is unchanged — all the above only activates when
`dispatchMode = "phase-agents"` is set in `.catalyst/config.json`.

## Cold-start recovery (CTL-639)

When the daemon restarts after a crash or `kill`, the boot-resume pass
(`boot-resume.mjs::reconcileBootResume`) re-dispatches in-flight tickets whose
`--bg` workers are no longer alive. The pass classifies each candidate by phase:

| Phase class | Phases | Boot behaviour |
|---|---|---|
| **Cheap** | `triage`, `research`, `plan` | Auto-re-dispatched immediately (no operator action needed). Work is short and idempotent. |
| **Expensive** | `implement`, `verify`, `review`, `pr`, `monitor-merge`, `monitor-deploy`, `remediate` | **Gated** — a `.boot-resume-pending-approval` marker is written under `workers/<TICKET>/` and a `phase.<phase>.boot-resume-gated.<ticket>` audit event is emitted. No worker is spawned until the operator approves. |

### Operator greenlight for expensive phases

To approve re-dispatch of a gated ticket, create the approval sentinel:

```bash
touch "$ORCH_DIR/workers/<TICKET>/.boot-resume-approved"
```

The scheduler picks it up within one tick (≤30 s) and calls `reviveDispatch`
for that ticket's phase — subject to the same MAX_REVIVES and storm-breaker
guards as a per-tick reclaim. Both sentinels are deleted on a successful
dispatch so a subsequent reboot does not re-dispatch.

To list currently gated tickets:

```bash
find "$ORCH_DIR/workers" -name ".boot-resume-pending-approval" | while read p; do
  echo "$(basename "$(dirname "$p")"): $(jq -r '.phase' "$p")"
done
```

If a HUD button later writes the same sentinel it requires no logic changes —
`processApprovedResumes` polls for the file, not for the transport that wrote it.

## See also

- [`website/src/content/docs/reference/orchestration/phase-agents.md`](../website/src/content/docs/reference/orchestration/phase-agents.md) — user-facing canonical doc shipped in PR #812
- [`plugins/dev/skills/orchestrate/SKILL.md`](../plugins/dev/skills/orchestrate/SKILL.md) — orchestrator skill source of truth
- [`plugins/dev/scripts/orchestrate-phase-advance`](../plugins/dev/scripts/orchestrate-phase-advance) — wake handler (canonical phase sequence)
- [`plugins/dev/scripts/phase-agent-dispatch`](../plugins/dev/scripts/phase-agent-dispatch) — worker spawn + turn-cap resolution
- [`plugins/dev/scripts/broker/index.mjs`](../plugins/dev/scripts/broker/index.mjs) — broker daemon (`tryPhaseLifecycleRoute`, `shouldSkipEvent`)
- [`plugins/dev/scripts/catalyst-events`](../plugins/dev/scripts/catalyst-events) — events CLI (tail, wait-for, query)
- [ADR-006](adrs.md) — global state JSON design
- [ADR-008](adrs.md) — SQLite session store
- [ADR-014](adrs.md) — worker owns full PR lifecycle (no more `gh pr merge --auto`)

## Self-assign activation runbook (CTL-1011)

The execution-core daemon writes the Catalyst bot as the Linear assignee on every ticket it claims (`applyAssignee`, CTL-781). The mechanism is always invoked — when `botUserId` is absent or the token lacks scope, one deduped `warn` surfaces the gap instead of a silent skip.

### Before you start

Two prerequisites block the board-visibility outcome (assigned agent visible in Linear):

1. **OAuth decision** — choose Path A or Path B:
   - **Path A**: grant `app:assignable` scope to the existing Catalyst Orchestrator app (`ff78d890-7906-4c22-b2f5-020bd150c790`). The simplest path if your workspace already has the app installed.
   - **Path B**: create a dedicated bot member account, add it to your Linear workspace, and use its `viewer.id` as the `botUserId`. The preferred path for fine-grained control.

2. **Token scope** — the OAuth access token stored under `catalyst.linear.bot.orchestrator.accessToken` must include `app:assignable`. Re-mint the token after granting the scope (step 4 below).

### Activation steps

1. **Decide Path A or B** (see above). For Path A, go to your Linear workspace settings → API → OAuth apps → Catalyst Orchestrator → grant `app:assignable`.

2. **Re-mint the access token**:
   ```bash
   # Uses the client credentials flow (requires clientId + clientSecret already in global config)
   catalyst-execution-core remint-token --actor orchestrator
   # or manually via the OAuth endpoint
   ```

3. **Capture `viewer.id`** for the app actor:
   ```bash
   TOKEN=$(jq -r '.catalyst.linear.bot.orchestrator.accessToken' ~/.config/catalyst/config.json)
   BOT_ID=$(curl -s -X POST https://api.linear.app/graphql \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"query":"query{viewer{id name}}"}' | jq -r .data.viewer.id)
   echo "botUserId = $BOT_ID"
   ```

4. **Set `botUserId` in Layer-2 on all hosts** (never committed — lives in `~/.config/catalyst/config.json`):
   ```bash
   jq --arg id "$BOT_ID" '.catalyst.linear.bot.orchestrator.botUserId = $id' \
     ~/.config/catalyst/config.json > /tmp/cfg.json && mv /tmp/cfg.json ~/.config/catalyst/config.json
   ```
   Repeat on every host that runs the execution-core daemon.

5. **Restart the daemon** — `botUserId` is read only at startup:
   ```bash
   catalyst-execution-core restart
   ```

6. **Smoke-test** — let one ticket enter Triage and confirm the Catalyst bot appears as assignee in Linear. The CTL-1011 Phase 1/2 guards make a misstep loud: a missing `botUserId` prints one `warn` ("self-assign disabled") and a scope error prints one `warn` per Linear team ("app-actor lacks assignee scope") — both include the remedy.

7. **Backfill** (CTL-827) and enable the CTL-1159 ownership gate after the smoke-test passes.

### Diagnostic signals

| Symptom | Cause | Remedy |
|---------|-------|--------|
| `linear-write: self-assign disabled — botUserId not configured` (once per process) | `catalyst.linear.bot.orchestrator.botUserId` is null/absent | Steps 3–5 above |
| `linear-write: assignee write rejected — app-actor lacks assignee scope for team` (once per team) | Token missing `app:assignable` | Steps 1–2 + 5 |
| `applyAssignee` returns `reason: "verify-failed"` | Write succeeded but read-back mismatch (Linear eventual consistency lag) | Usually self-correcting; check if another user is reassigning the ticket |
