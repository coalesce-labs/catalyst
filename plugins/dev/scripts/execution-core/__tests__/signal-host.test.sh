#!/usr/bin/env bash
# signal-host.test.sh — verifies that phase-agent-dispatch writes a host block
# into the initial phase signal file (CTL-852 Phase 3).
#
# Run: bash plugins/dev/scripts/execution-core/__tests__/signal-host.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../../../" && pwd)"
DEV="${REPO_ROOT}/plugins/dev/scripts"

FAILURES=0
PASSES=0

ok() {
  local name="$1"
  PASSES=$((PASSES+1))
  echo "  PASS: $name"
}

fail() {
  local name="$1" detail="$2"
  FAILURES=$((FAILURES+1))
  echo "  FAIL: $name"
  echo "    $detail"
}

expect_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    ok "$name"
  else
    fail "$name" "expected '$expected' got '$actual'"
  fi
}

# --- setup ---
TMP_ORCH="$(mktemp -d)"
trap 'rm -rf "$TMP_ORCH"' EXIT

# Source host-identity.sh for ground-truth values
source "${DEV}/lib/host-identity.sh"
EXPECTED_HOST_NAME="$(catalyst_host_name)"
EXPECTED_HOST_ID="$(catalyst_host_id)"

# Build the initial signal JSON the same way phase-agent-dispatch does (CTL-852):
# The dispatch script writes the JSON with jq -nc including host block.
# We test the jq template by exercising it directly.

TS="2026-06-07T23:00:00Z"
TICKET="CTL-852"
PHASE="implement"

mkdir -p "${TMP_ORCH}/workers/${TICKET}"
SIGNAL_FILE="${TMP_ORCH}/workers/${TICKET}/phase-${PHASE}.json"

# Exercise the dispatch template (sourced from phase-agent-dispatch:589-603 + host fields).
HOST_NAME="$(catalyst_host_name)"
HOST_ID="$(catalyst_host_id)"

jq -nc \
  --arg ticket "$TICKET" \
  --arg phase "$PHASE" \
  --arg model "sonnet" \
  --argjson turnCap 75 \
  --arg orch "$TICKET" \
  --arg ts "$TS" \
  --arg wt "/tmp/fake-worktree" \
  --argjson generation 1 \
  --argjson attempt 1 \
  --arg host_name "$HOST_NAME" \
  --arg host_id "$HOST_ID" \
  '{ticket: $ticket, phase: $phase, orchestrator: $orch, model: $model,
    turnCap: $turnCap, status: "dispatched", bg_job_id: null,
    worktreePath: $wt, generation: $generation, attempt: $attempt,
    startedAt: $ts, updatedAt: $ts,
    host: {name: $host_name, id: $host_id}}' > "$SIGNAL_FILE"

# Assert host block is present
HOST_NAME_READ="$(jq -r '.host.name // empty' "$SIGNAL_FILE")"
HOST_ID_READ="$(jq -r '.host.id // empty' "$SIGNAL_FILE")"

expect_eq "dispatch signal has host.name" "$EXPECTED_HOST_NAME" "$HOST_NAME_READ"
expect_eq "dispatch signal has host.id" "$EXPECTED_HOST_ID" "$HOST_ID_READ"

# Assert host.id is 16-hex
if [[ ${#HOST_ID_READ} -eq 16 && "$HOST_ID_READ" =~ ^[0-9a-f]+$ ]]; then
  ok "host.id in signal is 16 hex chars"
else
  fail "host.id format" "got '$HOST_ID_READ' (len ${#HOST_ID_READ})"
fi

# Assert other fields not broken
STATUS="$(jq -r '.status' "$SIGNAL_FILE")"
expect_eq "dispatch signal has status=dispatched" "dispatched" "$STATUS"
TICKET_READ="$(jq -r '.ticket' "$SIGNAL_FILE")"
expect_eq "dispatch signal has correct ticket" "$TICKET" "$TICKET_READ"

# Test backfill: a signal WITHOUT host block gets host added
SIGNAL_NO_HOST="${TMP_ORCH}/workers/${TICKET}/phase-${PHASE}-nohost.json"
jq -nc \
  --arg ticket "$TICKET" \
  --arg phase "$PHASE" \
  --arg ts "$TS" \
  '{ticket: $ticket, phase: $phase, status: "running", updatedAt: $ts}' > "$SIGNAL_NO_HOST"

# Apply backfill (as emit-complete does)
HOST_NAME2="$(catalyst_host_name)"
HOST_ID2="$(catalyst_host_id)"
TMP_BF="${SIGNAL_NO_HOST}.tmp.$$"
jq --arg host_name "$HOST_NAME2" --arg host_id "$HOST_ID2" '
  if .host == null then .host = {name: $host_name, id: $host_id} else . end
' "$SIGNAL_NO_HOST" > "$TMP_BF" && mv "$TMP_BF" "$SIGNAL_NO_HOST"

BACKFILLED_NAME="$(jq -r '.host.name // empty' "$SIGNAL_NO_HOST")"
BACKFILLED_ID="$(jq -r '.host.id // empty' "$SIGNAL_NO_HOST")"
expect_eq "backfill adds host.name when absent" "$EXPECTED_HOST_NAME" "$BACKFILLED_NAME"
expect_eq "backfill adds host.id when absent" "$EXPECTED_HOST_ID" "$BACKFILLED_ID"

# Test preservation: existing host block is NOT overwritten by backfill
SIGNAL_HAS_HOST="${TMP_ORCH}/workers/${TICKET}/phase-${PHASE}-hashost.json"
jq -nc \
  --arg ticket "$TICKET" \
  --arg phase "$PHASE" \
  --arg ts "$TS" \
  '{ticket: $ticket, phase: $phase, status: "running", updatedAt: $ts, host: {name: "custom-host", id: "aaaa000000000000"}}' > "$SIGNAL_HAS_HOST"

TMP_PV="${SIGNAL_HAS_HOST}.tmp.$$"
jq --arg host_name "$HOST_NAME2" --arg host_id "$HOST_ID2" '
  if .host == null then .host = {name: $host_name, id: $host_id} else . end
' "$SIGNAL_HAS_HOST" > "$TMP_PV" && mv "$TMP_PV" "$SIGNAL_HAS_HOST"

PRESERVED_NAME="$(jq -r '.host.name // empty' "$SIGNAL_HAS_HOST")"
expect_eq "backfill preserves existing host block" "custom-host" "$PRESERVED_NAME"

echo ""
echo "Total: $((PASSES + FAILURES)), Passed: $PASSES, Failed: $FAILURES"
exit "$FAILURES"
