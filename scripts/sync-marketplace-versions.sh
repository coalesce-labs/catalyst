#!/bin/bash
# Sync marketplace.json plugin versions from plugin.json manifests
#
# Usage:
#   ./scripts/sync-marketplace-versions.sh           # Update marketplace.json
#   ./scripts/sync-marketplace-versions.sh --check    # Check only, exit 1 if out of sync

set -e

MARKETPLACE=".claude-plugin/marketplace.json"
CHECK_ONLY=false

if [[ "$1" == "--check" ]]; then
  CHECK_ONLY=true
fi

if [[ ! -f "$MARKETPLACE" ]]; then
  echo "❌ Marketplace file not found: $MARKETPLACE"
  exit 1
fi

PLUGINS=("dev" "pm" "analytics" "debugging" "meta")
OUT_OF_SYNC=()

for plugin in "${PLUGINS[@]}"; do
  PLUGIN_JSON="plugins/$plugin/.claude-plugin/plugin.json"
  if [[ ! -f "$PLUGIN_JSON" ]]; then
    echo "⚠️  Plugin manifest not found: $PLUGIN_JSON"
    continue
  fi

  PLUGIN_VERSION=$(jq -r '.version' "$PLUGIN_JSON")
  MARKETPLACE_VERSION=$(jq -r --arg name "catalyst-$plugin" \
    '.plugins[] | select(.name == $name) | .version' "$MARKETPLACE")

  if [[ "$PLUGIN_VERSION" != "$MARKETPLACE_VERSION" ]]; then
    OUT_OF_SYNC+=("catalyst-$plugin: plugin.json=$PLUGIN_VERSION marketplace.json=$MARKETPLACE_VERSION")

    if [[ "$CHECK_ONLY" == false ]]; then
      jq --arg name "catalyst-$plugin" --arg version "$PLUGIN_VERSION" \
        '(.plugins[] | select(.name == $name) | .version) = $version' \
        "$MARKETPLACE" > "$MARKETPLACE.tmp"
      mv "$MARKETPLACE.tmp" "$MARKETPLACE"
      echo "✅ Synced catalyst-$plugin: $MARKETPLACE_VERSION → $PLUGIN_VERSION"
    fi
  fi
done

if [[ ${#OUT_OF_SYNC[@]} -gt 0 ]]; then
  if [[ "$CHECK_ONLY" == true ]]; then
    echo "❌ Marketplace version drift detected:"
    for entry in "${OUT_OF_SYNC[@]}"; do
      echo "  • $entry"
    done
    echo ""
    echo "Run: ./scripts/sync-marketplace-versions.sh"
    exit 1
  fi
else
  echo "✅ All marketplace versions in sync"
fi
