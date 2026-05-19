#!/usr/bin/env bash
# CTL-495: setup-orchestrator.sh tags --launch sessions with
# task.type=orchestrate so Grafana cost can be sliced by activity.
#
# setup-orchestrator.sh has heavy bootstrap dependencies (git, create-worktree,
# catalyst-state). A full hermetic integration test would need to fake all of
# them. Instead we run a focused static check: the script sources
# lib/task-type.sh and calls __catalyst_append_task_type "orchestrate" inside
# the --launch block, BEFORE the exec claude line. Combined with
# lib-task-type.test.sh's behavioural coverage of the helper, this is
# sufficient to detect regressions in the wiring.
#
# Run: bash plugins/dev/scripts/__tests__/setup-orchestrator-task-type.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
TARGET="${REPO_ROOT}/plugins/dev/scripts/setup-orchestrator.sh"

FAILURES=0
PASSES=0

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

if [[ ! -f "$TARGET" ]]; then
  echo "FATAL: $TARGET not found" >&2
  exit 1
fi

# ─── Test 1: helper is sourced
echo "Test 1: setup-orchestrator.sh sources lib/task-type.sh"
if grep -q 'lib/task-type.sh' "$TARGET"; then
  pass "lib/task-type.sh source line present"
else
  fail "lib/task-type.sh source line present" "no match in $TARGET"
fi

# ─── Test 2: helper is called with "orchestrate"
echo ""
echo "Test 2: helper called with task type 'orchestrate'"
if grep -qE '__catalyst_append_task_type[[:space:]]+"orchestrate"' "$TARGET"; then
  pass "__catalyst_append_task_type \"orchestrate\" present"
else
  fail "__catalyst_append_task_type \"orchestrate\" present" "no match in $TARGET"
fi

# ─── Test 3: call ordering — task.type set BEFORE exec claude
echo ""
echo "Test 3: helper call comes before exec claude in launch block"
APPEND_LINE=$(grep -n '__catalyst_append_task_type[[:space:]]\+"orchestrate"' "$TARGET" | head -1 | cut -d: -f1)
# Match `exec claude` as actual code (start-of-line whitespace + exec), not
# inside an echo or comment elsewhere in the file.
EXEC_LINE=$(grep -nE '^[[:space:]]*exec claude\b' "$TARGET" | head -1 | cut -d: -f1)
if [[ -n "$APPEND_LINE" && -n "$EXEC_LINE" && "$APPEND_LINE" -lt "$EXEC_LINE" ]]; then
  pass "task.type set on line $APPEND_LINE before exec on line $EXEC_LINE"
else
  fail "task.type set before exec" "append=$APPEND_LINE exec=$EXEC_LINE"
fi

# ─── Test 4: the helper file exists and is loadable
echo ""
echo "Test 4: lib/task-type.sh exists and defines __catalyst_append_task_type"
HELPER="${REPO_ROOT}/plugins/dev/scripts/lib/task-type.sh"
if [[ -f "$HELPER" ]] && bash -c ". \"$HELPER\" && declare -F __catalyst_append_task_type" >/dev/null 2>&1; then
  pass "helper file exists and defines the function"
else
  fail "helper file exists and defines the function" "HELPER=$HELPER"
fi

# ─── Test 5: dynamic sourcing — running the helper-source line in isolation
# Run a stripped-down version of the launch block to confirm the source
# resolves correctly with the production SCRIPT_DIR layout.
echo ""
echo "Test 5: helper-source line resolves correctly when run from script dir"
TMP_DIR="$(mktemp -d -t setup-orch-task-type-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT
# Re-create the SCRIPT_DIR resolution and helper call in isolation.
RUN_OUT=$(
  cd "${REPO_ROOT}/plugins/dev/scripts"
  SCRIPT_DIR="$(pwd)"
  # shellcheck source=../../plugins/dev/scripts/lib/task-type.sh
  . "${SCRIPT_DIR}/lib/task-type.sh"
  __catalyst_append_task_type "orchestrate"
  printf '%s' "${OTEL_RESOURCE_ATTRIBUTES:-}"
)
if [[ "$RUN_OUT" == *"task.type=orchestrate"* ]]; then
  pass "helper-source + call in production layout sets task.type=orchestrate"
else
  fail "helper-source + call sets task.type=orchestrate" "RUN_OUT: $RUN_OUT"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "setup-orchestrator-task-type: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]]
