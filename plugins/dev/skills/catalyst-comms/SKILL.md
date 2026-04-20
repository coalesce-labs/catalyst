---
name: catalyst-comms
description:
  Protocol guide for the `catalyst-comms` file-based agent communication CLI. Use when
  agents need to coordinate across worktrees, sub-agents, teams, or orchestrators — e.g.
  orchestrator passes `CATALYST_COMMS_CHANNEL`, user asks to "coordinate with", "ask the
  other agent", or workers need to share state without HTTP.
---

# catalyst-comms — Agent Communication Protocol

A file-based messaging system: each channel is a JSONL log at
`~/catalyst/comms/channels/<name>.jsonl`, with participants tracked in
`~/catalyst/comms/channels.json`. No server, no HTTP. Works across worktrees because
the paths are absolute.

## When to Use

- **Orchestrator sets `CATALYST_COMMS_CHANNEL`** when dispatching workers — join it on
  startup.
- **User mentions** "coordinate with", "tell the other agent", "ask the X worker", or
  "check if Y has finished".
- **Parallel sub-agents** need to share partial results without waiting for the parent.
- **Agent teams** (`--team` in `/oneshot`) need to avoid stepping on each other's files.
- **Long-running agents** want a heartbeat visible to a human auditor.

## When NOT to Use

- Single-agent work. Just do the task.
- Handing structured data to the parent agent — use the normal return value.
- Persisting research or plans — that belongs in `thoughts/shared/`.

## Discovery

At startup, check for an orchestrator-assigned channel, then list what's already active:

```bash
# Orchestrator may have set this in the dispatch env
echo "$CATALYST_COMMS_CHANNEL"

# See all active channels on this machine
catalyst-comms channels
```

## Joining (always before sending)

```bash
catalyst-comms join <channel> --as <your-name> \
  --capabilities "what you own (file paths, domains)" \
  --parent "name of the agent that spawned you" \
  --orch "<orchestrator-id>" \
  --ttl 600
```

`--ttl` is how long (seconds) before a human treats your last activity as stale.
Long-running agents should re-join periodically (same `--as`) to bump `lastSeen`.

If the channel doesn't exist yet, `join` creates it. Participants are upserted by
`--as`, so re-joins are idempotent.

## Message Types

All `send` calls carry a `--type` (default `info`):

| Type         | When to use                                                    | Expected response |
|--------------|---------------------------------------------------------------|-------------------|
| `proposal`   | "I plan to do X"                                              | `ack` or counter  |
| `question`   | "Does my filter conflict with yours?"                         | `answer`          |
| `answer`     | Reply to a `question` (always set `--re <msg-id>`)            | —                 |
| `ack`        | Reply to a `proposal` saying "go ahead" (set `--re <msg-id>`) | —                 |
| `info`       | FYI, no response needed                                       | —                 |
| `attention`  | "I'm blocked, a human or coordinator must intervene"          | —                 |
| `done`       | "My portion is complete" (automatically sent by `done` cmd)   | —                 |

Example:

```bash
catalyst-comms send pr-114 "I'm rebasing first, please hold migrations" \
  --as backend-worker --type proposal

# Later, reply:
MSG_ID=$(catalyst-comms send pr-114 "ack, holding" \
  --as frontend-worker --type ack --re msg-abc123)
```

## Polling and Waiting

```bash
# One-shot read
catalyst-comms poll <channel>

# Only new messages past a line-count cursor (not a timestamp)
catalyst-comms poll <channel> --since 42

# Only messages addressed to me (or "all")
catalyst-comms poll <channel> --filter-to <your-name>

# Block until new messages arrive (uses fswatch if available, else 1s polling)
catalyst-comms poll <channel> --wait --filter-to <your-name>
```

Track your own `--since` cursor: after each batch, set `since` to the current line
count so you don't re-process old messages.

## Quorum and Completion

When every agent on the channel has posted its portion, the coordinator knows work
is truly done. The `done` command does both (post a `done` message AND check quorum):

```bash
catalyst-comms done <channel> --as <your-name>
# exit 0 → every active participant has posted done
# exit 1 → still waiting on others (names printed to stdout)
```

Participants with `status=left` are excluded from quorum — so `leave` if you bow out
early.

## Leaving

```bash
catalyst-comms leave <channel> --as <your-name>
```

Posts a `left` info message and marks your participant record `status:left`. Other
participants treat you as no longer responsible for quorum.

## Blocked / attention flow

```bash
catalyst-comms send <channel> "can't resolve migration conflict in 004_users.sql" \
  --as worker-3 --type attention --to coordinator
```

Human audit tools (`catalyst-comms watch`, `catalyst-comms status`) surface
`type=attention` messages prominently.

## Orchestrator → Worker Dispatch Pattern

Orchestrators running `/orchestrate` that want workers to coordinate should:

1. Create (or choose) a channel name like `orch-<orch-id>` or `wave-<N>`.
2. When dispatching each worker via `claude -p`, set:

   ```bash
   export CATALYST_COMMS_CHANNEL="orch-agent-obs-wave-1"
   claude -p ...
   ```

3. Workers check this env var at startup (or are instructed to by the dispatch prompt)
   and auto-join with `--as <ticket-id> --orch <orch-id>`.

### Worker Traffic Contract (CTL-111)

Workers dispatched by `/orchestrate` MUST produce traffic, not just join silently. The
hard-gate baseline is **minimum 4 messages per worker** across its lifetime:

| Hook                     | Type        | Example body                                       |
|--------------------------|-------------|----------------------------------------------------|
| Worker startup           | `info`      | `started oneshot for CTL-101`                      |
| Each phase transition    | `info`      | `researching → planning`                           |
| PR opened                | `info`      | `pr:#123 opened`                                   |
| Blocked / stalled        | `attention` | `worker failed: <reason>`                          |
| Worker settle            | `done`      | (posted via `catalyst-comms done` subcommand)      |

In the normal path, the `/oneshot` flow transitions through 5 phases (researching → planning →
implementing → validating → shipping), so a healthy worker emits **7+ messages** (1 start + 5
transitions + 1 PR-opened + 1 done). Anything < 4 = worker is not properly integrated.

**Where this is wired:**

- `/oneshot` skill — startup join, phase-transition post, PR-opened post, done, attention
- `/orchestrate` skill — orchestrator channel creation, `CATALYST_COMMS_CHANNEL` dispatch env,
  attention-poll in the monitoring loop, orchestrator done on settle

**Failure modes are silent by design:** every call is wrapped with `command -v catalyst-comms`
+ `|| true`, so a missing CLI or failed send never crashes the worker. Signal files remain the
authoritative state; comms is observability and coordination only.

## Sub-agent Pattern

When spawning a sub-agent via `Agent(...)`, pass the channel name in the prompt:

```
Join the shared channel 'orch-api-wave-1' as 'sub-codebase-analyzer' with
--parent 'CTL-58' --ttl 300. Report findings via:
  catalyst-comms send orch-api-wave-1 "..." --as sub-codebase-analyzer --type info
```

Sub-agents should always set a short TTL (≤5 min) — they typically finish fast and
a short TTL lets `gc` prune them cleanly.

## Human Auditing

```bash
# Live color-coded tail of a channel (for watching agents talk in real time)
catalyst-comms watch <channel>

# Summary dashboard: every channel, participant count, msg count, last activity
catalyst-comms status

# Full detail for one channel (participants + last 10 messages)
catalyst-comms status <channel>
```

## Garbage Collection

Stale channels accumulate. Run periodically (or wire into `/orchestrate` teardown):

```bash
catalyst-comms gc --older-than 7   # remove channels with no activity in 7d
catalyst-comms gc --older-than 0   # nuke everything (useful in tests)
```

## Message Schema Reference

Each line in `<channel>.jsonl`:

```json
{
  "id": "msg-<uuid>",
  "from": "<agent-name>",
  "to": "<agent-name>|all",
  "ch": "<channel-name>",
  "parent": "<parent-agent-name>|null",
  "orch": "<orchestrator-id>|null",
  "ts": "<ISO-8601>",
  "type": "proposal|question|answer|ack|info|attention|done",
  "re": "<msg-id>|null",
  "body": "<free-form text>"
}
```

Registry at `~/catalyst/comms/channels.json`:

```json
{
  "pr-114": {
    "name": "pr-114",
    "topic": "",
    "created": "<ISO>",
    "participants": [
      {
        "name": "ghost-fixer",
        "joined": "<ISO>",
        "ttl": 300,
        "lastSeen": "<ISO>",
        "capabilities": "state-reader.ts",
        "parent": "CTL-58",
        "orch": null,
        "status": "active|left"
      }
    ]
  }
}
```

## Design Principles

- **Files + `mkdir` locking + optional `fswatch`** — no servers, no dependencies beyond
  bash, `jq`, and `uuidgen`.
- **Global paths** (`~/catalyst/comms/`) — naturally shared across worktrees.
- **Bash-only** — any agent that can run a shell command can participate, including
  sub-agents.
- **Append-only JSONL** — crash-safe, auditable, trivially grep/jq-able.
