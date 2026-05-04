#!/usr/bin/env bash
# Shell tests for orchestrate-rebase (CTL-232).
# Run: bash plugins/dev/scripts/__tests__/orchestrate-rebase.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
REBASE="${REPO_ROOT}/plugins/dev/scripts/orchestrate-rebase"

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
  grep -qF -- "$needle" "$file" || { echo "    missing: $needle"; return 1; }
}

expect_exit() {
  local expected="$1"; shift
  set +e
  "$@" > "${SCRATCH}/out" 2>&1
  local rc=$?
  set -e
  [ "$rc" = "$expected" ] || { echo "    expected rc=$expected got rc=$rc"; sed 's/^/    /' "${SCRATCH}/out"; return 1; }
}

echo "orchestrate-rebase tests"

# Test 1: missing TICKET_ID fails
run "errors when TICKET_ID omitted" \
  expect_exit 1 bash -c "unset CATALYST_ORCHESTRATOR_ID CATALYST_ORCHESTRATOR_DIR; '$REBASE'"

# Test 2: missing orchestrator context fails
run "errors without orchestrator context" \
  bash -c "unset CATALYST_ORCHESTRATOR_ID CATALYST_ORCHESTRATOR_DIR; '$REBASE' TEST-1 2>&1 | grep -q 'required'"

# Test 3: --dry-run does not write files
ORCH_DIR="${SCRATCH}/orch"
mkdir -p "${ORCH_DIR}/workers"
CATALYST_ORCHESTRATOR_ID="orch-test" CATALYST_ORCHESTRATOR_DIR="$ORCH_DIR" \
  "$REBASE" TEST-1 --dry-run --pr 42 > "${SCRATCH}/dryrun.out" 2>&1
run "dry-run announces prompt path" expect_contains "${SCRATCH}/dryrun.out" "would write prompt"
run "dry-run announces dispatch path" expect_contains "${SCRATCH}/dryrun.out" "would write dispatch"
run "dry-run announces base branch" expect_contains "${SCRATCH}/dryrun.out" "base branch: main"
run "dry-run does not write prompt file" \
  bash -c "[ ! -f '${ORCH_DIR}/workers/rebase-TEST-1-prompt.md' ]"

# Test 4: real run writes prompt + dispatch files with substitutions
CATALYST_ORCHESTRATOR_ID="orch-test" CATALYST_ORCHESTRATOR_DIR="$ORCH_DIR" \
  "$REBASE" TEST-1 --pr 42 > "${SCRATCH}/run.out" 2>&1
run "writes prompt file" \
  bash -c "[ -f '${ORCH_DIR}/workers/rebase-TEST-1-prompt.md' ]"
run "writes dispatch file" \
  bash -c "[ -f '${ORCH_DIR}/workers/dispatch-rebase-TEST-1.sh' ]"
run "dispatch file is executable" \
  bash -c "[ -x '${ORCH_DIR}/workers/dispatch-rebase-TEST-1.sh' ]"
run "prompt substitutes TICKET_ID" \
  expect_contains "${ORCH_DIR}/workers/rebase-TEST-1-prompt.md" "Rebase Worker — TEST-1"
run "prompt substitutes PR_NUMBER" \
  expect_contains "${ORCH_DIR}/workers/rebase-TEST-1-prompt.md" "#42"
run "prompt substitutes BASE_BRANCH default" \
  expect_contains "${ORCH_DIR}/workers/rebase-TEST-1-prompt.md" "Base branch:** main"
run "prompt references signal file" \
  expect_contains "${ORCH_DIR}/workers/rebase-TEST-1-prompt.md" "${ORCH_DIR}/workers/TEST-1.json"
run "prompt references rebaseCommit field" \
  expect_contains "${ORCH_DIR}/workers/rebase-TEST-1-prompt.md" "rebaseCommit"
run "prompt mentions force-with-lease" \
  expect_contains "${ORCH_DIR}/workers/rebase-TEST-1-prompt.md" "force-with-lease"
run "dispatch file references TICKET_ID" \
  expect_contains "${ORCH_DIR}/workers/dispatch-rebase-TEST-1.sh" "TEST-1"
run "dispatch file uses rebase- prefix in session name" \
  expect_contains "${ORCH_DIR}/workers/dispatch-rebase-TEST-1.sh" '-n "rebase-TEST-1"'
run "dispatch file does not leave unresolved placeholders" \
  bash -c "! grep -E '\\\$\\{(ORCH_NAME|ORCH_DIR|WORKER_DIR|PROMPT_FILE|WORKER_MODEL|BRANCH_NAME|PR_NUMBER|PR_URL|SIGNAL_FILE|BASE_BRANCH)\\}' '${ORCH_DIR}/workers/dispatch-rebase-TEST-1.sh'"

# Test 5: --base-branch override is substituted into prompt
ORCH_DIR_5="${SCRATCH}/orch5"
mkdir -p "${ORCH_DIR_5}/workers"
CATALYST_ORCHESTRATOR_ID="orch-test" CATALYST_ORCHESTRATOR_DIR="$ORCH_DIR_5" \
  "$REBASE" TEST-5 --pr 99 --base-branch develop > "${SCRATCH}/run5.out" 2>&1
run "prompt substitutes custom --base-branch" \
  expect_contains "${ORCH_DIR_5}/workers/rebase-TEST-5-prompt.md" "Base branch:** develop"
run "prompt references custom base in fetch step" \
  expect_contains "${ORCH_DIR_5}/workers/rebase-TEST-5-prompt.md" "git fetch origin develop"

# Test 6: default WORKER_DIR resolution reads state.json:.worktreeBase
ORCH_DIR_6="${SCRATCH}/orch6"
WORKTREE_BASE_6="${SCRATCH}/wt-base6"
mkdir -p "${ORCH_DIR_6}/workers" "${WORKTREE_BASE_6}/orch-test-TEST-6"
cat > "${ORCH_DIR_6}/state.json" <<EOF
{"orchestrator": "orch-test", "worktreeBase": "${WORKTREE_BASE_6}"}
EOF
CATALYST_ORCHESTRATOR_ID="orch-test" CATALYST_ORCHESTRATOR_DIR="$ORCH_DIR_6" \
  "$REBASE" TEST-6 --pr 7 > "${SCRATCH}/run6.out" 2>&1
run "default WORKER_DIR uses state.json:.worktreeBase" \
  expect_contains "${ORCH_DIR_6}/workers/dispatch-rebase-TEST-6.sh" "WORKER_DIR=\"${WORKTREE_BASE_6}/orch-test-TEST-6\""

# Test 7: explicit --worker-dir still wins over state.json
ORCH_DIR_7="${SCRATCH}/orch7"
WORKTREE_BASE_7="${SCRATCH}/wt-base7"
EXPLICIT_DIR="${SCRATCH}/explicit/some-other-path"
mkdir -p "${ORCH_DIR_7}/workers" "${WORKTREE_BASE_7}/orch-test-TEST-7" "$EXPLICIT_DIR"
cat > "${ORCH_DIR_7}/state.json" <<EOF
{"orchestrator": "orch-test", "worktreeBase": "${WORKTREE_BASE_7}"}
EOF
CATALYST_ORCHESTRATOR_ID="orch-test" CATALYST_ORCHESTRATOR_DIR="$ORCH_DIR_7" \
  "$REBASE" TEST-7 --pr 9 --worker-dir "$EXPLICIT_DIR" > "${SCRATCH}/run7.out" 2>&1
run "--worker-dir override wins over state.json" \
  expect_contains "${ORCH_DIR_7}/workers/dispatch-rebase-TEST-7.sh" "WORKER_DIR=\"${EXPLICIT_DIR}\""

echo ""
echo "orchestrate-rebase: ${PASSES} passed, ${FAILURES} failed"
exit "$FAILURES"
