#!/bin/bash
# Check if plugin files were modified but version not bumped
# Can be used as a pre-commit hook or CI check

set -e

# Get list of changed files in this commit
CHANGED_FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || echo "")

if [[ -z "$CHANGED_FILES" ]]; then
  # No staged changes, check working directory instead
  CHANGED_FILES=$(git diff --name-only 2>/dev/null || echo "")
fi

if [[ -z "$CHANGED_FILES" ]]; then
  # Nothing changed
  exit 0
fi

# Check each plugin directory
PLUGINS=("dev" "pm" "analytics" "debugging" "meta")
NEEDS_VERSION_BUMP=()

for plugin in "${PLUGINS[@]}"; do
  PLUGIN_DIR="plugins/$plugin"

  if [[ ! -d "$PLUGIN_DIR" ]]; then
    continue
  fi

  # Check if any files in this plugin changed
  PLUGIN_CHANGED=$(echo "$CHANGED_FILES" | grep "^$PLUGIN_DIR/" || true)

  if [[ -z "$PLUGIN_CHANGED" ]]; then
    continue
  fi

  # Check if plugin.json version was also changed
  VERSION_CHANGED=$(echo "$CHANGED_FILES" | grep "^$PLUGIN_DIR/.claude-plugin/plugin.json$" || true)

  # If plugin files changed but version didn't, flag it
  if [[ -n "$PLUGIN_CHANGED" ]] && [[ -z "$VERSION_CHANGED" ]]; then
    NEEDS_VERSION_BUMP+=("$plugin")
  fi
done

# Report findings
if [[ ${#NEEDS_VERSION_BUMP[@]} -gt 0 ]]; then
  echo ""
  echo "⚠️  Plugin files changed but version not bumped!"
  echo ""
  echo "The following plugins have modified files:"
  for plugin in "${NEEDS_VERSION_BUMP[@]}"; do
    echo "  📦 catalyst-$plugin"
    # Show which files changed
    echo "$CHANGED_FILES" | grep "^plugins/$plugin/" | sed 's/^/     - /'
  done
  echo ""
  echo "💡 Recommended action:"
  echo ""
  echo "   Determine the type of change:"
  echo "   - Breaking changes (required updates): major version bump"
  echo "   - New features (backward compatible): minor version bump"
  echo "   - Bug fixes: patch version bump"
  echo ""
  echo "   Then run:"
  for plugin in "${NEEDS_VERSION_BUMP[@]}"; do
    echo "   ./scripts/bump-version.sh $plugin <major|minor|patch>"
  done
  echo ""
  echo "   Or bump all at once:"
  echo "   ./scripts/bump-version.sh all <major|minor|patch>"
  echo ""

  # In CI or pre-commit mode, fail
  if [[ "${STRICT_VERSION_CHECK:-}" == "true" ]]; then
    echo "❌ Version bump required before commit"
    exit 1
  else
    echo "⚠️  Warning only - commit will proceed"
    echo "   Set STRICT_VERSION_CHECK=true to enforce"
    exit 0
  fi
fi

exit 0
