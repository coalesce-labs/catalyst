#!/usr/bin/env bash
# CTL-1086: test _canonical_is_sentinel_leak predicate and canonical_jsonl_append
# sentinel guard in canonical-event.sh.
#
# Cases:
#   1. orch-test event to default prod events dir → NOT written (dropped)
#   2. orch-test event to a temp CATALYST_DIR override → written (legit test)
#   3. real orch event to the default prod events dir → written
#
# Run: bash plugins/dev/scripts/__tests__/canonical-event-sentinel-guard.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# CTL-1216: resolve the event-log basename through the SAME mirror the code under
# test uses, instead of pinning `$(date -u +%Y-%m)`. Pinning the scheme here made
# these fixtures write a file the (now weekly) code never opened — and pinning
# the NEW scheme would only move the coupling one flip further out.
#
# It fails LOUD on a bad path rather than falling back to the monthly name: a
# silent fallback here reproduces the old behaviour while looking like it
# resolved, which is precisely how a wrong path in this shim went unnoticed once
# already.
_ctl1216_active_log_basename() {
  local _lib="${SCRIPT_DIR}/../lib/catalyst-event-log-paths.sh"
  [[ -r "$_lib" ]] || { echo "FATAL: event-log path mirror not readable at $_lib" >&2; exit 1; }
  ( . "$_lib" >/dev/null 2>&1 && catalyst_event_log_basename )
}

REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LIB="${REPO_ROOT}/plugins/dev/scripts/lib/canonical-event.sh"

# shellcheck disable=SC1090
source "$LIB"

FAILURES=0
PASSES=0

ok()   { PASSES=$((PASSES+1));   echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; echo "    $2"; }

# Use a scratch HOME so the "default prod path" is a throwaway.
FAKE_HOME="$(mktemp -d)"
trap 'rm -rf "$FAKE_HOME"' EXIT

REAL_HOME="${HOME}"

# Build a minimal canonical JSON line with the given orchestration id
make_line() {
  local orch="$1"
  printf '{"resource":{"catalyst.orchestration":"%s"},"name":"phase.test.sentinel"}' "$orch"
}

# ── Test 1: orch-test to default prod dir → dropped ─────────────────────────
HOME="${FAKE_HOME}"
PROD_EVENTS_DIR="${FAKE_HOME}/catalyst/events"
mkdir -p "${PROD_EVENTS_DIR}"
LINE1="$(make_line "orch-test")"
canonical_jsonl_append "${PROD_EVENTS_DIR}" "${LINE1}" 2>/dev/null
MONTH_FILE="${PROD_EVENTS_DIR}/$(_ctl1216_active_log_basename)"
if [[ -f "${MONTH_FILE}" ]]; then
  COUNT1="$(wc -l < "${MONTH_FILE}" | tr -d ' ')"
else
  COUNT1=0
fi
HOME="${REAL_HOME}"

if [[ "${COUNT1}" -eq 0 ]]; then
  ok "orch-test to default prod dir is dropped"
else
  fail "orch-test to default prod dir is dropped" "expected 0 lines, got ${COUNT1}"
fi

# ── Test 2: orch-test to a temp CATALYST_DIR override → written ──────────────
TEMP_DIR="$(mktemp -d)"
TEMP_EVENTS="${TEMP_DIR}/events"
mkdir -p "${TEMP_EVENTS}"
LINE2="$(make_line "orch-test")"
canonical_jsonl_append "${TEMP_EVENTS}" "${LINE2}"
TEMP_MONTH="${TEMP_EVENTS}/$(_ctl1216_active_log_basename)"
if [[ -f "${TEMP_MONTH}" ]]; then
  COUNT2="$(wc -l < "${TEMP_MONTH}" | tr -d ' ')"
else
  COUNT2=0
fi
rm -rf "${TEMP_DIR}"

if [[ "${COUNT2}" -eq 1 ]]; then
  ok "orch-test to temp dir is written (legit test)"
else
  fail "orch-test to temp dir is written (legit test)" "expected 1 line, got ${COUNT2}"
fi

# ── Test 3: real orch to default prod dir → written ──────────────────────────
HOME="${FAKE_HOME}"
PROD_EVENTS_DIR2="${FAKE_HOME}/catalyst/events"
mkdir -p "${PROD_EVENTS_DIR2}"
LINE3="$(make_line "orch-CTL-1086")"
canonical_jsonl_append "${PROD_EVENTS_DIR2}" "${LINE3}"
MONTH_FILE2="${PROD_EVENTS_DIR2}/$(_ctl1216_active_log_basename)"
if [[ -f "${MONTH_FILE2}" ]]; then
  COUNT3="$(wc -l < "${MONTH_FILE2}" | tr -d ' ')"
else
  COUNT3=0
fi
HOME="${REAL_HOME}"

if [[ "${COUNT3}" -ge 1 ]]; then
  ok "real orch to default prod dir is written"
else
  fail "real orch to default prod dir is written" "expected >=1 line, got ${COUNT3}"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "${FAILURES}" -eq 0 ]] || exit 1
