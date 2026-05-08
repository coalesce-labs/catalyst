---
title: Semantic Event Routing (catalyst-broker)
description:
  Daemon that routes raw GitHub and Linear events to orchestrators and workers using semantic
  matching — one Groq call per batch replaces dozens of hand-crafted jq predicates.
sidebar:
  order: 6
---

`catalyst-broker` is a long-running daemon that subscribes to the global event log
(`~/catalyst/events/YYYY-MM.jsonl`) and delivers targeted wake events to the right orchestrators
and workers. Instead of writing a jq predicate for every event type you care about, you register
a natural-language intent once and the daemon handles the matching.

The daemon supports two routing paths:

- **Deterministic (`pr_lifecycle`)** — pure field comparison for PR/CI/review/BEHIND events. No
  Groq call, no latency beyond local I/O.
- **Prose (Groq-backed)** — a natural-language `prompt` you write; evaluated by
  `llama-3.1-8b-instant` in a single batched API call covering all registered interests.

Both paths produce the same output: a `filter.wake.<id>` event in the log that your
`catalyst-events wait-for` call is already watching for.

> **Note on naming:** `catalyst-broker` is the canonical CLI as of CTL-303. The older
> `catalyst-filter` command is preserved as a backward-compat shim — it execs `catalyst-broker`
> with the same arguments. Existing scripts that call `catalyst-filter start` continue to work.
> All new docs, install paths, and registrations should use `catalyst-broker`.

## Architecture

```mermaid
graph LR
  GH[GitHub webhook] --> EL[(Event log\n~/catalyst/events/)]
  LN[Linear webhook] --> EL
  CC[Claude Code\nOTel events] --> EL

  EL -->|fs.watch| FD[catalyst-broker\ndaemon]

  FD -->|deterministic match| DET[pr_lifecycle\nrouter]
  FD -->|batch + Groq call| LLM[llama-3.1-8b-instant]

  DET -->|filter.wake.&lt;id&gt;| EL
  LLM -->|filter.wake.&lt;id&gt;| EL

  EL -->|catalyst-events wait-for| OA[Orchestrator A]
  EL -->|catalyst-events wait-for| WB[Worker B]
  EL -->|catalyst-events wait-for| WC[Worker C]
```

The daemon is a fan-out multiplexer: one event in the log can produce multiple independent wakes
if multiple interests match. Each caller receives only the wake for its own `interest_id`.

## Quick Start

```bash
# 1. Add your Groq API key (see Credential Setup below)
# 2. Start the daemon
catalyst-broker start

# 3. Confirm it's running
catalyst-broker status
# → running (pid 12345)

# 4. Watch the log (in a separate terminal)
catalyst-broker logs
```

Once running, any orchestrator or worker that emits `filter.register` to the event log will
have its interests tracked automatically.

## Installation

`catalyst-broker` is installed with the rest of the Catalyst CLIs when you run `setup-catalyst`.
The [setup health check](./setup/) verifies the symlink resolves correctly. To install or
re-install manually:

```bash
bash plugins/dev/scripts/install-cli.sh
```

This creates `~/.catalyst/bin/catalyst-broker` (and sibling CLIs, including the
`catalyst-filter` backward-compat shim). Make sure `~/.catalyst/bin` is on your `PATH`:

```bash
export PATH="$HOME/.catalyst/bin:$PATH"
```

## Starting and Stopping

```bash
catalyst-broker start    # background process, writes ~/catalyst/broker.pid
catalyst-broker stop     # SIGTERM, then SIGKILL after 3 s if still alive
catalyst-broker restart  # stop followed by start
catalyst-broker status   # prints "running (pid N)" or "stopped"
catalyst-broker logs     # tail -f ~/catalyst/broker.log
catalyst-broker run      # foreground mode (useful for debugging)
```

The daemon writes its PID to `~/catalyst/broker.pid` and logs to `~/catalyst/broker.log`.
Logs are emitted as pino-formatted structured JSON lines (CTL-314) — pipe through `pino-pretty`
for human-readable output, or query directly with `jq`. The log level is controlled by the
`LOG_LEVEL` environment variable (see Configuration Reference).
It persists registered interests to `~/catalyst/broker-interests.json` so they survive a
restart. On first start after upgrading from CTL-303, the daemon migrates a legacy
`filter-interests.json` to the new path automatically.

The runtime prefers `bun` and falls back to `node`. Node.js ≥ 21 or Bun is required.

## Credential Setup

The daemon needs a Groq API key to evaluate prose interests. `pr_lifecycle` interests route
deterministically and work without a key.

**Option 1 — environment variable** (simplest):

```bash
export GROQ_API_KEY="gsk_..."
catalyst-broker start
```

**Option 2 — Layer 2 config file** (persists across shells):

```json
// ~/.config/catalyst/config-{projectKey}.json  (never committed)
{
  "groq": {
    "apiKey": "gsk_..."
  }
}
```

The daemon resolves the key in that order: environment variable first, config file second. If
neither is present it logs a warning and continues running — `pr_lifecycle` interests still work.

Get a Groq API key at [console.groq.com](https://console.groq.com).

## Protocol Reference

Interests are registered by writing structured events to the global event log — the same log
that carries GitHub, Linear, and Claude Code events. Any agent that can append to the log (via
`catalyst-state.sh event ...` or by appending JSONL directly) can register an interest.

### Registering an Interest

The `filter.register` event has two forms depending on `interest_type`.

#### pr_lifecycle — deterministic routing

Use this when you need CI, PR merge, review, and BEHIND events for known PR numbers:

```json
{
  "ts": "2026-05-08T07:00:00Z",
  "event": "filter.register",
  "orchestrator": "orch-ctl-api-2026-05-08",
  "worker": null,
  "detail": {
    "interest_id": "sess_20260508_abc123",
    "session_id": "sess_20260508_abc123",
    "interest_type": "pr_lifecycle",
    "notify_event": "filter.wake.sess_20260508_abc123",
    "persistent": true,
    "pr_numbers": [445, 446],
    "repo": "coalesce-labs/catalyst",
    "base_branches": [
      {"pr": 445, "base": "main"},
      {"pr": 446, "base": "main"}
    ]
  }
}
```

`pr_lifecycle` interests produce a wake when:
- A check suite completes on any of the listed PRs
- A PR is merged, closed, or receives a review
- The base branch receives a push (BEHIND state)

No Groq API key is needed for this path.

#### prose — Groq-backed semantic routing

Use this for conditions that don't map to known PR numbers, such as Linear ticket status changes
or comms messages addressed to your orchestrator:

```json
{
  "ts": "2026-05-08T07:00:00Z",
  "event": "filter.register",
  "orchestrator": "orch-ctl-api-2026-05-08",
  "worker": null,
  "detail": {
    "interest_id": "orch-ctl-api-2026-05-08",
    "session_id": "sess_20260508_abc123",
    "notify_event": "filter.wake.orch-ctl-api-2026-05-08",
    "prompt": "Wake me when: any of my workers posts a comms message of type attention to me; or one of my Linear tickets changes status",
    "persistent": true,
    "context": {
      "pr_numbers": [445, 446],
      "tickets": ["CTL-253", "CTL-254"],
      "branches": ["orch-ctl-api-2026-05-08-CTL-253"],
      "workers": ["sess_20260508_abc123"]
    }
  }
}
```

The `context` object is included in the Groq prompt alongside the intent so the LLM knows which
PR numbers and tickets belong to this interest.

#### ticket_lifecycle — deterministic Linear routing

Mirroring `pr_lifecycle` for GitHub PRs, `ticket_lifecycle` is a deterministic interest type for
Linear ticket events. Use it when you want to wake on state changes, comments, or PR links for a
known ticket without paying for a Groq round-trip:

```json
{
  "ts": "2026-05-08T07:00:00Z",
  "event": "filter.register",
  "orchestrator": "orch-ctl-api-2026-05-08",
  "worker": null,
  "detail": {
    "interest_id": "sess_20260508_abc123",
    "session_id": "sess_20260508_abc123",
    "interest_type": "ticket_lifecycle",
    "notify_event": "filter.wake.sess_20260508_abc123",
    "persistent": true,
    "tickets": ["CTL-253"],
    "wake_on": ["status_done", "pr_opened", "pr_merged"]
  }
}
```

Supported `wake_on` values include `status_done`, `status_in_review`, `status_changed`,
`comment_added`, `pr_opened`, and `pr_merged`. Omit `wake_on` to fire on any of them. Like
`pr_lifecycle`, this path requires no Groq API key. See the
[`broker` skill](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/broker/SKILL.md)
for the full agent-facing protocol.

### filter.wake

When the daemon finds a match, it appends a `filter.wake.<id>` event to the log:

```json
{
  "ts": "2026-05-08T07:01:23Z",
  "event": "filter.wake.orch-ctl-api-2026-05-08",
  "orchestrator": "orch-ctl-api-2026-05-08",
  "worker": null,
  "detail": {
    "reason": "PR #445 check suite completed with conclusion 'success'",
    "source_event_ids": ["evt_abc123"],
    "interest_id": "orch-ctl-api-2026-05-08"
  }
}
```

Your `catalyst-events wait-for` call matches on the OTel envelope:

```bash
catalyst-events wait-for \
  --filter ".attributes.\"event.name\" == \"filter.wake\" and \
            .attributes.\"event.label\" == \"${ORCH_ID}\"" \
  --timeout 7200
```

The `reason` field is informational only. After waking, always perform an authoritative REST
check (`gh api repos/{repo}/pulls/{number}`) to confirm the actual PR state before acting.

### filter.deregister

Emit this event when you no longer need the interest (e.g., at workflow exit or after merge):

```json
{
  "ts": "2026-05-08T07:05:00Z",
  "event": "filter.deregister",
  "orchestrator": null,
  "worker": null,
  "detail": {"interest_id": "orch-ctl-api-2026-05-08"}
}
```

The daemon also auto-deregisters interests when:

- `orchestrator-completed` or `orchestrator-failed` events arrive with a matching orchestrator ID
- A `session_id` has not produced a heartbeat for more than 3 minutes (watchdog cleanup)
- `persistent: false` is set and the first wake has fired

## Agent Identity and Auto-Correlation

CTL-303 introduced a structured agent-identity protocol on top of the interest registration above.
Instead of every agent hand-rolling a `filter.register`, agents emit `agent.checkin` at startup
and `agent.checkout` at exit. The broker watches for these events and auto-derives the obvious
interests — most notably a `pr_lifecycle` interest from a `claimed_pr` field.

```json
{
  "ts": "2026-05-08T07:00:00Z",
  "event": "agent.checkin",
  "detail": {
    "session_id": "sess_20260508_abc123",
    "ticket": "CTL-253",
    "orchestrator": "orch-ctl-api-2026-05-08",
    "claimed_pr": 445,
    "repo": "coalesce-labs/catalyst",
    "base_branches": [{"pr": 445, "base": "main"}]
  }
}
```

When the broker sees `claimed_pr` in an `agent.checkin`, it registers a `pr_lifecycle` interest
keyed on `session_id` automatically — the worker can then `wait-for` on
`filter.wake.${session_id}` without ever calling `filter.register` itself.

A second `agent.checkin` for the same `session_id` updates the existing identity (used to claim a
PR after the worker discovers its number). On `agent.checkout` (or after the watchdog declares
the session stale via heartbeat absence), the broker auto-deregisters all interests derived from
that identity.

The agent-facing protocol — recommended emit timing, identity fields, fallback behavior when the
broker is not running — is documented in the [`broker`
skill](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/broker/SKILL.md).

## Writing Effective Intent Prompts

Prose interests are evaluated by `llama-3.1-8b-instant`. Good prompts are specific and
condition-based:

```
# Good — names conditions directly
Wake me when: any of my workers posts a comms message of type attention to me;
or one of my Linear tickets changes status
```

```
# Good — CI and review coverage
Wake me when: CI passes or fails on PR 445; PR 445 receives a review or
changes-requested; I receive a comms message addressed to CTL-253
```

```
# Bad — too vague, produces false positives
Watch for things that might be relevant to my orchestrator
```

```
# Bad — uses raw field names (the LLM knows the event taxonomy, not the JSONL schema)
Match events where detail.prNumbers contains 445
```

Guidelines:
- Keep prompts to 50–100 words
- Register all your conditions in a single `filter.register` call, not multiple
- For PR/CI/review/BEHIND, use `pr_lifecycle` instead — it's more reliable and cheaper
- Prose is best for cross-concern conditions: Linear changes, comms messages, deployment status

## Multi-Tenant Behavior

All active interests from all orchestrators and workers share one daemon process. This has two
implications:

**Single Groq call per batch.** Every batch of incoming events triggers at most one API call,
regardless of how many orchestrators are registered. A 10-orchestrator wave with 30 prose
interests produces the same number of Groq calls as a single orchestrator with 1 prose interest.

**Isolated wakes.** The daemon emits each wake to the `notify_event` stored with that specific
interest. Orchestrator A's wake never fires for orchestrator B's `wait-for`. The `interest_id`
is the routing key — use a value that is globally unique (e.g., `$CATALYST_SESSION_ID`).

Two registrations with the same `interest_id` are treated as an idempotent update — the second
overwrites the first.

## Performance and Cost

| Path | Latency | Groq calls |
|---|---|---|
| `pr_lifecycle` (deterministic) | < 10 ms | 0 |
| Prose (Groq) | ~300–600 ms | 1 per batch (all interests combined) |

The default model `llama-3.1-8b-instant` is Groq's fastest and cheapest tier. At typical
orchestration scale (5–15 workers, one batch every few minutes) the cost is negligible.

To use a different model:

```bash
export FILTER_GROQ_MODEL="llama-3.3-70b-versatile"
catalyst-broker restart
```

## Configuration Reference

All settings are environment variables. They can also be set in your shell profile before
starting the daemon. The `FILTER_*` env-var names are kept from the daemon's pre-broker history
for backward compatibility — the broker reads the same names.

| Variable | Default | Effect |
|---|---|---|
| `GROQ_API_KEY` | — | Groq API key for prose interest evaluation |
| `FILTER_GROQ_MODEL` | `llama-3.1-8b-instant` | Groq model override |
| `FILTER_DEBOUNCE_MS` | `100` | How long to wait for more events before flushing a batch |
| `FILTER_HARD_CAP_MS` | `500` | Maximum batch hold time before forced flush |
| `FILTER_BATCH_SIZE` | `20` | Flush immediately when this many events accumulate |
| `FILTER_WATCHDOG_INTERVAL_MS` | `60000` | How often the watchdog checks for stale sessions |
| `FILTER_HEARTBEAT_STALE_MS` | `180000` | Session idle timeout before interest auto-deregistration |
| `CATALYST_DIR` | `~/catalyst` | Directory for PID file, log, interests file, and SQLite DB |
| `LOG_LEVEL` | `info` | pino log level: `trace` / `debug` / `info` / `warn` / `error` (CTL-314) |

## Relationship to catalyst-events wait-for

`catalyst-broker` is the **preferred path** for event-driven workflows. The direct
`catalyst-events wait-for` pattern with hand-crafted jq predicates remains available as a
fallback when the daemon is not running.

**Before catalyst-broker** (direct pattern, still valid as fallback):

```bash
catalyst-events wait-for \
  --filter "
    (.attributes.\"vcs.pr.number\" == 445 or
     (.body.payload.prNumbers // [] | contains([445]))) and
    (.attributes.\"event.name\" == \"github.pr.merged\" or
     .attributes.\"event.name\" == \"github.check_suite.completed\" or
     (.attributes.\"event.name\" | startswith(\"github.pr_review\")))
  " \
  --timeout 7200
```

**With catalyst-broker** (preferred):

```bash
# After emitting filter.register once, wait on a single narrow filter:
catalyst-events wait-for \
  --filter ".attributes.\"event.name\" == \"filter.wake\" and \
            .attributes.\"event.label\" == \"${SESSION_ID}\"" \
  --timeout 7200
```

The broker-backed approach:
- Is shorter and less error-prone (no event-type enumeration)
- Scales to new event types without changing the wait-for call
- Handles comms messages, Linear events, and deployment status in the same registration
- Degrades gracefully — if the daemon is not running, fall back to the direct pattern

To check whether the daemon is running before deciding which path to use:

```bash
if catalyst-broker status 2>/dev/null | grep -q "^running"; then
  USE_BROKER_DAEMON=true
else
  USE_BROKER_DAEMON=false
fi
```

## Startup Event

On boot the daemon emits a `broker.daemon.startup` event so subscribers can re-register their
interests after a restart. (Releases prior to CTL-315 emitted this event under the legacy name
`filter.daemon.startup`.) Watch for it with:

```bash
catalyst-events wait-for \
  --filter '.attributes."event.name" == "broker.daemon.startup"' \
  --timeout 0
```

## Related

- [Event Architecture](./events/) — the global event log and `catalyst-events` CLI that
  `catalyst-broker` reads and writes.
- [Tail-and-forward (catalyst-otel-forward)](./forwarder/) — sibling daemon that ships canonical
  events to OTLP / PostHog / Cloudflare Analytics Engine.
- [Terminal HUD (catalyst-hud)](./hud/) — Ink TUI for viewing the same event stream.
- [GitHub Webhooks](./webhooks/) — how raw GitHub events enter the event log.
- [Orchestration](../reference/orchestration/) — how orchestrators register prose interests to
  monitor their entire worker wave.
- [Workers](../reference/orchestration/workers/) — how individual workers register `pr_lifecycle`
  interests in the Phase 5 listen loop.

## Source

- CLI: [`plugins/dev/scripts/catalyst-broker`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/scripts/catalyst-broker)
- Daemon: [`plugins/dev/scripts/broker/index.mjs`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/scripts/broker/index.mjs)
- Backward-compat shim: [`plugins/dev/scripts/catalyst-filter`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/scripts/catalyst-filter)
- Skill (agent-facing): [`plugins/dev/skills/broker/SKILL.md`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/broker/SKILL.md)
