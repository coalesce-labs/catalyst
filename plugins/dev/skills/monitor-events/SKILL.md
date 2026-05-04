---
name: monitor-events
description:
  Reference for the canonical event-driven wait pattern in Catalyst skills. Use when a skill
  needs to block on a state change (PR merged, CI completed, push to branch, ticket
  transitioned) WITHOUT polling. Pairs the `catalyst-events` CLI with the Claude Code
  `Monitor` tool and `wait-for` for short-lived workers.
---

# monitor-events — Event-driven waits in skill prose

## What this is for

CTL-210 unified the Catalyst event log: every GitHub webhook, Linear webhook, comms post,
and orchestrator/worker lifecycle event flows through `~/catalyst/events/YYYY-MM.jsonl`.
Consumers no longer poll `gh pr view`, `linearis read`, or signal files — they subscribe
to the event stream via filter.

This skill documents the canonical patterns. Use it as a reference when writing or
migrating skill prose; do not invoke it as a slash command.

## Prerequisite — orch-monitor daemon must be running

The two primitives below read from `~/catalyst/events/YYYY-MM.jsonl`, which is populated
by the `orch-monitor` daemon (`plugins/dev/scripts/orch-monitor/server.ts`). When the
daemon is **not** running:

- `catalyst-events tail` returns an empty stream
- `catalyst-events wait-for` blocks until its `--timeout` expires (default 600s) and
  exits non-zero — callers fall back to `gh pr view` polling, which can't see deploys

Liveness check (the same call wired into `check-project-setup.sh`):

```bash
plugins/dev/scripts/catalyst-monitor.sh status        # human-readable
plugins/dev/scripts/catalyst-monitor.sh status --json # {"running":true,"pid":...}
```

Skills that invoke `check-project-setup.sh` (orchestrate, oneshot, merge-pr) handle the
liveness check automatically — interactive runs prompt to start the daemon, autonomous
runs warn-to-stderr and proceed. If you reuse the primitives outside those skills, run
the status check yourself and either start the daemon (`catalyst-monitor.sh start`) or
plan for the polling fallback.

## The two primitives

| Primitive | When | What |
|---|---|---|
| `Monitor` | Long-lived in-skill watch | Claude Code built-in tool; runs a background command and surfaces stdout lines as notifications |
| `catalyst-events wait-for` | Short-lived `claude -p` worker | Bash CLI; blocks until a matching event arrives, prints the line, exits 0 |

Both use `catalyst-events` under the hood. `tail` is the streaming foundation; `wait-for`
is `tail | head -n 1` with a timeout.

## Pattern 1 — Worker waits for its PR to merge

A `claude -p` worker that just opened PR #342 needs to block until the PR merges, then
do post-merge work. Use `wait-for`:

```bash
# Block until github.pr.merged for this PR arrives — up to 2 hours.
EVENT=$(catalyst-events wait-for \
  --filter ".event == \"github.pr.merged\" and .scope.pr == ${PR_NUMBER}" \
  --timeout 7200 || true)

# Mandatory fallback: ALWAYS confirm with an authoritative one-shot check.
# wait-for can return 0 (matched) or 1 (timed out); both paths must verify.
MERGE_STATE=$(gh pr view ${PR_NUMBER} --json state)
STATE=$(echo "$MERGE_STATE" | jq -r '.state')
if [ "$STATE" = "MERGED" ]; then
  # Proceed with post-merge work
fi
```

**Non-negotiable:** every `wait-for` is paired with an authoritative check. Reasons:

- The orch-monitor daemon may be down. No daemon → no webhook events → `wait-for`
  blocks until timeout. The `gh pr view` after timeout is the safety net.
- Transient state can race the event. The webhook may arrive while the worker is doing
  setup before reaching `wait-for`. The fallback covers that gap too.
- Filters may not match exactly. `wait-for` returns the first matching line; `gh pr view`
  returns canonical truth.

## Pattern 2 — Long-lived orchestrator wakes on multiple event types

The orchestrator's Phase 4 used to poll every 2–3 minutes for every active worker. With
CTL-210, the orchestrator runs a `Monitor` watching all PR/CI/push events, and the
per-cycle scan drops to 10 minutes maximum:

```text
Use the `Monitor` tool with this command:

catalyst-events tail --filter '
  (.event | startswith("github.pr.")) or
  (.event | startswith("github.check_")) or
  (.event == "github.push")
'

When a notification arrives, re-evaluate the affected worker's state via the
canonical `gh pr view` query. Do NOT trust the event's payload as the source
of truth — use it only as a wake-up trigger.
```

The orchestrator continues to maintain its 10-minute fallback scan (defense-in-depth).
The fast path is event-driven; the slow path is the safety net.

## Pattern 3 — Tail everything happening to a ticket

Useful for live debugging or operator dashboards:

```bash
catalyst-events tail --filter '.scope.ticket == "CTL-210"'
```

Captures GitHub PR events scoped to that ticket, Linear webhook events for the issue,
comms posts where the ticket is the from/parent, and orchestrator/worker lifecycle
events.

## Filter cookbook

| Need | Filter |
|---|---|
| All GitHub webhook events | `.event \| startswith("github.")` |
| All Linear webhook events | `.event \| startswith("linear.")` |
| One PR's merge | `.event == "github.pr.merged" and .scope.pr == 342` |
| Any push to a branch | `.event == "github.push" and .scope.ref == "refs/heads/main"` |
| CI completion | `.event \| startswith("github.check_suite.")` |
| Linear ticket state change | `.event == "linear.issue.state_changed" and .scope.ticket == "CTL-210"` |
| Comms message in one channel | `.event == "comms.message.posted" and .detail.channel == "orch-foo"` |
| Worker phase transition | `.event == "worker-status-change" and .worker == "CTL-210"` |
| Attention raised in this orchestrator | `.event == "attention-raised" and .orchestrator == "orch-foo"` |

## `--timeout` semantics

- `wait-for --timeout N` exits 1 after N seconds with no output. The caller decides what
  to do (usually: run the authoritative one-shot, then either re-invoke `wait-for` or
  give up).
- Default timeout is 1800 s (30 min) — long enough for human-paced events, short enough
  to recover from a daemon crash.
- For long waits (e.g. PR merge: hours), set `--timeout 7200`. The fallback after timeout
  re-checks via `gh` and either continues or re-invokes `wait-for`.

## Centralization risk

The event stream is a single point of failure. Mitigations:

1. **Always pair `wait-for` with a one-shot fallback.** No skill prose may say "trust the
   event stream" — every wait must be paired with an authoritative check.
2. **The 10-minute fallback poll inside orch-monitor** keeps writing events even when
   webhook delivery is broken. So daemon-up-but-webhooks-down is recoverable.
3. **The event log is plain JSONL on the local filesystem.** Anyone with shell access
   can `tail -F` it; no daemon required for reads.
4. **Catalyst-origin events** (worker-dispatched, phase-changed, comms.message.posted)
   are written by writers that don't depend on the daemon. Daemon-down only loses
   GitHub/Linear webhook events.

## v1 vs v2 envelopes

The event log carries two schemas in the same file:

- **v1** (bash writers, `catalyst-state.sh event`): `{ ts, event, orchestrator, worker, detail }`
- **v2** (TypeScript writers, webhook receiver, CTL-209+): adds `id`, `schemaVersion: 2`,
  `source`, `scope` (replacing flat `orchestrator` / `worker` with a nested object;
  v2 still emits the flat fields too as backward-compat aliases).

Filters that read `.scope.repo` / `.scope.pr` / `.scope.ticket` only match v2 envelopes.
Filters that read `.event` / `.worker` / `.orchestrator` work for both. Choose based on
which sources you need to match — webhook events use v2, orchestrator events use v1.

## Quick reference

```bash
catalyst-events tail [--filter <jq>] [--since-line <N>]
catalyst-events wait-for [--filter <jq>] [--timeout <sec>]

# Exit codes:
#   0   wait-for: matched a line (printed to stdout)
#   1   wait-for: timed out
#   2   usage error
```

Environment:

- `CATALYST_DIR` — base directory (default `$HOME/catalyst`)
- `CATALYST_EVENTS_DIR` — events directory (default `$CATALYST_DIR/events`)
- `CATALYST_EVENTS_FILE` — override path entirely (used by tests)

## Related skills

- `merge-pr` Phase 6 — uses `wait-for github.pr.merged` (CTL-210 migration)
- `orchestrate` Phase 4 — uses `Monitor` over `tail` (CTL-210 migration)
- `catalyst-comms` — agent-to-agent pub/sub on per-channel files; `comms.message.posted`
  fan-out events go through this same log
