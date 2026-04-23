# README hero image

1600×480 widescreen banner for the repo-root `README.md`. Delivered in CTL-154 per the
brand V2 kit (CTL-146 direction, CTL-147 mark, CTL-148 wordmark + lockups).

## Files

| File | Purpose |
|---|---|
| `readme-hero-light.svg` | Source — Precision Instrument palette (canvas `#FAFAF7`, ink `#2C3E64`) |
| `readme-hero-dark.svg`  | Source — Operator Console palette (canvas `#0B0D10`, ink `#FFB547`) |
| `readme-hero-light.png` | Rasterized 1600×480, no alpha |
| `readme-hero-dark.png`  | Rasterized 1600×480, no alpha |
| `build.sh`              | Rasterizer — regenerates both PNGs from their SVG sources |

## Composition

Both heroes share one layout:

- Flat canvas rect (hex-baked palette color)
- Horizontal lockup (mark + CATALYST wordmark) centered at `x=320, y=140`, scaled to 960×120
- Tagline `"Portable workflows for Claude Code"` centered at `x=800, y=360`, 42 pt

The SVG bakes palette hex values directly instead of using `currentColor`. Rasterization
has to bake a palette anyway, so the SVG and PNG stay identical in every environment.

## Tagline font

Rendered via SVG `<text>` with `font-family="ui-sans-serif, system-ui, -apple-system,
'Segoe UI', Helvetica, Arial, sans-serif"`. Regenerating the PNG requires a system with a
sans-serif font available to fontconfig (macOS has Helvetica; Linux typically has DejaVu
Sans). The committed PNGs are built once — CI does not regenerate them.

## GitHub light/dark routing

The repo-root `README.md` references both heroes via a `<picture>` element:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand-v2/readme-hero/readme-hero-dark.png">
  <img alt="Catalyst — Portable workflows for Claude Code" src="assets/brand-v2/readme-hero/readme-hero-light.png">
</picture>
```

GitHub honors `prefers-color-scheme` in the markdown renderer, so readers see the hero
that matches their chosen theme.

## Regenerating

```bash
./build.sh
```

Requires `rsvg-convert` and `magick` (ImageMagick 7). Both PNGs should stay well under
the 200 KB budget — current output is ~34 KB each.
