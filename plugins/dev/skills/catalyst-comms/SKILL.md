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

## Posting Discipline

The message-type table above defines what each type *means*. This section defines *when*
a worker should choose each type. Workers that emit `attention` as a heartbeat make the
orchestrator's NEEDS ATTENTION banner useless and foreclose any real-time interrupt
pattern (e.g., the Claude Code Monitor tool). Follow these rules.

### 1. Message-Type Semantics (when to choose which)

- **`info`** — the default. Cheap, append-only, never interrupts anyone. Use for phase
  transitions, PR-opened, "still working", and any FYI a human auditor or the orchestrator
  *might* read but is not required to act on.
- **`attention`** — reserved for orchestrator action. The orchestrator promotes every
  `attention` to a state-level NEEDS ATTENTION item. If you would not interrupt a human
  for it, do not post it. Default to `info` and ask: "is the orchestrator blocked from
  making forward progress unless it sees this *now*?" If no, it is `info`.
- **`done`** — sent only via the `done` subcommand at terminal success. One per worker
  per session. Never use `send --type done` manually; let the subcommand do it so quorum
  is auto-checked.
- **`proposal` / `question` / `answer` / `ack`** — peer-to-peer coordination only. Use
  when you need a sibling worker to confirm before you proceed (e.g., overlapping file
  scope). The recipient is expected to reply within minutes; if no reply, treat as `ack`
  and proceed.

### 2. Volume Budgets

Per worker per session:

| Type        | Budget                                                          |
|-------------|-----------------------------------------------------------------|
| `info`      | At phase boundaries + PR-opened only. ~5–7 in the normal path.  |
| `attention` | **0–2 per worker.** More than 2 means you are using it as info. |
| `done`      | Exactly 1, on terminal success.                                 |
| `proposal` / `question` / `answer` / `ack` | As needed for active coordination. |

`info` posts in the middle of a phase ("running tests…", "still here…") are noise. Phase
transitions are the heartbeat — skip per-step status updates.

`attention` above 2 is a signal that either (a) the worker is mis-categorising routine
events, or (b) something is genuinely wrong and the worker should stop and write a
clear final `attention` instead of spamming partial status.

### 3. Mandatory Escalation (when you MUST post `attention`)

These are not discretionary. The worker MUST post exactly one `attention` message —
clear, single-shot, with a body the orchestrator can act on — when any of these occur:

- **Scope conflict** — your dispatch brief tells you to touch files another worker also
  owns, or your work has a hard dependency on a sibling worker's output that has not
  arrived. Body: name the conflicting file/sibling.
- **Missing access** — required CLI / credential / API not available, and you cannot
  proceed without it. Body: name the missing thing.
- **Ambiguous spec** — the ticket / dispatch brief contradicts itself or omits a fact
  you must have to make a correct choice. Body: state the ambiguity and the two
  candidate interpretations.
- **Repeated test/CI failures** — same failure mode 3+ times after distinct fix
  attempts. Body: failure signature + what you tried.
- **Stalled merge** — you wrote `status="stalled"` for any reason (merge conflict you
  cannot resolve, required reviewer you cannot satisfy, branch protection rule you
  cannot meet). Body: which blocker, which PR.

Do NOT wait for human input before escalating. Post the `attention`, then either
continue working on what you *can* still do, or exit if the blocker is total.

### 4. Severity Framing (blocking vs nonblocking)

Catalyst uses a binary severity system mapped onto the existing types:

- **blocking** → `attention` (orchestrator must act before forward progress is possible)
- **nonblocking** → `info` (informational; orchestrator may act eventually)

When in doubt, prefix the body to make severity unambiguous to a human reading the
channel:

```bash
# blocking — pairs with --type attention
catalyst-comms send "$CH" "[blocking] missing GH_TOKEN, cannot create PR" \
  --as worker-3 --type attention

# nonblocking — pairs with --type info
catalyst-comms send "$CH" "[nonblocking] codex flagged 1 minor style issue, fixing inline" \
  --as worker-3 --type info
```

Workers MAY adopt P1/P2/P3 in the body (`[P1]`, `[P2]`, `[P3]`) for finer grain — but
only the binary distinction is enforced by the orchestrator. P1/P2/P3 is a body
convention, not a schema change.

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
