#!/bin/bash
# Check if plugin files were modified but version not bumped
# Can be used as a pre-commit hook or CI check
#
# CTL-2263: release-please is reinstated (CTL-2220 had removed it; see
# docs/releases.md "Versioning"). It bumps version.txt and both plugin.json
# files AFTER merge, via the release PR — never in the same PR that changed
# the plugin. So this gate's conventional-commit escape hatch is exactly
# right: a plugin change with no manual version bump in THIS PR passes as
# long as the branch's commits are conventional-commit-shaped, because
# release-please's own PR is what bumps the version, on its own schedule.
# This gate never bumps anything itself either way.

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
# NOTE: `release-please-config.json` is release-please's real config again
# (CTL-2263) — see docs/releases.md's "release-please-config.json" section
# for why scripts/packaging/cli.mjs also reading it for plugin order is a
# deliberate, resolved decision (CTL-2247), not drift.
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
  # release-please bumps version.txt and both plugin.json files AFTER this
  # PR merges, via its own release PR (CTL-2263) — never inside this PR.
  # The conventional-commit check below is only an escape hatch for THIS
  # gate: it decides whether this PR is allowed to merge without a version
  # bump already present, not whether one will ever happen. It always does,
  # on release-please's schedule, as long as the commit message is
  # conventional. If a plugin needs a version bump that can't wait for the
  # next release PR, bump version.txt and both plugin.json files by hand in
  # this PR instead — but don't do both, a hand bump plus release-please's
  # own bump is a double bump.
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
    echo "   release-please bumps the version after this merges, via its own release"
    echo "   PR. If it can't wait for that, bump version.txt + both plugin.json files"
    echo "   by hand instead (not in addition — that would double-bump)."
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
