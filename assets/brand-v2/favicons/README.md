# Catalyst V2 favicon set

Single source of truth for every favicon, app icon, and home-screen icon shipped by Catalyst.
Built from the CTL-147 mark assets in [`../mark.svg`](../mark.svg) and
[`../mark-simplified.svg`](../mark-simplified.svg) per the CTL-150 ticket.

## The set

| File                    | Format       | Size(s)            | Source mark             | Use |
|-------------------------|--------------|--------------------|-------------------------|-----|
| `favicon.svg`           | SVG, currentColor | viewBox 64×64 | detailed                | Modern browsers, themes via CSS color |
| `favicon.ico`           | Multi-res ICO | 16, 32, 48        | simplified (16), detailed (32, 48) | Legacy browser tabs |
| `apple-touch-icon.png`  | PNG, no alpha | 180×180           | detailed                | iOS home screen |
| `icon-192.png`          | PNG          | 192×192            | detailed                | PWA / Android |
| `icon-512.png`          | PNG          | 512×512            | detailed                | PWA install splash |
| `safari-pinned-tab.svg` | SVG, monochrome | viewBox 16×16   | hand-authored chevron   | Safari pinned tabs (recolored by user accent) |

## Distribution

Files in this directory are the source of truth. The build script copies them out to three
consumer locations:

| Consumer | Files |
|---|---|
| Repo root (`/`) | `favicon.svg`, `favicon.ico`, `apple-touch-icon.png` |
| `website/public/` (Starlight docs site) | `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `safari-pinned-tab.svg` |
| `plugins/dev/scripts/orch-monitor/public/` (internal ops UI) | `favicon.svg`, `favicon.ico` |

The orch-monitor only carries `favicon.svg` + `favicon.ico` because it is not a PWA and is
never added to an iOS home screen.

## Building

```bash
make favicons
# or, equivalently:
bash assets/brand-v2/favicons/build.sh
```

The script:

1. Renders `favicon-16.png` from `mark-simplified.svg` and `favicon-32.png` / `favicon-48.png`
   from `mark.svg`, with `currentColor` resolved to Operator Console accent
   (`#FFB547`, Signal Amber).
2. Packs the three intermediate PNGs into a multi-resolution `favicon.ico`.
3. Renders the iOS / PWA icons at 180/192/512 px, composited onto a solid Operator Console
   surface (`#0B0D10`) with no alpha — iOS dislikes transparent home-screen icons.
4. Cleans up the intermediate PNGs.
5. Copies the source set to the three consumer locations.
6. Removes legacy V1 squircle leftovers (`favicon.png` at root + website, `catalyst-logo.svg`
   in orch-monitor).

`favicon.svg` and `safari-pinned-tab.svg` are hand-authored and committed directly — the
build script does not regenerate them.

## Dependencies

- [`rsvg-convert`](https://gitlab.gnome.org/GNOME/librsvg) (Homebrew: `brew install librsvg`).
  Resolves `currentColor` via `--stylesheet` and rasterizes to PNG.
- [`magick`](https://imagemagick.org) (ImageMagick 7, Homebrew: `brew install imagemagick`).
  Packs the ICO and composites the solid-bg PNGs.

## Why the simplified mark for the 16 px ICO slot

The detailed mark's inner ghost chevron collapses into noise below 32 px. The simplified
mark is a separate drawing optimized for the 16 px grid and stays legible. This is the
two-size system documented in [`../README.md`](../README.md), now applied to favicons.

## Why solid-bg for `apple-touch-icon.png`

iOS composites transparent home-screen icons onto the wallpaper, which is unpredictable.
Modern Apple guidance is to bake the bg into the icon. The PWA icons follow the same
convention so that Android launchers and "Add to Home Screen" surfaces look consistent
between platforms.

## Browser hookup

- **Starlight** (`website/astro.config.mjs`): `favicon: "/favicon.svg"` + head links for
  apple-touch / icon-192 / safari-pinned-tab.
- **Orch-monitor** (`plugins/dev/scripts/orch-monitor/public/{index,history}.html`,
  `ui/index.html`): `<link rel="icon" type="image/svg+xml" href="/public/favicon.svg" />`.
- **Repo root**: served by Cloudflare Pages as the bare-domain fallback.

## Provenance

- **Source mark**: CTL-147 (PR #258, merged 2026-04-22).
- **Brand brief**: CTL-146 (PR #246, merged 2026-04-22).
- **This favicon set**: CTL-150.
