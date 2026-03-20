#!/bin/bash
# Check if plugin files were modified but version not bumped
# Can be used as a pre-commit hook or CI check

set -e

# Get list of changed files
if [[ -n "${BASE_REF:-}" ]]; then
  # CI mode: compare against PR base branch
  CHANGED_FILES=$(git diff --name-only "$BASE_REF"...HEAD 2>/dev/null || echo "")
elif [[ -n "$(git diff --cached --name-only 2>/dev/null)" ]]; then
  # Pre-commit mode: staged files
  CHANGED_FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || echo "")
else
  # Working directory mode
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

  # Check if any files in this plugin changed (excluding Release Please managed files)
  PLUGIN_CHANGED=$(echo "$CHANGED_FILES" | grep "^$PLUGIN_DIR/" | grep -v "CHANGELOG.md$" | grep -v "version.txt$" || true)

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
  # Release Please manages versions via conventional commits.
  # Check if the commits on this branch use conventional commit format,
  # which means Release Please will handle the version bump automatically.
  CONVENTIONAL_COMMITS=false
  if [[ -n "${BASE_REF:-}" ]]; then
    # Check commit messages for conventional commit prefixes
    COMMIT_MSGS=$(git log --format='%s' "$BASE_REF"...HEAD 2>/dev/null || echo "")
    if echo "$COMMIT_MSGS" | grep -qE '^(feat|fix|perf|refactor|chore|docs|style|test|build|ci)(\(.+\))?!?:'; then
      CONVENTIONAL_COMMITS=true
    fi
  fi

  if [[ "$CONVENTIONAL_COMMITS" == true ]]; then
    echo ""
    echo "ℹ️  Plugin files changed — version bump will be handled by Release Please"
    echo ""
    echo "The following plugins have modifications:"
    for plugin in "${NEEDS_VERSION_BUMP[@]}"; do
      echo "  📦 catalyst-$plugin"
      echo "$CHANGED_FILES" | grep "^plugins/$plugin/" | sed 's/^/     - /'
    done
    echo ""
    echo "✅ Conventional commits detected — Release Please will bump versions on merge"
    exit 0
  fi

  echo ""
  echo "⚠️  Plugin files changed but version not bumped!"
  echo ""
  echo "The following plugins have modified files:"
  for plugin in "${NEEDS_VERSION_BUMP[@]}"; do
    echo "  📦 catalyst-$plugin"
    echo "$CHANGED_FILES" | grep "^plugins/$plugin/" | sed 's/^/     - /'
  done
  echo ""
  echo "💡 Recommended action:"
  echo ""
  echo "   Use conventional commit messages so Release Please can auto-bump versions:"
  echo "   - feat(scope)!: breaking change  → major bump"
  echo "   - feat(scope): new feature       → minor bump"
  echo "   - fix(scope): bug fix            → patch bump"
  echo ""

  # In CI or pre-commit mode, fail
  if [[ "${STRICT_VERSION_CHECK:-}" == "true" ]]; then
    echo "❌ Conventional commit message required for plugin changes"
    exit 1
  else
    echo "⚠️  Warning only - commit will proceed"
    echo "   Set STRICT_VERSION_CHECK=true to enforce"
    exit 0
  fi
fi

exit 0
