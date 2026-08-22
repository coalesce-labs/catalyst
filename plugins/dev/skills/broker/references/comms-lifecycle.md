# comms_lifecycle Interest Type (CTL-357)

_Read this when registering orchestrator or worker interests to watch comms-channel messages, or
when the orchestrator needs to wake on worker `attention` / `done` posts._

Deterministic routing for `comms.message.posted` events on a shared comms channel. Replaces the
Groq prose interest the orchestrator used to register for "any of my workers posts an attention
message". The routing is keyed on channel + sender + message-type, with no model call.

## Subscriber kinds

- **`subscriber_kind: "orchestrator"`** — wakes when one of the orchestrator's `owned_workers`
  posts a message of an interesting type. Default `types_of_interest` is `["attention", "done"]`
  (matches `attention` and `done`, ignores `info` heartbeats).
- **`subscriber_kind: "worker"`** — wakes when a peer posts a message addressed to this worker
  (`to=<subscriber_ticket>`) or to all (`to=all`). Self-posts are ignored (self-loop guard).
  Workers default to all message types — orchestrator → worker traffic is rare and intentional.

## Schema

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

## Registering (orchestrator)

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
    }}' >> $(ls -t ~/catalyst/events/*.jsonl | head -1)
```

## Registering (worker)

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
    }}' >> $(ls -t ~/catalyst/events/*.jsonl | head -1)
```

## Match logic (no Groq call)

| Trigger | Condition |
|---|---|
| `event.name == "comms.message.posted"` | always required |
| `body.payload.channel == reg.channel` | always required |
| `body.payload.type` ∈ `reg.types_of_interest` | required (defaults: orchestrator → `["attention","done"]`, worker → all types) |
| Orchestrator: `attributes."catalyst.worker.ticket"` ∈ `reg.owned_workers` | required for orchestrator subscribers |
| Worker: `body.payload.to == reg.subscriber_ticket` OR `body.payload.to == "all"` | required for worker subscribers |
| Worker: sender (`catalyst.worker.ticket`) != `reg.subscriber_ticket` | self-loop guard |

## Wake Event Shape (Canonical On-Disk Form)

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

See [wake-payload-reference.md](wake-payload-reference.md) for the complete envelope field reference.
