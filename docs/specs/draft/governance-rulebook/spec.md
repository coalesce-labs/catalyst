---
title: Governance rulebook — direction explorations
status: draft
---

## Problem

How should the belief/rule engine ("Reason") present its rulebook so operators
can read and trust how the daemon reasons? Several directions were mocked before
the `/rules` swim-lane was chosen.

## Approach / options

Competing directions, none of these exact mockups shipped:

- [`rulebook-redesign.html`](./rulebook-redesign.html) — an early redesign of the
  belief-engine rulebook, superseded by the shipped swim-lane.
- [`governance-rulebook-v2-textbook.html`](./governance-rulebook-v2-textbook.html)
  — Direction A, "textbook calm": the rulebook as a calm, readable document.
- [`governance-rulebook-v2-livefeed.html`](./governance-rulebook-v2-livefeed.html)
  — Direction B, "live inference feed": the rulebook as a running feed of
  inferences.
- [`governance-track2-beliefs-view.html`](./governance-track2-beliefs-view.html)
  — a beliefs-centric view of the engine.

## Open questions

The swim-lane board ([accepted](../../accepted/rulebook-swimlane/)) is what
shipped for `/rules`. These remain as reference for future rulebook iterations —
whether any of the "textbook calm" / "live feed" ideas get folded back in is open.
