#!/bin/bash
# Check if plugin files were modified but version not bumped
# Can be used as a pre-commit hook or CI check
#
# CTL-2220: release-please (the tool that used to auto-bump versions on
# merge) has been removed from this repo. There is currently no automated
# replacement — see docs/releases.md "Versioning (post release-please)".
# This gate still enforces the conventional-commit format as an escape
# hatch: a plugin change with no manual version bump passes as long as the
# branch's commits are conventional-commit-shaped. It does not bump, and
# nothing downstream of it bumps, the version for you.

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

# Check every plugin listed in the shared plugin roster manifest. This keeps
# playground paths and newly added plugins covered without a second,
# silently drifting hardcoded roster.
#
# NOTE: `release-please-config.json` keeps its name for now purely because
# scripts/packaging/cli.mjs (owned by the in-flight CTL-1461 packaging work,
# out of scope for CTL-2220) hardcodes that path as its plugin-order source.
# It is no longer release-please's config — release-please itself is gone —
# just a `{"packages": {"<plugin-dir>": {"component": "<name>"}}}` roster.
REPO_ROOT=$(git rev-parse --show-toplevel)
RELEASE_CONFIG="$REPO_ROOT/release-please-config.json"
if [[ ! -f "$RELEASE_CONFIG" ]]; then
  echo "❌ release-please-config.json (plugin roster manifest) not found"
  exit 1
fi
PLUGIN_DIRS=()
while IFS= read -r plugin_dir; do
  PLUGIN_DIRS+=("$plugin_dir")
done < <(jq -r '.packages | keys[]' "$RELEASE_CONFIG")
NEEDS_VERSION_BUMP=()

for PLUGIN_DIR in "${PLUGIN_DIRS[@]}"; do
  if [[ ! -d "$PLUGIN_DIR" ]]; then
    continue
  fi

  # Check if any files in this plugin changed (excluding the changelog/version
  # record files a version bump itself would touch)
  PLUGIN_CHANGED=$(echo "$CHANGED_FILES" | grep "^$PLUGIN_DIR/" | grep -v "CHANGELOG.md$" | grep -v "version.txt$" || true)

  if [[ -z "$PLUGIN_CHANGED" ]]; then
    continue
  fi

  # Check if plugin.json version was also changed — CTL-1463: .codex-plugin/
  # plugin.json is an equally valid bump target now that it carries a second
  # version field, so a Codex-only manifest change (e.g. a manual version
  # bump, or a regen after CTL-1461 lands) must not mis-fire this gate as
  # "plugin files changed but version not bumped".
  VERSION_CHANGED=$(echo "$CHANGED_FILES" | grep -E "^$PLUGIN_DIR/\.(claude|codex)-plugin/plugin\.json$" || true)

  # If plugin files changed but version didn't, flag it
  if [[ -n "$PLUGIN_CHANGED" ]] && [[ -z "$VERSION_CHANGED" ]]; then
    NEEDS_VERSION_BUMP+=("$PLUGIN_DIR")
  fi
done

# Report findings
if [[ ${#NEEDS_VERSION_BUMP[@]} -gt 0 ]]; then
  # No automated version-bump mechanism runs after this gate (CTL-2220
  # removed release-please and nothing has replaced it). The conventional-
  # commit check below is only an escape hatch: it decides whether THIS gate
  # blocks the PR, not whether some later step will bump the version for
  # you. If a plugin actually needs a new version, bump version.txt and both
  # plugin.json files by hand in this PR.
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
    echo "ℹ️  Plugin files changed without a version bump"
    echo ""
    echo "The following plugins have modifications:"
    for plugin_dir in "${NEEDS_VERSION_BUMP[@]}"; do
      component=$(jq -r --arg pkg "$plugin_dir" '.packages[$pkg].component // $pkg' "$RELEASE_CONFIG")
      echo "  📦 $component"
      echo "$CHANGED_FILES" | grep "^$plugin_dir/" | sed 's/^/     - /'
    done
    echo ""
    echo "✅ Conventional commit message(s) detected — passing without a version bump."
    echo "   Nothing bumps the version automatically (release-please was removed,"
    echo "   CTL-2220); if this change should ship a new version, bump it by hand."
    exit 0
  fi

  echo ""
  echo "⚠️  Plugin files changed but version not bumped!"
  echo ""
  echo "The following plugins have modified files:"
  for plugin_dir in "${NEEDS_VERSION_BUMP[@]}"; do
    component=$(jq -r --arg pkg "$plugin_dir" '.packages[$pkg].component // $pkg' "$RELEASE_CONFIG")
    echo "  📦 $component"
    echo "$CHANGED_FILES" | grep "^$plugin_dir/" | sed 's/^/     - /'
  done
  echo ""
  echo "💡 Recommended action:"
  echo ""
  echo "   Either bump the version by hand (version.txt + both plugin.json files),"
  echo "   or use a conventional commit message so this gate passes without one:"
  echo "   - feat(scope)!: breaking change"
  echo "   - feat(scope): new feature"
  echo "   - fix(scope): bug fix"
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
