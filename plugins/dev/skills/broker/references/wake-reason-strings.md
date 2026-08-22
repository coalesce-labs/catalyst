# Wake Reason Strings and `wake-extract` Accessor

_Read this when decoding the `reason` field in a wake payload by interest type, or when using
`catalyst-events wake-extract` to normalize source-event fields without hand-rolling jq paths._

## Wake Reason Strings by Interest Type

### `pr_lifecycle`

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

### `ticket_lifecycle`

| Source event | `reason` pattern |
|---|---|
| `linear.issue.state_changed` (Done) | `"Ticket {id} marked Done"` |
| `linear.issue.state_changed` (In Review) | `"Ticket {id} moved to In Review"` |
| `linear.issue.state_changed` (other) | `"Ticket {id} state changed to {state}"` |
| `linear.issue.updated` | `"Ticket {id} updated"` |
| `linear.comment.created` | `"New comment on {id} by {author}"` |
| `github.pr.opened` (linked ticket) | `"PR #N opened on ticket {id}"` |
| `github.pr.merged` (linked ticket) | `"PR #N on ticket {id} merged"` |

### `comms_lifecycle`

| Subscriber kind | `reason` pattern |
|---|---|
| orchestrator | `"Worker {ticket} posted {type} on {channel}"` |
| worker | `"Message to {ticket} ({type}) on {channel} from {sender}"` |

## `wake-extract` — Typed Accessor

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
When `source_events` is empty (watchdog wakes), all fields except `interest_id` and `reason` are
`null` — treat the wake as a "go re-check" signal in that case.
