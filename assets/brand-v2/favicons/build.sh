#!/usr/bin/env bash
# build.sh — Build the Catalyst V2 favicon set from the source mark SVGs.
#
# Generates:
#   favicon.ico           — multi-res ICO with 16/32/48 slots (16 uses simplified mark,
#                            32 and 48 use the detailed mark)
#   apple-touch-icon.png  — 180x180, full mark on solid bg, no alpha
#   icon-192.png          — 192x192 PWA icon
#   icon-512.png          — 512x512 PWA install icon
#
# The two SVGs (favicon.svg, safari-pinned-tab.svg) are hand-authored and committed —
# this script does not regenerate them.
#
# After generating, distributes the set to the three consumer locations:
#   - repo root                                          (3 files)
#   - website/public/                                    (6 files)
#   - plugins/dev/scripts/orch-monitor/public/           (2 files)
#
# Removes V1 squircle leftovers in the same locations.
#
# Requires: rsvg-convert, magick (ImageMagick 7).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SOURCE_DIR="$SCRIPT_DIR"
MARK_DIR="$REPO_ROOT/assets/brand-v2"

# Operator Console palette — the V2 default.
ACCENT="#FFB547"   # Signal Amber
SURFACE="#0B0D10"  # Operator Console bg

log() { printf "  • %s\n" "$*"; }

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required tool '$1' not found in PATH" >&2
    exit 1
  }
}

require rsvg-convert
require magick

cd "$SOURCE_DIR"

# Render an SVG at the given size with currentColor resolved to ACCENT.
# Output is a transparent-bg PNG.
render_transparent() {
  local svg="$1" size="$2" out="$3"
  local css
  css="$(mktemp -t catalyst-fav-css.XXXXXX)"
  printf 'svg { color: %s; }\n' "$ACCENT" > "$css"
  rsvg-convert --stylesheet="$css" -w "$size" -h "$size" "$svg" -o "$out"
  rm -f "$css"
}

# Render an SVG at the given size and composite onto a solid SURFACE-colored canvas.
# Output PNG has no alpha (RGB) so iOS/Android home-screen launchers don't composite
# the mark onto a system-chosen background.
render_solid_bg() {
  local svg="$1" size="$2" out="$3"
  local tmp
  tmp="$(mktemp -t catalyst-fav-tmp.XXXXXX.png)"
  render_transparent "$svg" "$size" "$tmp"
  magick -size "${size}x${size}" "xc:$SURFACE" "$tmp" -gravity center -composite \
    -alpha remove -alpha off "$out"
  rm -f "$tmp"
}

echo "Building Catalyst V2 favicon set in $SOURCE_DIR"

# ── ICO slots — 16 from simplified, 32/48 from detailed. ────────────────────
log "Render favicon-16.png from mark-simplified.svg (transparent bg)"
render_transparent "$MARK_DIR/mark-simplified.svg" 16 favicon-16.png

log "Render favicon-32.png from mark.svg (transparent bg)"
render_transparent "$MARK_DIR/mark.svg" 32 favicon-32.png

log "Render favicon-48.png from mark.svg (transparent bg)"
render_transparent "$MARK_DIR/mark.svg" 48 favicon-48.png

log "Pack favicon.ico with 16/32/48 slots"
magick favicon-16.png favicon-32.png favicon-48.png favicon.ico

# ── Solid-bg PNGs for iOS / Android / PWA. ──────────────────────────────────
log "Render apple-touch-icon.png (180x180, solid bg, no alpha)"
render_solid_bg "$MARK_DIR/mark.svg" 180 apple-touch-icon.png

log "Render icon-192.png (192x192, solid bg)"
render_solid_bg "$MARK_DIR/mark.svg" 192 icon-192.png

log "Render icon-512.png (512x512, solid bg)"
render_solid_bg "$MARK_DIR/mark.svg" 512 icon-512.png

# ── Clean up intermediates. ─────────────────────────────────────────────────
rm -f favicon-16.png favicon-32.png favicon-48.png

# ── Distribute. ─────────────────────────────────────────────────────────────
echo
echo "Distributing to consumer locations"

distribute() {
  local dest="$1"
  shift
  for f in "$@"; do
    log "  → $dest/$f"
    cp "$SOURCE_DIR/$f" "$REPO_ROOT/$dest/$f"
  done
}

# Repo root: minimal set — covers Cloudflare Pages root requests + bare gh-pages
# fallback.
distribute "." favicon.svg favicon.ico apple-touch-icon.png

# Docs site (Starlight).
distribute "website/public" \
  favicon.svg favicon.ico apple-touch-icon.png \
  icon-192.png icon-512.png safari-pinned-tab.svg

# Orch-monitor (internal ops UI — no PWA, no iOS home screen).
distribute "plugins/dev/scripts/orch-monitor/public" \
  favicon.svg favicon.ico

# ── Remove V1 squircle leftovers. ───────────────────────────────────────────
echo
echo "Removing V1 squircle leftovers"

remove_if_exists() {
  for path in "$@"; do
    if [ -e "$REPO_ROOT/$path" ]; then
      log "  ✗ $path"
      rm -f "$REPO_ROOT/$path"
    fi
  done
}

remove_if_exists \
  favicon.png \
  website/public/favicon.png \
  plugins/dev/scripts/orch-monitor/public/catalyst-logo.svg

echo
echo "✓ Favicon set built and distributed."
