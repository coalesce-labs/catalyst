#!/usr/bin/env bash
# build-og-card.sh — Build the Catalyst V2 OG / social preview card (1200×630 PNG).
#
# Generates:
#   og-card.png           — 1200×630, sRGB, flattened (no alpha), < 300 KB
#
# The source `og-card.svg` is hand-authored and committed — this script does not regenerate it.
#
# After generating, distributes the PNG to the docs site:
#   - website/public/og-card.png
#
# Requires: rsvg-convert, magick (ImageMagick 7).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC="$SCRIPT_DIR/og-card.svg"
PNG="$SCRIPT_DIR/og-card.png"

log() { printf "  • %s\n" "$*"; }

require() {
	command -v "$1" >/dev/null 2>&1 || {
		echo "ERROR: required tool '$1' not found in PATH" >&2
		exit 1
	}
}

require rsvg-convert
require magick

if [ ! -f "$SRC" ]; then
	echo "ERROR: source not found: $SRC" >&2
	exit 1
fi

echo "Building Catalyst V2 OG card from $SRC"

# Render the SVG at native resolution — 1200×630 exactly.
log "Render og-card.png at 1200×630 from og-card.svg"
TMP="$(mktemp -t catalyst-og-card.XXXXXX.png)"
rsvg-convert -w 1200 -h 630 "$SRC" -o "$TMP"

# Flatten to solid-bg RGB, strip metadata, convert to sRGB. Flattened (no alpha) because
# some social platforms composite the OG card onto their own bg when alpha is present.
log "Flatten alpha, convert to sRGB, strip metadata"
magick "$TMP" -background "#07090B" -alpha remove -alpha off -colorspace sRGB -strip "$PNG"
rm -f "$TMP"

# Report size + dimensions.
BYTES=$(stat -f %z "$PNG" 2>/dev/null || stat -c %s "$PNG")
KB=$((BYTES / 1024))
log "og-card.png: ${BYTES} bytes (~${KB} KB)"
if [ "$BYTES" -ge 307200 ]; then
	echo "WARNING: og-card.png is ${KB} KB — acceptance criterion is < 300 KB." >&2
fi

# Distribute to consumer locations.
echo
echo "Distributing to consumer locations"
log "  → website/public/og-card.png"
cp "$PNG" "$REPO_ROOT/website/public/og-card.png"

echo
echo "✓ OG card built and distributed."
