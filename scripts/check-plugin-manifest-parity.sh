#!/bin/bash
# check-plugin-manifest-parity.sh (CTL-2220)
#
# Real-tree successor to validate-release-config.sh's Checks 9-11 (deleted
# alongside the rest of that release-please-specific script). Those checks
# had no dependency on release-please's own machinery — they compared the
# actual on-disk .claude-plugin/plugin.json and .codex-plugin/plugin.json
# version values, and asserted neither marketplace catalog carries a stray
# `version` field. Losing them when release-please's automation was removed
# would have silently dropped the only PR-time guard against the Claude and
# Codex manifests drifting apart (CTL-1463's acceptance criterion).
#
# Reads the plugin roster from release-please-config.json's `.packages` keys
# — same shared roster scripts/check-plugin-version.sh reads. See
# docs/releases.md's "release-please-config.json" section for why that file
# is still named that.

set -euo pipefail

REPO_ROOT="${CHECK_PLUGIN_MANIFEST_PARITY_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CONFIG="$REPO_ROOT/release-please-config.json"

ERRORS=0
fail() { echo "FAIL: $1"; ERRORS=$((ERRORS + 1)); }
pass() { echo "PASS: $1"; }

if [[ ! -f "$CONFIG" ]]; then
  fail "release-please-config.json (plugin roster manifest) not found"
  exit 1
fi

PACKAGES=$(jq -r '.packages | keys[]' "$CONFIG")

# --- Check: every plugin.json (Claude + Codex) has a non-empty version ---
MISSING_VERSIONS=()
for pkg in $PACKAGES; do
  for target in claude codex; do
    dir=".${target}-plugin"
    PLUGIN_JSON="$REPO_ROOT/$pkg/$dir/plugin.json"
    if [[ ! -f "$PLUGIN_JSON" ]]; then
      MISSING_VERSIONS+=("$pkg/$dir/plugin.json (file missing)")
      continue
    fi
    version=$(jq -r '.version // empty' "$PLUGIN_JSON")
    if [[ -z "$version" ]]; then
      MISSING_VERSIONS+=("$pkg/$dir/plugin.json (empty version)")
    fi
  done
done

if [[ ${#MISSING_VERSIONS[@]} -gt 0 ]]; then
  fail "plugin.json files missing a version field"
  printf '    %s\n' "${MISSING_VERSIONS[@]}"
else
  pass "All Claude and Codex plugin.json files have a version field"
fi

# --- Check: per-package version parity between .claude-plugin and .codex-plugin ---
# Deliberately NOT an `if [[ -f ... ]]; then compare; fi` shape that passes
# vacuously when a file is absent — counts comparisons and reports
# inconclusive (never PASS) if that count is zero.
PARITY_MISMATCHES=()
PARITY_COMPARISONS=0
for pkg in $PACKAGES; do
  CLAUDE_JSON="$REPO_ROOT/$pkg/.claude-plugin/plugin.json"
  CODEX_JSON="$REPO_ROOT/$pkg/.codex-plugin/plugin.json"
  if [[ ! -f "$CLAUDE_JSON" || ! -f "$CODEX_JSON" ]]; then
    continue
  fi
  claude_version=$(jq -r '.version // empty' "$CLAUDE_JSON")
  codex_version=$(jq -r '.version // empty' "$CODEX_JSON")
  PARITY_COMPARISONS=$((PARITY_COMPARISONS + 1))
  if [[ "$claude_version" != "$codex_version" ]]; then
    PARITY_MISMATCHES+=("$pkg: claude=$claude_version codex=$codex_version")
  fi
done

if [[ "$PARITY_COMPARISONS" -eq 0 ]]; then
  fail "0 Claude/Codex plugin.json pairs found to compare — inconclusive, treated as a failure"
elif [[ ${#PARITY_MISMATCHES[@]} -gt 0 ]]; then
  fail "Claude/Codex plugin.json versions disagree"
  printf '    %s\n' "${PARITY_MISMATCHES[@]}"
else
  pass "Claude/Codex plugin.json versions agree ($PARITY_COMPARISONS pairs compared)"
fi

# --- Check: neither marketplace catalog carries a version field ---
# plugin.json (both Claude's and Codex's) is the version source of truth; a
# version in either catalog would be a third place to drift.
for marketplace in ".claude-plugin/marketplace.json" ".agents/plugins/marketplace.json"; do
  MARKETPLACE_PATH="$REPO_ROOT/$marketplace"
  if [[ ! -f "$MARKETPLACE_PATH" ]]; then
    fail "$marketplace not found"
    continue
  fi
  VERSIONED=$(jq -r '.plugins[]? | select(.version) | .name' "$MARKETPLACE_PATH" 2>/dev/null || true)
  if [[ -n "$VERSIONED" ]]; then
    fail "$marketplace has version fields (version must only be in plugin.json)"
    echo "$VERSIONED" | sed 's/^/    /'
  else
    pass "$marketplace has no version fields"
  fi
done

# --- Check: release-please schema completeness + extra-files targets (CTL-2263) ---
# CTL-2220 deleted validate-release-config.sh (11 checks) and replaced only
# Checks 9-11 above; nothing asserted a package's extra-files actually point
# at the two plugin.json files that exist. Harmless while the config was a
# bare roster; restoring real extra-files re-opens the hole, and the failure
# mode is silent — version.txt gets bumped while both plugin.json files stay
# behind. Deliberately NOT an `if [[ -f ... ]]` shape that passes vacuously
# when a target is absent — every package is checked and a zero-package
# config is reported inconclusive, never a pass.
SCHEMA_MISMATCHES=()
SCHEMA_COMPARISONS=0
for pkg in $PACKAGES; do
  SCHEMA_COMPARISONS=$((SCHEMA_COMPARISONS + 1))
  PKG_JSON=$(jq -c --arg pkg "$pkg" '.packages[$pkg]' "$CONFIG")

  release_type=$(jq -r '.["release-type"] // empty' <<<"$PKG_JSON")
  component=$(jq -r '.component // empty' <<<"$PKG_JSON")
  changelog_path=$(jq -r '.["changelog-path"] // empty' <<<"$PKG_JSON")
  include_tag=$(jq -r '.["include-component-in-tag"] // empty' <<<"$PKG_JSON")

  MISSING_FIELDS=()
  [[ -z "$release_type" ]] && MISSING_FIELDS+=("release-type")
  [[ -z "$component" ]] && MISSING_FIELDS+=("component")
  [[ -z "$changelog_path" ]] && MISSING_FIELDS+=("changelog-path")
  [[ "$include_tag" != "true" ]] && MISSING_FIELDS+=("include-component-in-tag")

  if [[ ${#MISSING_FIELDS[@]} -gt 0 ]]; then
    SCHEMA_MISMATCHES+=("$pkg: missing field(s): ${MISSING_FIELDS[*]}")
    continue
  fi

  for target in claude codex; do
    dir=".${target}-plugin"
    # extra-files "path" is relative to the PACKAGE directory (release-please's
    # own convention — confirmed against the pre-removal config at
    # 179aa5618^:release-please-config.json), not the repo root.
    rel_path="$dir/plugin.json"
    abs_path="$pkg/$rel_path"
    match=$(jq -r --arg path "$rel_path" \
      '[.["extra-files"][]? | select(.path == $path)] | length' <<<"$PKG_JSON")
    if [[ "$match" -eq 0 ]]; then
      SCHEMA_MISMATCHES+=("$pkg: extra-files missing entry for $rel_path")
      continue
    fi
    if [[ "$match" -gt 1 ]]; then
      SCHEMA_MISMATCHES+=("$pkg: extra-files has $match entries for $rel_path (expected exactly 1)")
      continue
    fi
    entry_type=$(jq -r --arg path "$rel_path" \
      '.["extra-files"][] | select(.path == $path) | .type' <<<"$PKG_JSON")
    entry_jsonpath=$(jq -r --arg path "$rel_path" \
      '.["extra-files"][] | select(.path == $path) | .jsonpath' <<<"$PKG_JSON")
    if [[ "$entry_type" != "json" ]]; then
      SCHEMA_MISMATCHES+=("$pkg: extra-files entry for $rel_path has type=$entry_type (expected json)")
    fi
    if [[ "$entry_jsonpath" != '$.version' ]]; then
      SCHEMA_MISMATCHES+=("$pkg: extra-files entry for $rel_path has jsonpath=$entry_jsonpath (expected \$.version)")
    fi
    if [[ ! -f "$REPO_ROOT/$abs_path" ]]; then
      SCHEMA_MISMATCHES+=("$pkg: extra-files path $abs_path does not resolve to a file that exists")
    fi
  done
done

if [[ "$SCHEMA_COMPARISONS" -eq 0 ]]; then
  fail "0 packages found to check schema/extra-files completeness — inconclusive, treated as a failure"
elif [[ ${#SCHEMA_MISMATCHES[@]} -gt 0 ]]; then
  fail "release-please-config.json package entries missing required schema fields or extra-files targets"
  printf '    %s\n' "${SCHEMA_MISMATCHES[@]}"
else
  pass "All package entries carry required schema fields and complete extra-files ($SCHEMA_COMPARISONS packages checked)"
fi

if [[ "$ERRORS" -gt 0 ]]; then
  echo ""
  echo "❌ $ERRORS check(s) failed"
  exit 1
fi

echo ""
echo "✅ All plugin manifest parity checks passed"
exit 0
