#!/usr/bin/env bash
# Tests for adr-drift.sh — the ADR-drift detector (CTL-459).
# Run: bash plugins/dev/scripts/__tests__/adr-drift-detector.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SCRIPT="${REPO_ROOT}/plugins/dev/scripts/morning-briefing/adr-drift.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    PASSES=$((PASSES + 1))
    echo "  PASS: $label"
  else
    FAILURES=$((FAILURES + 1))
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
  fi
}

assert_json_eq() {
  local label="$1" expected_jq="$2" actual_json="$3" expected_val="$4"
  local val
  val=$(jq -r "$expected_jq" <<<"$actual_json" 2>/dev/null || echo "JQ_ERR")
  assert_eq "$label" "$expected_val" "$val"
}

assert_exit_code() {
  local label="$1" expected="$2" actual="$3"
  assert_eq "$label" "$expected" "$actual"
}

# ---- fixture builders ---------------------------------------------------------

# Build a project tree with an ADR directory and a code tree.
#   $1 — project root dir
make_project() {
  local root="$1"
  mkdir -p "$root/docs/adrs" "$root/src" "$root/.catalyst"
  cat > "$root/.catalyst/config.json" <<'EOF'
{
  "catalyst": {
    "projectKey": "test",
    "adrs": { "directory": "docs/adrs" }
  }
}
EOF
}

write_adr() {
  local path="$1" frontmatter="$2" body="${3:-}"
  cat > "$path" <<EOF
---
${frontmatter}
---

# $(basename "$path" .md)

${body}
EOF
}

# ---- Test 1: empty / missing dir produces no decisions ------------------------

echo "Test 1: missing adrs-dir produces no false positives"
PROJ="$SCRATCH/proj1"
mkdir -p "$PROJ"
# No docs/adrs, no .catalyst config
OUT=$(bash "$SCRIPT" --root "$PROJ" 2>&1)
RC=$?
assert_exit_code "1.1 exit 0 when no ADRs dir" "0" "$RC"
assert_json_eq "1.2 decisions empty" '.decisions | length' "$OUT" "0"

# ---- Test 2: ADR with passing assertion → no drift ----------------------------

echo "Test 2: ADR assertion matches code → no drift"
PROJ="$SCRATCH/proj2"
make_project "$PROJ"
echo "function getThing() { return 42; }" > "$PROJ/src/lib.js"
write_adr "$PROJ/docs/adrs/0001-getthing.md" 'adr_id: ADR-001
code_assertions:
  - pattern: "getThing"
    expectation: found
    description: "getThing function exists"'
OUT=$(bash "$SCRIPT" --root "$PROJ" 2>&1)
RC=$?
assert_exit_code "2.1 exit 0" "0" "$RC"
assert_json_eq "2.2 decisions empty (assertion held)" '.decisions | length' "$OUT" "0"

# ---- Test 3: adr_ahead_of_code drift ------------------------------------------

echo "Test 3: pattern not in code, expectation=found → adr_ahead_of_code"
PROJ="$SCRATCH/proj3"
make_project "$PROJ"
echo "// no relevant code here" > "$PROJ/src/lib.js"
write_adr "$PROJ/docs/adrs/0002-missing.md" 'adr_id: ADR-002
code_assertions:
  - pattern: "MissingFunction"
    expectation: found
    description: "ADR requires MissingFunction in codebase"'
OUT=$(bash "$SCRIPT" --root "$PROJ" 2>&1)
RC=$?
assert_exit_code "3.1 exit 0" "0" "$RC"
assert_json_eq "3.2 one decision" '.decisions | length' "$OUT" "1"
assert_json_eq "3.3 type=adr_drift" '.decisions[0].type' "$OUT" "adr_drift"
assert_json_eq "3.4 drift_status correct" '.decisions[0].drift_status' "$OUT" "adr_ahead_of_code"
assert_json_eq "3.5 status=open" '.decisions[0].status' "$OUT" "open"
assert_json_eq "3.6 has summary" '.decisions[0].summary | length > 0' "$OUT" "true"
assert_json_eq "3.7 has id" '.decisions[0].id | length > 0' "$OUT" "true"
assert_json_eq "3.8 adr path set" '.decisions[0].adr | test("0002-missing.md$")' "$OUT" "true"

# ---- Test 4: code_ahead_of_adr drift ------------------------------------------

echo "Test 4: pattern in code, expectation=not_found → code_ahead_of_adr"
PROJ="$SCRATCH/proj4"
make_project "$PROJ"
echo "const NEW_API = require('./new-api');" > "$PROJ/src/lib.js"
write_adr "$PROJ/docs/adrs/0003-stale.md" 'adr_id: ADR-003
code_assertions:
  - pattern: "NEW_API"
    expectation: not_found
    description: "Old ADR forbade NEW_API but it has shipped"'
OUT=$(bash "$SCRIPT" --root "$PROJ" 2>&1)
RC=$?
assert_exit_code "4.1 exit 0" "0" "$RC"
assert_json_eq "4.2 one decision" '.decisions | length' "$OUT" "1"
assert_json_eq "4.3 drift_status correct" '.decisions[0].drift_status' "$OUT" "code_ahead_of_adr"

# ---- Test 5: ADR without code_assertions is skipped ---------------------------

echo "Test 5: ADR without code_assertions → no decisions"
PROJ="$SCRATCH/proj5"
make_project "$PROJ"
write_adr "$PROJ/docs/adrs/0004-narrative.md" 'adr_id: ADR-004
title: "Decision without assertions"'
OUT=$(bash "$SCRIPT" --root "$PROJ" 2>&1)
RC=$?
assert_exit_code "5.1 exit 0" "0" "$RC"
assert_json_eq "5.2 no decisions" '.decisions | length' "$OUT" "0"

# ---- Test 6: multiple assertions, mixed pass/fail -----------------------------

echo "Test 6: multiple assertions in one ADR"
PROJ="$SCRATCH/proj6"
make_project "$PROJ"
echo "function alpha() {}" > "$PROJ/src/code.js"
# alpha: found (passes), beta: not found (fails), gamma: not found, expects not_found (passes)
write_adr "$PROJ/docs/adrs/0005-multi.md" 'adr_id: ADR-005
code_assertions:
  - pattern: "alpha"
    expectation: found
    description: "alpha exists"
  - pattern: "beta"
    expectation: found
    description: "beta exists"
  - pattern: "gamma"
    expectation: not_found
    description: "gamma not yet introduced"'
OUT=$(bash "$SCRIPT" --root "$PROJ" 2>&1)
RC=$?
assert_exit_code "6.1 exit 0" "0" "$RC"
assert_json_eq "6.2 exactly one drift (beta)" '.decisions | length' "$OUT" "1"
assert_json_eq "6.3 drift is for beta" '.decisions[0].summary | test("beta")' "$OUT" "true"

# ---- Test 7: schema-conforming output -----------------------------------------

echo "Test 7: output conforms to briefing schema (id/type/summary/status required)"
PROJ="$SCRATCH/proj7"
make_project "$PROJ"
write_adr "$PROJ/docs/adrs/0006-schema.md" 'adr_id: ADR-006
code_assertions:
  - pattern: "ThisWillNotExist123"
    expectation: found
    description: "required field test"'
OUT=$(bash "$SCRIPT" --root "$PROJ" 2>&1)
assert_json_eq "7.0 at least one decision produced" '.decisions | length >= 1' "$OUT" "true"
# Every decision must have id, type, summary, status — all strings, non-empty
assert_json_eq "7.1 all decisions have id" '([.decisions[] | select(.id and (.id | length > 0))] | length) == (.decisions | length)' "$OUT" "true"
assert_json_eq "7.2 all decisions have type=adr_drift" '([.decisions[] | select(.type == "adr_drift")] | length) == (.decisions | length)' "$OUT" "true"
assert_json_eq "7.3 all decisions have summary" '([.decisions[] | select(.summary and (.summary | length > 0))] | length) == (.decisions | length)' "$OUT" "true"
assert_json_eq "7.4 all decisions have status" '([.decisions[] | select(.status)] | length) == (.decisions | length)' "$OUT" "true"

# ---- Test 8: malformed YAML doesn't crash the run -----------------------------

echo "Test 8: malformed YAML in one ADR is tolerated"
PROJ="$SCRATCH/proj8"
make_project "$PROJ"
# One good ADR + one with broken YAML
write_adr "$PROJ/docs/adrs/0007-good.md" 'adr_id: ADR-007
code_assertions:
  - pattern: "ZetaZetaZeta"
    expectation: found
    description: "missing"'
cat > "$PROJ/docs/adrs/0008-broken.md" <<'EOF'
---
adr_id: ADR-008
code_assertions:
  - pattern: "[invalid yaml here
    expectation: bad
EOF
OUT=$(bash "$SCRIPT" --root "$PROJ" 2>&1)
RC=$?
assert_exit_code "8.1 exit 0 despite bad YAML" "0" "$RC"
# Good ADR's drift should still appear (broken one skipped)
assert_json_eq "8.2 at least one decision (good ADR processed)" '.decisions | length >= 1' "$OUT" "true"

# ---- Test 9: config-driven adrs.directory -------------------------------------

echo "Test 9: catalyst.adrs.directory config is honored"
PROJ="$SCRATCH/proj9"
mkdir -p "$PROJ/custom/adrs-here" "$PROJ/src" "$PROJ/.catalyst"
cat > "$PROJ/.catalyst/config.json" <<'EOF'
{
  "catalyst": {
    "projectKey": "test",
    "adrs": { "directory": "custom/adrs-here" }
  }
}
EOF
write_adr "$PROJ/custom/adrs-here/0009-cfg.md" 'adr_id: ADR-009
code_assertions:
  - pattern: "ConfigDrivenMissing"
    expectation: found
    description: "checks config-driven path"'
OUT=$(bash "$SCRIPT" --root "$PROJ" 2>&1)
RC=$?
assert_exit_code "9.1 exit 0" "0" "$RC"
assert_json_eq "9.2 finds drift via configured dir" '.decisions | length' "$OUT" "1"

# ---- Test 10: --adrs-dir flag overrides config --------------------------------

echo "Test 10: --adrs-dir flag overrides config"
PROJ="$SCRATCH/proj10"
make_project "$PROJ"  # configures docs/adrs (empty)
mkdir -p "$PROJ/other/adrs"
write_adr "$PROJ/other/adrs/0010-other.md" 'adr_id: ADR-010
code_assertions:
  - pattern: "FlagOverride"
    expectation: found
    description: "flag wins"'
OUT=$(bash "$SCRIPT" --root "$PROJ" --adrs-dir "$PROJ/other/adrs" 2>&1)
RC=$?
assert_exit_code "10.1 exit 0" "0" "$RC"
assert_json_eq "10.2 flag-specified dir used" '.decisions | length' "$OUT" "1"

# ---- summary ------------------------------------------------------------------

echo
echo "============================================="
echo "  PASSES:   $PASSES"
echo "  FAILURES: $FAILURES"
echo "============================================="

[[ "$FAILURES" -eq 0 ]] || exit 1
exit 0
