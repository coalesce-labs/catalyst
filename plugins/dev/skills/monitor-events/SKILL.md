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
CTL-210, the orchestrator runs a `Monitor` watching all PR/CI/push/lifecycle events, and
the reactive scan drops to a 10-minute idle fallback as the safety net (CTL-243):

```text
Use the `Monitor` tool with this command:

catalyst-events tail --filter '
  (.event | startswith("github.pr.")) or
  (.event | startswith("github.pr_review")) or
  (.event | startswith("github.check_")) or
  (.event | startswith("github.deployment")) or
  (.event == "github.push") or
  (.event | startswith("linear.issue.")) or
  (.event == "worker-status-change") or
  (.event == "worker-pr-created") or
  (.event == "worker-done") or
  (.event == "worker-failed") or
  (.event == "attention-raised") or
  (.event == "attention-resolved")
'

When a notification arrives, re-evaluate the affected worker's state via the
canonical `gh pr view` query. Do NOT trust the event's payload as the source
of truth — use it only as a wake-up trigger.
```

The orchestrator's filter is intentionally broad — it covers every event type that
could require a dashboard re-render, a fix-up dispatch, or a merge-confirmation
re-scan. See `orchestrate/SKILL.md` Phase 4 for the wake-up classification table that
maps each event to its reaction.

The orchestrator continues to maintain its 10-minute fallback scan (defense-in-depth).
The fast path is event-driven; the slow path is the safety net.

## Pattern 3 — Reactive PR lifecycle (multi-event wait + classify + dispatch)

Pattern 1's single-event wait is fine for the happy path: the PR merges, the
worker exits. But between PR-create and PR-merge, four things can happen that
the agent should *react to*, not just sleep through:

| Event | Means | Agent should |
|---|---|---|
| `github.check_suite.completed` (conclusion=`failure` / `timed_out`) | CI failed | pull failure logs, fix, push, re-enter the wait |
| `github.pr_review.submitted` (state=`changes_requested`) | Reviewer requested changes | run `/review-comments`, push, re-enter the wait |
| `github.push` to the base branch | PR is now BEHIND | `gh pr update-branch`, re-enter the wait |
| `github.pr.merged` / `github.pr.closed` | terminal | confirm via `gh pr view`, exit |

Wrap one disjunctive `wait-for` around all of them; classify with a `case` on
`.event`; re-enter the loop on every non-terminal event. Authoritative
`gh pr view` runs on every wake-up — same safety rule as Pattern 1.

```bash
BASE_BRANCH=$(gh pr view "$PR_NUMBER" --json baseRefName --jq '.baseRefName')
ITER=0
MAX_ITER=20

while [ $ITER -lt $MAX_ITER ]; do
  ITER=$((ITER + 1))

  EVENT_JSON=$(catalyst-events wait-for \
    --filter '
      (.event == "github.pr.merged" and .scope.pr == '"$PR_NUMBER"') or
      (.event == "github.pr.closed" and .scope.pr == '"$PR_NUMBER"') or
      (.event == "github.check_suite.completed"
         and (.detail.prNumbers // [] | index('"$PR_NUMBER"') != null)
         and (.detail.conclusion == "failure" or .detail.conclusion == "timed_out")) or
      (.event == "github.pr_review.submitted"
         and .scope.pr == '"$PR_NUMBER"'
         and .detail.state == "changes_requested") or
      (.event == "github.push" and .scope.ref == "refs/heads/'"$BASE_BRANCH"'")
    ' \
    --timeout 1800 || true)

  # MANDATORY authoritative re-check on every wake-up.
  PR_STATE=$(gh pr view "$PR_NUMBER" --json state --jq '.state')
  if [ "$PR_STATE" = "MERGED" ]; then break; fi
  if [ "$PR_STATE" = "CLOSED" ]; then exit 1; fi

  EVENT=$(echo "$EVENT_JSON" | jq -r '.event // ""')
  case "$EVENT" in
    github.check_suite.completed)
      # Pull failure logs, classify, fix, push. Then re-enter the loop.
      ;;
    github.pr_review.submitted)
      # Bot vs human — handle differently. See heuristic below.
      ;;
    github.push)
      gh pr update-branch "$PR_NUMBER" || true
      ;;
    "")
      # Timed out — no event. The gh pr view above already confirmed
      # we're not merged; fall through to next iteration.
      ;;
  esac
done
```

### Bot vs human authorship

Review and comment events carry `detail.author = { login, type }` where `type`
is GitHub's `user.type` field — typically `"User"` or `"Bot"`. Use it to route
review-changes-requested events without re-fetching from the GitHub API:

```bash
AUTHOR_TYPE=$(echo "$EVENT_JSON" | jq -r '.detail.author.type // "User"')
case "$AUTHOR_TYPE" in
  Bot)
    # codex, claude-code-review, dependabot — addressable inline.
    /catalyst-dev:review-comments "$PR_NUMBER"
    ;;
  *)
    # Human reviewer — surface to the operator and keep waiting.
    ;;
esac
```

The `// "User"` fallback ensures pre-CTL-228 events (no `author` field) are
treated as human-authored — the safer default.

### Gotchas

- **`check_suite.completed` has no `scope.pr`.** A check suite spans many
  PRs; the affected PR numbers live in `detail.prNumbers`. Filter with
  `(.detail.prNumbers // [] | index($PR) != null)`, not `.scope.pr == $PR`.
- **The filter is one jq expression.** Clauses are joined with `or`, not
  comma. Each clause is parenthesized.
- **Bash quoting.** The shell-variable interpolation (`'"$PR_NUMBER"'`) is
  intentional — the outer single quotes protect the jq syntax from $-expansion,
  the inner double quotes re-enable it for one variable. Test your filter
  by piping a fixture event through `jq -c "select(<filter>)"` before
  trusting it in production.
- **Iteration cap.** `MAX_ITER=20` prevents runaway loops on a stuck failure
  mode. Apply per-failure-type fix budgets inside each handler too (e.g. give
  up after 3 distinct fix attempts on the same CI check).

### Long-lived precedent

The orchestrator's Phase 4 loop has used this shape for a while —
`Monitor` over `tail` with a disjunctive filter, then `case` on the
`gh pr view` result. The pattern above is the short-lived `claude -p`-friendly
equivalent: `wait-for` instead of `Monitor`, `case` on the matched event
instead of the canonical PR state. They share the same safety rule: treat
events as wake-up triggers; treat `gh pr view` (or its equivalent) as truth.

## Pattern 4 — Tail everything happening to a ticket

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
| CI failure for one PR | `.event == "github.check_suite.completed" and .detail.conclusion == "failure" and (.detail.prNumbers // [] \| index(342) != null)` |
| Review changes-requested by a bot | `.event == "github.pr_review.submitted" and .detail.state == "changes_requested" and .detail.author.type == "Bot"` |
| Comment from a human on a PR | `.event == "github.issue_comment.created" and (.detail.author.type // "User") != "Bot"` |
| Linear ticket state change | `.event == "linear.issue.state_changed" and .scope.ticket == "CTL-210"` |
| Comms message in one channel | `.event == "comms.message.posted" and .detail.channel == "orch-foo"` |
| Worker phase transition | `.event == "worker-status-change" and .worker == "CTL-210"` |
| Worker reached terminal state | `.event == "worker-done" or .event == "worker-failed"` |
| PR review activity | `(.event \| startswith("github.pr_review")) or (.event == "github.issue_comment.created")` |
| Deploy outcome | `.event \| startswith("github.deployment")` |
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

- `merge-pr` Phase 6 — uses Pattern 3 (reactive PR lifecycle, CTL-228)
- `create-pr` Step 12 — uses Pattern 3 (reactive PR lifecycle, CTL-228)
- `oneshot` Phase 5 — worker exits at `merging`; long-lived watchers
  (orchestrator Phase 4, standalone `/merge-pr`) consume Pattern 3 on its
  behalf
- `orchestrate` Phase 4 — uses `Monitor` over `tail` with a disjunctive
  filter; the long-lived precedent for Pattern 3
- `catalyst-comms` — agent-to-agent pub/sub on per-channel files;
  `comms.message.posted` fan-out events go through this same log
