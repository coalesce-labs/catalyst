---
title: Phase agents
description:
  Nine short-lived skills the orchestrator dispatches per ticket — each runs in its own `claude
  --bg` job, advances on a broker event, and bills against the subscription pool instead of
  Agent-SDK-Credit.
sidebar:
  order: 2
---

The **phase-agent pipeline** decomposes a worker run from one long `claude -p` `oneshot` session
into nine short-lived skills the orchestrator dispatches one at a time. Each phase is its own
`claude --bg` job: it starts with empty context, reads the prior phase's artifact, does one thing,
emits a `phase.<name>.complete.<ticket>` event, and exits. The orchestrator wakes on the event and
dispatches the next phase.

This default pipeline is one instance of a [workflow descriptor](/reference/orchestration/workflows/) —
the JSON definition of the steps, their order, and the per-step model / effort / prompt levers. The
phases documented below are the default descriptor's `steps[]`.

The decomposition is the answer to the **2026-06-15 Agent-SDK-Credit billing change**. After that
date every `claude -p` call bills against the Agent-SDK-Credit budget; `claude --bg` jobs continue
to draw from the Max 20x subscription pool. Moving worker dispatch off `-p` to `--bg` keeps a
typical orchestrator run inside the $200/month Max 20x envelope.

:::note[Default vs phase-agents] The orchestrator still ships with `dispatchMode: "oneshot-legacy"`
as the default — a single long `claude -p` worker per ticket running
[`/catalyst-dev:oneshot`](/reference/orchestration/workers/). Opt into the phase-agent pipeline by
setting `catalyst.orchestration.dispatchMode` to `"phase-agents"` in `.catalyst/config.json`. The
legacy oneshot path is preserved indefinitely for single-shot interactive use and as a fallback. :::

## The 9 phases

| #   | Skill                                             | Model             | Turn cap | Goal artifact                                 | Linear state    | Delegates to                      |
| --- | ------------------------------------------------- | ----------------- | -------- | --------------------------------------------- | --------------- | --------------------------------- |
| 1   | [`phase-triage`](#1-phase-triage)                 | Opus              | 10       | `triage.json`                                 | label `triaged` | —                                 |
| 2   | [`phase-research`](#2-phase-research)             | Opus              | 35       | `thoughts/shared/research/<date>-<ticket>.md` | `researching`   | `/catalyst-dev:research-codebase` |
| 3   | [`phase-plan`](#3-phase-plan)                     | Opus              | 25       | `thoughts/shared/plans/<date>-<ticket>.md`    | `planning`      | `/catalyst-dev:create-plan`       |
| 4   | [`phase-implement`](#4-phase-implement)           | Opus _(see Cost)_ | 75       | commits + `phase-implement.json`              | `inProgress`    | `/catalyst-dev:implement-plan`    |
| 5   | [`phase-verify`](#5-phase-verify)                 | Opus              | 20       | `verify.json`                                 | `verifying`     | gates + adversarial sub-agents    |
| 6   | [`phase-review`](#6-phase-review)                 | Opus              | 25       | `review.json` + remediation commit            | `reviewing`     | `/review` (gstack)                |
| 7   | [`phase-pr`](#7-phase-pr)                         | Opus              | 12       | open PR + `phase-pr.json`                     | `inReview`      | `/catalyst-dev:create-pr`         |
| 8   | [`phase-monitor-merge`](#8-phase-monitor-merge)   | Opus              | 50       | merged PR + `phase-monitor-merge.json`        | `done`          | (lifts oneshot Phase 5 loop)      |
| 9   | [`phase-monitor-deploy`](#9-phase-monitor-deploy) | Haiku             | 30       | `phase-monitor-deploy.json`                   | —               | `/canary` (gstack)                |

Default models come from `phase-agent-dispatch:51` (Opus) plus the per-phase override in
`phase-agent-dispatch:55-66`. Resolution order is `--model` CLI flag >
`catalyst.orchestration.phaseAgents.modelOverrides[phase][ticket]` >
`catalyst.orchestration.phaseAgents.models[phase]` > default Opus.

Turn caps follow the same precedence: `--turn-cap` CLI flag >
`catalyst.orchestration.phaseAgents.turnCaps[phase]` > the per-phase default above.

### Linear comment trail (CTL-632)

Every phase from `phase-triage` through `phase-monitor-deploy` (phases 1–9) mirrors its output back
to the Linear ticket as a single comment in its End block — not just `phase-triage`. So the ticket
accumulates a running commentary as the pipeline walks: the triaged classification, then the
research summary, the plan summary, the implement summary (files/lines), the verify gates +
findings, the review verdict, the PR (with pre-merge verification), the merge outcome (CI rollup +
bot/Codex reviews handled + time-to-merge), and the deploy (environment + preview URL + canary
verdict). The mirror is **idempotent** — guarded by a per-phase marker file
(`${ORCH_DIR}/workers/${TICKET}/.linear-mirror-<phase>`) so a re-dispatched or revived phase agent
doesn't double-post — and **fail-open** (a `linearis` failure logs and continues, never blocking the
phase). Each comment body is hard-truncated to 30,000 bytes (under Linear's effective comment cap)
with a truncation marker.

**Caveat:** the mirror lives in each skill's End block, so a phase the execution-core daemon
*reclaims* (false-declares dead and advances past) never runs its End block and posts no comment —
the daemon's reclaim path has no mirror fallback.

#### Run-metadata footer

Every mirror comment ends with a shared footer rendered by
`plugins/dev/scripts/lib/phase-mirror-footer.sh`:

```
---
_model `claude-opus-4-7` · 3 sub-agent(s) launched · active 7m 52s_
_catalyst session `sess_…` · job `bc222a77` · session uuid `bc222a77-…` · cwd `/…/wt/…`_
```

- **model / sub-agent count / active working duration** are read from the worker's conversation
  JSONL (resolved via the signal's `bg_job_id` → `~/.claude/jobs/<bg>/state.json` → `.linkScanPath`).
  _active_ is the sum of `turn_duration` events — actual compute time, **not** wall-clock — so a
  mostly-waiting phase like `phase-monitor-merge` reports only the time it was working.
- **identifiers + cwd** let an operator resume or inspect the exact session.
- The footer is **best-effort**: each field degrades to a placeholder independently and the helper
  never fails the comment. **Cost/token totals are intentionally omitted** — the only number
  reliably available at post time excludes sub-agent sessions; a true sub-agent-inclusive rollup
  (likely via OTEL/Prometheus, which Grafana already aggregates per ticket) is tracked in CTL-666.

### 1. `phase-triage`

Entry phase. Reads the Linear ticket, expands acronyms, classifies it
(`feature`/`bug`/`docs`/`refactor`/`chore`), identifies dependencies, estimates scope, writes
`${ORCH_DIR}/workers/${TICKET}/triage.json`, posts a triaged comment to Linear, and applies the
`triaged` label. Emits `phase.triage.complete.<TICKET>`.

The bash body does the deterministic work; Opus is used to refine ambiguous fields.

### 2. `phase-research`

Reads `triage.json` from the prior phase, delegates to
[`/catalyst-dev:research-codebase`](/plugins/catalyst-dev/), and emits
`phase.research.complete.<TICKET>` once `thoughts/shared/research/<date>-<ticket>.md` exists with
the standard frontmatter, Summary, Findings (≥10 `file:line` references), and References sections.
Mirrors its research summary to the ticket as a Linear comment (CTL-632).

### 3. `phase-plan`

Reads the research document by glob (`thoughts/shared/research/*-<ticket>.md`), delegates to
[`/catalyst-dev:create-plan`](/plugins/catalyst-dev/), and emits `phase.plan.complete.<TICKET>` once
`thoughts/shared/plans/<date>-<ticket>.md` exists with Overview plus phased Tests First (Red) →
Implementation (Green) → Refactor → Success Criteria sections. Mirrors its plan summary to the
ticket as a Linear comment (CTL-632).

### 4. `phase-implement`

Reads the plan, delegates to [`/catalyst-dev:implement-plan`](/plugins/catalyst-dev/) via the Task
tool, commits each plan phase as it lands. `/goal` succeeds when `git diff <base>..HEAD` is
non-empty AND the targeted tests pass. Emits `phase.implement.complete.<TICKET>`. Mirrors its
implement summary to the ticket as a Linear comment (CTL-632).

The cost projection assumes Sonnet on this phase — that's a config flip
(`catalyst.orchestration.phaseAgents.models.implement = "sonnet"`), not a code change. The shipped
default is Opus; switch it once you have a baseline to compare against. Per-ticket overrides via
`modelOverrides.implement.<TICKET>` give you an escape hatch when a particularly ambiguous plan
needs Opus.

### 5. `phase-verify`

Read-only adversarial verification. Runs tsc, tests, lint, security scan, reward-hacking scan, plus
the `code-reviewer`, `pr-test-analyzer`, and `silent-failure-hunter` sub-agents. Writes
`${ORCH_DIR}/workers/${TICKET}/verify.json` with a `regression_risk` score and findings list. Never
writes application code; test files are the only writable target. Emits
`phase.verify.complete.<TICKET>`. Mirrors the regression-risk score, per-gate pass/fail/skip, and
findings to the ticket as a Linear comment (CTL-632).

This is the **independent verification layer** that replaces the orchestrator's adversarial recheck
— see [Verification and reward-hacking defense](/reference/orchestration/verification/).

### 6. `phase-review`

Reads `verify.json`, runs the `/review` skill (gstack) against the diff, writes
`${ORCH_DIR}/workers/${TICKET}/review.json`, and creates a remediation commit for any HIGH-severity
finding with a deterministic fix. Emits `phase.review.complete.<TICKET>`. Mirrors its review verdict
and findings to the ticket as a Linear comment (CTL-632).

Explicitly skips `/ultrareview` (per the source plan); operator can still run it manually after the
PR opens.

### 7. `phase-pr`

Delegates to [`/catalyst-dev:create-pr`](/plugins/catalyst-dev/) (which already runs `describe-pr`
and transitions Linear to `inReview`), then writes PR number + URL into `phase-pr.json` so the
downstream `phase-monitor-merge` skips a redundant `gh` query. Emits `phase.pr.complete.<TICKET>`.

### 8. `phase-monitor-merge`

The **active listen loop**. Lifts the body of `oneshot` Phase 5 Step 2 verbatim: event-driven wait
on `catalyst-events wait-for`, inline resolution of CI failures, bot review threads, and BEHIND
rebases, then `gh pr merge --squash --delete-branch` when the PR reaches CLEAN. Transitions Linear
to `done` and emits `phase.monitor-merge.complete.<TICKET>`.

Stalls (CI red after 3 fix attempts, unresolvable conflicts, human changes-requested) write
`status: "stalled"` and post `attention` to the comms channel — the orchestrator's monitor loop
handles dispatch from there.

### 9. `phase-monitor-deploy`

Optional. Subscribes via `catalyst-events wait-for` to `deployment_status` events on the merge SHA
matching `$PHASE_DEPLOY_ENV` (default `production`), then runs the `/canary` skill (gstack) to
verify the live deployment. Writes `phase-monitor-deploy.json` and emits
`phase.monitor-deploy.complete.<TICKET>`, `.failed.<TICKET>`, or `.skipped.<TICKET>`. Uses Haiku by
default — most of the work is polling and reading deployment status events.

On a successful deploy it extracts the **preview / environment URL** from the `deployment_status`
event (`environmentUrl`, falling back to `targetUrl`), persists it to the signal as structured data
(`.deployment.url`) so a HUD or agent can link straight to the running deploy, and mirrors a deploy
comment to Linear (environment + clickable preview URL + canary verdict). As the terminal phase,
this is the last automated comment on the ticket.

Skipped automatically when no deploy event arrives within the wall-clock timeout, so projects
without deployment hooks don't block on this phase forever.

## Broker `phase_lifecycle` interest

The orchestrator subscribes once per ticket via
[`catalyst-broker`](/observability/catalyst-broker/)'s deterministic `phase_lifecycle` interest
type:

| Field           | Value                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `interest_type` | `phase_lifecycle`                                                                                  |
| `ticket`        | the Linear ticket ID, e.g. `CTL-123`                                                               |
| `phase_names`   | `["triage","research","plan","implement","verify","review","pr","monitor-merge","monitor-deploy"]` |
| `notify_event`  | `filter.wake.<ORCH_NAME>`                                                                          |

Event pattern matched: `phase.<name>.(complete|failed).<TICKET>`. Routing is purely deterministic —
no Groq call, no prose evaluation. The broker auto-cleans the interest when the orchestrator emits
`agent.checkout`.

## Dispatch flow

```text
Orchestrator               phase-agent-dispatch         Phase agent (claude --bg)
     │                              │                              │
     ├─ creates worker signal ──────>│                              │
     │   workers/CTL-N.json          │                              │
     │                              ├─ writes phase signal:        │
     │                              │   workers/CTL-N/phase-triage.json
     │                              │   {status: "dispatched"}     │
     │                              ├─ launches claude --bg ───────>│
     │                              │   /catalyst-dev:phase-triage  │  reads triage.json
     │                              │   --orch-dir …                │  does its one job
     │                              │                              │  writes artifact
     │                              │                              │  emits phase.triage.complete.CTL-N
     │<─── filter.wake.<ORCH_NAME> ──┴──────────────────────────────│  → broker matches, fires wake
     │                                                              │  exits
     ├─ orchestrate-phase-advance --completed-phase triage           │
     │   --ticket CTL-N                                              │
     │     → phase_next(triage) = research                           │
     │     → orchestrate-dispatch-next --phase research --ticket CTL-N
     │     → (loops back to phase-agent-dispatch for next phase)     │
     ▼
```

Each phase agent is **idempotent**: if `phase-agent-dispatch` finds an existing signal with `status`
of `dispatched`, `running`, or `done`, it exits 0 without re-spawning. Only `failed` signals are
overwritten.

## Configuration

All phase-agent config lives under `catalyst.orchestration` in `.catalyst/config.json`:

```json
{
  "catalyst": {
    "orchestration": {
      "dispatchMode": "phase-agents",
      "phaseAgents": {
        "models": {
          "implement": "sonnet",
          "pr": "sonnet",
          "monitor-deploy": "haiku"
        },
        "modelOverrides": {
          "implement": {
            "CTL-501": "opus"
          }
        },
        "turnCaps": {
          "implement": 100
        }
      }
    }
  }
}
```

| Key                                         | Default            | Purpose                                                                                                     |
| ------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `dispatchMode`                              | `"oneshot-legacy"` | `"phase-agents"` enables the pipeline; `"oneshot-legacy"` keeps a single long `claude -p` worker per ticket |
| `phaseAgents.models[phase]`                 | `"opus"`           | Per-phase default model                                                                                     |
| `phaseAgents.modelOverrides[phase][ticket]` | none               | Per-phase, per-ticket override (highest precedence after CLI)                                               |
| `phaseAgents.turnCaps[phase]`               | see table above    | Hard cap on Claude turns per phase                                                                          |

Resolution order — both for model and turn-cap — is **CLI flag > `modelOverrides[phase][ticket]` >
`models[phase]` > built-in default**.

## Cost economics

The pipeline is a billing change first and an architecture change second. Two things matter:

1. **Subscription-pool dispatch.** Every phase agent runs as `claude --bg`, which draws from the Max
   20x subscription pool. The orchestrator itself is the only `-p` call on the dispatch path, and
   it's a short coordination loop. Per-run Agent-SDK-Credit spend on the worker path: **$0**.
2. **Per-phase model assignment.** The fresh context per phase costs ~$2.25 of "rehydration tax" per
   run (each phase re-reads prior artifacts). That tax is recouped by assigning Sonnet to Phase 4
   (implement) and Phase 7 (pr) and Haiku to Phase 9 (monitor-deploy).

**Cost projection** (Opus 4.7 = $5/$25 per Mtok in/out; Sonnet 4.6 ≈ $3/$15; Haiku 4.5 ≈ $0.80/$4,
sourced from the planning research; per-phase rows are **still projection-only** — see the
validation status below):

| Phase            | Model  | Est. turns | Cost (mixed) | Cost (all-Opus) |
| ---------------- | ------ | ---------- | ------------ | --------------- |
| 1 Triage         | Opus   | 5–8        | $0.30        | $0.30           |
| 2 Research       | Opus   | 25–30      | $2.50        | $2.50           |
| 3 Plan           | Opus   | 15–20      | $1.50        | $1.50           |
| 4 Implement      | Sonnet | 40–60      | $2.70        | $4.50           |
| 5 Verify         | Opus   | 10–15      | $0.80        | $0.80           |
| 6 Review         | Opus   | 15–20      | $1.20        | $1.20           |
| 7 PR             | Sonnet | 5–8        | $0.18        | $0.30           |
| 8 Monitor-merge  | Opus   | 10–30      | $0.50        | $0.50           |
| 9 Monitor-deploy | Haiku  | 5–15       | $0.03        | $0.20           |
| **Total**        | mixed  | ~150       | **~$9.71**   | $11.80          |

**Measured oneshot-legacy baseline** (the calibration point for the table above —
[CTL-485](https://linear.app/coalesce-labs/issue/CTL-485), orchestrator
`o-ctl-476-...-486`, 2026-05-17, n=7, all-Opus 4.7 with the 1M-context flag):

| Statistic          | Value (USD)     |
| ------------------ | --------------- |
| Min / max          | $4.48 / $15.13  |
| Median             | $8.08           |
| Mean               | $7.95           |
| Mean cache-read    | 4.78M tokens    |
| Mean duration      | 555 s (~9 min)  |
| Mean turns         | 46              |

The all-Opus projection ($11.80) is ~48% higher than the measured oneshot-legacy mean. The
documented per-run rehydration tax (~$2.25) plus coordinator overhead accounts for most of the
gap. The order-of-magnitude is right; the per-phase split still needs a phase-agents run to
validate row-by-row.

:::note[Validation status (2026-05-18)] **End-to-end cost capture for `phase-agents` mode is
landed (CTL-496).** `update-dashboard.sh --roll-usage` sweeps both `workers/<TICKET>.json`
(legacy) and `workers/<TICKET>/phase-<NAME>.json` (phase-agents) on every monitor wake-up via
the CTL-487 wiring, populating `signal.cost`, `state.workers[T].usage` (aggregated across phases
with `+=`), `state.usage`, and per-phase `session_metrics` rows.

Phase-mode USAGE is sourced from the bg session conversation JSONL
(`~/.claude/projects/<wt>/<sid>.jsonl`) by
[`extract-cost-from-jsonl.sh`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/scripts/extract-cost-from-jsonl.sh)
because `claude --bg` does not emit the stream-json `result` event that legacy roll-usage
parses. The extractor reads per-message `usage` blocks, splits cache_creation by 5m/1h TTL, and
applies per-model pricing from
[`plugins/dev/scripts/claude-pricing.json`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/scripts/claude-pricing.json)
(version-pinned, manually updated when Anthropic publishes rate changes).

`session_metrics` attribution is by `session_id`. Each phase agent starts its own
`catalyst-session.sh` row with `skill_name = phase-<name>`, and the prelude persists
`catalystSessionId` into the phase signal so roll-usage mirrors cost into the right row without
DB heuristics. A `ticket_key + skill_name` fallback handles in-flight runs that predate the
prelude change.

Open follow-up:

- [CTL-488](https://linear.app/coalesce-labs/issue/CTL-488) — per-phase rows in the projection
  table still need an end-to-end `dispatchMode: "phase-agents"` run to validate row-by-row now
  that the data path is reliable. This is now a data-collection task, not a wiring gap. :::

## Observing a run

Real-time:

- **HUD** — `catalyst-hud` shows per-ticket phase, signal status, and (once `session_metrics` is
  populated) cumulative cost.
- **Events** — `catalyst-events tail` streams `phase.<name>.complete.<TICKET>` as each phase lands.
- **Signal files** — `${ORCH_DIR}/workers/<TICKET>/phase-<name>.json` records dispatch state,
  artifact path, and timing for every phase.

After the run:

```bash
# Aggregate cost per workflow (once session_metrics has data)
sqlite3 ~/catalyst/catalyst.db -header -column <<'SQL'
SELECT s.workflow_id,
       s.ticket_key,
       s.skill_name,
       printf('$%.4f', sm.cost_usd) AS cost,
       sm.input_tokens,
       sm.output_tokens,
       sm.duration_ms / 1000 AS dur_s
FROM sessions s
LEFT JOIN session_metrics sm ON s.session_id = sm.session_id
WHERE s.skill_name LIKE 'phase-%'
  AND s.workflow_id = '<your-orchestrator-session-id>'
ORDER BY s.started_at;
SQL
```

```bash
# Count completion events emitted by a ticket's full run
catalyst-events tail --since 24h \
  | jq -c 'select(.attributes."event.name" | startswith("phase.")
                  and (.attributes."event.name" | endswith(".CTL-N")))' \
  | wc -l
# Expect 9 (one per phase) for a successful run.
```

## End-to-end runbook

For the first real run against a low-risk ticket:

1. **Pick a small ticket** (docs fix, small refactor, no external deps).
2. **Set dispatch mode** in `.catalyst/config.json`:
   ```json
   { "catalyst": { "orchestration": { "dispatchMode": "phase-agents" } } }
   ```
3. **Verify `session_metrics` populates** with a single test session before committing to a full
   run. The orchestrator's monitor loop calls `update-dashboard.sh --roll-usage` on every
   wake-up, which sweeps both `workers/<TICKET>.json` (legacy) and `workers/<TICKET>/phase-<NAME>.json`
   (phase-agents) and writes through to signal + state + DB. If `cost_usd` is still `0` after a
   phase reaches `status: "done"`, check `${ORCH_DIR}/.roll-usage.log` — `bg-state-missing` or
   `jsonl-missing` action codes point at a stale or relocated `~/.claude/jobs/<bg>/state.json`;
   `extract-failed` points at the `extract-cost-from-jsonl.sh` script. You can manually flush a
   single phase with `orchestrate-roll-usage.sh --orch <orch-id> --ticket <TICKET> --phase
   <NAME> -v` to validate the data path independently.
4. **Dispatch the orchestrator**:
   ```bash
   /catalyst-dev:orchestrate <TICKET> --auto-merge --max-parallel 1
   ```
5. **Watch the HUD** through to merge. Expect 9 `phase.<name>.complete.<TICKET>` events in
   `catalyst-events tail`.
6. **Pull cost data** via the SQL query above. Compare per-phase numbers to the projection table;
   deltas >1.5× warrant tightening the relevant phase's turn cap or trimming its system prompt.

## Related

- [Workflow descriptors](/reference/orchestration/workflows/) — the pipeline as data; this page
  documents the default descriptor's steps
- [Workers and signal files](/reference/orchestration/workers/) — signal-file schema (shared between
  oneshot and phase-agent workers)
- [Verification and reward-hacking defense](/reference/orchestration/verification/) — the
  `phase-verify` and `phase-review` adversarial layers
- [Semantic event routing (catalyst-broker)](/observability/catalyst-broker/) — protocol for
  `phase_lifecycle` and related interest types
- [Orchestration overview](/reference/orchestration/) — Level 2/3 orchestration model and full
  config reference
