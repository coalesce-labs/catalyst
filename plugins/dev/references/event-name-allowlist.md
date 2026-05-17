# Canonical worker-event allowlist

Authoritative list of canonical event names a worker should wake on, in OTel
canonical form (`.attributes."event.name"`). Source of truth for each group is
the broker code path that routes it — cited inline so doc and code stay in
sync. A regression test in `plugins/dev/scripts/broker/index.test.mjs` fails
loudly when this file and the broker's routing tables drift apart.

For envelope shape and the full attribute schema, see [[event-schema]].
For writing filters by hand or registering interests, see [[monitor-events]],
[[wait-for-github]], [[catalyst-filter]].

## Why this exists

The broker's `tryDeterministicRoute` and `tryTicketLifecycleRoute` functions
already encode the actionable subset of canonical event names. Workers that
hand-roll `catalyst-events wait-for --filter` predicates or `filter.register`
calls were guessing at the right names — sometimes targeting the legacy v1 raw
names (`worker-pr-created`, `attention-raised`) that no longer appear on disk,
sometimes writing over-broad clauses that wake on 60-70% of unrelated webhooks.

The allowlist below is the answer to "which event names should I filter on?"
Anything not in this list is either non-actionable (e.g. `check_run.created`,
`pull_request.synchronize`) or covered by a different lifecycle group.

## pr_lifecycle

Source: `plugins/dev/scripts/broker/index.mjs:708-833` (`tryDeterministicRoute`).

Workers registering a `pr_lifecycle` interest (or its auto-correlated form via
`agent.checkin` with `claimed_pr`) wake on these event names:

- `github.check_suite.completed` — CI finished on a watched PR (conclusion ∈ success/failure)
- `github.pr.merged` — watched PR was merged
- `github.pr.closed` — watched PR closed without merging (`body.payload.merged === false`)
- `github.pr_review.submitted` — watched PR review state ∈ {changes_requested, approved}
- `github.pr_review_comment.created` — review comment on watched PR
- `github.pr_review_thread.resolved` — review thread resolved on watched PR
- `github.deployment.created` — deployment started for watched PR's merge commit
- `github.deployment_status.success` — production deployment finished
- `github.deployment_status.failure` — production deployment failed
- `github.deployment_status.error` — production deployment errored
- `github.push` — push to a watched PR's base branch (the PR is now BEHIND)

## ticket_lifecycle

Source: `plugins/dev/scripts/broker/index.mjs:847-849` (`TICKET_LIFECYCLE_ALL_WAKE_ON`)
+ `plugins/dev/scripts/broker/index.mjs:851-960` (`tryTicketLifecycleRoute`).

The interest registration uses **kind-names** (`pr_opened`, `pr_merged`,
`status_done`, `status_in_review`, `status_changed`, `comment_added`) — these
are NOT event names. The broker maps them to these canonical event names on
the wire:

- `linear.issue.state_changed` — drives `status_done`, `status_in_review`, `status_changed`
- `linear.issue.updated` — drives `status_changed`
- `linear.comment.created` — drives `comment_added`
- `github.pr.opened` — drives `pr_opened` (when ticket id matches PR title/body/branch)
- `github.pr.merged` — drives `pr_merged` (when ticket id matches PR title/body/branch)
- `github.pr.closed` — body-text ticket extraction (same scoping as opened/merged)

## comms_lifecycle

Source: `plugins/dev/scripts/broker/index.mjs:682-706` (`matchCommsLifecycle`).

A single event drives this interest:

- `comms.message.posted` — filtered by `body.payload.channel`, `body.payload.type` (must be in `types_of_interest`), and recipient (`body.payload.to` matches `subscriber_ticket`, or sender is in `owned_workers` for orchestrator subscribers)

## worker_lifecycle (broker projection — CTL-483)

Source: `plugins/dev/scripts/broker/index.mjs:handleWorkerStateChanged`. This is a
command event consumed by the broker for the worker-signal projection (ADR-018),
not a wake-up target for `pr_lifecycle` / `ticket_lifecycle` interests. Worker
agents do NOT register interests on it; the broker matches by `event.name` in
its dispatch chain and projects the new state to
`<orchDir>/workers/<TICKET>.json.projected`.

- `worker.state_changed` — emitted by scripts that mutate
  `workers/<TICKET>.json`. Carries the full new state in `body.payload.state`,
  plus `attributes."catalyst.orchestrator.id"`, `attributes."catalyst.worker.ticket"`,
  and `attributes."catalyst.writer"` (which script emitted). The broker writes
  the state byte-for-byte (minus a `_projected` audit-metadata field) to the
  shadow path.

During Phase 1 of the ADR-018 migration, only `orchestrate-auto-rebase` emits
this event. Phase 1 producers are being rolled out one at a time; the remaining
six writers are tracked under follow-up tickets.

## Pitfall: bare `catalyst.orchestrator.id` clauses

`plugins/dev/scripts/orch-monitor/lib/webhook-handler.ts:635-642` stamps
`catalyst.orchestrator.id` on every github webhook event whose PR head-branch
starts with an orchestrator prefix (this is the CTL-234 attribution feature,
intentional). A filter clause like:

```
.attributes."catalyst.orchestrator.id" == "<orch>"
```

with no event-type guard therefore matches EVERY github webhook for that
orchestrator's PRs — including non-actionable `check_run.created`,
`pull_request.synchronize`, `pull_request_review.dismissed`, label-only
updates, etc. The over-wake is real: a worker introspective measured 60–70%
of waked events as non-actionable.

Always combine the orchestrator clause with an event-name guard from the
allowlist above:

```
.attributes."event.name" == "github.pr.merged"
  and .attributes."catalyst.orchestrator.id" == "<orch>"
```

Or — when scoping by PR rather than orchestrator — drop the orch clause and
use `.attributes."vcs.pr.number"` instead.

See [[wait-for-github]] § Known filter pitfalls for the broader table.

## Schema drift: v1 raw names vs canonical names on disk

Some bash producers (`catalyst-state.sh:130-153`) still build event records
internally using v1 raw event strings (`worker-pr-created`, `attention-raised`,
…). The `event_append` helper translates those to canonical names BEFORE
writing — see `__orch_canonical_for`. The line that lands in
`~/catalyst/events/YYYY-MM.jsonl` always uses the canonical name. Filter
writers MUST target canonical:

| v1 raw (caller-side strings) | canonical (on-disk `event.name`) |
|---|---|
| `orchestrator-started` | `orchestrator.started` |
| `orchestrator-failed` | `orchestrator.failed` |
| `worker-dispatched` | `orchestrator.worker.dispatched` |
| `worker-pr-created` | `orchestrator.worker.pr_created` |
| `worker-pr-merged` | `orchestrator.worker.pr_merged` |
| `worker-done` | `orchestrator.worker.done` |
| `worker-failed` | `orchestrator.worker.failed` |
| `worker-launch-failed` | `orchestrator.worker.launch_failed` |
| `worker-revived` | `orchestrator.worker.revived` |
| `worker-status-terminal` | `orchestrator.worker.status_terminal` |
| `worker-phase-advanced` | `orchestrator.worker.phase_advanced` |
| `attention-raised` | `orchestrator.attention.raised` |
| `attention-resolved` | `orchestrator.attention.resolved` |
| `archive` | `orchestrator.archived` |

`filter.register`, `filter.deregister`, and `filter.wake` keep their bare
names on disk — they are NOT prefixed with `orchestrator.` (see
`__orch_canonical_for:146-151` for the exception).

Removing the v1 writes from `catalyst-state.sh` is a separate migration
(deferred — see CTL-370 § Out of scope).

## Quick filter examples

```bash
# PR merged for one watched PR
catalyst-events wait-for --filter \
  '.attributes."event.name" == "github.pr.merged" and .attributes."vcs.pr.number" == 342'

# CI failure on any of the orch's PRs (multi-PR set)
catalyst-events wait-for --filter \
  '.attributes."event.name" == "github.check_suite.completed"
   and .body.payload.conclusion == "failure"
   and ((.body.payload.prNumbers // []) | any(IN(342, 343, 344)))'

# Worker reached terminal state (any worker in this orch)
catalyst-events wait-for --filter \
  '(.attributes."event.name" == "orchestrator.worker.done"
    or .attributes."event.name" == "orchestrator.worker.failed")
   and .attributes."catalyst.orchestrator.id" == "orch-foo"'

# Attention raised on any worker in this orch
catalyst-events wait-for --filter \
  '.attributes."event.name" == "orchestrator.attention.raised"
   and .attributes."catalyst.orchestrator.id" == "orch-foo"'
```
