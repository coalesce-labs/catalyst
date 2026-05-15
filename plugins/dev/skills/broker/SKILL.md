---
name: broker
description:
  Protocol reference for the Catalyst event broker daemon. Covers agent identity (agent.checkin/
  checkout), auto-correlation of ticket↔PR interests, ticket_lifecycle deterministic routing for
  Linear events, and the existing pr_lifecycle + Groq prose routing paths. Use when an agent needs
  to wait for events related to its own ticket/PR, watch another ticket's lifecycle, or register
  any semantic interest in the event stream.
---

# Catalyst Event Broker — Protocol Reference (CTL-303)

The broker daemon evolved from the `catalyst-filter` daemon (CTL-284). It adds:

1. **Structured agent identity** — `agent.checkin` / `agent.checkout` events so the broker knows
   who is working on what. The broker auto-derives `pr_lifecycle` interests from check-in data.
2. **`ticket_lifecycle` interest type** — deterministic routing for Linear webhook events keyed on
   ticket identifiers. No Groq round-trip for state changes, comments, and PR links.
3. **Auto-correlation** — when an agent checks in with a ticket, the broker auto-registers a
   `pr_lifecycle` interest the moment a PR linking that ticket appears. Agents no longer need to
   call `filter.register pr_lifecycle` explicitly.
4. **Backward compat** — all CTL-284 `pr_lifecycle` explicit registration still works unchanged.
   Groq prose classification remains for ambiguous / multi-condition interests.

## Daemon Management

```bash
# Check status (broker and filter are aliases)
catalyst-broker status   # → "running (pid N)" or "stopped"
catalyst-filter status   # deprecated alias — delegates to catalyst-broker

# Start / stop / restart
catalyst-broker start
catalyst-broker stop
catalyst-broker restart

# View logs
catalyst-broker logs
```

## Interest Types Summary

| Interest type | Routing | Use case |
|---|---|---|
| `pr_lifecycle` | Deterministic | Watch CI, reviews, merge, deployment for a known PR number |
| `ticket_lifecycle` | Deterministic | Watch Linear state changes, comments, PR links for a ticket |
| `comms_lifecycle` | Deterministic | Watch comms-channel messages (worker → orchestrator attention/done, orchestrator → worker directives) |
| (prose prompt) | Groq LLM (env-gated off; CTL-357) | Anything ambiguous, cross-cutting, or complex — set `CATALYST_BROKER_PROSE_ENABLED=1` to re-enable |

## 1. Auto-Correlation (The Common Case — No Registration Needed)

**When an agent's own ticket/PR** is the concern, registration is automatic:

```bash
# catalyst-session.sh start emits agent.checkin automatically:
CATALYST_SESSION_ID=$(catalyst-session.sh start --skill oneshot --ticket CTL-275)
# ↑ The broker records: agent CTL-275 with no claimed_pr yet.

# When you later create the PR, update claimed_pr via agent.checkin:
cat >> ~/catalyst/events/$(date -u +%Y-%m).jsonl <<EOF
{"ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","event":"agent.checkin","detail":{"session_id":"$CATALYST_SESSION_ID","ticket":"CTL-275","claimed_pr":$PR_NUMBER,"orchestrator":"${CATALYST_ORCHESTRATOR_ID:-}"}}
EOF
# ↑ The broker sees claimed_pr → auto-registers pr_lifecycle for filter.wake.$CATALYST_SESSION_ID
```

The `oneshot` skill now uses this pattern instead of calling `filter.register` directly. The
explicit `filter_register_worker` function is kept for backward compat but is no longer the
recommended path for new work.

## 2. `agent.checkin` Event

Emitted by `catalyst-session.sh start` and optionally after PR creation. Shape:

```json
{
  "ts": "2026-05-08T07:00:00Z",
  "event": "agent.checkin",
  "detail": {
    "session_id": "sess_20260508_abcd",
    "agent_name": "ctl-275-worker",
    "ticket": "CTL-275",
    "orchestrator": "orch-2026-05-08",
    "claimed_pr": 501,
    "cwd": "/path/to/worktree"
  }
}
```

Fields:
- `session_id` — required. Primary key in the broker's `agents` table.
- `agent_name` — human label (defaults to `session_id` if missing).
- `ticket` — Linear ticket identifier (e.g. `"CTL-275"`). Enables `ticket_lifecycle` auto-correlation.
- `orchestrator` — parent orchestrator ID; enables stale-session watchdog routing.
- `claimed_pr` — if set, broker immediately auto-registers `pr_lifecycle` for this agent.
- `cwd` — working directory; included for diagnostics.

## 3. `agent.checkout` Event

Emitted by `catalyst-session.sh end`. Shape:

```json
{
  "ts": "2026-05-08T09:00:00Z",
  "event": "agent.checkout",
  "detail": {
    "session_id": "sess_20260508_abcd",
    "status": "done"
  }
}
```

On checkout, the broker:
- Marks the agent as `done` in the `agents` SQLite table.
- Removes any auto-correlated `pr_lifecycle` interest (explicit registrations are preserved).

## 3a. `worker.waiting` / `worker.resumed` Events (CTL-403)

Emitted automatically by `catalyst-events wait-for` when `$CATALYST_SESSION_ID` is set. These
events make wait loops visible to the broker so the watchdog can distinguish a legitimately
waiting session from a silently dead one.

### `worker.waiting` shape

```json
{
  "ts": "2026-05-14T16:30:00Z",
  "event": "worker.waiting",
  "detail": {
    "session_id": "sess_20260514_abcd",
    "orchestrator": "orch-foo",
    "ticket": "CTL-275",
    "wait_for": ".attributes.\"event.name\" == \"github.pr.merged\"",
    "timeout_ms": 7200000,
    "since": "2026-05-14T16:30:00Z",
    "reason": "catalyst-events wait-for"
  }
}
```

### `worker.resumed` shape

```json
{
  "ts": "2026-05-14T18:00:00Z",
  "event": "worker.resumed",
  "detail": {
    "session_id": "sess_20260514_abcd",
    "orchestrator": "orch-foo",
    "ticket": "CTL-275",
    "outcome": "matched"
  }
}
```

`outcome` is `"matched"` when the wait returned a result, `"timed_out"` when the deadline elapsed.

### Broker behavior

On `worker.waiting`:
- Stores the session in the in-memory `waitingSessions` Map and the `waiting_sessions` SQLite table.
- Resets the heartbeat timer so the session does not appear stale during the wait.
- During watchdog ticks, any session in `waitingSessions` whose `timeoutAt > now` is skipped — it
  is "legitimately waiting" and should not trigger a stale-heartbeat wake.
- The `broker.state.json` file includes an `waitingSessions` array with all currently active waits;
  the HUD dashboard's worker list reads this to overlay `wait:Xm` in the STATUS column.

On `worker.resumed`:
- Removes the session from `waitingSessions` and the SQLite table.
- Normal heartbeat-staleness tracking resumes.

### Broker state file

`~/catalyst/broker.state.json` gains a `waitingSessions` array:

```json
{
  "waitingSessions": [
    {
      "sessionId": "sess_20260514_abcd",
      "ticket": "CTL-275",
      "orchestrator": "orch-foo",
      "waitFor": ".attributes.\"event.name\" == \"github.pr.merged\"",
      "timeoutAt": "2026-05-14T18:30:00Z",
      "reason": "catalyst-events wait-for"
    }
  ]
}
```

Empty array `[]` when no sessions are currently waiting.

## 3b. `orchestrator.status` Events (CTL-405)

Emitted by the orchestrate skill at each wave transition via `orchestrate-status.sh emit`. These
events make the orchestrator's current phase visible to the broker, the HUD, and operators, and
serve as a liveness heartbeat so the watchdog does not fire stale-session wakes for an orchestrator
that is actively monitoring between waves.

### Event shape

```json
{
  "ts": "2026-05-15T00:00:00Z",
  "event": "orchestrator-status",
  "orchestrator": "orch-foo",
  "detail": {
    "orchestrator": "orch-foo",
    "phase": "monitoring",
    "wave": 2,
    "active_workers": 3,
    "total_workers": 5,
    "summary": "wave 2 monitoring (3/5 active)",
    "session_id": "sess_20260515_abcd"
  }
}
```

`phase` values:

| Value | Meaning |
|---|---|
| `dispatching` | Launching workers for a wave |
| `monitoring` | Event loop watching workers for a wave |
| `reviewing` | Post-merge verification (Phase 5) |
| `paused` | Waiting for human gate |

### Broker behavior

On `orchestrator.status`:
- Stores the entry in `orchestratorStatusMap[orchId]` (replaces any prior entry for that orch).
- If `detail.session_id` is present, resets `lastHeartbeat[sessionId]` to now — so the watchdog
  treats the status event as a heartbeat and skips stale-session wakes while the orchestrator is in
  a monitoring loop.
- Calls `persistBrokerState()` to flush the update to `broker.state.json`.
- On `orchestrator-completed` / `orchestrator-failed`, the entry is removed from `orchestratorStatusMap`.

### Broker state file

`~/catalyst/broker.state.json` gains an `activeOrchestrators` array:

```json
{
  "activeOrchestrators": [
    {
      "orchestratorId": "orch-foo",
      "phase": "monitoring",
      "wave": 2,
      "activeWorkers": 3,
      "totalWorkers": 5,
      "summary": "wave 2 monitoring (3/5 active)",
      "ts": "2026-05-15T00:00:00Z",
      "sessionId": "sess_20260515_abcd"
    }
  ]
}
```

Empty array `[]` when no orchestrators have reported status.

### Emitting from the orchestrate skill

```bash
ORCH_STATUS_SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate-status.sh"
[[ -x "$ORCH_STATUS_SCRIPT" ]] && "$ORCH_STATUS_SCRIPT" emit \
  --orch "${ORCH_NAME}" \
  --phase monitoring \
  --wave 2 \
  --active 3 \
  --total 5 \
  --summary "wave 2 monitoring" 2>/dev/null || true
```

The `--orch` and `--session` flags fall back to `$CATALYST_ORCHESTRATOR_ID` and
`$CATALYST_SESSION_ID` env vars when omitted.

## 4. `ticket_lifecycle` Interest Type

Register to watch a ticket's Linear events and PR links deterministically:

```bash
# Register via filter.register event
ORCH_ID="${CATALYST_ORCHESTRATOR_ID:-my-orch}"
jq -nc \
  --arg orch "$ORCH_ID" \
  --arg sid "$CATALYST_SESSION_ID" \
  '{ts: (now | todate), event: "filter.register",
    orchestrator: $orch,
    worker: null,
    detail: {
      interest_id: $sid,
      notify_event: ("filter.wake." + $sid),
      interest_type: "ticket_lifecycle",
      tickets: ["CTL-275"],
      wake_on: ["status_done", "pr_opened", "pr_merged"],
      persistent: true,
      session_id: $sid
    }}' >> ~/catalyst/events/$(date -u +%Y-%m).jsonl
```

### `wake_on` Values

| Value | Fires on |
|---|---|
| `status_done` | `linear.issue.state_changed` where state matches `/done/i` |
| `status_in_review` | `linear.issue.state_changed` where state matches `/in.?review/i` |
| `status_changed` | Any `linear.issue.state_changed` or `linear.issue.updated` |
| `comment_added` | `linear.comment.created` for the ticket |
| `pr_opened` | `github.pr.opened` whose body/title/branch references the ticket |
| `pr_merged` | `github.pr.merged` whose body/title/branch references the ticket |

Omit `wake_on` (or pass `null`) to fire on all of the above.

### Wake Event Shape (Canonical On-Disk Form)

```json
{
  "ts": "2026-05-08T18:25:00.000Z",
  "id": "<uuid>",
  "resource": { "service.name": "catalyst.broker" },
  "attributes": {
    "event.name": "filter.wake.sess_20260508_abcd",
    "catalyst.orchestrator.id": "my-orch"
  },
  "body": {
    "payload": {
      "reason": "Ticket CTL-275 marked Done",
      "source_event_ids": ["<uuid>"],
      "source_events": [{
        "id": "<uuid>",
        "name": "linear.issue.state_changed",
        "ts": "2026-05-08T18:24:58.000Z",
        "ticket": "CTL-275",
        "pr": null,
        "repo": null,
        "payload_excerpt": { "state": "Done", "stateType": "completed" }
      }],
      "interest_id": "sess_20260508_abcd",
      "ticket": "CTL-275"
    }
  }
}
```

See §10 for the complete field reference and `wake-extract` accessor.

### Waiting for a Ticket Wake

```bash
EVENT=$(catalyst-events wait-for \
  --filter ".attributes.\"event.name\" == \"filter.wake.${CATALYST_SESSION_ID}\"" \
  --timeout 600 2>/dev/null || true)
```

## 4a. `comms_lifecycle` Interest Type (CTL-357)

Deterministic routing for `comms.message.posted` events on a shared comms channel. Replaces the
Groq prose interest the orchestrator used to register for "any of my workers posts an attention
message". The routing is keyed on channel + sender + message-type, with no model call.

### Subscriber kinds

- **`subscriber_kind: "orchestrator"`** — wakes when one of the orchestrator's `owned_workers`
  posts a message of an interesting type. Default `types_of_interest` is `["attention", "done"]`
  (matches `attention` and `done`, ignores `info` heartbeats).
- **`subscriber_kind: "worker"`** — wakes when a peer posts a message addressed to this worker
  (`to=<subscriber_ticket>`) or to all (`to=all`). Self-posts are ignored (self-loop guard).
  Workers default to all message types — orchestrator → worker traffic is rare and intentional.

### Schema

```json
{
  "interest_id": "<id>",
  "interest_type": "comms_lifecycle",
  "notify_event": "filter.wake.<id>",
  "persistent": true,
  "channel": "orch-<orch-id>",
  "subscriber_kind": "orchestrator",
  "owned_workers": ["CTL-352", "CTL-354"],
  "types_of_interest": ["attention", "done"]
}
```

Worker variant:
```json
{
  "interest_id": "<sess-id>-comms",
  "interest_type": "comms_lifecycle",
  "notify_event": "filter.wake.<sess-id>",
  "persistent": true,
  "channel": "orch-<orch-id>",
  "subscriber_kind": "worker",
  "subscriber_ticket": "CTL-357"
}
```

### Registering (orchestrator)

```bash
jq -nc \
  --arg orch "${CATALYST_ORCHESTRATOR_ID}" \
  --arg id "${CATALYST_ORCHESTRATOR_ID}-comms" \
  --arg channel "${CATALYST_ORCHESTRATOR_ID}" \
  --argjson workers '["CTL-352","CTL-354"]' \
  '{ts: (now | todate), event: "filter.register",
    orchestrator: $orch,
    worker: null,
    detail: {
      interest_id: $id,
      interest_type: "comms_lifecycle",
      notify_event: ("filter.wake." + $orch),
      persistent: true,
      channel: $channel,
      subscriber_kind: "orchestrator",
      owned_workers: $workers,
      types_of_interest: ["attention", "done"]
    }}' >> ~/catalyst/events/$(date -u +%Y-%m).jsonl
```

### Registering (worker)

The worker uses interest_id `"${CATALYST_SESSION_ID}-comms"` (NOT just the session_id) so it
coexists with the broker's auto-correlated `pr_lifecycle` interest (interest_id =
session_id). Both share `notify_event: "filter.wake.${CATALYST_SESSION_ID}"`, so the
existing `wait-for` predicate is unchanged.

```bash
jq -nc \
  --arg sid "$CATALYST_SESSION_ID" \
  --arg id "${CATALYST_SESSION_ID}-comms" \
  --arg orch "${CATALYST_ORCHESTRATOR_ID}" \
  --arg channel "$CATALYST_COMMS_CHANNEL" \
  --arg ticket "$TICKET_ID" \
  '{ts: (now | todate), event: "filter.register",
    orchestrator: $orch,
    worker: null,
    detail: {
      interest_id: $id,
      interest_type: "comms_lifecycle",
      notify_event: ("filter.wake." + $sid),
      persistent: true,
      session_id: $sid,
      channel: $channel,
      subscriber_kind: "worker",
      subscriber_ticket: $ticket
    }}' >> ~/catalyst/events/$(date -u +%Y-%m).jsonl
```

### Match logic (no Groq call)

| Trigger | Condition |
|---|---|
| `event.name == "comms.message.posted"` | always required |
| `body.payload.channel == reg.channel` | always required |
| `body.payload.type` ∈ `reg.types_of_interest` | required (defaults: orchestrator → `["attention","done"]`, worker → all types) |
| Orchestrator: `attributes."catalyst.worker.ticket"` ∈ `reg.owned_workers` | required for orchestrator subscribers |
| Worker: `body.payload.to == reg.subscriber_ticket` OR `body.payload.to == "all"` | required for worker subscribers |
| Worker: sender (`catalyst.worker.ticket`) != `reg.subscriber_ticket` | self-loop guard |

### Wake Event Shape (Canonical On-Disk Form)

```json
{
  "ts": "2026-05-08T18:26:00.000Z",
  "id": "<uuid>",
  "resource": { "service.name": "catalyst.broker" },
  "attributes": {
    "event.name": "filter.wake.orch-2026-05-12",
    "catalyst.orchestrator.id": "orch-2026-05-12"
  },
  "body": {
    "payload": {
      "reason": "Worker CTL-352 posted attention on orch-orch-2026-05-12",
      "source_event_ids": ["<uuid>"],
      "source_events": [{
        "id": "<uuid>",
        "name": "comms.message.posted",
        "ts": "2026-05-08T18:25:59.000Z",
        "ticket": "CTL-352",
        "pr": null,
        "repo": null,
        "payload_excerpt": { "action": "attention" }
      }],
      "interest_id": "orch-2026-05-12-comms"
    }
  }
}
```

See §10 for the complete field reference and `wake-extract` accessor.

## 5. `pr_lifecycle` Interest Type (CTL-284 — Unchanged)

Explicit PR-number registration still works:

```bash
jq -nc \
  --arg orch "${CATALYST_ORCHESTRATOR_ID:-}" \
  --arg sid "$CATALYST_SESSION_ID" \
  --argjson pr "$PR_NUMBER" \
  --arg repo "$(gh repo view --json nameWithOwner --jq '.nameWithOwner')" \
  --arg base "main" \
  '{ts: (now | todate), event: "filter.register",
    orchestrator: $orch,
    worker: null,
    detail: {
      interest_id: $sid,
      interest_type: "pr_lifecycle",
      notify_event: ("filter.wake." + $sid),
      persistent: true,
      pr_numbers: [$pr],
      repo: $repo,
      base_branches: [{pr: $pr, base: $base}],
      session_id: $sid
    }}' >> ~/catalyst/events/$(date -u +%Y-%m).jsonl
```

Events matched: `github.check_suite.completed`, `github.pr.merged`, `github.pr.closed`,
`github.pr_review.submitted`, `github.pr_review_comment.created`, `github.pr_review_thread.resolved`,
`github.deployment.created`, `github.deployment_status.*`, `github.push` (base-branch pushes).

## 6. Groq Prose Registration (Env-gated off — CTL-357)

> **Off by default.** `CATALYST_BROKER_PROSE_ENABLED=0` is the new default. Empirical evidence
> (`orch-ctl-352-354-2026-05-12`) showed a ~95% false-positive rate on prose wakes — every
> session heartbeat, every unrelated Linear ticket change, and every info comms post matched
> nominally narrow interests. Prose interests already on disk are loaded but never matched against
> events. On startup, if any prose interests are found, the broker emits a single
> `broker.daemon.prose_disabled` info event so the operator can see them at a glance.
>
> Set `CATALYST_BROKER_PROSE_ENABLED=1` in the environment when launching the daemon to re-enable
> Groq classification for prompt-based interests. Prefer the deterministic types
> (`pr_lifecycle`, `ticket_lifecycle`, `comms_lifecycle`) for anything routine.

For complex / multi-condition interests that genuinely need fuzzy matching, register with a
natural-language prompt:

```bash
jq -nc \
  --arg orch "${CATALYST_ORCHESTRATOR_ID:-}" \
  --arg sid "$CATALYST_SESSION_ID" \
  '{ts: (now | todate), event: "filter.register",
    orchestrator: $orch,
    worker: null,
    detail: {
      interest_id: $sid,
      notify_event: ("filter.wake." + $sid),
      prompt: "Wake me when any of my workers has a CI failure or gets changes-requested",
      context: {pr_numbers: [501, 502], tickets: ["CTL-275", "CTL-276"]},
      persistent: true
    }}' >> ~/catalyst/events/$(date -u +%Y-%m).jsonl
```

Requires `GROQ_API_KEY` or `groq.apiKey` in `~/.config/catalyst/config.json`.

## 7. Deregistration

```bash
jq -nc --arg sid "$CATALYST_SESSION_ID" \
  '{ts: (now | todate), event: "filter.deregister",
    detail: {interest_id: $sid}}' >> ~/catalyst/events/$(date -u +%Y-%m).jsonl
```

Auto-deregistration happens on:
- `agent.checkout` for auto-correlated interests
- Orchestrator termination (`orchestrator-completed` / `orchestrator-failed`)
- One-shot interests after their first wake
- Watchdog stale-session cleanup

## 8. Querying Agent State

The broker persists agent identity to SQLite (`~/catalyst/filter-state.db`). You can query it:

```bash
sqlite3 ~/catalyst/filter-state.db \
  "SELECT agent_name, ticket, claimed_pr, status FROM agents WHERE status = 'active';"
```

## 9. Fallback When Broker Is Not Running

```bash
if ! catalyst-broker status | grep -q "^running"; then
  # jq direct wait — no broker, no Groq
  EVENT=$(catalyst-events wait-for \
    --filter ".attributes.\"vcs.pr.number\" == ${PR_NUMBER}" \
    --timeout 300 2>/dev/null || true)
fi
```

## 10. Wake Event Envelope Reference

All `filter.wake.*` events written to the event log use the canonical OTel envelope
(CTL-300). This section documents every field so skills can extract data from the wake
payload directly rather than making round-trip REST/GraphQL calls.

### Canonical On-Disk Shape

```json
{
  "ts": "2026-05-08T18:25:00.000Z",
  "id": "<uuid>",
  "observedTs": "2026-05-08T18:25:00.000Z",
  "severityText": "INFO",
  "severityNumber": 9,
  "resource": {
    "service.name": "catalyst.broker",
    "service.namespace": "catalyst"
  },
  "attributes": {
    "event.name": "filter.wake.<interest_id>",
    "catalyst.orchestrator.id": "<orch-id or null>",
    "vcs.repository.name": "<org/repo or null>"
  },
  "body": {
    "payload": {
      "reason": "<human-readable why this fired>",
      "source_event_ids": ["<uuid>"],
      "source_events": [ /* compact source summaries — see below */ ],
      "interest_id": "<id>",
      "ticket": "<CTL-XXX or null>"
    }
  }
}
```

### `body.payload` Fields

| Field | Type | Description |
|---|---|---|
| `reason` | string | Human-readable description of why the broker fired |
| `source_event_ids` | string[] | UUIDs of the raw events that matched the interest |
| `source_events` | object[] | Compact summaries of the source events (CTL-350) — see below |
| `interest_id` | string | Which interest registration matched |
| `ticket` | string\|null | Linear ticket ID — **only set on `ticket_lifecycle` wakes** |

`source_events` is empty on watchdog wakes (stale interest, dead session).

### `source_events[]` Element Structure

Each element is a compact summary of one matching raw event:

```json
{
  "id": "<event-uuid>",
  "name": "github.check_suite.completed",
  "ts": "2026-05-08T18:24:55.000Z",
  "ticket": null,
  "pr": 342,
  "repo": "org/repo",
  "message": "github.check_suite.completed in org/repo (truncated to 200 chars)",
  "payload_excerpt": {
    "state": null,
    "stateType": null,
    "conclusion": "failure",
    "title": null,
    "merged": null,
    "action": null
  },
  "lookup_jq": "jq 'select(.id == \"<uuid>\")' ~/catalyst/events/2026-05.jsonl"
}
```

`payload_excerpt` always has these six keys; any key not applicable to the source event type is `null`:

| Key | Populated for |
|---|---|
| `conclusion` | `github.check_suite.completed`, `github.workflow_run.completed` |
| `state` | `github.pr_review.submitted` (review state), `linear.issue.state_changed` |
| `stateType` | `linear.issue.state_changed` (Linear state type: `completed`, `started`, etc.) |
| `merged` | `github.pr.merged` → `true` |
| `action` | `comms.message.posted` (message type: `attention`, `info`, `done`) |
| `title` | `github.pr.opened`, `linear.issue.*` |

### Wake Reason Strings by Interest Type

#### `pr_lifecycle`

| Source event | `reason` pattern |
|---|---|
| `github.check_suite.completed` (failure/timed_out) | `"CI failing on PR #N — check_suite conclusion: failure"` |
| `github.check_suite.completed` (success) | `"All CI checks passing on PR #N"` |
| `github.pr.merged` | `"PR #N merged (merge commit: SHA). Now waiting for deployment..."` |
| `github.pr.closed` (not merged) | `"PR #N closed without merging"` |
| `github.pr_review.submitted` (bot, changes_requested) | `"Automated review comment from {reviewer} (bot): Changes requested on PR #N..."` |
| `github.pr_review.submitted` (human, changes_requested) | `"Changes requested by {reviewer} on PR #N..."` |
| `github.pr_review.submitted` (approved) | `"PR #N approved by {reviewer}"` |
| `github.pr_review_comment.created` | `"{author}: '{body}'. Comment must be marked resolved..."` |
| `github.pr_review_thread.resolved` | `"Review thread {threadId} resolved on PR #N"` |
| `github.deployment.created` | `"Deployment started for merge commit {sha} on environment {env}"` |
| `github.deployment_status.success` | `"Deployment succeeded on {env}. Work is complete."` |
| `github.deployment_status.failure/error` | `"Deployment failed on {env}. URL: {url}"` |
| `github.push` to base branch | `"Base branch {branch} updated — PR #N is now behind. Rebase may be needed."` |

#### `ticket_lifecycle`

| Source event | `reason` pattern |
|---|---|
| `linear.issue.state_changed` (Done) | `"Ticket {id} marked Done"` |
| `linear.issue.state_changed` (In Review) | `"Ticket {id} moved to In Review"` |
| `linear.issue.state_changed` (other) | `"Ticket {id} state changed to {state}"` |
| `linear.issue.updated` | `"Ticket {id} updated"` |
| `linear.comment.created` | `"New comment on {id} by {author}"` |
| `github.pr.opened` (linked ticket) | `"PR #N opened on ticket {id}"` |
| `github.pr.merged` (linked ticket) | `"PR #N on ticket {id} merged"` |

#### `comms_lifecycle`

| Subscriber kind | `reason` pattern |
|---|---|
| orchestrator | `"Worker {ticket} posted {type} on {channel}"` |
| worker | `"Message to {ticket} ({type}) on {channel} from {sender}"` |

### `wake-extract` — Typed Accessor

`catalyst-events wake-extract` normalizes a `filter.wake.*` event into a flat JSON object
so skills do not need to hand-roll `jq` paths into `source_events[0].payload_excerpt.*`:

```bash
EVENT=$(catalyst-events wait-for \
  --filter ".attributes.\"event.name\" | startswith(\"filter.wake.${CATALYST_SESSION_ID}\")" \
  --timeout 600)

FIELDS=$(echo "$EVENT" | catalyst-events wake-extract)

# Read normalized fields without knowing the source event type
PR_NUMBER=$(echo "$FIELDS"      | jq -r '.pr_number // empty')
CI_CONCLUSION=$(echo "$FIELDS"  | jq -r '.ci_conclusion // empty')
REVIEW_STATE=$(echo "$FIELDS"   | jq -r '.review_state // empty')
MERGED=$(echo "$FIELDS"         | jq -r '.merged // empty')
REASON=$(echo "$FIELDS"         | jq -r '.reason')
```

`wake-extract` output shape:

```json
{
  "event_name": "github.check_suite.completed",
  "interest_id": "sess_20260508_abcd",
  "reason": "CI failing on PR #342 — check_suite conclusion: failure",
  "pr_number": 342,
  "ticket": null,
  "repo": "org/repo",
  "ci_conclusion": "failure",
  "review_state": null,
  "merged": null,
  "action": null,
  "source_event_id": "<uuid>"
}
```

All fields are nullable. Fields not applicable to the source event type are `null`.
When `source_events` is empty (watchdog wakes), all fields except `interest_id` and `reason` are `null` — treat the wake as a "go re-check" signal in that case.
