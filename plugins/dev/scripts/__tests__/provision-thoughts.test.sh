#!/usr/bin/env bash
# Tests for provision-thoughts.sh (CTL-1214 / bug #6).
# Hermetic — exercises only the dry-run / no-clone / verify-only seams plus the
# HLT_ROOT / HL_CONFIG / CATALYST_REGISTRY env overrides. NO real git clone, NO
# network, NO real gh. Asserts the would-be humanlayer.json .thoughts payload the
# script prints under --dry-run.
#
# Covered:
#  1. --orgs derivation → global fallback (.thoughts.thoughtsRepo) is the
#     coalesce-labs HLT path (NEVER groundworkapp), defaultProfile coalesce-labs,
#     and a profile entry per org.
#  2. --registry derivation → org set from registry repoRoots, and the bug-#1 fix:
#     repoMapping 'repo' comes from each repoRoot's .catalyst/config.json
#     .thoughts.directory (not the basename) when present.
#  3. --orgs CSV overrides registry derivation.
#  4. Primary org (coalesce-labs) is force-included even when absent from --orgs.
#
# Run: bash plugins/dev/scripts/__tests__/provision-thoughts.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROVISION="${SCRIPTS_DIR}/provision-thoughts.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# A throwaway HL_CONFIG so nothing ever touches the real ~/.config/humanlayer.
# (--dry-run never writes, but we point at scratch as defense-in-depth.)
HL_CONFIG_FILE="$SCRATCH/humanlayer.json"

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    PASSES=$((PASSES + 1))
    echo "  PASS: $label"
  else
    FAILURES=$((FAILURES + 1))
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
  fi
}

assert_grep() {
  local label="$1" output="$2" pattern="$3"
  if grep -qF -- "$pattern" <<<"$output"; then
    PASSES=$((PASSES + 1))
    echo "  PASS: $label"
  else
    FAILURES=$((FAILURES + 1))
    echo "  FAIL: $label"
    echo "    expected substring: $pattern"
    echo "    actual output:"
    echo "$output" | head -40 | sed 's/^/      /'
  fi
}

assert_not_grep() {
  local label="$1" output="$2" pattern="$3"
  if grep -qF -- "$pattern" <<<"$output"; then
    FAILURES=$((FAILURES + 1))
    echo "  FAIL: $label (unexpected pattern found)"
    echo "    unexpected substring: $pattern"
    echo "    actual output:"
    echo "$output" | head -40 | sed 's/^/      /'
  else
    PASSES=$((PASSES + 1))
    echo "  PASS: $label"
  fi
}

# Run provision-thoughts.sh hermetically. Always --dry-run --no-clone so it never
# touches the network/git, with HL_CONFIG forced at a scratch file and an empty
# CATALYST_REGISTRY unless explicitly passed.
run_provision() {
  env -i PATH="$PATH" HOME="$SCRATCH/home" USER="testnode" \
    HLT_ROOT="$SCRATCH/hlt" HL_CONFIG="$HL_CONFIG_FILE" \
    bash "$PROVISION" --dry-run --no-clone "$@" 2>&1
}

# Extract just the printed dry-run .thoughts JSON object from script output.
# The script prints "DRY-RUN humanlayer.json .thoughts would be:" then `jq .`
# pretty output. Slice from the first '{' after that banner to EOF and let jq
# re-parse the (single) object.
extract_json() {
  local out="$1"
  awk '/DRY-RUN humanlayer.json .thoughts would be:/{found=1; next} found{print}' <<<"$out" \
    | jq -c . 2>/dev/null
}

echo "=== provision-thoughts.sh hermetic tests ==="
echo "SCRIPT: $PROVISION"
echo "SCRATCH: $SCRATCH"
echo ""

# ─── Phase 1: --orgs derivation, global fallback + profiles ──────────────────
echo "=== Phase 1: --orgs derivation (global fallback never groundworkapp) ==="

ORGS_OUT="$(run_provision --orgs coalesce-labs,rightsite-cloud,ryanrozich)"
ORGS_JSON="$(extract_json "$ORGS_OUT")"

assert_grep "dry-run prints the would-be humanlayer.json banner" "$ORGS_OUT" \
  "DRY-RUN humanlayer.json .thoughts would be:"

# Global fallback thoughtsRepo MUST be the coalesce-labs HLT path.
tr_val="$(jq -r '.thoughtsRepo' <<<"$ORGS_JSON")"
assert_eq "global fallback thoughtsRepo is coalesce-labs HLT path" \
  "$tr_val" "$SCRATCH/hlt/coalesce-labs/thoughts"

# And NEVER groundworkapp anywhere in the payload.
assert_not_grep "no groundworkapp anywhere in dry-run thoughts payload" "$ORGS_JSON" \
  "groundworkapp"

# defaultProfile == coalesce-labs.
dp_val="$(jq -r '.defaultProfile' <<<"$ORGS_JSON")"
assert_eq "defaultProfile is coalesce-labs" "$dp_val" "coalesce-labs"

# A profile entry for each org (mapped through org_profile: rightsite-cloud→adva).
assert_eq "profile entry exists for coalesce-labs" \
  "$(jq -r '.profiles["coalesce-labs"].thoughtsRepo // "MISSING"' <<<"$ORGS_JSON")" \
  "$SCRATCH/hlt/coalesce-labs/thoughts"
assert_eq "profile entry exists for rightsite-cloud (profile key 'adva')" \
  "$(jq -r '.profiles["adva"].thoughtsRepo // "MISSING"' <<<"$ORGS_JSON")" \
  "$SCRATCH/hlt/rightsite-cloud/thoughts"
assert_eq "profile entry exists for ryanrozich" \
  "$(jq -r '.profiles["ryanrozich"].thoughtsRepo // "MISSING"' <<<"$ORGS_JSON")" \
  "$SCRATCH/hlt/ryanrozich/thoughts"
assert_eq "exactly 3 profiles for the 3-org CSV" \
  "$(jq -r '.profiles | length' <<<"$ORGS_JSON")" "3"

# ─── Phase 2: --registry derivation + bug-#1 repoMapping repo field ──────────
echo ""
echo "=== Phase 2: --registry derivation + repoMapping .thoughts.directory ==="

# Synthetic registries covering: (2a) a config-bearing repoRoot maps to its
# declared .thoughts.directory; (2b) a config-LESS repoRoot maps to its basename
# WITHOUT crashing even when it is first in the registry; (2c) a mix where the
# config-less repo correctly uses its OWN basename and does not inherit the
# prior repo's directory. (2b/2c previously documented two write_config bugs —
# a `set -u` crash and a cross-iteration `local sub` leak — now fixed by
# defaulting `sub` to the basename unconditionally before the config branch.)
REPO_CL="$SCRATCH/github/coalesce-labs/catalyst"           # HAS .catalyst.thoughts.directory
REPO_GW="$SCRATCH/github/groundworkapp/groundwork"         # NO config.json
mkdir -p "$REPO_CL/.catalyst" "$REPO_GW"
# Real Layer-1 schema nests the key under the top-level "catalyst" object —
# .catalyst.thoughts.directory (NOT top-level .thoughts.directory). Using the
# real shape here is what makes this a genuine regression guard for the jq-path
# fix in provision-thoughts.sh (CTL-1214 verify).
cat > "$REPO_CL/.catalyst/config.json" <<'EOF'
{"catalyst":{"thoughts":{"directory":"catalyst-workspace"}}}
EOF

# (2a) bug-#1 fixture: a single config-bearing repoRoot. repoMapping repo must be
# the config.json .thoughts.directory ("catalyst-workspace"), NOT basename "catalyst".
REG_CL="$SCRATCH/registry-cl.json"
cat > "$REG_CL" <<EOF
{"projects":[{"repoRoot":"$REPO_CL","team":"CTL"}]}
EOF

REG_OUT="$(run_provision --registry "$REG_CL")"
REG_JSON="$(extract_json "$REG_OUT")"

assert_grep "registry derivation logs the registry path" "$REG_OUT" \
  "Deriving orgs from registry"

# Org set derived from the repoRoot: coalesce-labs (also the forced primary).
assert_eq "registry-derived: coalesce-labs profile present" \
  "$(jq -r '.profiles["coalesce-labs"].thoughtsRepo // "MISSING"' <<<"$REG_JSON")" \
  "$SCRATCH/hlt/coalesce-labs/thoughts"

# bug-#1 fix: repoMapping repo == config.json .thoughts.directory, NOT basename.
cl_repo="$(jq -r --arg p "$REPO_CL" '.repoMappings[$p].repo // "MISSING"' <<<"$REG_JSON")"
assert_eq "repoMapping repo comes from .catalyst/config.json .thoughts.directory" \
  "$cl_repo" "catalyst-workspace"
assert_not_grep "repoMapping repo is NOT the repoRoot basename when config present" \
  "$cl_repo" "catalyst\""
assert_eq "repoMapping for coalesce-labs repo has profile coalesce-labs" \
  "$(jq -r --arg p "$REPO_CL" '.repoMappings[$p].profile // "MISSING"' <<<"$REG_JSON")" \
  "coalesce-labs"

# (2b) org normalization is independent of the config.json: even though this
# config-LESS, groundworkapp-only registry hits a second source bug in the
# config phase (below), the clone-phase org derivation runs first and correctly
# normalizes groundworkapp → rightsite-cloud (and force-includes coalesce-labs).
# Assert on the clone-phase "Node org set" log line + the "WOULD clone" lines,
# which are emitted before the crash.
REG_GW="$SCRATCH/registry-gw.json"
cat > "$REG_GW" <<EOF
{"projects":[{"repoRoot":"$REPO_GW","team":"ADV"}]}
EOF

GW_OUT="$(run_provision --registry "$REG_GW")"

assert_grep "isolated config-less: org set normalizes groundworkapp → rightsite-cloud" \
  "$GW_OUT" "Node org set: coalesce-labs rightsite-cloud"
assert_grep "isolated config-less: would clone rightsite-cloud (normalized) thoughts" \
  "$GW_OUT" "rightsite-cloud/thoughts"
assert_not_grep "isolated config-less: never derives a groundworkapp HLT dir" \
  "$GW_OUT" "hlt/groundworkapp"

# (2b-fix) A registry whose FIRST repoRoot has no .catalyst/config.json must NOT
# crash: write_config defaults `sub` to the basename unconditionally before the
# config branch, so there is no `set -u` unbound-variable abort and the DRY-RUN
# payload is printed. The config-less repo maps to its basename ("groundwork").
assert_not_grep "config-less-first: no 'sub: unbound variable' crash" \
  "$GW_OUT" "sub: unbound variable"
assert_grep "config-less-first: DRY-RUN payload IS printed (config phase completes)" \
  "$GW_OUT" "DRY-RUN humanlayer.json .thoughts would be:"
GW_JSON="$(extract_json "$GW_OUT")"
assert_eq "config-less repo maps to its repoRoot basename" \
  "$(jq -r --arg p "$REPO_GW" '.repoMappings[$p].repo // "MISSING"' <<<"$GW_JSON")" \
  "groundwork"

# (2c) Combined registry, config-bearing repo FIRST. The config-bearing repo maps
# to its .thoughts.directory, and the following config-LESS repo correctly uses
# its OWN basename ("groundwork") — NOT the prior repo's directory. This is the
# regression guard for the fixed cross-iteration `local sub` leak.
REG_BOTH="$SCRATCH/registry-both.json"
cat > "$REG_BOTH" <<EOF
{"projects":[
  {"repoRoot":"$REPO_CL","team":"CTL"},
  {"repoRoot":"$REPO_GW","team":"ADV"}
]}
EOF

BOTH_OUT="$(run_provision --registry "$REG_BOTH")"
BOTH_JSON="$(extract_json "$BOTH_OUT")"

assert_eq "combined: config-bearing repo maps to its .thoughts.directory" \
  "$(jq -r --arg p "$REPO_CL" '.repoMappings[$p].repo // "MISSING"' <<<"$BOTH_JSON")" \
  "catalyst-workspace"
assert_eq "combined: config-less repo uses its OWN basename (no cross-iteration leak)" \
  "$(jq -r --arg p "$REPO_GW" '.repoMappings[$p].repo // "MISSING"' <<<"$BOTH_JSON")" \
  "groundwork"
assert_eq "combined: exactly 2 repoMappings (one per registry repoRoot)" \
  "$(jq -r '.repoMappings | length' <<<"$BOTH_JSON")" "2"

# ─── Phase 3: --orgs CSV overrides registry derivation ───────────────────────
echo ""
echo "=== Phase 3: --orgs overrides --registry ==="

# Pass BOTH --orgs and --registry; --orgs must win (registry-only repoRoots'
# orgs that aren't in the CSV must not appear as profiles). Use a CSV that
# excludes rightsite-cloud/adva entirely.
OVR_OUT="$(run_provision --orgs coalesce-labs,ryanrozich --registry "$REG_BOTH")"
OVR_JSON="$(extract_json "$OVR_OUT")"

# org set comes from CSV → exactly coalesce-labs + ryanrozich (no adva profile).
assert_eq "override: profile count is exactly 2 (CSV-derived)" \
  "$(jq -r '.profiles | length' <<<"$OVR_JSON")" "2"
assert_eq "override: coalesce-labs profile present" \
  "$(jq -r '.profiles["coalesce-labs"].thoughtsRepo // "MISSING"' <<<"$OVR_JSON")" \
  "$SCRATCH/hlt/coalesce-labs/thoughts"
assert_eq "override: ryanrozich profile present" \
  "$(jq -r '.profiles["ryanrozich"].thoughtsRepo // "MISSING"' <<<"$OVR_JSON")" \
  "$SCRATCH/hlt/ryanrozich/thoughts"
assert_eq "override: adva profile ABSENT (registry org not in CSV)" \
  "$(jq -r '.profiles["adva"].thoughtsRepo // "ABSENT"' <<<"$OVR_JSON")" \
  "ABSENT"
# But repoMappings still seed from the registry regardless of org override.
assert_eq "override: repoMappings still seeded from registry (2 entries)" \
  "$(jq -r '.repoMappings | length' <<<"$OVR_JSON")" "2"

# ─── Phase 4: primary org force-included even when absent from --orgs ─────────
echo ""
echo "=== Phase 4: primary org (coalesce-labs) force-included ==="

NOPRIM_OUT="$(run_provision --orgs ryanrozich)"
NOPRIM_JSON="$(extract_json "$NOPRIM_OUT")"

# coalesce-labs must be force-prepended → profile present + still the default/fallback.
assert_eq "force-include: coalesce-labs profile present though absent from --orgs" \
  "$(jq -r '.profiles["coalesce-labs"].thoughtsRepo // "MISSING"' <<<"$NOPRIM_JSON")" \
  "$SCRATCH/hlt/coalesce-labs/thoughts"
assert_eq "force-include: defaultProfile still coalesce-labs" \
  "$(jq -r '.defaultProfile' <<<"$NOPRIM_JSON")" "coalesce-labs"
assert_eq "force-include: global thoughtsRepo still coalesce-labs HLT path" \
  "$(jq -r '.thoughtsRepo' <<<"$NOPRIM_JSON")" \
  "$SCRATCH/hlt/coalesce-labs/thoughts"
assert_eq "force-include: ryanrozich also present (2 profiles total)" \
  "$(jq -r '.profiles | length' <<<"$NOPRIM_JSON")" "2"

# Sanity: the real HL config file was never created (dry-run is side-effect-free).
assert_eq "HL_CONFIG file never written under --dry-run" \
  "$([[ -e "$HL_CONFIG_FILE" ]] && echo EXISTS || echo ABSENT)" "ABSENT"

# ─── Phase 5: empty/unrecognized registry must not crash (set -u, bash 3.2) ──
echo ""
echo "=== Phase 5: registry yielding zero recognized orgs ==="
# A registry whose repoRoots match no /github/<org>/<repo> path → ORGS empty
# during derivation. Under `set -u`, macOS system bash 3.2 aborts on an empty
# "${ORGS[@]}" expansion; the script must instead fall back to the primary org.
REG_NONE="$SCRATCH/registry-none.json"
cat > "$REG_NONE" <<EOF
{"projects":[{"repoRoot":"/var/tmp/not-a-github-path/repo","team":"X"}]}
EOF

NONE_OUT="$(run_provision --registry "$REG_NONE")"
assert_not_grep "zero-recognized-org registry does not crash (no unbound variable)" \
  "$NONE_OUT" "unbound variable"
NONE_JSON="$(extract_json "$NONE_OUT")"
assert_eq "zero-recognized-org registry falls back to primary coalesce-labs" \
  "$(jq -r '.defaultProfile // "MISSING"' <<<"$NONE_JSON")" "coalesce-labs"

# Explicitly exercise the bash-3.2 set -u path when the system bash is 3.x
# (macOS). On Linux / bash 5 this is skipped (the empty-array trap is bash-3.2
# specific); bash 5 tolerates the expansion, so the assertion above is the
# cross-platform guard and this is the platform-specific reproduction.
if [[ -x /bin/bash ]] && /bin/bash -c '[[ ${BASH_VERSINFO[0]} -lt 4 ]]' 2>/dev/null; then
  B32_OUT="$(env -i PATH="$PATH" HOME="$SCRATCH/home" USER="testnode" \
    HLT_ROOT="$SCRATCH/hlt" HL_CONFIG="$HL_CONFIG_FILE" \
    /bin/bash "$PROVISION" --dry-run --no-clone --registry "$REG_NONE" 2>&1)"
  assert_not_grep "bash 3.2: zero-recognized-org registry does not abort with unbound variable" \
    "$B32_OUT" "unbound variable"
else
  echo "  SKIP: system bash is not 3.x (no bash-3.2 empty-array repro on this host)"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Results ==="
echo "PASS: $PASSES"
echo "FAIL: $FAILURES"
echo ""
echo "provision-thoughts.test.sh: ${PASSES} passed, ${FAILURES} failed"

exit "$FAILURES"
