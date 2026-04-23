# Catalyst Brand V2 — Mark, wordmark, lockups

This folder holds the Catalyst V2 mark (CTL-147) plus the drawn wordmark and two lockups
(CTL-148), the favicon set (CTL-150), the 1200×630 social preview card (CTL-152), and the
monochrome variants and README hero (CTL-154). Everything follows the **Ignition Chevron**
direction picked in [CTL-146][ctl-146-direction] (PR #246).

[ctl-146-direction]: ../../packages/tokens/docs/brand-v2-direction.md

## Files

### Variable marks (theme via `currentColor`)

| File                    | `viewBox`         | Paths                  | Primary size range                      |
|-------------------------|-------------------|------------------------|-----------------------------------------|
| `mark.svg`              | `0 0 64 64`       | 2 (6 cmds ≤ 20)        | Mark at 32 px and above                 |
| `mark-simplified.svg`   | `0 0 16 16`       | 1 (3 cmds ≤ 8)         | Mark at 16–32 px                        |
| `wordmark.svg`          | `0 0 656 100`     | 8 (one per letter)     | Wordmark stand-alone                    |
| `lockup-horizontal.svg` | `0 0 806 100`     | 2 mark + 8 wordmark    | Primary lockup                          |
| `lockup-stacked.svg`    | `0 0 656 240`     | 2 mark + 8 wordmark    | Compact / square lockup                 |

### Rasterized export — OG card (CTL-152)

| File            | `viewBox`         | Paths                  | Primary size range                      |
|-----------------|-------------------|------------------------|-----------------------------------------|
| `og-card.svg`   | `0 0 1200 630`    | lockup + tagline + URL | Source for the social preview card      |
| `og-card.png`   | 1200 × 630 raster | —                      | Shipped to `website/public/og-card.png` |

Every mark/wordmark/lockup path uses `stroke="currentColor"` — no hex literals. The OG card
(`og-card.svg`) is an export source, not a themable asset, so it bakes Operator Console hex values
directly.

### Fixed-color monochrome variants (CTL-154)

For surfaces that lose CSS context — email clients, print, stickers, slide decks,
terminal screenshots — the V2 mark also ships with the stroke baked into pure black or
pure white. `opacity` is removed entirely so these variants are strictly single-tint.

| File                                   | Ink     | Use on           |
|----------------------------------------|---------|------------------|
| `mark-mono-black.svg`                  | `#000`  | Light backgrounds |
| `mark-mono-white.svg`                  | `#FFF`  | Dark backgrounds  |
| `lockup-horizontal-mono-black.svg`     | `#000`  | Light backgrounds |
| `lockup-horizontal-mono-white.svg`     | `#FFF`  | Dark backgrounds  |
| `lockup-stacked-mono-black.svg`        | `#000`  | Light backgrounds |
| `lockup-stacked-mono-white.svg`        | `#FFF`  | Dark backgrounds  |

Geometry is identical to the source files — same `viewBox`, same path count, same
letter data-attributes. Only the stroke color is hard-coded and the inner-chevron
opacity is removed.

### README hero image (CTL-154)

1600×480 banner referenced at the top of the repo-root `README.md` via a `<picture>`
element for GitHub light/dark mode routing. See [readme-hero/README.md](readme-hero/README.md)
for the composition spec and regeneration command.

### Favicons (CTL-150)

See [favicons/README.md](favicons/README.md).

## The two-size system

The simplified mark is **not** a scaled-down copy of the detailed mark — it is a separate drawing
optimised for its own grid.

- **Detailed mark** (`mark.svg`) — stacked double-chevron. Outer chevron is the silhouette; inner
  chevron is inset by 18 % and shares the apex, producing depth without gradient or shadow. Use at
  **32 px and up**.
- **Simplified mark** (`mark-simplified.svg`) — single chevron, three points, one stroke. Designed
  to survive the 16 × 16 favicon cell as a recognisable inverted V. Use at **16–32 px**.

Below 32 px the inner chevron in the detailed mark collapses into visual noise, which is the reason
the simplified mark exists as a separate file rather than a CSS scale.

## Wordmark

`wordmark.svg` is a drawn, stroke-based CATALYST — not a font export. Eight paths, one per letter
(`data-letter="C"`, `"A1"`, `"T1"`, `"A2"`, `"L"`, `"Y"`, `"S"`, `"T2"`). The construction matches
the chevron mark's straight-edge geometry: stroke-based, square caps, miter joins, no fills.

- `viewBox="0 0 656 100"` — **cap-height 100** for easy sizing. Render at any height `h` and the
  wordmark is `6.56 × h` wide.
- Stroke-width is `10` units (10 % of cap height) so the wordmark's optical weight matches the mark
  when they sit side-by-side.
- Tracking is tight — roughly −0.01 em equivalent — so the word reads as one shape, not eight.
- Slightly condensed letter proportions keep the overall lockup compact.

Typography pairing: the wordmark is designed to sit alongside **Space Grotesk** (System A) and **GT
Super / Fraunces** (System B) without fighting either. It is uppercase, geometric, and has custom
squared terminals so it does not read as a font render.

## Lockups

Two lockups ship as single SVG files with the mark embedded as a nested `<svg>` (so the mark's
internal `viewBox="0 0 64 64"` coordinate system is preserved).

### `lockup-horizontal.svg` — primary

- Mark on the **left**, wordmark on the **right**.
- **Gap** between mark and wordmark: `50` units = **0.5 × mark height** (per CTL-146's direction
  spec: `Lockup gap: 0.5 × mark height`).
- Mark is scaled to `100 × 100` so its height visually matches the wordmark's cap-height.
- `viewBox="0 0 806 100"` — `100 (mark) + 50 (gap) + 656 (wordmark)`.
- Vertically, the mark's visual center and the wordmark's cap center both sit at `y = 50`.

### `lockup-stacked.svg` — compact / square

- Mark **above**, wordmark **below**, both centered on a shared vertical axis.
- **Vertical rhythm:** `40` units between the mark's baseline and the wordmark's cap line
  (`0.4 × mark height`). Tighter than the horizontal gap so the two parts read as one vertical
  stack, not two stacked blocks.
- `viewBox="0 0 656 240"` — `100 (mark) + 40 (gap) + 100 (wordmark)`. Width matches the wordmark
  since the mark is narrower.
- Mark is centered horizontally at `x = 278` (= `(656 − 100) / 2`).

### Clear space

All lockups — including the mark used alone — require a minimum clear space of **0.5 × mark height**
(`0.5 × cap-height` for wordmark-only use) on every side. No other graphic element may enter that
zone.

- Horizontal lockup at display size `h`: clear space `= 0.5 × h` on top/bottom/left/right.
- Stacked lockup at display size `h`: clear space `= 0.125 × h` on every side (because `h` is the
  240-unit height, and 0.5 × mark-height = 0.5 × (100/240) × h ≈ 0.208 × h — round to 0.25 × h for
  safety).
- Wordmark stand-alone at display height `h`: clear space `= 0.5 × h` on top/bottom, `0.5 × h` on
  left/right.

Rule of thumb: imagine a copy of the mark tucked against each edge of the bounding box. No copy,
logo, icon, or photograph should cross that outer envelope.

### Minimum size

- `mark.svg` — min **32 px** (use `mark-simplified.svg` below 32 px).
- `mark-simplified.svg` — min **16 px**.
- `wordmark.svg` — min **80 px wide** (cap-height `80 / 6.56 ≈ 12 px`; below this the strokes of S
  and A crossbars crush).
- `lockup-horizontal.svg` — min **160 px wide**. Below this, switch to the stacked variant or the
  mark-only.
- `lockup-stacked.svg` — min **72 px wide**. Below this, switch to `mark-simplified.svg` alone — the
  wordmark below the mark stops being legible.

Rasterised usage (favicon, OG card, apple-touch-icon) is out of scope here — CTL-150 owns the raster
set.

## Tinting via `currentColor`

Both marks inherit their stroke color from the `color` CSS property on any ancestor. The simplest
usage — inline SVG or `<img>` with a CSS mask — lets you drive the mark from a design token.

### Pattern 1 — inline SVG (recommended)

```tsx
// React / JSX example
import Mark from "./assets/brand-v2/mark.svg?react"; // via vite-plugin-svgr

<span style={{ color: "var(--color-accent)" }}>
  <Mark width={48} height={48} />
</span>;
```

```html
<!-- Vanilla HTML — inline the SVG then color it with CSS -->
<span class="brand-mark">
  <!-- contents of mark.svg pasted here -->
</span>

<style>
  .brand-mark {
    color: var(--color-accent);
  }
</style>
```

### Pattern 2 — CSS `mask-image`

```css
.mark-icon {
  width: 24px;
  height: 24px;
  background-color: var(--color-accent);
  mask-image: url("./mark-simplified.svg");
  mask-size: contain;
  mask-repeat: no-repeat;
  -webkit-mask-image: url("./mark-simplified.svg");
}
```

Using `<img src="mark.svg">` directly will **not** pick up `currentColor` — the SVG is rendered in
its own document context and has no ancestor CSS to inherit from. Inline it (Pattern 1) or use a CSS
mask (Pattern 2).

### Accent token values

`--color-accent` is defined per system in `@catalyst/tokens`:

| System                       | Accent       | Source                                             |
| ---------------------------- | ------------ | -------------------------------------------------- |
| Operator Console (dark)      | Signal Amber | `packages/tokens/tokens/operator-console.json`     |
| Precision Instrument (light) | Graphite ink | `packages/tokens/tokens/precision-instrument.json` |

Hard-coding a hex in the SVG is an antipattern here — per the brief (R3), the hex comes from the
token layer, never from the mark file.

## Design constraints (inherited from CTL-146)

- **R1** — simplified ≤ 8 path commands. (This file: 3. ✅)
- **R2** — detailed ≤ 24 beziers. (This file: 0 beziers, 6 straight-line commands. ✅)
- **R3** — `currentColor` only; no hex in path fills. ✅
- **R4** — two separate SVG files. ✅
- **G2** — not an A-glyph. ✅ (chevron, no letter)

For the full hard-requirement list see
`thoughts/shared/product/brand/2026-04-22-catalyst-brand-v2-brief.md` (HumanLayer-managed; not in
this repo).

## Size matrix — expected rendering

| Size   | Which file            | Expected silhouette                                  |
| ------ | --------------------- | ---------------------------------------------------- |
| 16 px  | `mark-simplified.svg` | Clean inverted V, 2 dev-px stroke                    |
| 24 px  | `mark-simplified.svg` | Clean inverted V, 3 dev-px stroke                    |
| 32 px  | either (crossover)    | Both resolve; prefer detailed in dark theme          |
| 48 px  | `mark.svg`            | Stacked chevron, inner ghost resolves                |
| 128 px | `mark.svg`            | Full gesture, still reads as one mark not two shapes |
| 512 px | `mark.svg`            | Scale-invariant; no added detail required            |

## OG / social preview card (CTL-152)

The `og-card.svg` + `og-card.png` pair is the 1200×630 social preview card used by Open Graph,
Twitter cards, and LinkedIn embeds. It is also the canonical source for the GitHub repository
social-preview image (upload via GitHub → Settings → Social preview).

**Layout**

- Operator Console dark background (gradient `#07090B` → `#0D1117`).
- 6 px Signal Amber (`#FFB547`) vertical rail on the left edge — terminal side-rail motif.
- Horizontal lockup at 604 × 75 (75% of source viewBox `0 0 806 100`), stroked in Signal Amber at
  (x=96, y=220).
- Tagline in Space Grotesk Medium 56 px (`#E6EDF3`) at (x=96, y=408): "AI-assisted development
  workflows for Claude Code".
- Canonical URL in IBM Plex Sans 28 px (`#9AA7B2`) at (x=96, y=538): "catalyst.coalescelabs.ai".

**Rendering**

```bash
# Regenerate og-card.png from og-card.svg and copy to website/public.
assets/brand-v2/build-og-card.sh
```

Uses `rsvg-convert` for vector → PNG at 1200×630, then ImageMagick to flatten alpha, convert to
sRGB, and strip metadata. Output is < 80 KB (budget is < 300 KB).

**Distribution**

- Source vector: `assets/brand-v2/og-card.svg`.
- Rastered card: `assets/brand-v2/og-card.png`.
- Docs site: `website/public/og-card.png` (byte-identical copy).
- Wired into `website/src/routeData.ts` as the `og:image`/`twitter:image` target for the home page.
  Leaf docs pages keep their astro-og-canvas generated per-page cards.
- Default `twitter:card="summary_large_image"` and fallback `og:image` live in
  `website/astro.config.mjs` `head[]`.

**Why hex literals are OK here (but not in the mark SVGs)**

Per the R3 constraint, the mark/wordmark/lockup SVGs may only use `currentColor`. The OG card is a
different kind of asset — it exists to be rasterized for external consumers who render their own
background. The hex palette (Operator Console bg + Signal Amber accent) is baked in at export time
so shares look identical regardless of the viewer's theme.

## Provenance

- **Direction picked in:** CTL-146 (PR #246, merged 2026-04-22).
  `packages/tokens/docs/brand-v2-direction.md` carries the committable decision summary.
- **Mark delivered in:** CTL-147 (PR #258).
- **Wordmark + lockups delivered in:** CTL-148 (PR #262).
- **Favicon set delivered in:** CTL-150 (PR #261).
- **OG / social preview card delivered in:** CTL-152 (this PR).
- **V1 retirement:** V1 squircle-and-glyph files (`favicon.svg`, `website/public/favicon.svg`,
  `plugins/dev/scripts/orch-monitor/public/catalyst-logo.svg`) were replaced in the favicon ticket
  (CTL-150).
