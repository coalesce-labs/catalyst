---
title: Handoffs and resume
description: How to stop mid-workflow and pick up later without losing context.
sidebar:
  order: 3
---

Handoffs are Catalyst's answer to the two most common interruptions in AI-assisted development:

1. You need to stop mid-ticket and come back later
2. Context usage is about to exceed your session's budget

Both are solved by writing a **handoff document** — a structured snapshot of what's done, what's next, and any decisions made — and resuming from it in a fresh session.

## When to write a handoff

Trigger a handoff before any of these:

- **End of day / end of pairing session** — preserves state cleanly
- **Context usage above ~60%** — `/context` shows your current usage; above 60% and you risk truncation mid-phase
- **Phase completed, phase N+1 is someone else's turn** — hand off to a reviewer or another worker
- **You need to escalate a decision** — handoff doc makes the open question visible
- **Unexpected error / confusion** — capture what went wrong so the resumer doesn't repeat it

## Writing one

```bash
/catalyst-dev:create-handoff
```

This skill:

1. Reads `.catalyst/.workflow-context.json` to find the current ticket and phase
2. Scans `thoughts/shared/research/` and `thoughts/shared/plans/` for the current ticket's artifacts
3. Reads git status / git log to capture uncommitted work and recent commits
4. Reads recent Linear comments on the ticket
5. Asks you (briefly) what decisions you want to preserve and what the next session should prioritize
6. Writes a handoff at `thoughts/shared/handoffs/YYYY-MM-DD-{ticket}-{desc}.md`
7. Syncs thoughts (if HumanLayer is installed)

The handoff doc has a stable structure:

```markdown
## Current state
- Ticket: CTL-48 — Documentation audit & restructure
- Phase: implement (3 of 6)
- Worktree: agent-obs-CTL-48 (agent-obs-CTL-48 branch)
- Uncommitted changes: yes — 14 files modified

## What's done
- Phase 1 research: thoughts/shared/research/2026-04-14-CTL-48-audit.md
- Phase 2 plan: thoughts/shared/plans/2026-04-14-CTL-48-audit.md
- Phase 3 implementation: 60% (sections 1-4 of plan complete, section 5 in progress)

## What's next
- Complete section 5 of plan (plugin README regeneration)
- Phase 4 validation + quality gates
- Phase 5 ship

## Open questions
- Should the orch-monitor section go under reference/ or get its own top-level Observability section? (decided: Observability section — see PR description)

## Important decisions made
- Keep the existing orchestration.md as overview; add focused subarticles under reference/orchestration/
- Sidebar uses Starlight autogenerate — new sections are automatic via directory placement
```

## Resuming

In a fresh session, in the same worktree (or any worktree with the thoughts repo synced):

```bash
/catalyst-dev:resume-handoff
```

The resume skill:

1. Looks for the most recent handoff in `thoughts/shared/handoffs/`
2. Verifies the codebase state matches (uncommitted changes still present? Branch matches?)
3. Reads the handoff + workflow context + recent artifacts
4. Produces an **action plan** — ordered list of what to do next
5. Waits for you to confirm before continuing

If the codebase state diverged (someone else pushed, you rebased, etc.), the resume skill surfaces the divergence instead of plowing ahead — you decide how to reconcile.

## What handoffs are NOT for

- **Not a replacement for commits** — commit working code before handoff; handoffs describe intent and state, not a substitute for a clean git history
- **Not version control** — if you want to preserve a specific revision of a plan, save it to `thoughts/shared/plans/` explicitly; handoffs are ephemeral
- **Not a log** — a handoff is a snapshot, not a tail of every action taken. Use the `/cost` command and git log for action logs.

## Autonomous handoffs

When `/catalyst-dev:oneshot` encounters an unrecoverable error at any phase, it writes a handoff automatically before exiting. Common triggers:

- Quality gates failed after max retries
- Implementation phase hit an API quota limit
- Context exhaustion despite per-phase isolation (rare)

The autonomous handoff includes everything a manual one would, plus the full error context. Resume it the same way: `/catalyst-dev:resume-handoff`.

## Handoff + orchestration

Under an orchestrator, workers that get stuck still write handoffs to the same `thoughts/shared/handoffs/` location. The orchestrator's attention system surfaces them in the dashboard so you can see "CTL-48 wrote a handoff at 19:15 — needs human decision." Picking up a handed-off worker is manual: read the handoff, decide what to do, optionally re-dispatch with updated instructions.
