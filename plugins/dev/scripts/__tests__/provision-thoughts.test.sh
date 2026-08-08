#!/usr/bin/env bash
# Tests for provision-thoughts.sh (CTL-1214 / bug #6; re-scoped 2026-08-01 for the
# thagale/catalyst fork — see git history for the original upstream
# coalesce-labs/rightsite-cloud/ryanrozich/groundworkapp version, which tested a
# per-org profile-name catalog and a groundworkapp→rightsite-cloud normalization
# that only applied to the upstream author's own multi-client orgs).
# Hermetic — exercises only the dry-run / no-clone / verify-only seams plus the
# HLT_ROOT / HL_CONFIG / CATALYST_REGISTRY env overrides. NO real git clone, NO
# network, NO real gh. Asserts the would-be humanlayer.json .thoughts payload the
# script prints under --dry-run.
#
# Covered:
#  1. --orgs derivation → global fallback (.thoughts.thoughtsRepo) is the
#     operator-org (PRIMARY_ORG) HLT path, defaultProfile operator-org,
#     and a profile entry per org (org_profile is identity — profile == org).
#  2. --registry derivation → org set from registry repoRoots, and the bug-#1 fix:
#     repoMapping 'repo' comes from each repoRoot's .catalyst/config.json
#     .thoughts.directory (not the basename) when present.
#  3. --orgs CSV overrides registry derivation.
#  4. Primary org (operator-org) is force-included even when absent from --orgs.
#  5. A registry yielding zero recognized orgs falls back to the primary org,
#     without an unbound-variable abort (macOS bash 3.2 empty-array guard).
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

# Same, but with CATALYST_PROVISION_THOUGHTS_PRIMARY_ORG set — for exercising the
# optional primary-org override (force-include + global-fallback + failure-avoidance).
run_provision_with_primary() {
  local primary="$1"; shift
  env -i PATH="$PATH" HOME="$SCRATCH/home" USER="testnode" \
    HLT_ROOT="$SCRATCH/hlt" HL_CONFIG="$HL_CONFIG_FILE" \
    CATALYST_PROVISION_THOUGHTS_PRIMARY_ORG="$primary" \
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
echo "=== Phase 1: --orgs derivation (global fallback is PRIMARY_ORG) ==="

ORGS_OUT="$(run_provision --orgs operator-org,org-b,org-c)"
ORGS_JSON="$(extract_json "$ORGS_OUT")"

assert_grep "dry-run prints the would-be humanlayer.json banner" "$ORGS_OUT" \
  "DRY-RUN humanlayer.json .thoughts would be:"

# Global fallback thoughtsRepo MUST be the operator-org (PRIMARY_ORG) HLT path.
tr_val="$(jq -r '.thoughtsRepo' <<<"$ORGS_JSON")"
assert_eq "global fallback thoughtsRepo is operator-org HLT path" \
  "$tr_val" "$SCRATCH/hlt/operator-org/thoughts"

# defaultProfile == operator-org.
dp_val="$(jq -r '.defaultProfile' <<<"$ORGS_JSON")"
assert_eq "defaultProfile is operator-org" "$dp_val" "operator-org"

# A profile entry for each org (org_profile is identity — profile always == org).
assert_eq "profile entry exists for operator-org" \
  "$(jq -r '.profiles["operator-org"].thoughtsRepo // "MISSING"' <<<"$ORGS_JSON")" \
  "$SCRATCH/hlt/operator-org/thoughts"
assert_eq "profile entry exists for org-b" \
  "$(jq -r '.profiles["org-b"].thoughtsRepo // "MISSING"' <<<"$ORGS_JSON")" \
  "$SCRATCH/hlt/org-b/thoughts"
assert_eq "profile entry exists for org-c" \
  "$(jq -r '.profiles["org-c"].thoughtsRepo // "MISSING"' <<<"$ORGS_JSON")" \
  "$SCRATCH/hlt/org-c/thoughts"
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
REPO_HT="$SCRATCH/github/operator-org/catalyst"      # HAS .catalyst.thoughts.directory
REPO_OTHER="$SCRATCH/github/other-org/widget"              # NO config.json
mkdir -p "$REPO_HT/.catalyst" "$REPO_OTHER"
# Real Layer-1 schema nests the key under the top-level "catalyst" object —
# .catalyst.thoughts.directory (NOT top-level .thoughts.directory). Using the
# real shape here is what makes this a genuine regression guard for the jq-path
# fix in provision-thoughts.sh (CTL-1214 verify).
cat > "$REPO_HT/.catalyst/config.json" <<'EOF'
{"catalyst":{"thoughts":{"directory":"catalyst-workspace"}}}
EOF

# (2a) bug-#1 fixture: a single config-bearing repoRoot. repoMapping repo must be
# the config.json .thoughts.directory ("catalyst-workspace"), NOT basename "catalyst".
REG_HT="$SCRATCH/registry-ht.json"
cat > "$REG_HT" <<EOF
{"projects":[{"repoRoot":"$REPO_HT","team":"CAT"}]}
EOF

REG_OUT="$(run_provision --registry "$REG_HT")"
REG_JSON="$(extract_json "$REG_OUT")"

assert_grep "registry derivation logs the registry path" "$REG_OUT" \
  "Deriving orgs from registry"

# Org set derived from the repoRoot: operator-org (also the forced primary).
assert_eq "registry-derived: operator-org profile present" \
  "$(jq -r '.profiles["operator-org"].thoughtsRepo // "MISSING"' <<<"$REG_JSON")" \
  "$SCRATCH/hlt/operator-org/thoughts"

# bug-#1 fix: repoMapping repo == config.json .thoughts.directory, NOT basename.
ht_repo="$(jq -r --arg p "$REPO_HT" '.repoMappings[$p].repo // "MISSING"' <<<"$REG_JSON")"
assert_eq "repoMapping repo comes from .catalyst/config.json .thoughts.directory" \
  "$ht_repo" "catalyst-workspace"
assert_not_grep "repoMapping repo is NOT the repoRoot basename when config present" \
  "$ht_repo" "catalyst\""
assert_eq "repoMapping for operator-org repo has profile operator-org" \
  "$(jq -r --arg p "$REPO_HT" '.repoMappings[$p].profile // "MISSING"' <<<"$REG_JSON")" \
  "operator-org"

# (2b) A second, unrelated org's config-LESS repoRoot resolves via plain identity
# (org_profile == org, repo_root_org with no normalization step). No
# CATALYST_PROVISION_THOUGHTS_PRIMARY_ORG is set here, so nothing is force-included
# — the org set is exactly the registry-derived org, which also becomes the
# primary/global-fallback (see Phase 4a below for that specific assertion).
REG_OTHER="$SCRATCH/registry-other.json"
cat > "$REG_OTHER" <<EOF
{"projects":[{"repoRoot":"$REPO_OTHER","team":"WID"}]}
EOF

OTHER_OUT="$(run_provision --registry "$REG_OTHER")"

assert_grep "isolated config-less: org set is exactly the registry org (no override to force-include)" \
  "$OTHER_OUT" "Node org set: other-org"
assert_grep "isolated config-less: would clone the registry org's own thoughts repo" \
  "$OTHER_OUT" "other-org/thoughts"

# (2b-fix) A registry whose FIRST repoRoot has no .catalyst/config.json must NOT
# crash: write_config defaults `sub` to the basename unconditionally before the
# config branch, so there is no `set -u` unbound-variable abort and the DRY-RUN
# payload is printed. The config-less repo maps to its basename ("widget").
assert_not_grep "config-less-first: no 'sub: unbound variable' crash" \
  "$OTHER_OUT" "sub: unbound variable"
assert_grep "config-less-first: DRY-RUN payload IS printed (config phase completes)" \
  "$OTHER_OUT" "DRY-RUN humanlayer.json .thoughts would be:"
OTHER_JSON="$(extract_json "$OTHER_OUT")"
assert_eq "config-less repo maps to its repoRoot basename" \
  "$(jq -r --arg p "$REPO_OTHER" '.repoMappings[$p].repo // "MISSING"' <<<"$OTHER_JSON")" \
  "widget"

# (2c) Combined registry, config-bearing repo FIRST. The config-bearing repo maps
# to its .thoughts.directory, and the following config-LESS repo correctly uses
# its OWN basename ("widget") — NOT the prior repo's directory. This is the
# regression guard for the fixed cross-iteration `local sub` leak.
REG_BOTH="$SCRATCH/registry-both.json"
cat > "$REG_BOTH" <<EOF
{"projects":[
  {"repoRoot":"$REPO_HT","team":"CAT"},
  {"repoRoot":"$REPO_OTHER","team":"WID"}
]}
EOF

BOTH_OUT="$(run_provision --registry "$REG_BOTH")"
BOTH_JSON="$(extract_json "$BOTH_OUT")"

assert_eq "combined: config-bearing repo maps to its .thoughts.directory" \
  "$(jq -r --arg p "$REPO_HT" '.repoMappings[$p].repo // "MISSING"' <<<"$BOTH_JSON")" \
  "catalyst-workspace"
assert_eq "combined: config-less repo uses its OWN basename (no cross-iteration leak)" \
  "$(jq -r --arg p "$REPO_OTHER" '.repoMappings[$p].repo // "MISSING"' <<<"$BOTH_JSON")" \
  "widget"
assert_eq "combined: exactly 2 repoMappings (one per registry repoRoot)" \
  "$(jq -r '.repoMappings | length' <<<"$BOTH_JSON")" "2"

# ─── Phase 3: --orgs CSV overrides registry derivation ───────────────────────
echo ""
echo "=== Phase 3: --orgs overrides --registry ==="

# Pass BOTH --orgs and --registry; --orgs must win (registry-only repoRoots'
# orgs that aren't in the CSV must not appear as profiles). Use a CSV that
# excludes other-org entirely.
OVR_OUT="$(run_provision --orgs operator-org,org-b --registry "$REG_BOTH")"
OVR_JSON="$(extract_json "$OVR_OUT")"

# org set comes from CSV → exactly operator-org + org-b (no other-org profile).
assert_eq "override: profile count is exactly 2 (CSV-derived)" \
  "$(jq -r '.profiles | length' <<<"$OVR_JSON")" "2"
assert_eq "override: operator-org profile present" \
  "$(jq -r '.profiles["operator-org"].thoughtsRepo // "MISSING"' <<<"$OVR_JSON")" \
  "$SCRATCH/hlt/operator-org/thoughts"
assert_eq "override: org-b profile present" \
  "$(jq -r '.profiles["org-b"].thoughtsRepo // "MISSING"' <<<"$OVR_JSON")" \
  "$SCRATCH/hlt/org-b/thoughts"
assert_eq "override: other-org profile ABSENT (registry org not in CSV)" \
  "$(jq -r '.profiles["other-org"].thoughtsRepo // "ABSENT"' <<<"$OVR_JSON")" \
  "ABSENT"
# But repoMappings still seed from the registry regardless of org override.
assert_eq "override: repoMappings still seeded from registry (2 entries)" \
  "$(jq -r '.repoMappings | length' <<<"$OVR_JSON")" "2"

# ─── Phase 4: primary org — implicit (first --orgs entry) vs. explicit override ─
echo ""
echo "=== Phase 4: primary/global-fallback org resolution ==="

# (4a) No CATALYST_PROVISION_THOUGHTS_PRIMARY_ORG set: with no override, the
# primary/global-fallback org is simply whichever org came out first — no
# force-include of anything else, since there is nothing to force.
NOPRIM_OUT="$(run_provision --orgs org-b)"
NOPRIM_JSON="$(extract_json "$NOPRIM_OUT")"

assert_eq "no override: defaultProfile is the first (only) --orgs entry" \
  "$(jq -r '.defaultProfile' <<<"$NOPRIM_JSON")" "org-b"
assert_eq "no override: global thoughtsRepo matches org-b's HLT path" \
  "$(jq -r '.thoughtsRepo' <<<"$NOPRIM_JSON")" \
  "$SCRATCH/hlt/org-b/thoughts"
assert_eq "no override: exactly 1 profile (nothing force-included)" \
  "$(jq -r '.profiles | length' <<<"$NOPRIM_JSON")" "1"

# (4b) CATALYST_PROVISION_THOUGHTS_PRIMARY_ORG set: it IS force-prepended even
# when absent from --orgs, and remains the global fallback/defaultProfile.
FORCE_OUT="$(run_provision_with_primary "operator-org" --orgs org-b)"
FORCE_JSON="$(extract_json "$FORCE_OUT")"

assert_eq "override: primary-org profile present though absent from --orgs" \
  "$(jq -r '.profiles["operator-org"].thoughtsRepo // "MISSING"' <<<"$FORCE_JSON")" \
  "$SCRATCH/hlt/operator-org/thoughts"
assert_eq "override: defaultProfile is the override" \
  "$(jq -r '.defaultProfile' <<<"$FORCE_JSON")" "operator-org"
assert_eq "override: global thoughtsRepo is the override's HLT path" \
  "$(jq -r '.thoughtsRepo' <<<"$FORCE_JSON")" \
  "$SCRATCH/hlt/operator-org/thoughts"
assert_eq "override: org-b also present (2 profiles total)" \
  "$(jq -r '.profiles | length' <<<"$FORCE_JSON")" "2"

# Sanity: the real HL config file was never created (dry-run is side-effect-free).
assert_eq "HL_CONFIG file never written under --dry-run" \
  "$([[ -e "$HL_CONFIG_FILE" ]] && echo EXISTS || echo ABSENT)" "ABSENT"

# ─── Phase 5: empty/unrecognized registry — fail loud, or fall back to override ─
echo ""
echo "=== Phase 5: registry yielding zero recognized orgs ==="
# A registry whose repoRoots match no /github/<org>/<repo> path → ORGS empty
# during derivation. Under `set -u`, macOS system bash 3.2 aborts on an empty
# "${ORGS[@]}" expansion — the script must never crash on this, but with no
# override configured it correctly has no way to guess an org and must fail
# loudly (not silently default to some hardcoded name).
REG_NONE="$SCRATCH/registry-none.json"
cat > "$REG_NONE" <<EOF
{"projects":[{"repoRoot":"/var/tmp/not-a-github-path/repo","team":"X"}]}
EOF

NONE_OUT="$(run_provision --registry "$REG_NONE")"; NONE_RC=$?
assert_not_grep "zero-recognized-org registry does not crash (no unbound variable)" \
  "$NONE_OUT" "unbound variable"
assert_eq "zero-recognized-org + no override: exits non-zero (fails loud, no silent default)" \
  "$NONE_RC" "1"
assert_grep "zero-recognized-org + no override: clear error naming the override env var" \
  "$NONE_OUT" "CATALYST_PROVISION_THOUGHTS_PRIMARY_ORG"

# With the override set, the same zero-recognized-org registry falls back to it
# cleanly instead of failing.
NONE_OVR_OUT="$(run_provision_with_primary "operator-org" --registry "$REG_NONE")"
assert_not_grep "zero-recognized-org + override: does not crash (no unbound variable)" \
  "$NONE_OVR_OUT" "unbound variable"
NONE_OVR_JSON="$(extract_json "$NONE_OVR_OUT")"
assert_eq "zero-recognized-org + override: falls back to the override org" \
  "$(jq -r '.defaultProfile // "MISSING"' <<<"$NONE_OVR_JSON")" "operator-org"

# Explicitly exercise the bash-3.2 set -u path when the system bash is 3.x
# (macOS). On Linux / bash 5 this is skipped (the empty-array trap is bash-3.2
# specific); bash 5 tolerates the expansion, so the assertions above are the
# cross-platform guard and this is the platform-specific reproduction.
if [[ -x /bin/bash ]] && /bin/bash -c '[[ ${BASH_VERSINFO[0]} -lt 4 ]]' 2>/dev/null; then
  B32_OUT="$(env -i PATH="$PATH" HOME="$SCRATCH/home" USER="testnode" \
    HLT_ROOT="$SCRATCH/hlt" HL_CONFIG="$HL_CONFIG_FILE" \
    CATALYST_PROVISION_THOUGHTS_PRIMARY_ORG="operator-org" \
    /bin/bash "$PROVISION" --dry-run --no-clone --registry "$REG_NONE" 2>&1)"
  assert_not_grep "bash 3.2: zero-recognized-org registry does not abort with unbound variable" \
    "$B32_OUT" "unbound variable"
else
  echo "  SKIP: system bash is not 3.x (no bash-3.2 empty-array repro on this host)"
fi

# ─── Phase 6: catalyst.thoughts.org is the thoughts owner ────────────────────
# The regression this locks (Codex #3080 P1): a project's thoughts owner is NOT
# derivable from its checkout path or its HumanLayer profile alias. The real
# fleet shape — code under /github/<code-org>/<repo>, thoughts under a DIFFERENT
# GitHub org, reached through a third name as the profile — must round-trip.
echo ""
echo "=== Phase 6: catalyst.thoughts.org drives the thoughts owner ==="

REPO_SPLIT="$SCRATCH/github/code-org/product"
mkdir -p "$REPO_SPLIT/.catalyst"
cat > "$REPO_SPLIT/.catalyst/config.json" <<'EOF'
{"catalyst":{"thoughts":{"org":"thoughts-org","profile":"alias","directory":"product-notes"}}}
EOF
REG_SPLIT="$SCRATCH/registry-split.json"
cat > "$REG_SPLIT" <<EOF
{"projects":[{"repoRoot":"$REPO_SPLIT","team":"SPL"}]}
EOF

SPLIT_OUT="$(run_provision --registry "$REG_SPLIT")"
SPLIT_JSON="$(extract_json "$SPLIT_OUT")"

assert_grep "split-org: clones the thoughts.org repo, not the checkout's own org" \
  "$SPLIT_OUT" "thoughts-org/thoughts"
assert_not_grep "split-org: never derives an HLT dir from the CODE org" \
  "$SPLIT_OUT" "hlt/code-org"
assert_not_grep "split-org: never treats the profile alias as a GitHub org" \
  "$SPLIT_OUT" "hlt/alias"
assert_eq "split-org: profile key is the declared alias, pointing at the thoughts.org HLT path" \
  "$(jq -r '.profiles["alias"].thoughtsRepo // "MISSING"' <<<"$SPLIT_JSON")" \
  "$SCRATCH/hlt/thoughts-org/thoughts"
assert_eq "split-org: repoMapping profile is the alias (org and profile may differ)" \
  "$(jq -r --arg p "$REPO_SPLIT" '.repoMappings[$p].profile // "MISSING"' <<<"$SPLIT_JSON")" \
  "alias"
assert_eq "split-org: repoMapping repo still comes from .thoughts.directory" \
  "$(jq -r --arg p "$REPO_SPLIT" '.repoMappings[$p].repo // "MISSING"' <<<"$SPLIT_JSON")" \
  "product-notes"

# A project declaring ONLY a profile falls back to it as the org — loudly, since
# that is right only when the two names coincide.
REPO_PROF="$SCRATCH/github/code-org/legacy"
mkdir -p "$REPO_PROF/.catalyst"
cat > "$REPO_PROF/.catalyst/config.json" <<'EOF'
{"catalyst":{"thoughts":{"profile":"legacy-org"}}}
EOF
REG_PROF="$SCRATCH/registry-prof.json"
cat > "$REG_PROF" <<EOF
{"projects":[{"repoRoot":"$REPO_PROF","team":"LEG"}]}
EOF

PROF_OUT="$(run_provision --registry "$REG_PROF")"
assert_grep "profile-only: WARNs that thoughts.org is unset before falling back" \
  "$PROF_OUT" "catalyst.thoughts.org is unset"
assert_grep "profile-only: falls back to the profile as the org (does not abort)" \
  "$PROF_OUT" "legacy-org/thoughts"

# --primary-org beats registry ORDER for the global fallback (Codex #3080 P1).
REG_ORDER="$SCRATCH/registry-order.json"
cat > "$REG_ORDER" <<EOF
{"projects":[
  {"repoRoot":"$REPO_SPLIT","team":"SPL"},
  {"repoRoot":"$REPO_HT","team":"CAT"}
]}
EOF
ORDER_OUT="$(env -i PATH="$PATH" HOME="$SCRATCH/home" USER="testnode" \
  HLT_ROOT="$SCRATCH/hlt" HL_CONFIG="$HL_CONFIG_FILE" \
  bash "$PROVISION" --dry-run --no-clone --registry "$REG_ORDER" \
  --primary-org operator-org 2>&1)"
ORDER_JSON="$(extract_json "$ORDER_OUT")"
assert_eq "--primary-org wins over the registry's first project" \
  "$(jq -r '.defaultProfile' <<<"$ORDER_JSON")" "operator-org"
assert_eq "--primary-org sets the global thoughtsRepo" \
  "$(jq -r '.thoughtsRepo' <<<"$ORDER_JSON")" "$SCRATCH/hlt/operator-org/thoughts"
assert_grep "--primary-org echoes the resolved primary for the caller to read back" \
  "$ORDER_OUT" "Primary org: operator-org"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Results ==="
echo "PASS: $PASSES"
echo "FAIL: $FAILURES"
echo ""
echo "provision-thoughts.test.sh: ${PASSES} passed, ${FAILURES} failed"

exit "$FAILURES"
