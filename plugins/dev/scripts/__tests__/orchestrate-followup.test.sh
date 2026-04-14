#!/usr/bin/env bash
# Shell tests for orchestrate-followup. Run: bash plugins/dev/scripts/__tests__/orchestrate-followup.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
FOLLOWUP="${REPO_ROOT}/plugins/dev/scripts/orchestrate-followup"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

run() {
  local name="$1"; shift
  if "$@" > "${SCRATCH}/out" 2>&1; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name"
    echo "    command: $*"
    echo "    output:"
    sed 's/^/      /' "${SCRATCH}/out"
  fi
}

expect_contains() {
  local file="$1" needle="$2"
  grep -q -- "$needle" "$file" || { echo "    missing: $needle"; return 1; }
}

expect_exit() {
  local expected="$1"; shift
  set +e
  "$@" > "${SCRATCH}/out" 2>&1
  local rc=$?
  set -e
  [ "$rc" = "$expected" ] || { echo "    expected rc=$expected got rc=$rc"; sed 's/^/    /' "${SCRATCH}/out"; return 1; }
}

echo "orchestrate-followup tests"

# Test 1: missing PARENT_TICKET fails
run "errors when PARENT_TICKET omitted" \
  expect_exit 1 "$FOLLOWUP" --findings "x"

# Test 2: missing --findings fails
run "errors when --findings omitted" \
  expect_exit 1 "$FOLLOWUP" TEST-1

# Test 3: missing orchestrator context fails
run "errors without orchestrator context" \
  bash -c "unset CATALYST_ORCHESTRATOR_ID CATALYST_ORCHESTRATOR_DIR; '$FOLLOWUP' TEST-1 --findings 'x' 2>&1 | grep -q 'required'"

# Test 4: --dry-run prints plan without side effects
ORCH_DIR="${SCRATCH}/orch"
mkdir -p "${ORCH_DIR}/workers"
CATALYST_ORCHESTRATOR_ID="orch-test" CATALYST_ORCHESTRATOR_DIR="$ORCH_DIR" \
  "$FOLLOWUP" TEST-1 \
    --findings "missing null check in foo.ts:15" \
    --team-key "TST" \
    --ticket "TST-99" \
    --dry-run > "${SCRATCH}/dryrun.out" 2>&1

run "dry-run shows parent ticket" expect_contains "${SCRATCH}/dryrun.out" "parent: TEST-1"
run "dry-run shows default title" expect_contains "${SCRATCH}/dryrun.out" "Follow-up: TEST-1"
run "dry-run shows findings" expect_contains "${SCRATCH}/dryrun.out" "missing null check in foo.ts:15"
run "dry-run shows follow-up reference" expect_contains "${SCRATCH}/dryrun.out" "Follow-up to TEST-1"
run "dry-run does not create signal file" \
  bash -c "[ ! -f '${ORCH_DIR}/workers/TST-99.json' ]"

# Test 5: custom title overrides default
CATALYST_ORCHESTRATOR_ID="orch-test" CATALYST_ORCHESTRATOR_DIR="$ORCH_DIR" \
  "$FOLLOWUP" TEST-1 --findings "x" --title "Custom title" --team-key "TST" --ticket "TST-99" --dry-run \
  > "${SCRATCH}/title.out" 2>&1
run "dry-run honors --title override" expect_contains "${SCRATCH}/title.out" "title:  Custom title"

# Test 6: refuses to create ticket without linearis + without --ticket
run "refuses without --ticket when linearis missing (simulated)" \
  bash -c "CATALYST_ORCHESTRATOR_ID=orch-test CATALYST_ORCHESTRATOR_DIR='$ORCH_DIR' PATH=/usr/bin:/bin '$FOLLOWUP' TEST-1 --findings x --team-key TST 2>&1 | grep -qi 'linearis\\|create-worktree'"

echo ""
echo "orchestrate-followup: ${PASSES} passed, ${FAILURES} failed"
exit "$FAILURES"
