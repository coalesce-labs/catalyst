---
name: resume-handoff
description:
  "Resume work from a handoff document. **ALWAYS use when** the user says 'resume handoff', 'pick up
  where we left off', 'continue from handoff', or provides a handoff document path. Verifies current
  codebase state against handoff, validates changes, and creates an action plan."
disable-model-invocation: false
allowed-tools: Read, Bash, TodoWrite
version: 1.0.0
---

# Resume work from a handoff document

You are resuming work from a handoff document through an interactive process. Handoffs carry
context, learnings, and next steps from a prior session that need to be understood and continued —
never assume the handoff's state still matches the codebase; verify first.

## Load on demand

| when | read |
| -- | -- |
| finding the handoff to resume from (no path given, path given, ticket given, or the cited path is missing on disk) | [`references/discovery.md`](references/discovery.md) |
| reading the handoff, verifying it against current state, and building the plan | [`references/process.md`](references/process.md) |
| deciding what to do given the codebase's divergence from the handoff | [`references/scenarios.md`](references/scenarios.md) |

## Prerequisites

```bash
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" || exit 1
fi
```

## Configuration note

This skill uses ticket references like `PROJ-123`. Replace `PROJ` with your Linear team's ticket
prefix — read it from `.catalyst/config.json` if available, otherwise use a generic `TICKET-XXX`
form (`ENG-123`, `FEAT-456`).

## Invariants

- **Read the handoff document completely** — no `limit`/`offset` — and read every research or plan
  document it references, before proposing anything.
- **Never use sub-agents to read the handoff itself.** Sub-agents are fine for verifying the
  codebase state it describes ([`references/process.md`](references/process.md)).
- **Get user confirmation** before acting on the analysis, and again before starting implementation.
- **A missing handoff file is not lost work.** The channel/ticket thread is authoritative; recover
  from there rather than re-doing landed work ([`references/discovery.md`](references/discovery.md)).

## CLI tools

To fetch ticket context from Linear (e.g. a ticket referenced in the handoff), use the Linearis
CLI — run `linearis issues usage` or see `/catalyst-dev:linearis` for exact syntax. Do not guess
commands.
