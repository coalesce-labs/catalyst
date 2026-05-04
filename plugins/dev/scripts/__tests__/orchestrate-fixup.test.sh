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

# Test 6 (CTL-231): default WORKER_DIR resolution reads state.json:.worktreeBase
# Regression for the CTL-59 split that broke the dirname(ORCH_DIR) fallback.
ORCH_DIR_2="${SCRATCH}/orch2"
WORKTREE_BASE_2="${SCRATCH}/wt-base"
mkdir -p "${ORCH_DIR_2}/workers" "${WORKTREE_BASE_2}/orch-test-TEST-2"
cat > "${ORCH_DIR_2}/state.json" <<EOF
{"orchestrator": "orch-test", "worktreeBase": "${WORKTREE_BASE_2}"}
EOF
CATALYST_ORCHESTRATOR_ID="orch-test" CATALYST_ORCHESTRATOR_DIR="$ORCH_DIR_2" \
  "$FIXUP" TEST-2 --issues "bar.ts:5: bug" --pr 7 > "${SCRATCH}/run2.out" 2>&1
run "default WORKER_DIR uses state.json:.worktreeBase (not dirname(ORCH_DIR))" \
  expect_contains "${ORCH_DIR_2}/workers/dispatch-fixup-TEST-2.sh" "WORKER_DIR=\"${WORKTREE_BASE_2}/orch-test-TEST-2\""
run "default WORKER_DIR does NOT include dirname(ORCH_DIR)" \
  bash -c "! grep -q '$(dirname "$ORCH_DIR_2")/orch-test-TEST-2' '${ORCH_DIR_2}/workers/dispatch-fixup-TEST-2.sh'"

# Test 7 (CTL-231): backward-compat — when state.json is missing, fall back to old
# dirname(ORCH_DIR) behavior and warn on stderr (pre-CTL-228 orchestrators)
ORCH_DIR_3="${SCRATCH}/parent3/orch3"
mkdir -p "${ORCH_DIR_3}/workers"
# No state.json — simulates a pre-CTL-228 orchestrator directory
CATALYST_ORCHESTRATOR_ID="orch-test" CATALYST_ORCHESTRATOR_DIR="$ORCH_DIR_3" \
  "$FIXUP" TEST-3 --issues "baz.ts:1: bug" --pr 8 > "${SCRATCH}/run3.out" 2>&1
run "fallback warns when state.json is missing" \
  expect_contains "${SCRATCH}/run3.out" "warn:"
run "fallback uses dirname(ORCH_DIR) when state.json missing" \
  expect_contains "${ORCH_DIR_3}/workers/dispatch-fixup-TEST-3.sh" "WORKER_DIR=\"$(dirname "$ORCH_DIR_3")/orch-test-TEST-3\""

# Test 8 (CTL-231): explicit --worker-dir still wins over state.json
ORCH_DIR_4="${SCRATCH}/orch4"
WORKTREE_BASE_4="${SCRATCH}/wt-base4"
EXPLICIT_DIR="${SCRATCH}/explicit/some-other-path"
mkdir -p "${ORCH_DIR_4}/workers" "${WORKTREE_BASE_4}/orch-test-TEST-4" "$EXPLICIT_DIR"
cat > "${ORCH_DIR_4}/state.json" <<EOF
{"orchestrator": "orch-test", "worktreeBase": "${WORKTREE_BASE_4}"}
EOF
CATALYST_ORCHESTRATOR_ID="orch-test" CATALYST_ORCHESTRATOR_DIR="$ORCH_DIR_4" \
  "$FIXUP" TEST-4 --issues "x" --pr 9 --worker-dir "$EXPLICIT_DIR" > "${SCRATCH}/run4.out" 2>&1
run "--worker-dir override wins over state.json" \
  expect_contains "${ORCH_DIR_4}/workers/dispatch-fixup-TEST-4.sh" "WORKER_DIR=\"${EXPLICIT_DIR}\""

echo ""
echo "orchestrate-fixup: ${PASSES} passed, ${FAILURES} failed"
exit "$FAILURES"
