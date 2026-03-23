#!/bin/bash
# Checks that release-please is healthy: workflow runs succeed and no releases are stuck.
# Designed to run on a schedule so failures are caught within hours, not after the next PR.
#
# Checks:
#   1. Last release-please workflow run succeeded
#   2. No releasable commits are sitting on main without an open release PR
#   3. plugin.json versions match .release-please-manifest.json

set -euo pipefail

ERRORS=0

fail() {
  echo "FAIL: $1"
  ERRORS=$((ERRORS + 1))
}

pass() {
  echo "PASS: $1"
}

# --- Check 1: Last release-please workflow run succeeded ---
LAST_RUN=$(gh run list --workflow=release-please.yml --limit 1 --json conclusion,databaseId,createdAt --jq '.[0] // empty')

if [[ -z "$LAST_RUN" ]]; then
  fail "No release-please workflow runs found"
else
  CONCLUSION=$(echo "$LAST_RUN" | jq -r '.conclusion')
  RUN_ID=$(echo "$LAST_RUN" | jq -r '.databaseId')
  CREATED=$(echo "$LAST_RUN" | jq -r '.createdAt')

  if [[ "$CONCLUSION" == "success" ]]; then
    pass "Last release-please run succeeded (run $RUN_ID, $CREATED)"
  else
    fail "Last release-please run status: $CONCLUSION (run $RUN_ID, $CREATED)"
    echo "  View: gh run view $RUN_ID --log"
  fi
fi

# --- Check 2: No releasable commits stranded without a release PR ---
# For each package, find the latest release tag and check if conventional
# commits have landed since then without a corresponding open release PR.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$REPO_ROOT/release-please-config.json"

if [[ ! -f "$CONFIG" ]]; then
  fail "release-please-config.json not found"
  echo ""
  echo "FAILED: $ERRORS check(s) failed"
  exit 1
fi

OPEN_RELEASE_PRS=$(gh pr list --label "autorelease: pending" --state open --json headRefName --jq '.[].headRefName' 2>/dev/null || true)

STRANDED=()

for pkg in $(jq -r '.packages | keys[]' "$CONFIG"); do
  component=$(jq -r --arg pkg "$pkg" '.packages[$pkg].component // empty' "$CONFIG")
  if [[ -z "$component" ]]; then
    continue
  fi

  # Find latest release tag for this component
  latest_tag=$(git tag --list "${component}-v*" --sort=-version:refname | head -1)

  if [[ -z "$latest_tag" ]]; then
    # No tags yet — skip, bootstrap hasn't completed
    continue
  fi

  # Extract the scope from the component name (e.g. catalyst-dev -> dev)
  scope="${component#catalyst-}"

  # Check for releasable conventional commits since the last tag
  releasable_commits=$(git log "${latest_tag}..origin/main" --oneline --format='%s' -- "$pkg" 2>/dev/null \
    | grep -cE "^(feat|fix|perf)(\($scope\))?!?:" || true)

  if [[ "$releasable_commits" -gt 0 ]]; then
    # Check if there's an open release PR for this component
    has_pr=false
    for pr_branch in $OPEN_RELEASE_PRS; do
      if [[ "$pr_branch" == *"$component"* ]]; then
        has_pr=true
        break
      fi
    done

    if [[ "$has_pr" == "false" ]]; then
      STRANDED+=("$component: $releasable_commits releasable commit(s) since $latest_tag with no open release PR")
    fi
  fi
done

if [[ ${#STRANDED[@]} -gt 0 ]]; then
  fail "Releasable commits on main with no open release PR"
  for msg in "${STRANDED[@]}"; do
    echo "  - $msg"
  done
  echo "  This usually means the release-please workflow is failing."
else
  pass "No stranded releasable commits (all packages have release PRs or are up to date)"
fi

# --- Check 3: plugin.json versions match manifest ---
# plugin.json is the source of truth for Claude Code plugin distribution.
# If it drifts from the manifest, other workspaces get stale plugins.

MANIFEST="$REPO_ROOT/.release-please-manifest.json"

if [[ -f "$MANIFEST" ]]; then
  DRIFTED=()
  for pkg in $(jq -r '.packages | keys[]' "$CONFIG"); do
    PLUGIN_JSON="$REPO_ROOT/$pkg/.claude-plugin/plugin.json"
    manifest_ver=$(jq -r --arg pkg "$pkg" '.[$pkg] // empty' "$MANIFEST")

    if [[ -f "$PLUGIN_JSON" ]]; then
      plugin_ver=$(jq -r '.version // empty' "$PLUGIN_JSON")
      plugin_name=$(jq -r '.name // empty' "$PLUGIN_JSON")

      if [[ -n "$manifest_ver" ]] && [[ -n "$plugin_ver" ]] && [[ "$manifest_ver" != "$plugin_ver" ]]; then
        DRIFTED+=("$plugin_name: plugin.json=$plugin_ver manifest=$manifest_ver")
      fi
    fi
  done

  if [[ ${#DRIFTED[@]} -gt 0 ]]; then
    fail "plugin.json versions don't match manifest (other workspaces are getting stale plugins!)"
    for msg in "${DRIFTED[@]}"; do
      echo "  - $msg"
    done
    echo "  release-please extra-files should keep these in sync. Check if the release PR updated plugin.json."
  else
    pass "plugin.json versions match manifest"
  fi
else
  fail "Missing .release-please-manifest.json"
fi

# --- Summary ---
echo ""
if [[ $ERRORS -gt 0 ]]; then
  echo "RELEASE HEALTH: UNHEALTHY ($ERRORS issue(s))"
  exit 1
else
  echo "RELEASE HEALTH: HEALTHY"
  exit 0
fi
