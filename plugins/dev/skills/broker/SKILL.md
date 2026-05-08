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
| (prose prompt) | Groq LLM | Anything ambiguous, cross-cutting, or complex |

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

### Wake Event Shape

```json
{
  "event": "filter.wake.sess_20260508_abcd",
  "orchestrator": "my-orch",
  "worker": null,
  "detail": {
    "reason": "Ticket CTL-275 marked Done",
    "source_event_ids": ["..."],
    "interest_id": "sess_20260508_abcd",
    "ticket": "CTL-275"
  }
}
```

### Waiting for a Ticket Wake

```bash
EVENT=$(catalyst-events wait-for \
  --filter ".attributes.\"event.name\" == \"filter.wake\" and .attributes.\"event.label\" == \"${CATALYST_SESSION_ID}\"" \
  --timeout 600 2>/dev/null || true)
```

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

## 6. Groq Prose Registration (Unchanged)

For complex / multi-condition interests, register with a natural-language prompt:

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
