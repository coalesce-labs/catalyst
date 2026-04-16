#!/usr/bin/env bash
# Shell tests for catalyst-state.sh
#
# Covers the new runs-dir helpers added for CTL-59:
# - `run-dir <orch-id>` prints the resolved path to ~/catalyst/runs/<id>/
# - `ensure-run-dir <orch-id>` creates runs/<id>/workers/output/ layout
# - RUNS_DIR honors CATALYST_DIR env override (for tests)
# - `ensure-run-dir` is idempotent

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
STATE_SCRIPT="${REPO_ROOT}/plugins/dev/scripts/catalyst-state.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t catalyst-state-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label"
  else
    fail "$label — expected '$expected', got '$actual'"
  fi
}

assert_dir_exists() {
  local path="$1" label="$2"
  if [[ -d "$path" ]]; then
    pass "$label"
  else
    fail "$label — directory not found: $path"
  fi
}

if [[ ! -x "$STATE_SCRIPT" ]]; then
  echo "FATAL: catalyst-state.sh not found or not executable at $STATE_SCRIPT" >&2
  exit 1
fi

# ─── Test 1: run-dir prints correct path ────────────────────────────────────
echo ""
echo "--- Test 1: run-dir prints resolved path ---"
export CATALYST_DIR="$SCRATCH/cat1"
RUN_DIR=$("$STATE_SCRIPT" run-dir orch-2026-04-16)
assert_eq "$SCRATCH/cat1/runs/orch-2026-04-16" "$RUN_DIR" "run-dir output matches \$CATALYST_DIR/runs/<id>"

# ─── Test 2: ensure-run-dir creates full layout ─────────────────────────────
echo ""
echo "--- Test 2: ensure-run-dir creates workers/output/ layout ---"
export CATALYST_DIR="$SCRATCH/cat2"
"$STATE_SCRIPT" ensure-run-dir orch-test-42 >/dev/null
assert_dir_exists "$SCRATCH/cat2/runs/orch-test-42" "run dir exists"
assert_dir_exists "$SCRATCH/cat2/runs/orch-test-42/workers" "workers/ exists"
assert_dir_exists "$SCRATCH/cat2/runs/orch-test-42/workers/output" "workers/output/ exists"

# ─── Test 3: ensure-run-dir is idempotent ───────────────────────────────────
echo ""
echo "--- Test 3: ensure-run-dir runs twice without error ---"
export CATALYST_DIR="$SCRATCH/cat3"
"$STATE_SCRIPT" ensure-run-dir orch-idempotent >/dev/null
touch "$SCRATCH/cat3/runs/orch-idempotent/workers/CTL-1.json"
"$STATE_SCRIPT" ensure-run-dir orch-idempotent >/dev/null
if [[ -f "$SCRATCH/cat3/runs/orch-idempotent/workers/CTL-1.json" ]]; then
  pass "second ensure-run-dir preserved existing signal file"
else
  fail "second ensure-run-dir wiped existing signal file"
fi

# ─── Test 4: ensure-run-dir rejects missing arg ─────────────────────────────
echo ""
echo "--- Test 4: ensure-run-dir requires orch-id ---"
export CATALYST_DIR="$SCRATCH/cat4"
set +e
"$STATE_SCRIPT" ensure-run-dir 2>/dev/null
RC=$?
set -e
if [[ "$RC" != "0" ]]; then
  pass "ensure-run-dir without arg exits non-zero"
else
  fail "ensure-run-dir without arg should have failed"
fi

# ─── Test 5: run-dir rejects missing arg ────────────────────────────────────
echo ""
echo "--- Test 5: run-dir requires orch-id ---"
set +e
"$STATE_SCRIPT" run-dir 2>/dev/null
RC=$?
set -e
if [[ "$RC" != "0" ]]; then
  pass "run-dir without arg exits non-zero"
else
  fail "run-dir without arg should have failed"
fi

# ─── Test 6: init creates runs/ alongside events/ and history/ ──────────────
echo ""
echo "--- Test 6: init creates the top-level runs/ directory ---"
export CATALYST_DIR="$SCRATCH/cat6"
"$STATE_SCRIPT" init >/dev/null
assert_dir_exists "$SCRATCH/cat6/runs" "runs/ created by init"
assert_dir_exists "$SCRATCH/cat6/events" "events/ created by init"
assert_dir_exists "$SCRATCH/cat6/history" "history/ created by init"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════"
echo " $PASSES passed, $FAILURES failed"
echo "══════════════════════════════════════════════"

if [[ "$FAILURES" -gt 0 ]]; then
  exit 1
fi
