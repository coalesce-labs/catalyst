---
title: Guided Workflows
description: Level 2 — the research → plan → implement → validate → ship pipeline, manual or autonomous.
sidebar:
  order: 0
---

Once you're past running single skills like `/catalyst-dev:research-codebase` or `/catalyst-dev:commit` in isolation, the natural next step is chaining them into a full ticket-to-merge pipeline. Catalyst calls this **Level 2 — Guided Workflows**.

You can run it two ways:

| Mode | Skill | When |
|------|-------|------|
| **Manual, phase by phase** | `/catalyst-dev:research-codebase` → `/catalyst-dev:create-plan` → `/catalyst-dev:implement-plan` → `/catalyst-dev:validate-plan` → `/catalyst-dev:create-pr` → `/catalyst-dev:merge-pr` | You want to review and steer each phase before the next begins |
| **Autonomous single-session** | `/catalyst-dev:oneshot <ticket>` | The ticket is well-scoped and you're OK letting Claude run end-to-end with context isolation between phases |

Both modes share the same artifacts (research docs in `thoughts/shared/research/`, plans in `thoughts/shared/plans/`) and the same Linear state transitions. The only difference is **how much you're in the loop**.

## The pipeline

```
Research  →  Plan  →  Implement  →  Validate  →  Ship  →  Merge
  (doc)    (doc)      (code+tests)   (gates)    (PR)    (branch)
```

Each phase writes an artifact that the next phase reads. If you stop halfway (context exhaustion, need to hand off, want a human to review), the artifacts persist in `thoughts/` and you can resume later in a fresh session.

## Deeper dives

- [Understanding phases](./phases/) — what each phase does, what it writes, and how workflow context tracks the handoff between them
- [Oneshot vs manual](./oneshot-vs-manual/) — concrete guidance on which mode fits which ticket shape
- [Handoffs and resume](./handoffs/) — how to stop midway and pick up later without losing context

## Level 1 vs Level 2 vs Level 3

It helps to know where this sits in the full Catalyst stack:

| Level | What you invoke | What it does |
|-------|-----------------|--------------|
| **Level 1 — Single skills** | `/catalyst-dev:research-codebase` on its own, or `/catalyst-dev:commit` to save work | One focused capability at a time |
| **Level 2 — Guided Workflows** (this section) | `/catalyst-dev:oneshot` or the manual phase chain | Full ticket-to-merged-PR pipeline, one ticket at a time |
| **Level 3 — Orchestration** | `/catalyst-dev:orchestrate` | Many Level 2 workers in parallel, coordinated across git worktrees |

Level 2 is usually where people settle. Level 3 is for when you have **multiple independent tickets** ready to go simultaneously — if you don't, you don't need it.

## When to stay at Level 2

- The ticket has some ambiguity and you want to steer the plan before committing to it
- You're still learning what Catalyst does (manual phase mode shows you every artifact)
- You'd rather review one PR per sitting than manage three parallel workers
- You want to use `/catalyst-dev:oneshot` but don't want orchestrator infrastructure (signal files, worktrees, monitor)

## When to graduate to Level 3

- You have 3+ independent, well-scoped tickets ready at once
- You're tired of sequential ticket work and want parallel execution
- You want adversarial verification between workers (Level 3 adds this automatically)
- You're running in an environment where observability matters (dashboards, event streams)

See the [Orchestration reference](/reference/orchestration/) for Level 3 details.
