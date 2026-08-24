#!/bin/bash
# Validates release-please-config.json for common issues that silently break releases.
# Run locally or in CI to catch misconfigurations before they reach main.

set -euo pipefail

# Test-only override: scripts/__tests__/validate-release-config.test.sh points
# this at a scratch fixture directory so it can exercise the checks without
# a real repo checkout. Unset in production — default behavior is unchanged.
REPO_ROOT="${VALIDATE_RELEASE_CONFIG_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CONFIG="$REPO_ROOT/release-please-config.json"
MANIFEST="$REPO_ROOT/.release-please-manifest.json"

ERRORS=0

fail() {
  echo "FAIL: $1"
  ERRORS=$((ERRORS + 1))
}

pass() {
  echo "PASS: $1"
}

# --- Check 1: Config and manifest files exist ---
if [[ ! -f "$CONFIG" ]]; then
  fail "release-please-config.json not found"
  exit 1
fi

if [[ ! -f "$MANIFEST" ]]; then
  fail ".release-please-manifest.json not found"
  exit 1
fi

pass "Config and manifest files exist"

# --- Check 2: No path traversal (..) in extra-files paths ---
# release-please resolves extra-files paths relative to the package directory.
# Paths containing ".." are rejected by release-please >=17.x as illegal pathing characters.
TRAVERSAL_PATHS=$(jq -r '
  .packages // {} | to_entries[] |
  .key as $pkg |
  (.value["extra-files"] // [])[] |
  if type == "object" then .path else . end |
  select(contains("..")) |
  "\($pkg): \(.)"
' "$CONFIG" 2>/dev/null || true)

if [[ -n "$TRAVERSAL_PATHS" ]]; then
  fail "extra-files paths contain '..' traversal (rejected by release-please >=17.x)"
  echo "  Offending paths:"
  echo "$TRAVERSAL_PATHS" | sed 's/^/    /'
  echo "  Fix: Remove extra-files with traversal. Handle cross-directory file updates in a separate workflow step."
else
  pass "No path traversal in extra-files"
fi

# --- Check 3: All package directories in config actually exist ---
MISSING_DIRS=$(jq -r '.packages // {} | keys[]' "$CONFIG" | while read -r pkg; do
  if [[ ! -d "$REPO_ROOT/$pkg" ]]; then
    echo "$pkg"
  fi
done)

if [[ -n "$MISSING_DIRS" ]]; then
  fail "Package directories in config don't exist on disk"
  echo "$MISSING_DIRS" | sed 's/^/    /'
else
  pass "All package directories exist"
fi

# --- Check 4: Manifest packages match config packages ---
CONFIG_PKGS=$(jq -r '.packages // {} | keys | sort | .[]' "$CONFIG")
MANIFEST_PKGS=$(jq -r 'keys | sort | .[]' "$MANIFEST")

if [[ "$CONFIG_PKGS" != "$MANIFEST_PKGS" ]]; then
  fail "Packages in config and manifest don't match"
  echo "  Config packages:   $(echo $CONFIG_PKGS | tr '\n' ' ')"
  echo "  Manifest packages: $(echo $MANIFEST_PKGS | tr '\n' ' ')"
else
  pass "Config and manifest packages match"
fi

# --- Check 5: extra-files targets exist on disk ---
MISSING_TARGETS=$(jq -r '
  .packages // {} | to_entries[] |
  .key as $pkg |
  (.value["extra-files"] // [])[] |
  if type == "object" then .path else . end |
  "\($pkg)|\(.)"
' "$CONFIG" 2>/dev/null | while IFS='|' read -r pkg path; do
  # Resolve relative to package dir
  resolved="$REPO_ROOT/$pkg/$path"
  canonical=$(cd "$REPO_ROOT/$pkg" && realpath -m "$path" 2>/dev/null || echo "$resolved")
  if [[ ! -f "$canonical" ]]; then
    echo "$pkg: $path (resolved: $canonical)"
  fi
done)

if [[ -n "$MISSING_TARGETS" ]]; then
  fail "extra-files targets don't exist on disk"
  echo "$MISSING_TARGETS" | sed 's/^/    /'
else
  pass "All extra-files targets exist"
fi

# --- Check 6: Every config package has a corresponding marketplace.json entry ---
MARKETPLACE="$REPO_ROOT/.claude-plugin/marketplace.json"

if [[ -f "$MARKETPLACE" ]]; then
  MARKETPLACE_NAMES=$(jq -r '.plugins[].name' "$MARKETPLACE" | sort)
  MISSING_MARKETPLACE=()

  for pkg in $(jq -r '.packages | keys[]' "$CONFIG"); do
    component=$(jq -r --arg pkg "$pkg" '.packages[$pkg].component // empty' "$CONFIG")
    if [[ -n "$component" ]] && ! echo "$MARKETPLACE_NAMES" | grep -qx "$component"; then
      MISSING_MARKETPLACE+=("$component (from $pkg)")
    fi
  done

  if [[ ${#MISSING_MARKETPLACE[@]} -gt 0 ]]; then
    fail "Config packages missing from marketplace.json"
    for msg in "${MISSING_MARKETPLACE[@]}"; do
      echo "    $msg"
    done
  else
    pass "All config packages have marketplace.json entries"
  fi
else
  fail "marketplace.json not found at .claude-plugin/marketplace.json"
fi

# --- Check 7: marketplace.json must NOT have version fields (DRY — version lives in plugin.json) ---
# plugin.json silently overrides marketplace.json. Having both causes confusion and drift.
MARKETPLACE_VERSIONS=$(jq -r '.plugins[] | select(.version) | .name' "$MARKETPLACE" 2>/dev/null || true)

if [[ -n "$MARKETPLACE_VERSIONS" ]]; then
  fail "marketplace.json has version fields (version must only be in plugin.json)"
  echo "$MARKETPLACE_VERSIONS" | sed 's/^/    /'
  echo "  Fix: Remove version from marketplace.json entries. plugin.json is the source of truth."
else
  pass "marketplace.json has no version fields (correct — plugin.json is source of truth)"
fi

# --- Check 8: Every plugin.json has a version field ---
MISSING_VERSIONS=()
for pkg in $(jq -r '.packages | keys[]' "$CONFIG"); do
  PLUGIN_JSON="$REPO_ROOT/$pkg/.claude-plugin/plugin.json"
  if [[ -f "$PLUGIN_JSON" ]]; then
    version=$(jq -r '.version // empty' "$PLUGIN_JSON")
    if [[ -z "$version" ]]; then
      MISSING_VERSIONS+=("$pkg/.claude-plugin/plugin.json")
    fi
  else
    MISSING_VERSIONS+=("$pkg/.claude-plugin/plugin.json (file missing)")
  fi
done

if [[ ${#MISSING_VERSIONS[@]} -gt 0 ]]; then
  fail "plugin.json files missing version field"
  for msg in "${MISSING_VERSIONS[@]}"; do
    echo "    $msg"
  done
else
  pass "All plugin.json files have version fields"
fi

# --- Check 9: Every config package has .codex-plugin/plugin.json with a non-empty $.version ---
# Mirrors Check 8. A missing file is a FAIL, never a skip — CTL-1463 makes the
# Codex manifest an equal partner to plugin.json in the version-authority
# chain, so its absence is exactly as broken as plugin.json's would be.
MISSING_CODEX_VERSIONS=()
MISSING_CODEX_EXTRA_FILES=()
for pkg in $(jq -r '.packages | keys[]' "$CONFIG"); do
  codex_extra_files=$(jq -r --arg pkg "$pkg" '
    [(.packages[$pkg]["extra-files"] // [])[] |
      select(type == "object" and .path == ".codex-plugin/plugin.json" and .jsonpath == "$.version")]
    | length
  ' "$CONFIG")
  if [[ "$codex_extra_files" -ne 1 ]]; then
    MISSING_CODEX_EXTRA_FILES+=("$pkg: expected exactly one Codex extra-files entry for .codex-plugin/plugin.json $.version; found $codex_extra_files")
  fi
  CODEX_JSON="$REPO_ROOT/$pkg/.codex-plugin/plugin.json"
  if [[ -f "$CODEX_JSON" ]]; then
    codex_version=$(jq -r '.version // empty' "$CODEX_JSON")
    if [[ -z "$codex_version" ]]; then
      MISSING_CODEX_VERSIONS+=("$pkg/.codex-plugin/plugin.json")
    fi
  else
    MISSING_CODEX_VERSIONS+=("$pkg/.codex-plugin/plugin.json (file missing)")
  fi
done

if [[ ${#MISSING_CODEX_EXTRA_FILES[@]} -gt 0 ]]; then
  fail "Codex version propagation is missing or duplicated in release-please extra-files"
  for msg in "${MISSING_CODEX_EXTRA_FILES[@]}"; do
    echo "    $msg"
  done
fi

if [[ ${#MISSING_CODEX_VERSIONS[@]} -gt 0 ]]; then
  fail ".codex-plugin/plugin.json files missing or missing version field"
  for msg in "${MISSING_CODEX_VERSIONS[@]}"; do
    echo "    $msg"
  done
else
  pass "All .codex-plugin/plugin.json files have version fields"
fi

# --- Check 10: per-package version parity between .claude-plugin and .codex-plugin ---
# The acceptance-criterion check: release-please writes both files' $.version
# in the same commit via the two extra-files entries, so they must always
# agree. Deliberately NOT the `if [[ -f ... ]]; then compare; fi` shape Checks
# 3/8 use — that shape passes VACUOUSLY when the file is absent
# ([].every(p) is true), which is exactly how a check stops checking anything
# while still printing PASS. This check counts comparisons performed and
# reports inconclusive — never PASS — if that count is zero.
PARITY_MISMATCHES=()
PARITY_COMPARISONS=0
for pkg in $(jq -r '.packages | keys[]' "$CONFIG"); do
  CLAUDE_JSON="$REPO_ROOT/$pkg/.claude-plugin/plugin.json"
  CODEX_JSON="$REPO_ROOT/$pkg/.codex-plugin/plugin.json"
  if [[ ! -f "$CLAUDE_JSON" || ! -f "$CODEX_JSON" ]]; then
    continue
  fi
  claude_version=$(jq -r '.version // empty' "$CLAUDE_JSON")
  codex_version=$(jq -r '.version // empty' "$CODEX_JSON")
  if [[ -z "$claude_version" || -z "$codex_version" ]]; then
    continue
  fi
  PARITY_COMPARISONS=$((PARITY_COMPARISONS + 1))
  if [[ "$claude_version" != "$codex_version" ]]; then
    PARITY_MISMATCHES+=("$pkg: claude=$claude_version codex=$codex_version")
  fi
done

if [[ $PARITY_COMPARISONS -eq 0 ]]; then
  fail "inconclusive — 0 comparisons performed (no package had both plugin.json files present with a version)"
elif [[ ${#PARITY_MISMATCHES[@]} -gt 0 ]]; then
  fail "Claude/Codex plugin.json version mismatch ($PARITY_COMPARISONS compared)"
  for msg in "${PARITY_MISMATCHES[@]}"; do
    echo "    $msg"
  done
else
  pass "Claude and Codex plugin.json versions agree ($PARITY_COMPARISONS compared)"
fi

# --- Check 11: .agents/plugins/marketplace.json must NOT have version fields ---
# Mirrors Check 7's rationale verbatim: plugin.json (both Claude's and
# Codex's) is the version source of truth; a version in the catalog would be
# a third place to drift.
CODEX_MARKETPLACE="$REPO_ROOT/.agents/plugins/marketplace.json"

if [[ -f "$CODEX_MARKETPLACE" ]]; then
  CODEX_MARKETPLACE_VERSIONS=$(jq -r '.plugins[]? | select(.version) | .name' "$CODEX_MARKETPLACE" 2>/dev/null || true)
  if [[ -n "$CODEX_MARKETPLACE_VERSIONS" ]]; then
    fail ".agents/plugins/marketplace.json has version fields (version must only be in plugin.json)"
    echo "$CODEX_MARKETPLACE_VERSIONS" | sed 's/^/    /'
  else
    pass ".agents/plugins/marketplace.json has no version fields (correct — plugin.json is source of truth)"
  fi
else
  fail ".agents/plugins/marketplace.json not found (mirrors Check 7 — same file-must-exist posture as .claude-plugin/marketplace.json)"
fi

# --- Summary ---
echo ""
if [[ $ERRORS -gt 0 ]]; then
  echo "FAILED: $ERRORS check(s) failed"
  exit 1
else
  echo "ALL CHECKS PASSED"
  exit 0
fi
