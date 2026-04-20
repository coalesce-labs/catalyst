---
title: Agent Communication (catalyst-comms)
description: File-based messaging CLI so Claude Code agents can coordinate across worktrees, sub-agents, teams, and orchestrators — no server, no HTTP, just JSONL files.
sidebar:
  order: 7
---

`catalyst-comms` is a file-based agent communication channel. It lets parallel Claude Code agents
— across different worktrees, sub-agents, or orchestrator waves — send messages to each other
without a server, a message broker, or any HTTP.

Under the hood, each channel is an append-only JSONL file on disk. Any shell that can run `jq`
can participate. The storage layout is global, so agents in completely separate worktrees see the
same channels.

## When to Use

- An orchestrator (`/catalyst-dev:orchestrate`) is running multiple workers and you want them to
  coordinate — avoid stepping on the same files, share partial results, signal completion.
- Parallel sub-agents spawned by an `Agent(...)` call need to share state without waiting for the
  parent to serialize them.
- A long-running agent wants a heartbeat that a human auditor can `watch`.
- A worker is blocked and needs to signal a coordinator or human for intervention.

## When NOT to Use

- **Single-agent work.** Just do the task.
- **Returning structured data to a parent agent** — use the normal Agent return value, not a
  channel.
- **Persisting research or plans** — those belong in `thoughts/shared/`, not in channel messages.

## Installation

`catalyst-comms` is installed alongside the rest of the Catalyst dev CLIs via `setup-catalyst`.
When you run the [setup health check](./setup-health-check/), it:

1. Creates `~/.catalyst/bin/` and populates it with symlinks to every `catalyst-*` CLI.
2. Tells you the one PATH line to add to `~/.zshrc` or `~/.bashrc`:

   ```bash
   export PATH="$HOME/.catalyst/bin:$PATH"
   ```

3. Verifies on subsequent runs that the symlinks still resolve (important after a plugin update,
   since symlinks can point at a previous version's scripts directory).

You can also run the installer directly:

```bash
bash plugins/dev/scripts/install-cli.sh              # install / re-point
bash plugins/dev/scripts/install-cli.sh --uninstall  # clean removal
```

Once PATH is set up, `catalyst-comms --help` and the siblings (`catalyst-session`,
`catalyst-monitor`, `catalyst-state`, `catalyst-db`, `catalyst-thoughts`, `catalyst-claude`)
work from any shell.

## Quick Start

Two terminals. In the first, join a channel and start watching it:

```bash
catalyst-comms join demo --as alice --ttl 300
catalyst-comms watch demo
```

In the second, join with a different name and send a message:

```bash
catalyst-comms join demo --as bob --ttl 300
catalyst-comms send demo "hello alice, how's the build?" --as bob --type question
```

The first terminal's `watch` view shows the message appear with color-coded agent names. Reply:

```bash
# Capture bob's message id from watch, then answer:
catalyst-comms send demo "green across the board" --as alice --type answer --re msg-<bob-id>
catalyst-comms done demo --as alice
catalyst-comms done demo --as bob
```

Once both participants have posted `done`, the channel has quorum and the coordinator knows work
is complete.

## Commands

### `join` — enter a channel

```bash
catalyst-comms join <channel> --as <name> \
  [--capabilities "what you own"] \
  [--parent <parent-agent-name>] \
  [--orch <orchestrator-id>] \
  [--ttl <seconds>] \
  [--topic "one-line description"]
```

Creates the channel if it doesn't exist. Re-joins with the same `--as` are idempotent — they
bump `lastSeen`. Long-running agents should re-join periodically so their TTL doesn't elapse.

### `send` — append a message

```bash
catalyst-comms send <channel> "<body>" \
  --as <name> \
  [--type proposal|question|answer|ack|info|attention|done] \
  [--to <name>|all] \
  [--re <msg-id>]
```

Prints the new message id on stdout. Default type is `info`. Use `--re` when replying to a
question or proposal so the reply threads correctly.

### `poll` — read messages

```bash
# One-shot read of everything
catalyst-comms poll <channel>

# Only messages past a cursor (line count, not timestamp)
catalyst-comms poll <channel> --since 42

# Only messages addressed to you (or "all")
catalyst-comms poll <channel> --filter-to <your-name>

# Block until new matching messages appear
catalyst-comms poll <channel> --wait --filter-to <your-name>
```

Track the cursor yourself: after each batch, set `--since` to the current line count.

### `done` — post completion + check quorum

```bash
catalyst-comms done <channel> --as <your-name>
# exit 0  → every active participant has posted done
# exit 1  → still waiting; missing participants are printed to stdout
```

Participants with `status=left` are excluded from quorum.

### `leave` — bow out early

```bash
catalyst-comms leave <channel> --as <your-name>
```

Marks your record `status=left` and posts an info message. Others no longer wait on you for
quorum.

### `channels` — list everything

```bash
catalyst-comms channels
```

Dumps the full registry (`~/catalyst/comms/channels.json`) as JSON. Useful to discover what's
active.

### `watch` — live tail

```bash
catalyst-comms watch <channel> [--summary-interval <seconds>]
```

Color-coded tail of a channel as messages arrive. Prints a periodic summary line of participants
and totals.

### `status` — summary dashboard

```bash
catalyst-comms status             # all channels, participant/message counts, last activity
catalyst-comms status <channel>   # full detail: participants + last 10 messages
```

### `gc` — prune stale channels

```bash
catalyst-comms gc --older-than 7   # remove channels inactive > 7 days
catalyst-comms gc --older-than 0   # nuke all channels (useful in tests)
```

## Message Types

Every `send` call has a `--type` (default `info`):

| Type         | When to use                                                    | Expected response |
| ------------ | -------------------------------------------------------------- | ----------------- |
| `proposal`   | "I plan to do X"                                               | `ack` or counter  |
| `question`   | "Does my filter conflict with yours?"                          | `answer`          |
| `answer`     | Reply to a `question` (always pair with `--re <msg-id>`)       | —                 |
| `ack`        | Reply to a `proposal` meaning "go ahead" (`--re <msg-id>`)     | —                 |
| `info`       | Freeform FYI, no response needed                               | —                 |
| `attention`  | "I'm blocked — a human or coordinator must intervene"          | —                 |
| `done`       | "My portion is complete" (auto-sent by `done` command)         | —                 |

`watch` and `status` surface `type=attention` messages prominently — use them for real blockers,
not for routine updates.

## Storage Layout

All channels live under `$CATALYST_DIR/comms/` (default `~/catalyst/comms/`):

```
~/catalyst/comms/
├── channels.json                 # registry: channels, participants, capabilities
└── channels/
    ├── pr-114.jsonl              # one file per channel, append-only
    ├── orch-ctl-ux-wave-1.jsonl
    └── demo.jsonl
```

Paths are absolute, so agents in different git worktrees see the same channels automatically.

Each JSONL line is a message:

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

The registry entry for a channel:

```json
{
  "pr-114": {
    "name": "pr-114",
    "topic": "",
    "created": "2026-04-20T12:00:00Z",
    "participants": [
      {
        "name": "ghost-fixer",
        "joined": "2026-04-20T12:00:01Z",
        "ttl": 300,
        "lastSeen": "2026-04-20T12:12:00Z",
        "capabilities": "state-reader.ts",
        "parent": "CTL-58",
        "orch": null,
        "status": "active"
      }
    ]
  }
}
```

## Orchestrator → Worker Dispatch

Orchestrators that want their workers to coordinate should:

1. Pick a channel name — convention is `orch-<orch-id>` or `wave-<N>`.
2. Set `CATALYST_COMMS_CHANNEL` when dispatching each worker:

   ```bash
   export CATALYST_COMMS_CHANNEL="orch-ctl-ux-apr20-wave-1"
   claude -p ...
   ```

3. Workers read the env var at startup and auto-join with `--as <ticket-id> --orch <orch-id>`.

The orchestrator can monitor progress with `catalyst-comms watch` in a dedicated terminal pane.

## Sub-agent Pattern

When spawning a sub-agent via `Agent(...)`, pass the channel name in the prompt:

```text
Join the shared channel 'orch-api-wave-1' as 'sub-codebase-analyzer' with
--parent 'CTL-58' --ttl 300. Report findings via:
  catalyst-comms send orch-api-wave-1 "..." --as sub-codebase-analyzer --type info
```

Sub-agents should always set a short TTL (≤ 5 min) — they typically finish fast and a short TTL
lets `gc` prune them cleanly.

## Human Auditing

```bash
catalyst-comms watch <channel>     # live color-coded tail
catalyst-comms status              # summary across all channels
catalyst-comms status <channel>    # participants + last 10 messages
```

`attention`-type messages are highlighted so a human auditor can triage blockers at a glance.

## Design Principles

- **Files + `mkdir` locking + optional `fswatch`.** No servers, no dependencies beyond `bash`,
  `jq`, and `uuidgen`.
- **Global paths** (`~/catalyst/comms/`). Naturally shared across worktrees.
- **Bash-only interface.** Any agent that can run a shell command can participate, including
  sub-agents invoked via `Agent(...)`.
- **Append-only JSONL.** Crash-safe, auditable, trivially `grep`/`jq`-able.

## Related

- [Setup Health Check](./setup-health-check/) — how `catalyst-comms` and peers get installed.
- [Observability](../observability/) — the monitoring side of multi-worker orchestration.
- [Skills Reference](./skills/) — the `catalyst-comms` model-invocable skill that Claude
  automatically activates when coordination phrases show up.

## Source

- Script: [`plugins/dev/scripts/catalyst-comms`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/scripts/catalyst-comms)
- Skill (agent-facing): [`plugins/dev/skills/catalyst-comms/SKILL.md`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/catalyst-comms/SKILL.md)
