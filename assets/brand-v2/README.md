# Catalyst Brand V2 — Mark assets

This folder holds the Catalyst V2 primary mark, delivered per **CTL-147** and following the
**Ignition Chevron** direction picked in [CTL-146][ctl-146-direction] (PR #246).

[ctl-146-direction]: ../../packages/tokens/docs/brand-v2-direction.md

## Files

| File                  | `viewBox` | Path commands | Primary size range |
|-----------------------|-----------|---------------|--------------------|
| `mark.svg`            | `0 0 64 64` | 6 (≤ 20 cap)   | 32 px and above    |
| `mark-simplified.svg` | `0 0 16 16` | 3 (≤ 8 cap)    | 16–32 px (favicons)|

Both files ship without color: every path uses `stroke="currentColor"`, so the consuming
surface controls tint.

## The two-size system

The simplified mark is **not** a scaled-down copy of the detailed mark — it is a separate
drawing optimised for its own grid.

- **Detailed mark** (`mark.svg`) — stacked double-chevron. Outer chevron is the silhouette;
  inner chevron is inset by 18 % and shares the apex, producing depth without gradient or
  shadow. Use at **32 px and up**.
- **Simplified mark** (`mark-simplified.svg`) — single chevron, three points, one stroke.
  Designed to survive the 16 × 16 favicon cell as a recognisable inverted V. Use at
  **16–32 px**.

Below 32 px the inner chevron in the detailed mark collapses into visual noise, which is the
reason the simplified mark exists as a separate file rather than a CSS scale.

## Tinting via `currentColor`

Both marks inherit their stroke color from the `color` CSS property on any ancestor. The
simplest usage — inline SVG or `<img>` with a CSS mask — lets you drive the mark from a
design token.

### Pattern 1 — inline SVG (recommended)

```tsx
// React / JSX example
import Mark from './assets/brand-v2/mark.svg?react';   // via vite-plugin-svgr

<span style={{ color: 'var(--color-accent)' }}>
  <Mark width={48} height={48} />
</span>
```

```html
<!-- Vanilla HTML — inline the SVG then color it with CSS -->
<span class="brand-mark">
  <!-- contents of mark.svg pasted here -->
</span>

<style>
  .brand-mark { color: var(--color-accent); }
</style>
```

### Pattern 2 — CSS `mask-image`

```css
.mark-icon {
  width: 24px;
  height: 24px;
  background-color: var(--color-accent);
  mask-image: url('./mark-simplified.svg');
  mask-size: contain;
  mask-repeat: no-repeat;
  -webkit-mask-image: url('./mark-simplified.svg');
}
```

Using `<img src="mark.svg">` directly will **not** pick up `currentColor` — the SVG is
rendered in its own document context and has no ancestor CSS to inherit from. Inline it
(Pattern 1) or use a CSS mask (Pattern 2).

### Accent token values

`--color-accent` is defined per system in `@catalyst/tokens`:

| System                    | Accent        | Source                                          |
|---------------------------|---------------|-------------------------------------------------|
| Operator Console (dark)   | Signal Amber  | `packages/tokens/tokens/operator-console.json`  |
| Precision Instrument (light) | Graphite ink | `packages/tokens/tokens/precision-instrument.json` |

Hard-coding a hex in the SVG is an antipattern here — per the brief (R3), the hex comes from
the token layer, never from the mark file.

## Design constraints (inherited from CTL-146)

- **R1** — simplified ≤ 8 path commands. (This file: 3. ✅)
- **R2** — detailed ≤ 24 beziers. (This file: 0 beziers, 6 straight-line commands. ✅)
- **R3** — `currentColor` only; no hex in path fills. ✅
- **R4** — two separate SVG files. ✅
- **G2** — not an A-glyph. ✅ (chevron, no letter)

For the full hard-requirement list see
`thoughts/shared/product/brand/2026-04-22-catalyst-brand-v2-brief.md` (HumanLayer-managed;
not in this repo).

## Size matrix — expected rendering

| Size   | Which file             | Expected silhouette                                  |
|--------|------------------------|------------------------------------------------------|
| 16 px  | `mark-simplified.svg`  | Clean inverted V, 2 dev-px stroke                    |
| 24 px  | `mark-simplified.svg`  | Clean inverted V, 3 dev-px stroke                    |
| 32 px  | either (crossover)     | Both resolve; prefer detailed in dark theme          |
| 48 px  | `mark.svg`             | Stacked chevron, inner ghost resolves                |
| 128 px | `mark.svg`             | Full gesture, still reads as one mark not two shapes |
| 512 px | `mark.svg`             | Scale-invariant; no added detail required            |

## Provenance

- **Direction picked in:** CTL-146 (PR #246, merged 2026-04-22).
  `packages/tokens/docs/brand-v2-direction.md` carries the committable decision summary.
- **Delivered in:** CTL-147.
- **V1 retirement:** out of scope here. V1 squircle-and-glyph files
  (`favicon.svg`, `website/public/favicon.svg`,
  `plugins/dev/scripts/orch-monitor/public/catalyst-logo.svg`) are replaced in the favicon-set
  ticket (CTL-150).
- **Wordmark + lockups:** CTL-148. Not shipped here.
