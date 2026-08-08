---
title: Rules Explorer — direction explorations
status: draft
---

## Problem

How should operators explore the execution-core rules — "how the daemon thinks" —
as an interactive surface rather than a static list? Three visual metaphors were
mocked.

## Approach / options

Three competing directions, none confirmed shipped:

- [`rules-explorer-mission-control.html`](./rules-explorer-mission-control.html)
  — "Mission Control": a dashboard/console framing.
- [`rules-explorer-circuit-schematic.html`](./rules-explorer-circuit-schematic.html)
  — "Dataflow Schematic": rules as a circuit / dataflow diagram.
- [`rules-explorer-living-textbook.html`](./rules-explorer-living-textbook.html)
  — "Living Textbook": rules as annotated, readable prose.

## Open questions

Which metaphor (if any) becomes the Rules Explorer surface is undecided. Promote
the chosen one to `accepted/` with a `git mv` once a direction is picked and ships.
