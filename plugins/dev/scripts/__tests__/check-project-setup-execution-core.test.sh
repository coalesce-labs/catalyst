#!/usr/bin/env bash
# Tests for the check-project-setup.sh execution-core verification block (CTL-564
# Phase 4). When dispatchMode is execution-core, the script must verify the
# contract states are present in stateMap/stateIds and a registry entry exists,
# emitting warnings (never errors) for any gap.
#
# Run: bash plugins/dev/scripts/__tests__/check-project-setup-execution-core.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SCRIPT="${REPO_ROOT}/plugins/dev/scripts/check-project-setup.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; }

# build_project <dir> <dispatchMode> <full-contract:0|1> <registry-entry:0|1>
# Writes an isolated fixture repo with a .catalyst/config.json and a temp
# CATALYST_DIR holding a registry.json.
build_project() {
  local dir="$1" mode="$2" full="$3" registry="$4"
  mkdir -p "$dir/.catalyst"
  mkdir -p "$dir/thoughts/shared/research" "$dir/thoughts/shared/plans" \
    "$dir/thoughts/shared/handoffs" "$dir/thoughts/shared/prs" "$dir/thoughts/shared/reports"

  local state_map state_ids
  if [[ $full == "1" ]]; then
    state_map='{"backlog":"Backlog","todo":"Ready","triage":"Triage","research":"Research","planning":"Plan","inProgress":"Implement","verifying":"Validate","reviewing":"Validate","inReview":"PR","done":"Done","canceled":"Canceled"}'
    state_ids='{"Backlog":"id-b","Triage":"id-t","Ready":"id-rd","Research":"id-rs","Plan":"id-pl","Implement":"id-im","Validate":"id-va","PR":"id-pr","Done":"id-dn","Canceled":"id-cn"}'
  else
    # missing Validate and PR from both stateMap values and stateIds keys
    state_map='{"backlog":"Backlog","todo":"Ready","triage":"Triage","research":"Research","planning":"Plan","inProgress":"Implement","done":"Done","canceled":"Canceled"}'
    state_ids='{"Backlog":"id-b","Triage":"id-t","Ready":"id-rd","Research":"id-rs","Plan":"id-pl","Implement":"id-im","Done":"id-dn","Canceled":"id-cn"}'
  fi

  cat > "$dir/.catalyst/config.json" <<EOF
{
  "catalyst": {
    "projectKey": "test-project",
    "project": { "ticketPrefix": "CTL" },
    "linear": {
      "teamKey": "CTL",
      "stateMap": ${state_map},
      "stateIds": ${state_ids}
    },
    "orchestration": { "dispatchMode": "${mode}" }
  }
}
EOF

  local catalyst_dir="${dir}.catalyst-home"
  mkdir -p "${catalyst_dir}/execution-core"
  if [[ $registry == "1" ]]; then
    cat > "${catalyst_dir}/execution-core/registry.json" <<EOF
{ "projects": [ { "team": "CTL", "repoRoot": "${dir}", "eligibleQuery": { "status": "Ready" } } ] }
EOF
  else
    echo '{ "projects": [] }' > "${catalyst_dir}/execution-core/registry.json"
  fi
  echo "$catalyst_dir"
}

# run_check <project-dir> <catalyst-dir> — run the script, capture output.
run_check() {
  local cwd="$1" catalyst_dir="$2"
  ( cd "$cwd" \
    && env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" \
       CATALYST_AUTONOMOUS=1 CATALYST_DIR="$catalyst_dir" \
       bash "$SCRIPT" 2>&1 )
}

echo "check-project-setup execution-core tests"

# ─── Test 1: phase-agents → no execution-core contract warning ───────────────
P1="${SCRATCH}/p1"
CD1="$(build_project "$P1" "phase-agents" 1 0)"
OUT1="$(run_check "$P1" "$CD1" || true)"
if ! grep -qiE "contract state|execution-core registry entry" <<<"$OUT1"; then
  pass "phase-agents repo emits no execution-core contract warning"
else
  fail "phase-agents repo emits no execution-core contract warning"
  echo "$OUT1" | sed 's/^/    /'
fi

# ─── Test 2: execution-core, missing Validate/PR → warns about contract states
P2="${SCRATCH}/p2"
CD2="$(build_project "$P2" "execution-core" 0 1)"
OUT2="$(run_check "$P2" "$CD2" || true)"
if grep -qiE "Validate" <<<"$OUT2" && grep -qiE "contract state" <<<"$OUT2"; then
  pass "execution-core repo warns about missing contract states"
else
  fail "execution-core repo warns about missing contract states"
  echo "$OUT2" | sed 's/^/    /'
fi

# ─── Test 3: execution-core, contract present, no registry entry → warns ──────
P3="${SCRATCH}/p3"
CD3="$(build_project "$P3" "execution-core" 1 0)"
OUT3="$(run_check "$P3" "$CD3" || true)"
if grep -qiE "registry entry" <<<"$OUT3"; then
  pass "execution-core repo warns about missing registry entry"
else
  fail "execution-core repo warns about missing registry entry"
  echo "$OUT3" | sed 's/^/    /'
fi

# ─── Test 4: execution-core, contract present + registry entry → no warning ───
P4="${SCRATCH}/p4"
CD4="$(build_project "$P4" "execution-core" 1 1)"
OUT4="$(run_check "$P4" "$CD4" || true)"
if ! grep -qiE "contract state|registry entry" <<<"$OUT4"; then
  pass "fully-configured execution-core repo emits no execution-core warning"
else
  fail "fully-configured execution-core repo emits no execution-core warning"
  echo "$OUT4" | sed 's/^/    /'
fi

# ─── Test 5: execution-core warnings never set exit 1 (warnings-only → exit 0) ─
P5="${SCRATCH}/p5"
CD5="$(build_project "$P5" "execution-core" 0 0)"
run_check "$P5" "$CD5" > /dev/null 2>&1
RC5=$?
if [[ $RC5 -eq 0 ]]; then
  pass "execution-core gap stays a warning — script still exits 0"
else
  fail "execution-core gap stays a warning — script still exits 0 (got rc=$RC5)"
fi

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[ "$FAILURES" = "0" ]
