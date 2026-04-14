---
title: Oneshot vs manual
description: When to let /catalyst-dev:oneshot run the full pipeline and when to steer phase-by-phase.
sidebar:
  order: 2
---

Both modes produce the same artifacts and end state. The real difference is **where you spend your attention** — upfront (writing a precise ticket and trusting oneshot) vs distributed across phases (steering each one in real time).

## The quick decision

**Use `/catalyst-dev:oneshot` when:**

- The ticket description reads like a crisp spec (clear acceptance criteria, scoped)
- You've done similar work before in this repo — you trust the planning instincts
- The codebase has well-established patterns the plan will likely follow
- You want context isolation (large refactors that would blow a single session's context)
- You're dispatching it from an orchestrator (Level 3) and can't steer anyway

**Use manual phase-by-phase when:**

- The ticket is vague or has multiple viable approaches — the plan needs human calibration
- You're doing something novel and want to review each artifact before committing
- You're new to the codebase and want to see the research findings before the plan locks in
- The implementation will touch sensitive systems (auth, billing, migrations) and you want to review the plan before code is written
- You're teaching the model patterns specific to this repo — manual mode gives you editing opportunities between phases

## Ticket shape rubric

Look at your ticket. If all of these are true, oneshot is a safe default:

| Criterion | Good for oneshot | Needs manual |
|-----------|------------------|--------------|
| Acceptance criteria | Bulleted, testable | Prose, vague |
| Scope | Single feature or area | Cross-cutting or "also cleanup while you're there" |
| Architecture decisions | Already made or implied by existing patterns | Open — "figure out how to do X" |
| Dependencies on other work | None or clearly listed | "Blocked by Y" language |
| Test strategy | Implied by existing test suite | Ambiguous |

For tickets where 2+ rows lean toward "needs manual," start manual and you can switch to oneshot from the plan phase if it turns out simpler than expected.

## A middle option: manual until plan, then oneshot

A pattern that works well:

```
You:    /catalyst-dev:research-codebase "how does auth work"
        → review the research doc, ask follow-up questions
You:    /catalyst-dev:create-plan
        → iterate the plan interactively until you're happy
You:    /catalyst-dev:oneshot CTL-42 --skip-research --skip-plan
        → lets oneshot handle implement→validate→ship→merge autonomously
```

(`--skip-research` / `--skip-plan` flags use the most recent artifacts in the workflow context, so they need to exist first.)

This gives you control over the two judgment-heavy phases and autonomy on the four mechanical phases.

## What oneshot does that manual doesn't

- **Context isolation** — each phase launches a fresh `claude` session, so context doesn't compound
- **Automatic handoffs** — if any phase fails, oneshot writes a handoff doc you can resume from
- **Quality gates wired in** — validation phase runs config-driven gates (typecheck, lint, test, build) and retries with auto-fix
- **Auto-merge arming** — Phase 5 arms `gh pr merge --squash --auto` so the PR merges itself when CI passes

You can replicate all of this manually, but it's ~12 commands vs 1.

## What manual gives you that oneshot doesn't

- **Real-time steering** — you see the research before the plan is written, and the plan before code
- **Natural stopping points** — every phase boundary is a clean place to call it a day
- **Smaller blast radius** — if you notice something's off, you've only spent one phase of tokens
- **Better for learning** — every artifact is visible in `thoughts/` so you can study what Catalyst actually does

## Oneshot flags that matter

| Flag | Effect |
|------|--------|
| `--auto-merge` | Arm `gh pr merge --squash --auto` at Phase 5 exit |
| `--no-merge` | Stop after PR creation (don't arm auto-merge or wait for merge) |
| `--team` | Phase 3 runs as a multi-agent team (see [Agent Teams](/reference/agents/#agent-teams)) |
| `--skip-validation` | Skip Phase 4 entirely (not recommended unless you're ironically just adding docs) |
| `--skip-quality-gates` | Run `/catalyst-dev:validate-plan` but skip the config-driven gate loop |
| `--no-ticket` | Freeform mode — don't auto-create a Linear ticket from the research findings |

Full reference in [the oneshot skill docs](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/oneshot/SKILL.md).

## A note on cost

Oneshot runs four separate Opus sessions + one Sonnet session. A medium-complexity ticket usually lands $3–$10 in API costs. Manual mode is cheaper per ticket (one session, no context isolation overhead) but you pay with your own time. If you'd rather spend $5 than 90 minutes on a well-scoped ticket, oneshot is the right call.
