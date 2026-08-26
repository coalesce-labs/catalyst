# orchestrator.status Events (CTL-405)

_Read this when wiring up orchestrator liveness heartbeats, or when the HUD shows a stale orch session that is actually in a monitoring loop._

Emitted by the orchestrate skill at each wave transition via `orchestrate-status.sh emit`. These events make the orchestrator's current phase visible to the broker, the HUD, and operators, and serve as a liveness heartbeat so the watchdog does not fire stale-session wakes for an orchestrator that is actively monitoring between waves.

## Event shape

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

## Broker behavior

On `orchestrator.status`:
- Stores the entry in `orchestratorStatusMap[orchId]` (replaces any prior entry for that orch).
- If `detail.session_id` is present, resets `lastHeartbeat[sessionId]` to now — so the watchdog
  treats the status event as a heartbeat and skips stale-session wakes while the orchestrator is in a monitoring loop.
- Calls `persistBrokerState()` to flush the update to `broker.state.json`.
- On `orchestrator-completed` / `orchestrator-failed`, the entry is removed from `orchestratorStatusMap`.

## Broker state file

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

## Emitting from the orchestrate skill

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

The `--orch` and `--session` flags fall back to `$CATALYST_ORCHESTRATOR_ID` and `$CATALYST_SESSION_ID` env vars when omitted.
