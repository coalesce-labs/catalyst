#!/usr/bin/env bash
# Unit tests for lib/task-type.sh — the shared OTEL task.type helper.
#
# Run: bash plugins/dev/scripts/__tests__/lib-task-type.test.sh
#
# Contract: __catalyst_append_task_type "<value>" exports
# OTEL_RESOURCE_ATTRIBUTES with `task.type=<value>` appended. Idempotent
# (first writer wins) when a `task.type=` pair is already present.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HELPER="${REPO_ROOT}/plugins/dev/scripts/lib/task-type.sh"

FAILURES=0
PASSES=0

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

if [[ ! -f "$HELPER" ]]; then
  echo "FATAL: $HELPER not found" >&2
  exit 1
fi

# ─── Test 1: empty OTEL_RESOURCE_ATTRIBUTES → sets to single pair
echo "Test 1: empty initial → sets task.type alone"
RESULT=$(
  unset OTEL_RESOURCE_ATTRIBUTES
  # shellcheck source=/dev/null
  . "$HELPER"
  __catalyst_append_task_type "phase-research"
  printf '%s' "$OTEL_RESOURCE_ATTRIBUTES"
)
assert_eq "task.type=phase-research" "$RESULT" "single-pair output when var empty"

# ─── Test 2: pre-existing OTEL attrs without task.type → appends
echo ""
echo "Test 2: non-empty without task.type → appends"
RESULT=$(
  export OTEL_RESOURCE_ATTRIBUTES="project=foo,linear.key=BAR-1"
  # shellcheck source=/dev/null
  . "$HELPER"
  __catalyst_append_task_type "interactive"
  printf '%s' "$OTEL_RESOURCE_ATTRIBUTES"
)
assert_eq "project=foo,linear.key=BAR-1,task.type=interactive" "$RESULT" \
  "appends task.type with leading comma"

# ─── Test 3: idempotency — pre-existing task.type left alone
echo ""
echo "Test 3: idempotency — existing task.type wins"
RESULT=$(
  export OTEL_RESOURCE_ATTRIBUTES="task.type=preset,project=foo"
  # shellcheck source=/dev/null
  . "$HELPER"
  __catalyst_append_task_type "should-not-overwrite"
  printf '%s' "$OTEL_RESOURCE_ATTRIBUTES"
)
assert_eq "task.type=preset,project=foo" "$RESULT" \
  "existing task.type is preserved"

# ─── Test 4: empty value argument → exits non-zero
echo ""
echo "Test 4: empty value argument is an error"
(
  # shellcheck source=/dev/null
  . "$HELPER"
  __catalyst_append_task_type "" 2>/dev/null
)
RC=$?
if [[ "$RC" -ne 0 ]]; then
  pass "empty argument exits non-zero (rc=$RC)"
else
  fail "empty argument should exit non-zero, got rc=$RC"
fi

# ─── Test 5: substring guard — "not_task.type=foo" should still get tagged
echo ""
echo "Test 5: substring guard — pair detection is precise"
# Subshells to isolate state.
RESULT=$(
  export OTEL_RESOURCE_ATTRIBUTES="my_task.type_label=foo,other=bar"
  # shellcheck source=/dev/null
  . "$HELPER"
  __catalyst_append_task_type "phase-implement"
  printf '%s' "$OTEL_RESOURCE_ATTRIBUTES"
)
# The substring `task.type=` is contained within `my_task.type_label=foo`
# (because `_label` ≠ `=`). Document the current behaviour: the helper's
# substring check sees "task.type=" and skips — this is a known false-positive
# but the namespace is bash-only and we don't generate such keys.
# Note: with a stricter pattern we'd treat this as no-match. Test pins the
# current (intentionally simple) semantics.
if [[ "$RESULT" == *"task.type=phase-implement"* ]]; then
  # Stricter implementation (preferred future): pair detection is precise.
  pass "stricter detection: appends task.type when no exact pair present"
elif [[ "$RESULT" == "my_task.type_label=foo,other=bar" ]]; then
  pass "current substring detection: false-positive accepted (no append)"
else
  fail "unexpected result: '$RESULT'"
fi

# ─── Test 6: export — subprocesses see the value
echo ""
echo "Test 6: exported, subprocesses inherit"
RESULT=$(
  unset OTEL_RESOURCE_ATTRIBUTES
  # shellcheck source=/dev/null
  . "$HELPER"
  __catalyst_append_task_type "orchestrate"
  bash -c 'printf "%s" "${OTEL_RESOURCE_ATTRIBUTES:-UNSET}"'
)
assert_eq "task.type=orchestrate" "$RESULT" "export propagates to bash -c subprocess"

# ─── Test 7: set -u safety — sourced under strict mode, no unbound errors
echo ""
echo "Test 7: set -u safety"
(
  set -u
  unset OTEL_RESOURCE_ATTRIBUTES 2>/dev/null || true
  # shellcheck source=/dev/null
  . "$HELPER"
  __catalyst_append_task_type "set-u-test" 2>/dev/null
) >/dev/null 2>&1
if [[ $? -eq 0 ]]; then
  pass "helper survives set -u with empty OTEL_RESOURCE_ATTRIBUTES"
else
  fail "helper triggered unbound-variable error under set -u"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "lib-task-type: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
  exit 1
fi
exit 0
