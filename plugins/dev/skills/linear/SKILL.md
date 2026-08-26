---
name: linear
description:
  "Manage Linear tickets with workflow automation. **ALWAYS use when** the user says 'create a
  ticket', 'update the ticket', 'move ticket to', 'search Linear', or wants to create tickets from
  thoughts documents, update ticket status, or manage the Linear workflow. Uses Linearis CLI."
disable-model-invocation: false
allowed-tools: Bash(linearis *), Bash(source *), Bash(linear_read_ticket *), Read, Write, Edit, Grep
version: 1.0.0
---

# Linear - Ticket Management

Create tickets from thoughts documents, update existing tickets, and follow the Linearis-CLI workflow.

## REQUIRED: ticket format gate

**Before creating ANY ticket, apply the `/catalyst-dev:gherkin-ticket` standard** — an outcome-first title (`<actor> should <outcome> [so that <benefit>]`, no `[Component]` prefix) and a body leading with a plain-English use case, then tiered Gherkin acceptance criteria. Hard gate: do not draft a title/description without it. Component goes in a label, not the title.

## Reading Linear, and cloud detection

A **single ticket** read goes through the `linearis` skill's ["Reading Linear"](../linearis/SKILL.md#reading-linear) rule and its `linear_read_ticket` helper (source `"${CLAUDE_PLUGIN_ROOT}/scripts/lib/linear-read-replica.sh"`) — do NOT hand-roll a second version. A **scope-wide list/search** (across a project, team, or query) is NOT something that helper does — it covers one ticket at a time — so that stays on the `linearis` CLI directly, same as the `linearis` skill's Core Operations.

Either way, run the **same cloud-detection check** before trusting the replica for anything: confirm `replica_fresh` **and** the `.catalyst/config.json` marker (`plugin_dirs_repo_config_path`). Either failing is a loud, non-silent fallback to direct `linearis`/API reads — the non-fleet path, never an equal alternative; it protects the shared 2500/hr Linear API quota. Writes always go through `linearis`.

## Configuration

Team key/UUID and thoughts-URL come from `.catalyst/config.json`; prerequisites check, the JSON shape, and URL-mapping rules: [`references/setup-and-examples.md`](references/setup-and-examples.md).

## Workflow status

State names come from the `linearis` skill's **single-source** `stateMap` transition table — this skill does not restate it. Commands auto-update status on that table: `/research-codebase` → `stateMap.research`, `/create-plan` → `.planning`, `/implement-plan` → `.inProgress`, `/create-pr` → `.inReview`, `/merge-pr` → `.done`. Skip silently if Linearis is unavailable.

## Action-specific instructions

| action | steps |
| --- | --- |
| Create a ticket from a thoughts doc | [`references/creating-tickets.md`](references/creating-tickets.md) |
| Comment, move through workflow, or search | [`references/moving-and-searching.md`](references/moving-and-searching.md) |
| Full worked example (thought → ticket → plan → implement → PR → merge) | [`references/setup-and-examples.md`](references/setup-and-examples.md) |

## Notes

- **Labels overwrite by default**: `linearis issues update --labels` **replaces** every label on the ticket unless you pass `--label-mode add`. Cross-team same-name label trap: the `linearis` skill's label reference (CTL-1802).
- **CLI required**: Linearis CLI installed and configured with `LINEAR_API_TOKEN`.

For Linearis CLI syntax and the Linear read/cloud-detection rule, see the `linearis` skill (`/catalyst-dev:linearis`) — this skill does not restate either.
