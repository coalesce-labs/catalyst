# Migration record — `mockups/` → `docs/specs/` (CTL-1411)

When the `docs/specs/` convention landed, the existing mockup HTML from repo-root
`mockups/` was migrated here. This file records where each piece went and why, so
the classification is transparent and easy to correct — remember, promotion or
demotion is a single `git mv`.

## Classification rule

- **accepted/** — the mockup's design was already committed to the repo as
  reviewed source, **or** its feature demonstrably shipped (a Done ticket / merged
  PR whose design this mockup represents).
- **draft/** — an exploratory or competing direction with no confirmation it
  shipped.

Where ship-status was uncertain, the call is noted below as **(best-guess)** —
flip it with a `git mv` if you know better.

## What moved

| From `mockups/` | To | Reason |
|---|---|---|
| `catalyst-board.html` | `accepted/board-redesign/` | Tracked deliverable; board UI shipped (web redesign, CTL-996 · #1745) |
| `retheme-board-warm.html` | `accepted/warm-identity/` | Tracked deliverable; warm-textbook identity spike (CTL-1071, Done) |
| `typography-specimen.html` | `accepted/warm-identity/` | Tracked deliverable; type specimen for CTL-1071 |
| `retheme-inbox-warm.html` | `accepted/warm-identity/` | Same CTL-1071 identity spike **(best-guess)** |
| `rulebook-swimlane.html` | `accepted/rulebook-swimlane/` | `/rules` swim-lane shipped (CTL-1328 · #2345) |
| `governance-ticket-journey-tab.html` | `accepted/ticket-journey/` | Ticket-detail / Journey design shipped (CTL-1003, Done) **(best-guess)** |
| `governance-track1-process-view.html` | `accepted/ticket-journey/` | Journey view for CTL-1003 **(best-guess)** |
| `rulebook-redesign.html` | `draft/governance-rulebook/` | Superseded by the shipped swim-lane; exploratory |
| `governance-rulebook-v2-livefeed.html` | `draft/governance-rulebook/` | Competing "live inference feed" direction, not shipped |
| `governance-rulebook-v2-textbook.html` | `draft/governance-rulebook/` | Competing "textbook calm" direction, not shipped |
| `governance-track2-beliefs-view.html` | `draft/governance-rulebook/` | Beliefs-view exploration, not shipped |
| `governance-track1-process-map.html` | `draft/governance-process-map/` | Pipeline-machine exploration, not shipped |
| `rules-explorer-circuit-schematic.html` | `draft/rules-explorer/` | One of three competing rules-explorer directions |
| `rules-explorer-living-textbook.html` | `draft/rules-explorer/` | Competing rules-explorer direction |
| `rules-explorer-mission-control.html` | `draft/rules-explorer/` | Competing rules-explorer direction |

Tracked files (first three) were moved with `git mv` to preserve history. The
rest were previously **untracked** WIP in `mockups/` and are newly committed here.

## `mockups/board-redesign-2026-06-13/` — decision: **discard**

That directory held three screenshots (`img1.png`, `img2.png`, `img3.png`) and
**no spec prose**. Per the "screenshots are not specs" rule, and because the board
redesign already shipped and is documented (CTL-996 · #1745), these screenshots
have no durable value. **Decision: discard** — they were never tracked (matched
`mockups/**/*.png` in `.gitignore`), so this is simply removing the local
directory; nothing leaves git history.

## `mockups/` after this migration

`mockups/` retains only its ephemeral, gitignored screenshots (`mockups/**/*.png`).
All reviewed mockup HTML now lives under `docs/specs/`. New design work should
start under `docs/specs/`, not `mockups/`.
