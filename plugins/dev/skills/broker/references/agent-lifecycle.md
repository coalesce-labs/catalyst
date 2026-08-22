# Agent Lifecycle — Check-in, Auto-Correlation, Checkout

_Read this when an agent needs to register itself with the broker, update its claimed PR, or
understand how `agent.checkin` / `agent.checkout` wire up auto-correlated interests._

## 1. Auto-Correlation (The Common Case — No Registration Needed)

**When an agent's own ticket/PR** is the concern, registration is automatic:

```bash
# catalyst-session.sh start emits agent.checkin automatically:
CATALYST_SESSION_ID=$(catalyst-session.sh start --skill oneshot --ticket CTL-275)
# ↑ The broker records: agent CTL-275 with no claimed_pr yet.

# When you later create the PR, update claimed_pr via agent.checkin:
cat >> $(ls -t ~/catalyst/events/*.jsonl | head -1) <<EOF
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
