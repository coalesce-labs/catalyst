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
#
# DIFF_HEAD is the ref to diff/read the PR's own content from. In CI mode
# (BASE_REF set) it defaults to PR_HEAD_SHA when the caller supplies it —
# actions/checkout leaves the *working tree* (and literal HEAD) at GitHub's
# synthetic pull_request merge commit, whose tree folds a file back to
# match base wherever the PR's own change happens to agree with base's
# (possibly since-advanced) value. Diffing/reading against the PR's real
# head commit instead of that merge tree avoids losing exactly the
# collision this gate exists to catch (CTL-2266 P1 follow-up).
DIFF_HEAD=""
if [[ -n "${BASE_REF:-}" ]]; then
  # CI mode: compare against PR base branch
  DIFF_HEAD="${PR_HEAD_SHA:-HEAD}"
  CHANGED_FILES=$(git diff --name-only "$BASE_REF"..."$DIFF_HEAD" 2>/dev/null || echo "")
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

# CTL-2266: version-monotonicity assertion.
#
# A raw git merge of two lanes that independently bump the SAME plugin to the
# SAME target version (e.g. both 12.66.3 -> 13.0.0) merges cleanly — no
# conflict marker, no red check, no dequeue. Nothing above this catches that:
# the existing loop below only asks "did plugin files change without a
# version bump", and a conventional-commit message makes that pass with no
# bump at all (docs/releases.md). This block closes the other half.
#
# Fires only when BASE_REF is set (CI mode) — the only mode with a real PR
# base to compare against, and the mode the merge queue re-runs required
# checks in against the current base. That's what makes "surfaces before
# merge" true even for a lane whose branch itself was forked before the other
# lane merged: CHANGED_FILES above already used three-dot (merge-base)
# semantics, so a plugin's version.txt shows as changed here whenever THIS
# lane touched it, regardless of how far $BASE_REF has since moved.
#
# version_gt <a> <b> — true iff semver <a> is strictly greater than <b>.
# Reuses the repo's `sort -V` idiom (check-setup.sh's version_ge,
# install-cli.sh's _ab_version_ge); plugin versions here are plain
# major.minor.patch, so version-aware sort ordering is sufficient without a
# full semver library.
version_gt() {
  [[ "$1" != "$2" ]] && [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" == "$1" ]]
}

MONOTONICITY_FAILURES=()

if [[ -n "${BASE_REF:-}" ]]; then
  for PLUGIN_DIR in "${PLUGIN_DIRS[@]}"; do
    if [[ ! -d "$PLUGIN_DIR" ]]; then
      continue
    fi

    VERSION_TXT_CHANGED=$(echo "$CHANGED_FILES" | grep -Fx "$PLUGIN_DIR/version.txt" || true)
    if [[ -z "$VERSION_TXT_CHANGED" ]]; then
      continue
    fi

    component=$(jq -r --arg pkg "$PLUGIN_DIR" '.packages[$pkg].component // $pkg' "$RELEASE_CONFIG" || true)

    # Read from $DIFF_HEAD via `git show`, never the working tree: in CI mode
    # the working tree is the synthetic merge commit, and reading it directly
    # here is exactly what let a same-value collision hide (see DIFF_HEAD
    # comment above).
    NEW_VERSION=$(git show "$DIFF_HEAD:$PLUGIN_DIR/version.txt" 2>/dev/null | tr -d '[:space:]')
    BASE_VERSION=$(git show "$BASE_REF:$PLUGIN_DIR/version.txt" 2>/dev/null | tr -d '[:space:]')

    if [[ -z "$NEW_VERSION" ]]; then
      MONOTONICITY_FAILURES+=("$component ($PLUGIN_DIR): version.txt is empty or unreadable in this PR")
      continue
    fi

    if [[ -z "$BASE_VERSION" ]]; then
      # Fail closed: an unreadable base is "could not look", never "no collision".
      MONOTONICITY_FAILURES+=("$component ($PLUGIN_DIR): could not read version.txt at \$BASE_REF ($BASE_REF) — cannot verify monotonicity")
      continue
    fi

    if ! version_gt "$NEW_VERSION" "$BASE_VERSION"; then
      MONOTONICITY_FAILURES+=("$component ($PLUGIN_DIR): version.txt is $NEW_VERSION, which is not strictly greater than \$BASE_REF's $BASE_VERSION — two lanes bumping to the same (or a lower) value merge silently with no conflict")
      continue
    fi

    for MANIFEST_REL in ".claude-plugin/plugin.json" ".codex-plugin/plugin.json"; do
      MANIFEST_PATH="$PLUGIN_DIR/$MANIFEST_REL"
      MANIFEST_CONTENT=$(git show "$DIFF_HEAD:$MANIFEST_PATH" 2>/dev/null || true)
      [[ -n "$MANIFEST_CONTENT" ]] || continue
      MANIFEST_VERSION=$(echo "$MANIFEST_CONTENT" | jq -r '.version // empty' 2>/dev/null || true)
      if [[ "$MANIFEST_VERSION" != "$NEW_VERSION" ]]; then
        MONOTONICITY_FAILURES+=("$component ($PLUGIN_DIR): $MANIFEST_REL version ($MANIFEST_VERSION) does not match version.txt ($NEW_VERSION)")
      fi
    done
  done
fi

if [[ ${#MONOTONICITY_FAILURES[@]} -gt 0 ]]; then
  echo ""
  echo "❌ Plugin version bump is invalid:"
  echo ""
  for failure in "${MONOTONICITY_FAILURES[@]}"; do
    echo "   - $failure"
  done
  echo ""
  echo "   Re-derive the version from \$BASE_REF's current value — never reconcile"
  echo "   a stale number with a raw merge. See docs/releases.md."
  exit 1
fi

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
    COMMIT_MSGS=$(git log --format='%s' "$BASE_REF"..."$DIFF_HEAD" 2>/dev/null || echo "")
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
