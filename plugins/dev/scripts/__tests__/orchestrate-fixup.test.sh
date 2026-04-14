#!/usr/bin/env bash
# Shell tests for orchestrate-fixup. Run: bash plugins/dev/scripts/__tests__/orchestrate-fixup.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
FIXUP="${REPO_ROOT}/plugins/dev/scripts/orchestrate-fixup"

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

echo "orchestrate-fixup tests"

# Test 1: missing TICKET_ID fails
run "errors when TICKET_ID omitted" \
  expect_exit 1 "$FIXUP" --issues "foo.ts:10: bug"

# Test 2: missing --issues fails
run "errors when --issues omitted" \
  expect_exit 1 "$FIXUP" TEST-1

# Test 3: missing orchestrator context fails
run "errors without orchestrator context" \
  bash -c "unset CATALYST_ORCHESTRATOR_ID CATALYST_ORCHESTRATOR_DIR; '$FIXUP' TEST-1 --issues 'x' 2>&1 | grep -q 'required'"

# Test 4: --dry-run does not write files
ORCH_DIR="${SCRATCH}/orch"
mkdir -p "${ORCH_DIR}/workers"
CATALYST_ORCHESTRATOR_ID="orch-test" CATALYST_ORCHESTRATOR_DIR="$ORCH_DIR" \
  "$FIXUP" TEST-1 --issues "foo.ts:10: null deref" --dry-run --pr 42 > "${SCRATCH}/dryrun.out" 2>&1
run "dry-run announces paths" expect_contains "${SCRATCH}/dryrun.out" "would write prompt"
run "dry-run announces dispatch path" expect_contains "${SCRATCH}/dryrun.out" "would write dispatch"
run "dry-run does not write prompt file" \
  bash -c "[ ! -f '${ORCH_DIR}/workers/fixup-TEST-1-prompt.md' ]"

# Test 5: real run writes prompt + dispatch files with substitutions
CATALYST_ORCHESTRATOR_ID="orch-test" CATALYST_ORCHESTRATOR_DIR="$ORCH_DIR" \
  "$FIXUP" TEST-1 --issues "foo.ts:10: null deref" --pr 42 > "${SCRATCH}/run.out" 2>&1
run "writes prompt file" \
  bash -c "[ -f '${ORCH_DIR}/workers/fixup-TEST-1-prompt.md' ]"
run "writes dispatch file" \
  bash -c "[ -f '${ORCH_DIR}/workers/dispatch-fixup-TEST-1.sh' ]"
run "dispatch file is executable" \
  bash -c "[ -x '${ORCH_DIR}/workers/dispatch-fixup-TEST-1.sh' ]"
run "prompt substitutes TICKET_ID" \
  expect_contains "${ORCH_DIR}/workers/fixup-TEST-1-prompt.md" "Fix-up Worker — TEST-1"
run "prompt substitutes PR_NUMBER" \
  expect_contains "${ORCH_DIR}/workers/fixup-TEST-1-prompt.md" "#42"
run "prompt substitutes ISSUES" \
  expect_contains "${ORCH_DIR}/workers/fixup-TEST-1-prompt.md" "foo.ts:10: null deref"
run "prompt references signal file" \
  expect_contains "${ORCH_DIR}/workers/fixup-TEST-1-prompt.md" "${ORCH_DIR}/workers/TEST-1.json"
run "prompt references fixupCommit field" \
  expect_contains "${ORCH_DIR}/workers/fixup-TEST-1-prompt.md" "fixupCommit"
run "dispatch file references TICKET_ID" \
  expect_contains "${ORCH_DIR}/workers/dispatch-fixup-TEST-1.sh" "TEST-1"
run "dispatch file does not leave unresolved placeholders" \
  bash -c "! grep -E '\\\$\\{(TICKET_ID|ORCH_NAME|ORCH_DIR|WORKER_DIR|PROMPT_FILE|WORKER_MODEL)\\}' '${ORCH_DIR}/workers/dispatch-fixup-TEST-1.sh'"

echo ""
echo "orchestrate-fixup: ${PASSES} passed, ${FAILURES} failed"
exit "$FAILURES"
