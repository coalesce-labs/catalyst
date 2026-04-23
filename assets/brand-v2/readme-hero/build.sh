#!/usr/bin/env bash
# build.sh — Rasterize the Catalyst README hero SVGs to PNG.
#
# Produces:
#   readme-hero-light.png — Precision Instrument palette (light mode)
#   readme-hero-dark.png  — Operator Console palette (dark mode)
#
# Both PNGs render at 1600x480 with no alpha (solid background). GitHub
# references them from the repo root README.md via a <picture> element
# for prefers-color-scheme routing.
#
# Requires: rsvg-convert, magick (ImageMagick 7). Fontconfig must be able
# to resolve a sans-serif family (macOS: Helvetica; Linux: DejaVu Sans).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required tool '$1' not found in PATH" >&2
    exit 1
  }
}
require rsvg-convert
require magick

render() {
  local variant="$1"
  local src="readme-hero-${variant}.svg"
  local out="readme-hero-${variant}.png"

  echo "  • Rendering ${out} (1600x480)"
  # rsvg-convert rasterizes SVG via Cairo. The background <rect> in the SVG means
  # alpha is already flat — we still strip alpha below for GitHub safety.
  rsvg-convert -w 1600 -h 480 "$src" -o "$out.tmp"

  # -strip removes EXIF / color profile metadata. -alpha remove flattens any
  # residual alpha onto the SVG's painted background. -quality 85 compresses.
  magick "$out.tmp" -strip -alpha remove -alpha off -quality 85 "$out"
  rm -f "$out.tmp"

  local bytes
  bytes=$(wc -c < "$out" | tr -d ' ')
  echo "    → ${bytes} bytes"
}

echo "Building Catalyst V2 README hero in $SCRIPT_DIR"
render light
render dark
echo
echo "✓ README hero rendered."
