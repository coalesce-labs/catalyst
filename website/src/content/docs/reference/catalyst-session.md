---
title: catalyst-session
description: SQLite-backed session lifecycle CLI for tracking skill runs, phase transitions, tool usage, and PR outcomes.
sidebar:
  order: 8
---

`catalyst-session` is the lifecycle tracking CLI for Catalyst agent sessions. It persists session
state to `~/catalyst/catalyst.db` (SQLite) and dual-writes a JSONL event line to
`~/catalyst/events/YYYY-MM.jsonl` for downstream tooling.

Skills call it at start, at each phase transition, and at completion. The orchestrator propagates
`CATALYST_SESSION_ID` to workers so their sessions are linked to the orchestration run.

## Subcommands

| Subcommand | Arguments | Description |
|------------|-----------|-------------|
| `start` | `--skill NAME [--ticket K] [--label L] [--workflow W]` | Create a new session. Prints the generated session ID to stdout. |
| `phase` | `<session-id> <status> [--phase N]` | Record a status/phase transition. Emits `phase-changed` event. |
| `metric` | `<session-id> [--cost USD] [--input N] [--output N] [--cache-read N] [--cache-creation N] [--duration-ms N]` | Update cost/token counters. |
| `tool` | `<session-id> <tool-name> [--duration MS]` | Increment tool usage histogram. |
| `iteration` | `<session-id> --kind plan\|fix [--by N]` | Increment plan-replan or implement-fix iteration counter. |
| `pr` | `<session-id> --number N --url URL [--ci STATUS]` | Record PR creation. Emits `pr-opened` event. |
| `end` | `<session-id> [--status done\|failed] [--reason TEXT]` | Mark session complete. Emits `session-ended` event and a `claude_code.session.outcome` OTLP metric. |
| `heartbeat` | `<session-id>` | Bump `updated_at` and emit a heartbeat event to the JSONL log. |
| `list` | `[--active] [--skill NAME] [--ticket KEY] [--limit N]` | List sessions as JSON. |
| `read` | `<session-id>` | Print full session state (session + metrics + tools + events + PRs). |
| `history` | `[--skill NAME] [--ticket KEY] [--since DATE] [--limit N]` | List past sessions. Defaults to limit 20. |
| `stats` | `[--skill NAME] [--since DATE]` | Aggregate statistics: avg cost, duration, success rate, skill breakdown. |
| `compare` | `<session-id-1> <session-id-2>` | Side-by-side comparison of two sessions. |
| `status` | `[--json]` | Unified view of all active sessions with PID liveness checks. |
| `restart` | `[--exec] [--all \| <session-id>...]` | Find crashed sessions and offer resume commands. |

## CATALYST_SESSION_ID

The `start` subcommand prints a session ID to stdout; the caller captures it and exports it:

```bash
CATALYST_SESSION_ID=$(catalyst-session start --skill "implement-plan" --ticket "CTL-48")
export CATALYST_SESSION_ID
```

When the orchestrator dispatches workers, it sets `CATALYST_SESSION_ID` in the worker's
environment so workers can reference the same session ID without re-running `start`. Skills
check for this env var at startup and skip `start` if already set.

## Database Tables

All session data lives in `~/catalyst/catalyst.db`:

| Table | Contents |
|-------|---------|
| `sessions` | One row per session: id, skill, ticket, status, started/ended timestamps, label |
| `session_metrics` | Cost and token counters per session |
| `session_tools` | Tool usage histogram (tool name → call count + total ms) |
| `session_events` | Phase transitions and heartbeats with timestamps |
| `session_prs` | PR numbers, URLs, and CI status for PRs opened in a session |

## OTLP Emission

On `end`, catalyst-session emits two OTLP payloads (when an OTLP endpoint is configured):

- **`claude_code.session.outcome`** log — carries `outcome`, `session_id`, `linear.key`, optional
  `reason`. Used for Loki queries and alerting on failure rates (CTL-157).
- **`claude_code.session.iterations`** metric — flushes the plan-replan and implement-fix
  iteration counters accumulated during the session (CTL-158).

## Typical Usage in Skills

The canonical pattern used by all workflow skills:

```bash
SESSION_SCRIPT="plugins/dev/scripts/catalyst-session.sh"

# At skill start
CATALYST_SESSION_ID=$("$SESSION_SCRIPT" start --skill "implement-plan" \
  --ticket "${TICKET_ID:-}" \
  --workflow "${CATALYST_SESSION_ID:-}")
export CATALYST_SESSION_ID

# At each phase transition
"$SESSION_SCRIPT" phase "$CATALYST_SESSION_ID" "implementing" --phase 3

# At skill end
"$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status done
```

Skills wrap this in an `if [[ -x "$SESSION_SCRIPT" ]]` guard so they degrade gracefully when the
script is unavailable (e.g., in CI environments without the dev plugin installed).

## Related

- [Agent Communication (catalyst-comms)](./catalyst-comms/) — sibling CLI for cross-agent messaging
- [Setup Health Check](./setup-health-check/) — verifies the session database schema and WAL mode
- [Observability Events](../observability/events/) — the JSONL event log catalyst-session writes to
