---
name: catalyst-filter
description:
  Protocol reference for the catalyst-filter semantic event routing daemon. Use when an
  orchestrator needs to wait for relevant events using a natural-language intent description
  instead of a precise jq predicate. Covers registration, waiting, deregistration, the wake
  event structure, prompt writing, context fields, and the fallback path when the daemon is
  not running.
---

# catalyst-filter — Semantic Event Routing Protocol

The `catalyst-filter` daemon sits between the raw catalyst event log and orchestrators. Instead
of requiring a precise jq filter at registration time, callers describe their intent in plain
language. The daemon batches incoming events, calls Groq Llama 3.1 8B to classify relevance, and
emits `filter.wake.{id}` events that orchestrators wait for with `catalyst-events wait-for`.

## When to Use

- **Orchestrator Phase 4** — replacing the poll loop with an event-driven wake signal
- **Any long-running wait** where the trigger condition is complex, multi-condition, or better
  expressed in words than jq
- **Multi-PR / multi-worker scenarios** — "wake me when any of my 4 PRs gets a CI failure or
  changes-requested review"

## When NOT to Use

- **Very short waits (< 1 min)** — direct `catalyst-events wait-for` with a jq filter is
  simpler and has lower latency
- **Single, precisely expressible conditions** — `.event == "github.pr.merged" and .scope.pr == 42`
  needs no LLM
- **`GROQ_API_KEY` is unavailable** — use the jq fallback described at the end of this doc

## Prerequisites

The daemon must be running and `GROQ_API_KEY` must be set:

```bash
# Check status
catalyst-filter status   # → "running (pid N)" or "stopped"

# Start if stopped
catalyst-filter start

# View startup log
catalyst-filter logs
```

`GROQ_API_KEY` is read from the environment. Set it in your shell profile or Layer 2 config
(`~/.config/catalyst/config-{projectKey}.json`).

## Protocol Overview

```
Orchestrator                         filter daemon                     Event log
    │                                     │                                │
    │── emit filter.register ────────────►│                                │
    │                                     │  polls every 200ms ◄───────────│
    │                                     │  batches events (100ms debounce)
    │                                     │  calls Groq: "is this relevant?"
    │                                     │── append filter.wake.{id} ────►│
    │                                     │                                │
    │◄── catalyst-events wait-for ────────────────────────────────────────│
    │    (.event == "filter.wake.{id}")   │                                │
    │                                     │                                │
    │── emit filter.deregister ──────────►│                                │
```

## Step 1 — Register

Emit a `filter.register` event to the catalyst event log before entering your wait:

```bash
STATE_SCRIPT="/path/to/plugins/dev/scripts/catalyst-state.sh"

"$STATE_SCRIPT" event "$(jq -nc \
  --arg orch "$ORCH_ID" \
  --arg prompt "Wake me when: CI fails on any of my PRs, a PR gets changes-requested review, a PR merges, or a worker crashes (no heartbeat)." \
  --argjson prs '[408, 409]' \
  --argjson tickets '["CTL-253", "CTL-254"]' \
  --argjson branches '["orch-ctl-253-2026-05-05-CTL-253", "orch-ctl-253-2026-05-05-CTL-254"]' \
  '{
    event: "filter.register",
    orchestrator: $orch,
    detail: {
      notify_event: ("filter.wake." + $orch),
      prompt: $prompt,
      persistent: true,
      context: {
        pr_numbers: $prs,
        tickets: $tickets,
        branches: $branches
      }
    }
  }')"
```

### Registration event schema

| Field | Type | Description |
|-------|------|-------------|
| `event` | string | Always `"filter.register"` |
| `orchestrator` | string | Orchestrator ID — used as the routing key if `detail.interest_id` is absent |
| `detail.notify_event` | string | Event name the daemon will emit when relevant events arrive (`"filter.wake.{id}"`) |
| `detail.prompt` | string | Natural-language description of what to wake on (see Prompt Writing below) |
| `detail.persistent` | boolean | `true` — keep interest active after each match (continuous monitoring). `false` (default) — auto-deregister after first wake (one-shot wait). |
| `detail.context` | object | Optional focus hints: `pr_numbers`, `tickets`, `branches`, `workers` |
| `detail.interest_id` | string | Optional override for the routing table key; defaults to `orchestrator` |
| `detail.session_id` | string | Optional session ID (`$CATALYST_SESSION_ID`). The daemon's watchdog uses this to clean up registrations whose session has gone stale (>3 min without heartbeat). Set this for any non-orchestrator agent. |
| `detail.interest_type` | string | Optional discriminator for built-in deterministic routing. When set (e.g. `"pr_lifecycle"`), `prompt` is ignored and the daemon uses typed field comparison instead of Groq classification. See "Built-in interest types" below. |

The daemon picks up `filter.register` from the live log within one poll cycle (~200ms).
On daemon restart, it scans the last 1000 lines of the log to recover active registrations,
and emits a `filter.daemon.startup` event so subscribers can re-register if they want
belt-and-suspenders coverage.

**Choosing `persistent`:**

- Use `persistent: true` for continuous monitoring — the orchestrator's Phase 4 loop where you want
  to be woken on every CI event, every PR update, every worker status change throughout the run.
- Use `persistent: false` (the default) for one-shot waits — "tell me when this specific PR merges"
  or "wake me when the next CI run completes". The interest is removed automatically after the first
  wake, so no explicit `filter.deregister` is needed.

### Built-in interest types (CTL-284)

Some interest categories are common enough that the daemon ships with deterministic
routing for them — no Groq round-trip, no semantic prompt required. Set
`detail.interest_type` to opt in.

When `interest_type` is set, the daemon ignores `detail.prompt` for that interest and
matches events using pure field comparison against the schema-v2 envelope. Unmatched
events still fall through to Groq for any prose-prompt interests in the same table —
so you can mix typed and prose interests freely.

#### `pr_lifecycle`

Built-in deterministic routing for the PR lifecycle: CI events, reviews, comments,
thread resolution, merges, deployments, and base-branch pushes that would put a PR
BEHIND. Replaces hand-written prose prompts for the common case.

```jsonc
{
  "event": "filter.register",
  "orchestrator": "$ORCH_NAME",
  "detail": {
    "interest_id": "filter.wake.$sid",
    "interest_type": "pr_lifecycle",
    "notify_event": "filter.wake.$sid",
    "pr_numbers": [445, 446],
    "repo": "coalesce-labs/catalyst",
    "base_branches": [
      { "pr": 445, "base": "main" },
      { "pr": 446, "base": "main" }
    ],
    "persistent": true
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `interest_type` | `"pr_lifecycle"` | Discriminator. Required for deterministic routing. |
| `pr_numbers` | `number[]` | PR numbers this interest cares about. Matched against `scope.pr` for PR/review events and `detail.prNumbers[]` for `check_suite`. |
| `repo` | string | `org/repo` form. Stored in `filter_state` for traceability. |
| `base_branches` | `Array<{ pr: number, base: string }>` | Per-PR base-branch map. Used to wake when `github.push` lands on a base branch (PR is now BEHIND). Optional — omit to skip BEHIND wakes. |

**Routed event topics:**

| Topic | Match condition | Wake reason |
|---|---|---|
| `github.check_suite.completed` | `detail.prNumbers ∋ pr_numbers ∧ detail.conclusion ∈ {success, failure}` | "All CI checks passing" / "CI failing on PR #N — check_suite conclusion: failure" |
| `github.pr.merged` | `scope.pr ∈ pr_numbers` | "PR #N merged (merge commit: ...). Now waiting for deployment — do not close out until deployment succeeds." |
| `github.pr.closed` (merged=false) | `scope.pr ∈ pr_numbers` | "PR #N closed without merging" |
| `github.pr_review.submitted` (changes_requested) | `scope.pr ∈ pr_numbers` | "Changes requested by {reviewer} on PR #N. PR is blocked from merging until review comments are resolved." (replaced by "Automated review comment from {reviewer} (bot): Changes requested on PR #N. PR is blocked from merging until review comments are resolved." when `detail.author.type === "Bot"`) |
| `github.pr_review.submitted` (approved) | `scope.pr ∈ pr_numbers` | "PR #N approved by {reviewer}" (with " (bot)" suffix appended when `detail.author.type === "Bot"`) |
| `github.pr_review_comment.created` | `scope.pr ∈ pr_numbers` | "New review comment from ..." (with bot prefix when `author.type === "Bot"`) |
| `github.pr_review_thread.resolved` | `scope.pr ∈ pr_numbers` | "Review thread {threadId} resolved on PR #N" |
| `github.deployment.created` | `scope.sha == filter_state[interestId].merge_commit_sha` | "Deployment started for merge commit {sha} on environment {env}" |
| `github.deployment_status.success` | `detail.deploymentId == filter_state[interestId].deployment_id` | "Deployment succeeded on {env}. Work is complete." |
| `github.deployment_status.failure` / `.error` | same as `.success` | "Deployment failed on {env}. URL: {targetUrl}" |
| `github.push` | `scope.ref == "refs/heads/{base}"` for some `base_branches[].base` | "Base branch {branch} updated — PR #N is now behind. Rebase may be needed." |

**State persistence.** `pr_lifecycle` interests use a SQLite table at
`~/catalyst/filter-state.db` (`bun:sqlite`, WAL mode) to track merge-commit-SHA →
deployment_id correlations across daemon restarts. The row is seeded on registration,
populated as the lifecycle progresses (`merge_commit_sha` on `pr.merged`, `deployment_id`
on `deployment.created`), and removed on `filter.deregister` or
`orchestrator-completed`/`orchestrator-failed`. The daemon never queries GitHub for SHA
information — everything comes from event detail fields.

**Mixing with prose interests.** A single agent (e.g. the orchestrator) may register
two interests: a `pr_lifecycle` one for the typed PR-lifecycle events, and a prose one
under a different `interest_id` for residual concerns like comms-attention or
Linear-ticket status changes that aren't covered by the deterministic table. Both
interests use the same `notify_event`, so the wait-for filter is unchanged.

### Per-agent-type registration patterns

The same registration mechanism serves three distinct agent profiles. Pick the one that
matches your agent's lifecycle.

#### Orchestrator (long-lived, multi-PR scope)

Routing key is the orchestrator name; one registration covers every active worker.

```jsonc
{
  "event": "filter.register",
  "orchestrator": "$ORCH_NAME",
  "detail": {
    "session_id": "$CATALYST_SESSION_ID",
    "notify_event": "filter.wake.$ORCH_NAME",
    "persistent": true,
    "prompt": "Wake me when: CI passes or fails on any of my PRs; a PR gets changes-requested, is merged, or closed; the base branch receives a push that would put my PRs BEHIND; any of my workers posts a comms message of type attention to me; or one of my Linear tickets changes status",
    "context": {
      "pr_numbers": [408, 409],
      "tickets": ["CTL-253", "CTL-254"],
      "branches": ["...-CTL-253", "...-CTL-254"]
    }
  }
}
```

#### Worker / oneshot (single-ticket scope, single PR)

Routing key is the session ID. `context.workers: [$sid]` lets the daemon's heartbeat
watchdog match this registration when the session goes stale.

```jsonc
{
  "event": "filter.register",
  "orchestrator": "$CATALYST_ORCHESTRATOR_ID",
  "detail": {
    "interest_id": "$CATALYST_SESSION_ID",
    "session_id": "$CATALYST_SESSION_ID",
    "notify_event": "filter.wake.$CATALYST_SESSION_ID",
    "persistent": true,
    "prompt": "Wake me when: CI passes or fails on PR ${PR_NUMBER}; PR ${PR_NUMBER} is merged or closed; PR ${PR_NUMBER} receives a review or changes-requested; the base branch of branch ${BRANCH} receives a push (BEHIND state); I receive a comms message addressed to ${TICKET_ID}; or my Linear ticket ${TICKET_ID} status changes",
    "context": {
      "pr_numbers": [535],
      "tickets": ["CTL-269"],
      "branches": ["fix/ctl-269-foo"],
      "workers": ["$CATALYST_SESSION_ID"]
    }
  }
}
```

A graceful trap on `EXIT/INT/TERM` should emit `filter.deregister` so the in-memory
table doesn't carry the entry until daemon restart. The watchdog cleanup at
`HEARTBEAT_STALE_MS` (default 3 min) is the crash-safety net.

#### Long-lived utility (e.g., monitor, custom wait scripts)

Same shape as the worker pattern — routing by `$CATALYST_SESSION_ID` with a
utility-specific prompt. Set `persistent: true` so the registration survives across
many wakes; deregister explicitly at exit.

### Daemon restarts

On boot the daemon emits `filter.daemon.startup` with `pid`, `recovered_interests`,
`watchdog_interval_ms`, and `heartbeat_stale_ms`. Persistent interests are also
recovered automatically from the last 1000 log lines, so a re-register on this event
is belt-and-suspenders rather than required.

```bash
# Optional: re-register on daemon restart
catalyst-events wait-for --filter '.event == "filter.daemon.startup"' --timeout 0 \
  | while read -r evt; do
      filter_register_self  # idempotent — overwrites the existing entry
    done
```

## Step 2 — Wait

After registering, block on the corresponding wake event:

```bash
EVENT=$(catalyst-events wait-for \
  --filter ".event == \"filter.wake.${ORCH_ID}\"" \
  --timeout 7200 || true)

# Mandatory authoritative check — always verify via REST regardless of wait outcome
# (daemon may be down; event may have arrived before wait started)
PR_JSON=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}")
# ... inspect PR_JSON for ground truth
```

**The authoritative check is non-negotiable.** `wait-for` is a wake-up trigger, not a source
of truth. Always follow it with a REST/CLI check before acting on the result.

## Step 3 — Read the Wake Event

When the daemon finds a match it appends a `filter.wake.{id}` event:

```json
{
  "ts": "2026-05-05T17:42:10Z",
  "event": "filter.wake.orch-ctl-253-2026-05-05",
  "orchestrator": "orch-ctl-253-2026-05-05",
  "worker": null,
  "detail": {
    "reason": "CI failed on PR #409 — check_run conclusion: failure (build workflow)",
    "source_event_ids": ["evt_abc123", "evt_def456"],
    "interest_id": "orch-ctl-253-2026-05-05"
  }
}
```

| Field | Description |
|-------|-------------|
| `detail.reason` | One sentence from the LLM explaining which events matched and why |
| `detail.source_event_ids` | IDs of the raw events that triggered this wake (v2 events only) |
| `detail.interest_id` | Routing key used to look up the interest registration |

Use `reason` as context for your diagnostic step, not as a decision signal. Confirm via REST.

## Step 4 — Deregister

Deregistration happens automatically in three cases:

1. **One-shot (`persistent: false`, the default)** — the daemon removes the interest immediately
   after emitting the first wake event. No explicit deregister needed.

2. **Orchestrator termination** — when `orchestrator-completed` or `orchestrator-failed` appears
   in the event log for an orchestrator ID that has active interests, the daemon removes all of
   that orchestrator's interests automatically.

3. **Explicit deregister** — emit `filter.deregister` at any time to remove the interest
   immediately (useful for `persistent: true` interests or early cancellation):

```bash
"$STATE_SCRIPT" event "$(jq -nc \
  --arg id "$ORCH_ID" \
  '{event: "filter.deregister", detail: {interest_id: $id}}')"
```

If a `persistent: true` orchestrator exits without emitting `filter.deregister` or
`orchestrator-completed`/`orchestrator-failed`, the daemon's in-memory table retains the entry
until the daemon restarts (on restart it replays the last 1000 log lines and applies all
register, deregister, and completion events in order).

## Prompt Writing Guide

The prompt is the only input the LLM uses to decide relevance. Be explicit about conditions,
not detection mechanics.

**Good prompts:**

```
Wake me when: CI fails on any of my PRs, a PR gets changes-requested review,
a PR merges successfully, a worker crashes or goes stale, or a merge conflict
(dirty state) is detected.
```

```
Alert me if: the release-please PR merges, a deployment_status failure event
arrives for the production environment, or a workflow run fails on main.
```

**What makes a prompt effective:**

- **Name the conditions directly** — "CI fails", "PR merges", "worker crashes" — not "check
  for check_run events with conclusion: failure". The LLM knows the event taxonomy.
- **Include all conditions at once** — one registration covers all scenarios. The LLM routes
  any matching event to your wake.
- **Keep it short** — 50–100 words is enough. Long prompts add latency without precision gains.
- **Don't describe the event fields** — you don't need to say "when `.event` equals
  `github.pr.merged`". Say "when a PR merges".

**Unhelpful prompts:**

```
Watch for things that might be relevant.           ← too vague; will fire on everything
Only wake me on github.check_suite.completed       ← use jq directly instead
```

## Context Fields

The `context` object focuses the LLM on your specific resources, reducing false positives
when multiple orchestrators are registered simultaneously:

| Field | Type | Effect |
|-------|------|--------|
| `pr_numbers` | `number[]` | PR numbers the orchestrator owns. Groq uses these to distinguish "CI failure on PR #408 (mine)" from "CI failure on PR #500 (not mine)". |
| `tickets` | `string[]` | Linear ticket IDs (e.g., `["CTL-253", "CTL-254"]`). Helps filter `linear.*` events and worker lifecycle events scoped to those tickets. |
| `branches` | `string[]` | Branch names. Used to distinguish `github.push` and `github.check_suite` events by branch. |

All fields are optional but strongly recommended. Without context, the LLM must infer scope
from the event payload alone and is more likely to produce false positives.

## Fallback: Daemon Not Running

If `catalyst-filter status` returns "stopped" (or if `GROQ_API_KEY` is not set), fall back to
a direct `catalyst-events wait-for` with a jq predicate:

```bash
FILTER_STATUS=$(catalyst-filter status 2>/dev/null || echo "stopped")
if [[ "$FILTER_STATUS" == "stopped" ]] || [[ -z "${GROQ_API_KEY:-}" ]]; then
  # jq fallback — express the condition syntactically
  EVENT=$(catalyst-events wait-for \
    --filter "
      (.event | startswith(\"github.pr.\")) or
      (.event | startswith(\"github.check_suite.\")) or
      (.event == \"worker-status-change\" and (.worker | IN(\"CTL-253\",\"CTL-254\")))
    " \
    --timeout 7200 || true)
else
  # Semantic filter path — register, wait, deregister
  # (steps 1–4 above)
fi
```

The jq fallback has higher noise (more events will wake the orchestrator) but zero external
dependencies. Always follow any wake event — semantic or syntactic — with an authoritative
REST check.

## Multi-Tenant Behavior

The daemon maintains one in-memory routing table for all active registrations. Each event
batch is classified against all registered interests in a single Groq call. Adding more
orchestrators does not increase per-orchestrator cost or latency — all interests are evaluated
simultaneously.

`filter.wake.{id}` events are per-interest: orchestrator A never receives orchestrator B's
wake events.

## Batching and Latency

Events are batched with:
- **100ms debounce**: each new event resets the timer
- **500ms hard cap**: batch flushes regardless of arrival rate after 500ms
- **20-event batch limit**: flushes immediately when batch reaches 20 events

Effective latency from a GitHub webhook arriving to the wake event appearing in the log:
approximately 300–600ms under normal load. At higher burst volume (GitHub CI fires multiple
`check_run.completed` events simultaneously), all fire in the same batch — 1 Groq call for N
simultaneous CI events.

## Quick Reference

```bash
# Check if daemon is running
catalyst-filter status

# Start / stop / restart
catalyst-filter start
catalyst-filter stop
catalyst-filter restart

# Debug: run in foreground
catalyst-filter run

# Tail daemon log
catalyst-filter logs

# Manually register an orchestrator interest
catalyst-state.sh event '{"event":"filter.register","orchestrator":"my-orch","detail":{"notify_event":"filter.wake.my-orch","prompt":"Wake me on CI failure or PR merge."}}'

# Manually register a session-keyed worker interest (CTL-269)
catalyst-state.sh event '{"event":"filter.register","orchestrator":"my-orch","detail":{"interest_id":"sess_abc","session_id":"sess_abc","notify_event":"filter.wake.sess_abc","persistent":true,"prompt":"Wake me on CI events for PR 42 or comms addressed to CTL-269.","context":{"pr_numbers":[42],"tickets":["CTL-269"],"workers":["sess_abc"]}}}'

# Wait for wake signal
catalyst-events wait-for --filter '.event == "filter.wake.my-orch"' --timeout 7200

# Deregister
catalyst-state.sh event '{"event":"filter.deregister","detail":{"interest_id":"my-orch"}}'
```

## Related

- [[monitor-events]] — canonical event-driven wait patterns (`wait-for` primitive reference)
- [[catalyst-comms]] — agent-to-agent messaging protocol
- `plugins/dev/scripts/catalyst-filter` — daemon CLI (start/stop/status/logs/run)
- `plugins/dev/scripts/filter-daemon/index.mjs` — daemon implementation
