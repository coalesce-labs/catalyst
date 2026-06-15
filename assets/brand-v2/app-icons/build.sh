#!/usr/bin/env bash
# build.sh — render the Catalyst Linear OAuth app icons from the canonical mark.
#
#   catalyst-icon-512.png      — workers app:  Signal Amber #FFB547
#   orchestrator-icon-512.png  — daemon app:   Operator Console "info" #58A6FF
#
# Both are the brand mark (../mark.svg) with currentColor resolved to the accent,
# composited onto the Operator Console surface #0B0D10, no alpha (512×512) — the
# same pipeline as ../favicons/build.sh, so the amber output is pixel-for-pixel the
# website/PWA icon-512.png (identical render; PNG metadata may differ).
#
# Requires: rsvg-convert, magick (ImageMagick 7).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARK="$SCRIPT_DIR/../mark.svg"
SURFACE="#0B0D10"

command -v rsvg-convert >/dev/null 2>&1 || { echo "error: rsvg-convert not found" >&2; exit 1; }
command -v magick >/dev/null 2>&1 || { echo "error: magick (ImageMagick 7) not found" >&2; exit 1; }

# render <accent-hex> <out-png> — mark tinted to accent on a solid SURFACE canvas.
render() {
  local accent="$1" out="$2" css tmp
  css="$(mktemp -t cat-appicon-css.XXXXXX)"
  tmp="$(mktemp -t cat-appicon.XXXXXX.png)"
  printf 'svg { color: %s; }\n' "$accent" >"$css"
  rsvg-convert --stylesheet="$css" -w 512 -h 512 "$MARK" -o "$tmp"
  magick -size 512x512 "xc:$SURFACE" "$tmp" -gravity center -composite \
    -alpha remove -alpha off "$out"
  rm -f "$css" "$tmp"
}

render "#FFB547" "$SCRIPT_DIR/catalyst-icon-512.png"      # workers
render "#58A6FF" "$SCRIPT_DIR/orchestrator-icon-512.png"  # daemon

echo "rendered catalyst-icon-512.png (amber) + orchestrator-icon-512.png (blue)"
