---
title: Your First Workflow
description: Walk through the research, plan, implement, and validate cycle.
---

Catalyst provides a structured development workflow that chains together: **research, plan, implement, validate, and ship**. Each phase produces a persistent artifact that feeds into the next.

## The Core Workflow

```
/research-codebase → /create-plan → /implement-plan → /validate-plan → /create-pr
```

## 1. Research Phase

Start by understanding the codebase:

```
/research-codebase
```

Follow the prompts to describe what you want to research. Catalyst will:

- Spawn parallel research agents (locator, analyzer, pattern-finder)
- Document what exists in the codebase (not critique it)
- Save findings to `thoughts/shared/research/`

## 2. Planning Phase

Create an implementation plan from your research:

```
/create-plan
```

Catalyst auto-discovers your most recent research and:

- Reads research documents
- Interactively builds a plan with you
- Includes automated AND manual success criteria
- Saves to `thoughts/shared/plans/YYYY-MM-DD-TICKET-description.md`

If revisions are needed before implementation:

```
/iterate-plan
```

## 3. Implementation Phase

Execute the approved plan:

```
/implement-plan
```

Omit the path — Catalyst auto-finds your most recent plan. It will:

- Read the plan fully
- Implement each phase sequentially
- Run automated verification after each phase
- Update checkboxes as work completes

## 4. Validation Phase

Verify the implementation:

```
/validate-plan
```

Catalyst will:

- Verify all success criteria
- Run automated test suites
- Document any deviations
- Provide a manual testing checklist

## 5. Ship It

Create a PR:

```
/create-pr
```

This automatically creates a pull request with a comprehensive description generated from your research and plan.

## One-Shot Alternative

For straightforward tasks, chain the entire workflow:

```
/oneshot PROJ-123
```

This runs research, planning, and implementation in a single invocation with context isolation between phases.

## Context Persistence

Save context between sessions with handoffs:

```bash
# Save context at any point
/create-handoff

# Resume in a new session
/resume-handoff
```

## Workflow Auto-Discovery

Catalyst tracks your workflow via `.claude/.workflow-context.json`:

- `/research-codebase` saves research — `/create-plan` auto-references it
- `/create-plan` saves plan — `/implement-plan` auto-finds it
- `/create-handoff` saves handoff — `/resume-handoff` auto-finds it

You don't need to specify file paths — commands remember your work.
