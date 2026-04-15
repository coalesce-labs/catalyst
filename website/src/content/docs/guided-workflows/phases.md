---
title: Understanding phases
description: What each phase does, what it writes, and how workflow context tracks the handoff between them.
sidebar:
  order: 1
---

The guided workflow has six phases. Each one does something discrete, writes an artifact, and hands off to the next phase via the **workflow context file** at `.catalyst/.workflow-context.json`. This page explains each phase and how they connect.

## The phases

| # | Phase | Skill | Writes | Typical duration |
|---|-------|-------|--------|------------------|
| 1 | **Research** | `/catalyst-dev:research-codebase` | `thoughts/shared/research/YYYY-MM-DD-{ticket}-{desc}.md` | 5–15 min |
| 2 | **Plan** | `/catalyst-dev:create-plan` | `thoughts/shared/plans/YYYY-MM-DD-{ticket}-{desc}.md` | 5–20 min (interactive) |
| 3 | **Implement** | `/catalyst-dev:implement-plan` | Code changes + tests (not committed yet) | 10–90 min |
| 4 | **Validate** | `/catalyst-dev:validate-plan` | Validation report + quality-gate output | 2–10 min |
| 5 | **Ship** | `/catalyst-dev:create-pr` | Commits, pushed branch, GitHub PR | 2–5 min |
| 6 | **Merge** | `/catalyst-dev:merge-pr` | Merged PR, deleted branch, Linear state=Done | 1–20 min (waits for CI) |

## What each phase reads

Each phase reads the previous phase's artifact plus anything it needs from workflow context:

```
Phase 2 (plan)      reads research doc path from workflow context
Phase 3 (implement) reads plan doc path from workflow context
Phase 4 (validate)  reads plan doc + the implementation diff
Phase 5 (ship)      reads everything above to write the PR description
Phase 6 (merge)     reads the PR number and waits for CI
```

This is why "the thoughts/ directory is the handoff mechanism" — artifacts live there so **any future session**, not just this one, can pick up where the current one left off.

## Workflow context

`.catalyst/.workflow-context.json` tracks the cross-phase state. A representative file:

```json
{
  "currentTicket": "CTL-48",
  "orchestration": null,
  "recent": {
    "research": [
      "thoughts/shared/research/2026-04-14-CTL-48-documentation-audit.md"
    ],
    "plan": [
      "thoughts/shared/plans/2026-04-14-CTL-48-documentation-audit.md"
    ]
  },
  "updatedAt": "2026-04-14T19:15:32Z"
}
```

The workflow-context script at `plugins/dev/scripts/workflow-context.sh` is the only writer. Skills call it to register their outputs; subsequent skills call it to discover what to read.

Three commands you might run directly:

```bash
# Set the current ticket (done automatically by /research-codebase et al)
plugins/dev/scripts/workflow-context.sh set-ticket CTL-48

# Print the most recent research doc
plugins/dev/scripts/workflow-context.sh recent research

# Print a full JSON dump
plugins/dev/scripts/workflow-context.sh dump
```

## Phase transitions and Linear state

If the current ticket is linked, each phase transitions it through Linear states using the `stateMap` from `.catalyst/config.json`:

| Phase start | Default state |
|-------------|---------------|
| 1 Research | In Progress |
| 2 Plan | In Progress |
| 3 Implement | In Progress |
| 5 Ship | In Review |
| 6 Merge | Done |

Phase 4 (validate) doesn't transition state — it's an internal quality check, not a milestone visible to others. Phases 1–3 stay in the same state by default because "In Progress" already covers the whole active-work span; override `stateMap.research`, `stateMap.planning`, and `stateMap.inProgress` in config if you want finer granularity.

## Stopping mid-workflow

You can stop at any phase boundary. The pattern:

1. Run the skill(s) you want
2. When you stop, run `/catalyst-dev:create-handoff` — this writes a handoff doc that captures what's done, what's next, and any decisions
3. In a future session, run `/catalyst-dev:resume-handoff` — it reads the latest handoff and the workflow context, and picks up where you left off

See [Handoffs and resume](../handoffs/) for the full pattern.

## What happens in team mode

Phase 3 supports `--team` to parallelize across multiple Claude Code instances. In team mode:

- A **lead agent** (Opus) coordinates and owns the plan
- **Teammates** (Sonnet) each take a file group (e.g., frontend, backend, tests)
- Each teammate can spawn its own research sub-agents
- The lead reviews their work at plan-approval gates

Team mode is worth it when the plan has 3+ clearly-independent file groups. For simpler plans, the coordination overhead usually isn't worth it.

```bash
/catalyst-dev:implement-plan --team
/catalyst-dev:oneshot --team CTL-48
```

Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. See [Agent Teams](/reference/agents/#agent-teams) for details.

## Phase isolation in oneshot

`/catalyst-dev:oneshot` runs all phases sequentially in a single session. Claude's automatic context compaction handles long-running workflows by compressing earlier messages as the conversation approaches context limits. Each phase writes its output to `thoughts/shared/` (research documents, plans), and subsequent phases read those files — so the essential information survives compaction naturally.

For complex phases, oneshot can spawn agent teams (subagents with their own context windows) to do parallel work, keeping the main session's context lean. This approach is simpler and more observable than forking separate processes.
