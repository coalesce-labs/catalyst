#!/usr/bin/env bash
# Regression guard for the clean-config invariant (CTL-1246, Phase 3; re-scoped
# 2026-08-01 for the thagale/catalyst fork — see git history for the original
# upstream coalesce-labs/rightsite-cloud/groundworkapp version, and again for the
# removal of the hardcoded-org-name default in favor of the
# CATALYST_PROVISION_THOUGHTS_PRIMARY_ORG override).
#
# The invariant: when CATALYST_PROVISION_THOUGHTS_PRIMARY_ORG is set, write_config()
# must ALWAYS use it as the GLOBAL thoughtsRepo/defaultProfile, never drifting to
# some OTHER org that merely happens to appear in the registry. This suite drives
# the script's hermetic --dry-run payload-print seam against a registry containing
# a second, unrelated org and asserts the printed .thoughts payload's global
# fallback never drifts to it.
#
# Run: bash plugins/dev/scripts/__tests__/provision-thoughts-invariant.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROVISION="${SCRIPTS_DIR}/provision-thoughts.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
HL_CONFIG_FILE="$SCRATCH/humanlayer.json"

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    PASSES=$((PASSES + 1)); echo "  PASS: $label"
  else
    FAILURES=$((FAILURES + 1)); echo "  FAIL: $label"
    echo "    expected: $expected"; echo "    actual:   $actual"
  fi
}
assert_not_grep() {
  local label="$1" output="$2" pattern="$3"
  if grep -qF -- "$pattern" <<<"$output"; then
    FAILURES=$((FAILURES + 1)); echo "  FAIL: $label (unexpected pattern found)"
    echo "    unexpected substring: $pattern"
    echo "$output" | head -40 | sed 's/^/      /'
  else
    PASSES=$((PASSES + 1)); echo "  PASS: $label"
  fi
}

run_provision() {
  env -i PATH="$PATH" HOME="$SCRATCH/home" USER="testnode" \
    HLT_ROOT="$SCRATCH/hlt" HL_CONFIG="$HL_CONFIG_FILE" \
    CATALYST_PROVISION_THOUGHTS_PRIMARY_ORG="operator-org" \
    bash "$PROVISION" --dry-run --no-clone "$@" 2>&1
}
extract_json() {
  awk '/DRY-RUN humanlayer.json .thoughts would be:/{found=1; next} found{print}' <<<"$1" \
    | jq -c . 2>/dev/null
}

echo "=== provision-thoughts clean-config invariant guard (CTL-1246) ==="
echo "SCRIPT: $PROVISION"
echo ""

# A registry whose ONLY repoRoot is an unrelated second org's code repo — proves
# the global fallback stays pinned to the configured override rather than
# drifting to whatever org happens to show up in the registry.
REG_OTHER="$SCRATCH/registry-other.json"
cat > "$REG_OTHER" <<EOF
{"projects":[{"repoRoot":"$SCRATCH/github/some-other-org/widget","team":"WID"}]}
EOF

OUT="$(run_provision --registry "$REG_OTHER")"
JSON="$(extract_json "$OUT")"

# 1. Global fallback thoughtsRepo is the configured override's HLT path, never some-other-org.
assert_eq "global thoughtsRepo ends with /operator-org/thoughts" \
  "$(jq -r '.thoughtsRepo' <<<"$JSON")" "$SCRATCH/hlt/operator-org/thoughts"
assert_not_grep "global thoughtsRepo never contains 'some-other-org'" \
  "$(jq -r '.thoughtsRepo' <<<"$JSON")" "some-other-org"

# 2. defaultProfile == the configured override.
assert_eq "defaultProfile == operator-org" "$(jq -r '.defaultProfile' <<<"$JSON")" "operator-org"

# 3. The unrelated org's own repoRoot resolves to its own profile/thoughts path
#    (org_profile is now identity — profile always == org), not folded into
#    the override and not dropped.
assert_eq "some-other-org repoRoot resolves to profile 'some-other-org' (org_profile is identity)" \
  "$(jq -r --arg p "$SCRATCH/github/some-other-org/widget" '.repoMappings[$p].profile // "MISSING"' <<<"$JSON")" \
  "some-other-org"
assert_eq "the 'some-other-org' profile points at its own HLT path" \
  "$(jq -r '.profiles["some-other-org"].thoughtsRepo // "MISSING"' <<<"$JSON")" \
  "$SCRATCH/hlt/some-other-org/thoughts"

echo ""
echo "=== Results ==="
echo "PASS: $PASSES"
echo "FAIL: $FAILURES"
echo ""
echo "provision-thoughts-invariant.test.sh: ${PASSES} passed, ${FAILURES} failed"
exit "$FAILURES"
