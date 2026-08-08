---
title: Rulebook — swim-lane board
status: accepted
ticket: CTL-1328
pr: 2345
---

## Problem

The belief/rule engine ("Reason") was hard to scan as a whole. Operators needed
to see the belief layers at a glance and jump from a rendered rule to its source.

## Outcome

Shipped as the `/rules` swim-lane view (CTL-1328 · #2345): the belief layers
render as a swim-lane board with a click-to-source drawer, making the whole
engine scannable. This mockup is the accepted direction that shipped — the
competing rulebook explorations live under
[`../../draft/governance-rulebook/`](../../draft/governance-rulebook/).

## Mockup

- [`rulebook-swimlane.html`](./rulebook-swimlane.html) — the swim-lane board.
