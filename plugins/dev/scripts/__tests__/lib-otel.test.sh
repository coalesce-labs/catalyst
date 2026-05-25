#!/usr/bin/env bash
# Unit tests for plugins/dev/direnv/lib/otel.sh — the dedup helper used by
# use_otel_context.
#
# Run: bash plugins/dev/scripts/__tests__/lib-otel.test.sh
#
# Contract: __catalyst_otel_dedup_attrs "<comma-string>" echoes the input
# with duplicate keys collapsed, keeping the LAST occurrence of each key
# (matches OTLP last-write-wins). Position of each surviving pair is the
# position of its FIRST occurrence in the input.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HELPER="${REPO_ROOT}/plugins/dev/direnv/lib/otel.sh"

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

# ─── Test 1: empty input → empty output
echo "Test 1: empty input → empty output"
RESULT=$(
  # shellcheck source=/dev/null
  . "$HELPER"
  __catalyst_otel_dedup_attrs ""
)
assert_eq "" "$RESULT" "empty input produces empty output"

# ─── Test 2: single pair → unchanged
echo ""
echo "Test 2: single pair → unchanged"
RESULT=$(
  . "$HELPER"
  __catalyst_otel_dedup_attrs "project=foo"
)
assert_eq "project=foo" "$RESULT" "single pair preserved verbatim"

# ─── Test 3: distinct keys → unchanged order
echo ""
echo "Test 3: distinct keys → unchanged"
RESULT=$(
  . "$HELPER"
  __catalyst_otel_dedup_attrs "project=foo,hostname=h1,branch=main"
)
assert_eq "project=foo,hostname=h1,branch=main" "$RESULT" \
  "no duplicates → no rewrite"

# ─── Test 4: duplicate key → LAST occurrence value wins, FIRST position kept
echo ""
echo "Test 4: duplicate project= → last value, first position"
RESULT=$(
  . "$HELPER"
  __catalyst_otel_dedup_attrs "project=old,hostname=h1,project=new"
)
assert_eq "project=new,hostname=h1" "$RESULT" \
  "LWW value at first-seen position"

# ─── Test 5: full triple-call scenario (three cd events)
echo ""
echo "Test 5: triple-call simulation"
RESULT=$(
  . "$HELPER"
  INPUT="project=p1,hostname=h1,branch=b1"
  INPUT="${INPUT},project=p2,hostname=h1,branch=b2,linear.key=CTL-1"
  INPUT="${INPUT},project=p3,hostname=h1,branch=b3,linear.key=CTL-2,catalyst.orchestration=run-3"
  __catalyst_otel_dedup_attrs "$INPUT"
)
assert_eq \
  "project=p3,hostname=h1,branch=b3,linear.key=CTL-2,catalyst.orchestration=run-3" \
  "$RESULT" "every key exactly once, third call's values win"

# ─── Test 6: LWW direction sanity
echo ""
echo "Test 6: LWW direction — project=old,project=new → project=new"
RESULT=$(
  . "$HELPER"
  __catalyst_otel_dedup_attrs "project=old,project=new"
)
assert_eq "project=new" "$RESULT" "last write wins"

# ─── Test 7: idempotent on already-dedup'd input
echo ""
echo "Test 7: idempotency"
RESULT=$(
  . "$HELPER"
  ONCE=$(__catalyst_otel_dedup_attrs "project=p1,hostname=h1")
  __catalyst_otel_dedup_attrs "$ONCE"
)
assert_eq "project=p1,hostname=h1" "$RESULT" "dedup is idempotent"

# ─── Test 8: value containing no '=' (defensive) — pass-through unchanged
echo ""
echo "Test 8: pair without '=' is preserved verbatim"
RESULT=$(
  . "$HELPER"
  __catalyst_otel_dedup_attrs "project=foo,malformed,hostname=h1"
)
# Documents current behaviour: a token without '=' has no key, so it cannot
# collide with anything and is preserved at its original position.
assert_eq "project=foo,malformed,hostname=h1" "$RESULT" \
  "malformed token preserved (no key to dedup against)"

# ─── Test 9: use_otel_context integration — no duplicate keys after 3 calls
echo ""
echo "Test 9: use_otel_context integration — no duplicate keys after 3 calls"
RESULT=$(
  . "$HELPER"
  unset OTEL_RESOURCE_ATTRIBUTES
  use_otel_context "p1" >/dev/null 2>&1
  use_otel_context "p2" >/dev/null 2>&1
  use_otel_context "p3" >/dev/null 2>&1
  printf '%s' "$OTEL_RESOURCE_ATTRIBUTES"
)
PROJECT_COUNT=$(printf '%s' "$RESULT" | tr ',' '\n' | grep -c '^project=' || true)
HOSTNAME_COUNT=$(printf '%s' "$RESULT" | tr ',' '\n' | grep -c '^hostname=' || true)
if [[ "$PROJECT_COUNT" -eq 1 && "$HOSTNAME_COUNT" -eq 1 ]]; then
  pass "use_otel_context after 3 calls → each key once (project=$PROJECT_COUNT, hostname=$HOSTNAME_COUNT)"
else
  fail "expected each key once, got project=$PROJECT_COUNT hostname=$HOSTNAME_COUNT in: $RESULT"
fi

# AC #2 — last value wins.
if [[ "$RESULT" == *"project=p3"* && "$RESULT" != *"project=p1"* && "$RESULT" != *"project=p2"* ]]; then
  pass "LWW — only project=p3 survives"
else
  fail "expected only project=p3 to survive, got: $RESULT"
fi

# ─── Summary
echo ""
echo "─────────────────────────────────────"
echo "Tests: $PASSES passed, $FAILURES failed"
if [[ "$FAILURES" -gt 0 ]]; then
  exit 1
fi
