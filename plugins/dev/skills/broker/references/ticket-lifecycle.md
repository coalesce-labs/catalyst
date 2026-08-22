# ticket_lifecycle Interest Type

_Read this when registering to watch a ticket's Linear events and PR links, or to decode
`wake_on` values and the wake event shape for `ticket_lifecycle` wakes._

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
    }}' >> $(ls -t ~/catalyst/events/*.jsonl | head -1)
```

## `wake_on` Values

| Value | Fires on |
|---|---|
| `status_done` | `linear.issue.state_changed` where state matches `/done/i` |
| `status_in_review` | `linear.issue.state_changed` where state matches `/in.?review/i` |
| `status_changed` | Any `linear.issue.state_changed` or `linear.issue.updated` |
| `comment_added` | `linear.comment.created` for the ticket |
| `pr_opened` | `github.pr.opened` whose body/title/branch references the ticket |
| `pr_merged` | `github.pr.merged` whose body/title/branch references the ticket |

Omit `wake_on` (or pass `null`) to fire on all of the above.

## Wake Event Shape (Canonical On-Disk Form)

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

See [wake-payload-reference.md](wake-payload-reference.md) for the complete field reference and
[wake-reason-strings.md](wake-reason-strings.md) for `wake-extract` accessor usage.

## Waiting for a Ticket Wake

```bash
EVENT=$(catalyst-events wait-for \
  --filter ".attributes.\"event.name\" == \"filter.wake.${CATALYST_SESSION_ID}\"" \
  --timeout 600 2>/dev/null || true)
```
