# Catalyst Brand V2 — Direction Pick

> Research artifact pointer. Full brief + direction explorations + scorecard live in the
> HumanLayer-managed `thoughts/` tree (not checked into this repo). This file carries the
> decision summary into the code repo so downstream tickets have a committable reference.
>
> Source ticket: **CTL-146** — `research(meta): Catalyst Brand V2 design brief + direction exploration`.

---

## Decision

**Direction 1 — Ignition Chevron.**

- **Through-line:** accelerant (upward kinetic vector)
- **Mark (detailed, ≥ 48 px):** stacked double-chevron, 8 bezier segments, `currentColor` stroke
- **Mark (simplified, ≤ 32 px):** single chevron, 3 points, sub-8 bezier per R1
- **Wordmark reference:** Space Grotesk Medium (500), uppercase, tracked -0.01em, custom terminals
- **Lockup gap:** 0.5 × mark height

Scorecard weighted total: **82/100** (vs. D2 Ring: 78, D3 Spark Node: 74, D4 Typographic First: 62).

The unique argument for D1 is that it is the only direction scoring 4+ on both legibility
at 16 px AND character simultaneously. It is also the cheapest to produce (~6 h) and the
only direction with balanced typography pairing across both UX systems (A and B).

## Trade-offs accepted

1. **D3 (Spark Node) is conceptually sharper** — it actually depicts the parallel-agent
   product primitive. D1 trades that conceptual precision for legibility at 16 px (hard
   requirement) and cross-system pairing flexibility.
2. **D2 (Catalyst Ring) is more on-name** — catalyst is literally chemistry. D1 wins on
   cost and System-A compatibility; D2 remains a strong System-B-only fallback.
3. **D1 shares a straight-edge geometric family with Adva.** Mitigation: the wordmark must
   commit to uppercase + custom terminals (not Adva's lowercase tracked 0.02em recipe).
   CTL-WORDMARK-LOCKUP owns this guardrail.

## Full research artifacts

Reachable only via HumanLayer thoughts sync. Paths reference the
`catalyst-workspace` thoughts repo:

- `thoughts/shared/product/brand/2026-04-22-catalyst-brand-v2-brief.md` —
  formal V2 brief, normative constraints (R1–R10, G1–G3)
- `thoughts/shared/product/brand/explorations/direction-1-ignition-chevron.md` — **winner**
- `thoughts/shared/product/brand/explorations/direction-2-catalyst-ring.md`
- `thoughts/shared/product/brand/explorations/direction-3-spark-node.md`
- `thoughts/shared/product/brand/explorations/direction-4-typographic-first.md`
- `thoughts/shared/product/brand/2026-04-22-catalyst-brand-v2-scorecard.md` —
  scorecard + recommendation

Predecessor audit that seeded the brief:

- `thoughts/shared/product/ux-refresh/logo-audit-2026-04-21.md` (CTL-124)

## Hard requirements inherited by follow-on tickets

All brand-V2 assets MUST:

- **R1.** Survive a 16 px favicon render via the simplified variant (≤ 8 beziers total).
- **R2.** Stay under 24 bezier segments in the detailed variant.
- **R3.** Use `fill="currentColor"` or `stroke="currentColor"` throughout — no hex literals
  in brand SVGs. Rasterizations (favicon.ico, OG cards) bake in the system accent at export.
- **R4.** Ship two separate SVG files: `mark.svg` and `mark-small.svg`.
- **R5.** Defend one conceptual through-line. For Direction 1: **accelerant** (upward kinetic vector).
- **R6.** Path-based wordmark (not system-font text elements).
- **R7.** Wordmark pairs cleanly with both Space Grotesk (System A) and GT Super (System B).
- **R8.** Single-color by default; duotone is opt-in.
- **R9.** Four lockups: horizontal (primary), stacked (compact), mark-only, wordmark-only.
- **R10.** Monochrome variants pass legibility on both `#0B0D10` and `#FAFAF7`.

Adva guardrails (all three must clear, none alone is a veto):

- **G1.** No steel blue (`#7AA7D9` family) as primary accent.
- **G2.** No single-angular-A glyph (wedge + slash).
- **G3.** No lowercase Space Grotesk Medium tracked 0.02em at 16–20 px for the wordmark.

## Follow-on tickets

| Ticket | Build | Direction-1 shape |
|---|---|---|
| **CTL-147** — mark redraw | `mark.svg` + `mark-small.svg`, currentColor refactor, retire the three duplicate V1 SVG files | Stacked double-chevron (detailed) + single chevron (simplified); outer chevron stroke, inner inset 18% |
| **CTL-WORDMARK-LOCKUP** | drawn wordmark + horizontal + stacked lockup | CATALYST uppercase, Space Grotesk skeleton with custom terminals, tracked -0.01em, optical weight 500; gap = 0.5 × mark height |
| **CTL-FAVICON-SET** | 16/32 raster, .ico with 16 slot, apple-touch, 192, 512, safari-pinned-tab | Auto-raster from `mark-small.svg` survives at 16 px (unlike D3/D4 which would require hand-drawn pixel versions) |
| **CTL-OG-CARD** | 1200 × 630 with lockup + tagline | Horizontal lockup on dark (System A) / ivory (System B); tagline in pairing body face |
| **CTL-MONOCHROME-README-HERO** | monochrome variants, README hero, Coalesce Labs avatar audit | Inherent — D1 is already stroke-based currentColor; no extra work for monochrome variants |

## Typography pairing contingency

The final wordmark execution depends on which UX system lands (System A or System B).
Both are scored in the direction file; the chosen direction (D1) works in either.

- **System A lands** → use Space Grotesk skeleton with custom terminals as drafted.
- **System B lands** → redraw the wordmark from a GT Super Display skeleton; keep uppercase and -0.01em tracking. The chevron mark is system-independent.
- **Undecided at start of CTL-WORDMARK-LOCKUP** → start with System A (current default across
  orch-monitor and docs surfaces); plan a second draft if B lands.

## Non-goals (still)

From the brief, unchanged by the direction pick:

- No animated logo.
- No non-English wordmarks.
- No merchandise or conference-badge assets.
- No re-brand of the parent Coalesce Labs organization.
- No mascot or character.
- No replacement of the A/B token systems themselves.
- No complete UI icon set (that's a different surface).
