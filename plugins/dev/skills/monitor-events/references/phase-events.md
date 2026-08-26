# Worker Phase Events — Severity Tiers and Coalescing (CTL-229)

_Read this when subscribing to worker phase transitions, understanding the batched `phase_advanced` vs immediate `status_terminal` split, or reading coalesced event shapes._

The worker emitter splits phase transitions into two topics so subscribers can filter by severity instead of inspecting `.detail` fields:

| Topic | Tier | When | Coalesces? | Carries `detail.pr`? |
|---|---|---|---|---|
| `worker-phase-advanced` | info | routine in-flight phases (researching, planning, implementing, validating, shipping) | yes — batched per orchestrator within `windowSec` (default 30 s) | no |
| `worker-status-terminal` | act  | actionable transitions (pr-created, merging, merged, done, failed, stalled, deploy-failed, deploying) | no — emitted immediately and flushes any pending coalesce queue | yes when `to ∈ {pr-created, merging, merged, done, deploy-failed}` |

Coalesced `orchestrator.worker.phase_advanced` events leave
`attributes."catalyst.worker.ticket"` unset at the envelope level; the per-change
`worker` lives inside `.body.payload.changes[]`:

```json
{
  "ts": "2026-05-04T22:00:00Z",
  "orchestrator": "orch-foo",
  "worker": null,
  "event": "worker-phase-advanced",
  "detail": {
    "windowSec": 30,
    "changes": [
      { "ts": "2026-05-04T21:59:32Z", "worker": "CTL-229", "from": "researching", "to": "planning" },
      { "ts": "2026-05-04T21:59:36Z", "worker": "CTL-232", "from": "planning",    "to": "implementing" }
    ]
  }
}
```

Stragglers (the last event in a sequence) flush via the next `emit` OR via an explicit `emit-worker-status-change.sh flush --orch <id>` invocation. The orchestrator's 10-min idle scan is the documented contract for periodic flushing — a worker exiting between phases does not need to flush its own queue.

## Subscriber recipes

```bash
# Subscribe to actionable transitions only (no routine progress noise)
catalyst-events tail --filter '.attributes."event.name" == "orchestrator.worker.status_terminal"'

# Subscribe to routine progress (already coalesced into batches)
catalyst-events tail --filter '.attributes."event.name" == "orchestrator.worker.phase_advanced"'

# A worker just opened a PR — wait until it tells you the PR number
catalyst-events wait-for --timeout 600 \
  --filter '.attributes."event.name" == "orchestrator.worker.status_terminal" and .body.payload.to == "pr-created" and .attributes."catalyst.worker.ticket" == "CTL-229"' \
  | jq -r '.body.payload.pr.number'
```
