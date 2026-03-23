#!/bin/bash
# Syncs versions from .release-please-manifest.json into .claude-plugin/marketplace.json.
# Called by the release-please workflow after releases are created.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$REPO_ROOT/.release-please-manifest.json"
MARKETPLACE="$REPO_ROOT/.claude-plugin/marketplace.json"

if [[ ! -f "$MANIFEST" ]] || [[ ! -f "$MARKETPLACE" ]]; then
  echo "Missing manifest or marketplace.json"
  exit 1
fi

# Map package paths to marketplace plugin indices
declare -A PLUGIN_INDEX=(
  ["plugins/dev"]=0
  ["plugins/pm"]=1
  ["plugins/analytics"]=2
  ["plugins/debugging"]=3
  ["plugins/meta"]=4
)

CHANGED=false

for pkg in "${!PLUGIN_INDEX[@]}"; do
  idx=${PLUGIN_INDEX[$pkg]}
  manifest_version=$(jq -r --arg pkg "$pkg" '.[$pkg] // empty' "$MANIFEST")
  marketplace_version=$(jq -r --argjson idx "$idx" '.plugins[$idx].version // empty' "$MARKETPLACE")

  if [[ -n "$manifest_version" ]] && [[ "$manifest_version" != "$marketplace_version" ]]; then
    jq --argjson idx "$idx" --arg ver "$manifest_version" \
      '.plugins[$idx].version = $ver' "$MARKETPLACE" > "$MARKETPLACE.tmp" \
      && mv "$MARKETPLACE.tmp" "$MARKETPLACE"
    echo "Synced $(jq -r --argjson idx "$idx" '.plugins[$idx].name' "$MARKETPLACE"): $marketplace_version -> $manifest_version"
    CHANGED=true
  fi
done

if [[ "$CHANGED" == "false" ]]; then
  echo "All marketplace.json versions already in sync"
fi
