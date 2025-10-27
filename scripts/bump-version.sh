#!/bin/bash
# Bump plugin version numbers

set -e

usage() {
  echo "Usage: $0 <plugin-name> <version-type>"
  echo ""
  echo "Arguments:"
  echo "  plugin-name   Plugin to bump (dev, pm, analytics, debugging, meta, or 'all')"
  echo "  version-type  Type of bump: major, minor, patch"
  echo ""
  echo "Examples:"
  echo "  $0 dev major      # 1.0.0 → 2.0.0 (breaking changes)"
  echo "  $0 pm minor       # 1.1.0 → 1.2.0 (new features)"
  echo "  $0 all patch      # x.y.0 → x.y.1 (bug fixes)"
  echo "  $0 dev 2.1.0      # Set specific version"
  exit 1
}

if [[ $# -lt 2 ]]; then
  usage
fi

PLUGIN_NAME=$1
VERSION_TYPE=$2

# Function to get plugin directory
get_plugin_dir() {
  local plugin=$1
  case "$plugin" in
    dev) echo "plugins/dev" ;;
    pm) echo "plugins/pm" ;;
    analytics) echo "plugins/analytics" ;;
    debugging) echo "plugins/debugging" ;;
    meta) echo "plugins/meta" ;;
    *) echo "" ;;
  esac
}

bump_plugin() {
  local plugin_name=$1
  local plugin_dir=$2
  local manifest="$plugin_dir/.claude-plugin/plugin.json"

  if [[ ! -f "$manifest" ]]; then
    echo "❌ Plugin manifest not found: $manifest"
    return 1
  fi

  # Get current version
  local current_version=$(jq -r '.version' "$manifest")
  echo "📦 Plugin: catalyst-$plugin_name"
  echo "   Current version: $current_version"

  # Calculate new version
  local new_version
  if [[ "$VERSION_TYPE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    # Specific version provided
    new_version="$VERSION_TYPE"
  else
    # Bump by type
    IFS='.' read -r major minor patch <<< "$current_version"
    case "$VERSION_TYPE" in
      major)
        new_version="$((major + 1)).0.0"
        ;;
      minor)
        new_version="$major.$((minor + 1)).0"
        ;;
      patch)
        new_version="$major.$minor.$((patch + 1))"
        ;;
      *)
        echo "❌ Invalid version type: $VERSION_TYPE"
        echo "   Use: major, minor, patch, or a specific version (e.g., 2.1.0)"
        return 1
        ;;
    esac
  fi

  echo "   New version: $new_version"

  # Update version in plugin.json
  jq --arg version "$new_version" '.version = $version' "$manifest" > "$manifest.tmp"
  mv "$manifest.tmp" "$manifest"

  # Update version in marketplace.json
  local marketplace=".claude-plugin/marketplace.json"
  if [[ -f "$marketplace" ]]; then
    jq --arg name "catalyst-$plugin_name" --arg version "$new_version" \
      '(.plugins[] | select(.name == $name) | .version) = $version' \
      "$marketplace" > "$marketplace.tmp"
    mv "$marketplace.tmp" "$marketplace"
    echo "   ✅ Updated plugin.json and marketplace.json"
  else
    echo "   ✅ Updated plugin.json"
    echo "   ⚠️  Marketplace not found - skipping"
  fi
  echo ""
}

# Bump plugins
if [[ "$PLUGIN_NAME" == "all" ]]; then
  echo "🔄 Bumping all plugins to $VERSION_TYPE..."
  echo ""
  for plugin in dev pm analytics debugging meta; do
    plugin_dir=$(get_plugin_dir "$plugin")
    if [[ -d "$plugin_dir" ]]; then
      bump_plugin "$plugin" "$plugin_dir"
    fi
  done
else
  plugin_dir=$(get_plugin_dir "$PLUGIN_NAME")
  if [[ -z "$plugin_dir" ]]; then
    echo "❌ Unknown plugin: $PLUGIN_NAME"
    echo "   Available: dev, pm, analytics, debugging, meta"
    exit 1
  fi

  bump_plugin "$PLUGIN_NAME" "$plugin_dir"
fi

echo "✨ Version bump complete!"
echo ""
echo "📝 Next steps:"
echo "  1. Review changes: git diff plugins/*/'.claude-plugin/plugin.json'"
echo "  2. Update CHANGELOG.md with changes"
echo "  3. Commit: git add -A && git commit -m 'chore: bump version to $VERSION_TYPE'"
echo "  4. Tag release: git tag v$VERSION_TYPE && git push --tags"
