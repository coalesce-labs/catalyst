# worker.waiting / worker.resumed Events (CTL-403)

_Read this when debugging why a wait loop appears stale to the watchdog, or to understand how
`catalyst-events wait-for` signals its wait state to the broker._

Emitted automatically by `catalyst-events wait-for` when `$CATALYST_SESSION_ID` is set. These
events make wait loops visible to the broker so the watchdog can distinguish a legitimately
waiting session from a silently dead one.

## `worker.waiting` shape

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

## `worker.resumed` shape

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

## Broker behavior

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

## Broker state file

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
