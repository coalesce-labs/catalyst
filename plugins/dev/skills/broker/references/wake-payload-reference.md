# Wake Event Envelope Reference

_Read this when parsing a `filter.wake.*` event payload — to understand every field in the
canonical OTel envelope and the `source_events[]` element structure._

All `filter.wake.*` events written to the event log use the canonical OTel envelope
(CTL-300). This section documents every field so skills can extract data from the wake
payload directly rather than making round-trip REST/GraphQL calls.

## Canonical On-Disk Shape

```json
{
  "ts": "2026-05-08T18:25:00.000Z",
  "id": "<uuid>",
  "observedTs": "2026-05-08T18:25:00.000Z",
  "severityText": "INFO",
  "severityNumber": 9,
  "resource": {
    "service.name": "catalyst.broker",
    "service.namespace": "catalyst",
    "catalyst.node.class": "worker"
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

## `body.payload` Fields

| Field | Type | Description |
|---|---|---|
| `reason` | string | Human-readable description of why the broker fired |
| `source_event_ids` | string[] | UUIDs of the raw events that matched the interest |
| `source_events` | object[] | Compact summaries of the source events (CTL-350) — see below |
| `interest_id` | string | Which interest registration matched |
| `ticket` | string\|null | Linear ticket ID — **only set on `ticket_lifecycle` wakes** |

`source_events` is empty on watchdog wakes (stale interest, dead session).

## `source_events[]` Element Structure

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
