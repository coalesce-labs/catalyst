---
name: briefing-followup
description:
  Interactive walk-through of today's morning briefing. Loads the briefing markdown at
  thoughts/briefings/YYYY-MM-DD.md (built by morning-briefing), parses its decisions block, and
  walks the user through each open decision — approve / reject / defer, schedule a calendar
  entry, file a Linear ticket, launch a relay-ticket session, draft an email, resolve ADR drift,
  or apply/edit/defer/reject a compound-engineering ADR proposal — then writes resolutions back
  to the briefing markdown. Use after /catalyst-dev:morning-briefing has produced today's
  briefing, or whenever the user says "walk the briefing" / "follow up on the briefing".
disable-model-invocation: true
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Task, mcp__*
---

# Briefing Follow-up — walk today's agenda

Invoke as `/catalyst-dev:briefing-followup` after `/catalyst-dev:morning-briefing` has produced
today's briefing. Reads its `decisions:` block, presents each open decision, and records what the
user chose.

## Flags

| Flag | Meaning |
|---|---|
| `--date YYYY-MM-DD` | Target briefing date. Default: today (UTC). |
| `--file PATH` | Override path resolution entirely (test/dev usage). |
| `--status STATUS` | Decision-status filter: `open` (default) or `all`. |

## Load on demand

| when | read |
| -- | -- |
| starting the session, loading + presenting the briefing, ending the session | `references/session.md` |
| the user picks an action for a decision | `references/actions.md` |
| the decision carries a `pending:` path (a compound-engineering ADR proposal) | `references/actions.md` (compound section) |
| writing resolutions back to the briefing markdown | `references/writeback.md` |
| this host might have no cloud mirror, or a replica read looks stale | `steward/references/cloud-detection.md` (canonical) |

## Loop

1. **Prelude** — start a session, resolve `$BRIEFING_PATH`, load and validate its frontmatter (`references/session.md`).
2. **Present the agenda** — a numbered list of open decisions.
3. **Per decision** — show its fields, offer the action set for its type, run the chosen handler, capture its JSON, log it (`references/actions.md`).
4. **Write back** — persist resolutions into the briefing's `resolutions:` block (`references/writeback.md`).
5. **End the session.**

## Invariants

- **Dispatching work means launching `/relay-ticket <TICKET>`** — never the legacy orchestrator or any retired background-dispatch path (CTL-2218). See `references/actions.md`.
- **`action-compound.sh --mode apply|edit` is the only writer of `docs/adrs.md`** — the `ticket-compound` curator only ever proposes.
- Every action handler soft-skips cleanly (`{"status":"skipped","reason":"..."}`) rather than failing the whole walk-through; a soft-skip is still logged.
- Reads of a single Linear ticket go through the replica-gated helper, never a bare `linearis issues read` (cloud-detection reference).

## Output contract

- **Input**: `thoughts/briefings/YYYY-MM-DD.md`, produced by `morning-briefing`, validated against `plugins/dev/templates/briefing-frontmatter.schema.json`.
- **Scratch log**: `${TMPDIR:-/tmp}/catalyst-briefing-followup/<date>.log`, one TSV line per resolved decision.
- **Resolutions JSON**: `<log-dir>/briefing-followup-<date>-resolutions.json`, one entry per action-handler invocation — `{decision_id, action, timestamp, result}`. Consumed by the write-back step.

## Pointers

`catalyst-dev:morning-briefing` (produces the input) · `catalyst-dev:linearis` · `relay-ticket` (the session this skill's dispatch action launches) · `steward` (the dispatch model this skill routes to).
