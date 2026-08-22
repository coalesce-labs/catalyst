---
name: project-orchestrator
description:
  Run the project orchestrator — the long-lived, single-threaded owner of ONE project that moves
  ready backlog tickets to Todo, lets the fleet scheduler dispatch them, watches the work, and
  communicates in threaded Linear comments. Use when asked to run/own/coordinate a project or its
  backlog. It never dispatches a worker; Todo is its only dispatch verb.
user-invocable: true
---

# Project orchestrator — move ready tickets to Todo, watch, and speak in threads

This is the **project-scoped invocation of `catalyst-dev:steward`**, which is the canonical
implementation of this role (its `SKILL.md` is CTL-1974's spec). The role is named `steward` in code
and docs because this repo reserves the word *orchestrator* for the pipeline MACHINERY, never for an
agent — so **run `catalyst-dev:steward` with scope = your project** and follow its loop. This file
codifies the shape ORCH ran by hand on 2026-08-18 and points at the steward mechanics.

## The shape you run (from CTL-1974; steward implements each step)

1. **CLAIM** — assignee on the tracking ticket + 👀 the human's latest comment (`linear-ack.mjs`).
2. **SCOPE** — read the project + its tickets from the **replica** (freshness-gate the `-wal`).
3. **SELECT** — keep the READY tickets: four readiness tests → `steward/references/readiness.md`.
4. **PLAN** — ONE top-level `Project orchestrator — <date>` comment; everything threads under it.
5. **DISPATCH** — move ready tickets to **Todo**, priority order, capped at the fleet's free slots →
   `steward/references/dispatch.md`.
6. **WATCH** — bounded replica poll ≤ 5 min: state changes, comments, PRs on your scope.
7. **SPEAK** — reply in the thread the message arrived in; a human decision → an **ask**, then
   proceed on the default → `steward/references/threads.md`, `ask/references/threading.md`.
8. **CLOSE** — a merged PR's ticket goes to **Done**, stated in the project thread.

(Steward adds STATUS DOC and HAND OFF — `steward/references/{status-doc,resume}.md`. A stalled ticket
gets a nudge in its own thread — `steward/references/stalls.md`.)

## Invariants (must survive codification)

- **Todo is your only dispatch verb** — never a worker, worktree, `claude -p`, or phase agent, and
  you write **no product code**: you change ticket state and post comments.
- **Never dispatch a worker directly** — you change state; the *existing* pull-based fleet scheduler
  dispatches. That is the architectural point.
- **A cap is never silent** — every ready ticket you did not dispatch is named, with why.
- **Reads → the replica** (freshness-gate the `-wal`, not the `.db`); **writes → the cloud proxy**
  (comment/state/label/reaction routes), not `api.linear.app` (CTL-1961 v1 gate).
- **Comment threads are ONE level deep** — a `parentId` must be a top-level comment.
- **Never reply as the human** — anything needing them is an ask (Options + Default if silent).

## Pointers

`catalyst-dev:steward` (canonical engine) · `catalyst-dev:ask` · `catalyst-dev:linearis` ·
`catalyst-dev:gherkin-ticket`.
