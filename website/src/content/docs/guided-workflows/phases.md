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
| 5 | **Ship** | `/catalyst-dev:create-pr` → active listen loop | Commits, pushed branch, GitHub PR, merged PR, deleted branch, Linear state=Done | 5–30 min |
| 6 | **Merge** | `/catalyst-dev:merge-pr` | Merged PR, deleted branch, Linear state=Done — *standalone only* | 1–20 min |

## What each phase reads

Each phase reads the previous phase's artifact plus anything it needs from workflow context:

```
Phase 2 (plan)      reads research doc path from workflow context
Phase 3 (implement) reads plan doc path from workflow context
Phase 4 (validate)  reads plan doc + the implementation diff
Phase 5 (ship)      reads everything above to write the PR description, then
                    enters a `catalyst-events wait-for` listen loop (powered by
                    the [`catalyst-broker`](/observability/catalyst-broker/)
                    daemon) — resolves CI failures, bot review threads, and
                    BEHIND inline — executes gh pr merge --squash --delete-branch
                    when CLEAN, writes status: done, and exits
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

| Phase start | Default `stateMap` key | Default state | Fine-grained state (phase-agents, CTL-454) |
|-------------|------------------------|---------------|--------------------------------------------|
| 1 Triage *(phase-agents only)* | `stateMap.triaged` | In Progress | `triaged` (label) |
| 1 Research | `stateMap.research` | In Progress | `researching` |
| 2 Plan | `stateMap.planning` | In Progress | `planning` |
| 3 Implement | `stateMap.inProgress` | In Progress | `inProgress` |
| 4 Verify *(phase-agents only)* | `stateMap.verifying` | In Progress | `verifying` |
| 4 Review *(phase-agents only)* | `stateMap.reviewing` | In Progress | `reviewing` |
| 5 Ship (PR opened) | `stateMap.inReview` | In Review | `inReview` |
| 5 Ship (PR merged) | `stateMap.done` | Done | `done` |
| 6 Merge (standalone only) | `stateMap.done` | Done | `done` |

By default every active-work phase maps to "In Progress" — the broad span is easier to read on Linear timelines and matches the legacy oneshot worker. For finer-grained observability (especially during phase-agents orchestration), define dedicated Linear states and point the `stateMap.*` keys at them — see [Phase agents → Configuration](/reference/orchestration/phase-agents/#configuration) for the schema.

Phase 4 (validate) in the legacy single-session workflow doesn't transition state — it's an internal quality check, not a milestone visible to others. In phase-agents mode, Phase 5 (verify) and Phase 6 (review) each transition state because they're independent sub-agent passes and the orchestrator surfaces them as distinct stages on the Linear ticket.

In phase-agents mode each phase also leaves a **comment trail** on the ticket, not just a state transition: phases 1–6 (triage through review) each mirror their artifact summary back as a Linear comment when they finish (CTL-632), so the ticket reads as a running log of what each phase found and produced. See [Phase agents → Linear comment trail](/reference/orchestration/phase-agents/#linear-comment-trail-ctl-632) for the idempotency and truncation details.

## Phase 6 and oneshot

In `/catalyst-dev:oneshot` and `/catalyst-dev:orchestrate` worker runs, **Phase 6 is folded into Phase 5**. The worker enters an event-driven listen loop immediately after opening the PR, resolves any blockers inline, and executes the merge itself before exiting. There is no separate merge phase.

`/catalyst-dev:merge-pr` remains available as a standalone tool for PRs that were opened outside the oneshot flow — for example, if you ran `/create-pr` manually and stopped there.

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
