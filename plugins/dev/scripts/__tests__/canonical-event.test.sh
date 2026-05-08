#!/usr/bin/env bash
# Shell tests for plugins/dev/scripts/lib/canonical-event.sh.
# Validates that bash-derived trace/span IDs match the TS-derived values.
#
# Run: bash plugins/dev/scripts/__tests__/canonical-event.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LIB="${REPO_ROOT}/plugins/dev/scripts/lib/canonical-event.sh"

# shellcheck disable=SC1090
source "$LIB"

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

# severity_number
expect_eq "severity_number DEBUG" "5"  "$(severity_number DEBUG)"
expect_eq "severity_number INFO"  "9"  "$(severity_number INFO)"
expect_eq "severity_number WARN"  "13" "$(severity_number WARN)"
expect_eq "severity_number ERROR" "17" "$(severity_number ERROR)"

# derive_trace_id — 32-hex
TRACE_ID="$(derive_trace_id 'orch-foo' '')"
if [[ ${#TRACE_ID} -eq 32 && "$TRACE_ID" =~ ^[0-9a-f]+$ ]]; then
  ok "derive_trace_id orch-foo → 32-hex"
else
  fail "derive_trace_id orch-foo" "got '$TRACE_ID' (len ${#TRACE_ID})"
fi

# derive_trace_id determinism
TRACE_2="$(derive_trace_id 'orch-foo' '')"
expect_eq "derive_trace_id deterministic" "$TRACE_ID" "$TRACE_2"

# derive_trace_id different inputs differ
TRACE_OTHER="$(derive_trace_id 'orch-bar' '')"
if [[ "$TRACE_ID" != "$TRACE_OTHER" ]]; then
  ok "derive_trace_id different inputs differ"
else
  fail "derive_trace_id collision" "orch-foo and orch-bar produced same id"
fi

# derive_trace_id session fallback
SESS_TRACE="$(derive_trace_id '' 'sess_abc')"
if [[ ${#SESS_TRACE} -eq 32 && "$SESS_TRACE" != "$TRACE_ID" ]]; then
  ok "derive_trace_id session fallback differs from orch"
else
  fail "derive_trace_id session fallback" "got '$SESS_TRACE'"
fi

# derive_trace_id empty inputs → empty
EMPTY_TRACE="$(derive_trace_id '' '')"
expect_eq "derive_trace_id empty inputs → empty" "" "$EMPTY_TRACE"

# derive_span_id — 16-hex
SPAN_ID="$(derive_span_id 'CTL-300' '')"
if [[ ${#SPAN_ID} -eq 16 && "$SPAN_ID" =~ ^[0-9a-f]+$ ]]; then
  ok "derive_span_id CTL-300 → 16-hex"
else
  fail "derive_span_id CTL-300" "got '$SPAN_ID' (len ${#SPAN_ID})"
fi

# Parity test: bash-derived trace id matches TS-derived trace id for the same input.
# We check this by running the TS lib's derive function via bun.
if command -v bun >/dev/null 2>&1; then
  TS_TRACE="$(bun --eval "
    import('${REPO_ROOT}/plugins/dev/scripts/orch-monitor/lib/canonical-event.ts').then(m => {
      console.log(m.deriveTraceId('orch-foo', null));
    });
  " 2>/dev/null | tr -d '\n')"
  if [[ -n "$TS_TRACE" ]]; then
    expect_eq "bash/TS trace_id parity (orch-foo)" "$TS_TRACE" "$TRACE_ID"
  else
    echo "  SKIP: bash/TS trace parity (bun --eval returned empty)"
  fi

  TS_SPAN="$(bun --eval "
    import('${REPO_ROOT}/plugins/dev/scripts/orch-monitor/lib/canonical-event.ts').then(m => {
      console.log(m.deriveSpanId('CTL-300', null));
    });
  " 2>/dev/null | tr -d '\n')"
  if [[ -n "$TS_SPAN" ]]; then
    expect_eq "bash/TS span_id parity (CTL-300)" "$TS_SPAN" "$SPAN_ID"
  else
    echo "  SKIP: bash/TS span parity (bun --eval returned empty)"
  fi
else
  echo "  SKIP: bash/TS parity tests (bun not on PATH)"
fi

# build_canonical_line minimal envelope
LINE="$(build_canonical_line \
  --ts "2026-05-08T18:00:00.000Z" \
  --severity INFO \
  --service "catalyst.session" \
  --event-name "session.phase" \
  --session "sess_test" \
  --phase 5 \
  --message "phase 5 entered" \
  --payload-json '{"to":"running","phase":5}')"

EVENT_NAME="$(echo "$LINE" | jq -r '.attributes."event.name"')"
expect_eq "build_canonical_line event.name" "session.phase" "$EVENT_NAME"

SVC="$(echo "$LINE" | jq -r '.resource."service.name"')"
expect_eq "build_canonical_line service.name" "catalyst.session" "$SVC"

NAMESPACE="$(echo "$LINE" | jq -r '.resource."service.namespace"')"
expect_eq "build_canonical_line service.namespace" "catalyst" "$NAMESPACE"

SEV_NUM="$(echo "$LINE" | jq -r '.severityNumber')"
expect_eq "build_canonical_line severityNumber" "9" "$SEV_NUM"

CHANNEL="$(echo "$LINE" | jq -r '.attributes."event.channel" // ""')"
expect_eq "build_canonical_line no channel by default" "" "$CHANNEL"

PHASE_OUT="$(echo "$LINE" | jq -r '.attributes."catalyst.phase"')"
expect_eq "build_canonical_line catalyst.phase as integer" "5" "$PHASE_OUT"

MSG="$(echo "$LINE" | jq -r '.body.message')"
expect_eq "build_canonical_line body.message" "phase 5 entered" "$MSG"

PAYLOAD_TO="$(echo "$LINE" | jq -r '.body.payload.to')"
expect_eq "build_canonical_line body.payload.to" "running" "$PAYLOAD_TO"

# Required-field validation
if build_canonical_line --severity INFO --service x --event-name y >/dev/null 2>&1; then
  fail "build_canonical_line missing --ts" "should have failed"
else
  ok "build_canonical_line errors on missing --ts"
fi

# canonical_jsonl_append rotates legacy file on first write
SCRATCH="$(mktemp -d)"
LEGACY_FILE="${SCRATCH}/$(date -u +%Y-%m).jsonl"
echo '{"event":"legacy","ts":"2026-05-07T00:00:00Z"}' > "$LEGACY_FILE"

CANONICAL_LINE="$(build_canonical_line \
  --ts "2026-05-08T00:00:00.000Z" \
  --severity INFO \
  --service catalyst.session \
  --event-name session.started)"
canonical_jsonl_append "$SCRATCH" "$CANONICAL_LINE"

if [[ -f "${LEGACY_FILE}.legacy" ]]; then
  ok "canonical_jsonl_append rotates legacy file"
else
  fail "canonical_jsonl_append rotation" "no .legacy file at ${LEGACY_FILE}.legacy"
fi

NEW_LINE_COUNT="$(wc -l < "$LEGACY_FILE" | tr -d ' ')"
expect_eq "canonical_jsonl_append wrote new canonical line" "1" "$NEW_LINE_COUNT"

rm -rf "$SCRATCH"

echo ""
echo "Total: $((PASSES + FAILURES)), Passed: $PASSES, Failed: $FAILURES"
exit "$FAILURES"
