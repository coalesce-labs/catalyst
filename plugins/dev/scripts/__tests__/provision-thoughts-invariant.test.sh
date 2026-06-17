#!/usr/bin/env bash
# Regression guard for the clean-config invariant (CTL-1246, Phase 3).
#
# The groundworkapp-fallback bug (CTL-1214 bug #6) was fixed in
# provision-thoughts.sh — write_config() now writes a coalesce-labs global
# thoughtsRepo + defaultProfile and normalizes groundworkapp → rightsite-cloud.
# This suite LOCKS that invariant so it cannot silently regress: it drives the
# script's hermetic --dry-run payload-print seam against a registry that contains
# a groundworkapp/Adva repoRoot and asserts the printed .thoughts payload can
# NEVER reintroduce a groundworkapp global fallback.
#
# No production behavior change — provision-thoughts.sh already satisfies these.
# If any assertion fails, fix write_config() (provision-thoughts.sh:114-165) /
# normalize_org() (:44) to restore the invariant.
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
    bash "$PROVISION" --dry-run --no-clone "$@" 2>&1
}
extract_json() {
  awk '/DRY-RUN humanlayer.json .thoughts would be:/{found=1; next} found{print}' <<<"$1" \
    | jq -c . 2>/dev/null
}

echo "=== provision-thoughts clean-config invariant guard (CTL-1246) ==="
echo "SCRIPT: $PROVISION"
echo ""

# A registry whose ONLY repoRoot is the groundworkapp (Adva) code repo — the exact
# shape that used to produce the global groundworkapp fallback.
REG_GW="$SCRATCH/registry-gw.json"
cat > "$REG_GW" <<EOF
{"projects":[{"repoRoot":"$SCRATCH/github/groundworkapp/groundwork","team":"ADV"}]}
EOF

OUT="$(run_provision --registry "$REG_GW")"
JSON="$(extract_json "$OUT")"

# 1. Global fallback thoughtsRepo is the coalesce-labs HLT path, never groundworkapp.
assert_eq "global thoughtsRepo ends with /coalesce-labs/thoughts" \
  "$(jq -r '.thoughtsRepo' <<<"$JSON")" "$SCRATCH/hlt/coalesce-labs/thoughts"
assert_not_grep "global thoughtsRepo never contains 'groundworkapp'" \
  "$(jq -r '.thoughtsRepo' <<<"$JSON")" "groundworkapp"

# 2. defaultProfile is coalesce-labs.
assert_eq "defaultProfile == coalesce-labs" "$(jq -r '.defaultProfile' <<<"$JSON")" "coalesce-labs"

# 3. NO profile thoughtsRepo path contains groundworkapp.
assert_not_grep "no profile.thoughtsRepo contains 'groundworkapp'" \
  "$(jq -r '.profiles[].thoughtsRepo' <<<"$JSON")" "groundworkapp"

# 4. No THOUGHTS path or profile mentions groundworkapp. (The repoMappings KEY is
#    the local source-code repoRoot — e.g. /github/groundworkapp/groundwork — and
#    legitimately contains the org dir name; that is the code repo path, not a
#    thoughts path. Strip the keys and assert the rest is groundworkapp-free, plus
#    assert the repoMapping VALUES (repo/profile) are clean too.)
assert_not_grep "no thoughts path / profile contains 'groundworkapp' (repoMapping keys excluded)" \
  "$(jq -c 'del(.repoMappings)' <<<"$JSON")" "groundworkapp"
assert_not_grep "repoMapping values (.repo/.profile) are groundworkapp-free" \
  "$(jq -r '.repoMappings[] | "\(.repo) \(.profile)"' <<<"$JSON")" "groundworkapp"

# 5. The Adva (groundworkapp) repoRoot normalizes to profile 'adva' → rightsite-cloud HLT.
assert_eq "groundworkapp repoRoot resolves to profile 'adva' (normalize_org applied)" \
  "$(jq -r --arg p "$SCRATCH/github/groundworkapp/groundwork" '.repoMappings[$p].profile // "MISSING"' <<<"$JSON")" \
  "adva"
assert_eq "the 'adva' profile points at the rightsite-cloud HLT path" \
  "$(jq -r '.profiles["adva"].thoughtsRepo // "MISSING"' <<<"$JSON")" \
  "$SCRATCH/hlt/rightsite-cloud/thoughts"

echo ""
echo "=== Results ==="
echo "PASS: $PASSES"
echo "FAIL: $FAILURES"
echo ""
echo "provision-thoughts-invariant.test.sh: ${PASSES} passed, ${FAILURES} failed"
exit "$FAILURES"
