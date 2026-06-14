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

# generate_event_id — non-empty and uniquely random per call (CTL-344)
EVENT_ID_1="$(generate_event_id)"
EVENT_ID_2="$(generate_event_id)"
if [[ ${#EVENT_ID_1} -ge 16 ]]; then
  ok "generate_event_id length >= 16"
else
  fail "generate_event_id length" "got '${EVENT_ID_1}' (len ${#EVENT_ID_1})"
fi
if [[ "$EVENT_ID_1" != "$EVENT_ID_2" ]]; then
  ok "generate_event_id unique across calls"
else
  fail "generate_event_id uniqueness" "two calls produced same id: ${EVENT_ID_1}"
fi

# synthesize_event_id — deterministic and 32-hex (CTL-344)
SYNTH_1="$(synthesize_event_id "trace1" "span1" "2026-05-12T00:00:00Z" "test.event")"
SYNTH_2="$(synthesize_event_id "trace1" "span1" "2026-05-12T00:00:00Z" "test.event")"
if [[ ${#SYNTH_1} -eq 32 && "$SYNTH_1" =~ ^[0-9a-f]+$ ]]; then
  ok "synthesize_event_id is 32-hex"
else
  fail "synthesize_event_id shape" "got '$SYNTH_1' (len ${#SYNTH_1})"
fi
expect_eq "synthesize_event_id deterministic" "$SYNTH_1" "$SYNTH_2"
SYNTH_OTHER="$(synthesize_event_id "trace2" "span1" "2026-05-12T00:00:00Z" "test.event")"
if [[ "$SYNTH_1" != "$SYNTH_OTHER" ]]; then
  ok "synthesize_event_id different inputs differ"
else
  fail "synthesize_event_id collision" "different inputs produced same id"
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

# build_canonical_line emits top-level id (CTL-344)
ID_OUT="$(echo "$LINE" | jq -r '.id')"
if [[ -n "$ID_OUT" && "$ID_OUT" != "null" && ${#ID_OUT} -ge 16 ]]; then
  ok "build_canonical_line top-level id present"
else
  fail "build_canonical_line id" "got '$ID_OUT' (len ${#ID_OUT})"
fi

# build_canonical_line: two calls with identical inputs produce different ids
# but identical traceId/spanId (twin property preserved for trace/span only)
LINE_B="$(build_canonical_line \
  --ts "2026-05-08T18:00:00.000Z" \
  --severity INFO \
  --service "catalyst.session" \
  --event-name "session.phase" \
  --trace-id "$(derive_trace_id 'orch-foo' '')" \
  --span-id "$(derive_span_id 'CTL-300' '')")"
LINE_C="$(build_canonical_line \
  --ts "2026-05-08T18:00:00.000Z" \
  --severity INFO \
  --service "catalyst.session" \
  --event-name "session.phase" \
  --trace-id "$(derive_trace_id 'orch-foo' '')" \
  --span-id "$(derive_span_id 'CTL-300' '')")"
ID_B="$(echo "$LINE_B" | jq -r '.id')"
ID_C="$(echo "$LINE_C" | jq -r '.id')"
TRACE_B="$(echo "$LINE_B" | jq -r '.traceId')"
TRACE_C="$(echo "$LINE_C" | jq -r '.traceId')"
SPAN_B="$(echo "$LINE_B" | jq -r '.spanId')"
SPAN_C="$(echo "$LINE_C" | jq -r '.spanId')"
if [[ "$ID_B" != "$ID_C" ]]; then
  ok "build_canonical_line id is unique across emissions"
else
  fail "build_canonical_line id uniqueness" "two emissions produced same id: $ID_B"
fi
expect_eq "build_canonical_line traceId stays deterministic" "$TRACE_B" "$TRACE_C"
expect_eq "build_canonical_line spanId stays deterministic" "$SPAN_B" "$SPAN_C"

SVC="$(echo "$LINE" | jq -r '.resource."service.name"')"
expect_eq "build_canonical_line service.name" "catalyst.session" "$SVC"

NAMESPACE="$(echo "$LINE" | jq -r '.resource."service.namespace"')"
expect_eq "build_canonical_line service.namespace" "catalyst" "$NAMESPACE"

# CTL-636: orchestration context promoted into the resource block.
LINE_RES="$(build_canonical_line \
  --ts "2026-05-25T18:00:00Z" \
  --severity INFO \
  --service "catalyst.session" \
  --event-name "phase.plan.complete" \
  --orch "CTL-636" \
  --linear-ticket "CTL-636")"

LINEAR_KEY_OUT="$(echo "$LINE_RES" | jq -r '.resource."linear.key" // ""')"
expect_eq "build_canonical_line promotes --linear-ticket to resource.linear.key" "CTL-636" "$LINEAR_KEY_OUT"

ORCH_OUT="$(echo "$LINE_RES" | jq -r '.resource."catalyst.orchestration" // ""')"
expect_eq "build_canonical_line promotes --orch to resource.catalyst.orchestration" "CTL-636" "$ORCH_OUT"

# attributes preserved, not moved
ATTR_LINEAR="$(echo "$LINE_RES" | jq -r '.attributes."linear.issue.identifier" // ""')"
expect_eq "build_canonical_line keeps linear.issue.identifier in attributes" "CTL-636" "$ATTR_LINEAR"

# absent when no context
LINE_BARE="$(build_canonical_line \
  --ts "2026-05-25T18:00:00Z" --severity INFO \
  --service "catalyst.session" --event-name "session.heartbeat")"
BARE_LINEAR="$(echo "$LINE_BARE" | jq -r '.resource | has("linear.key")')"
expect_eq "build_canonical_line omits linear.key with no context" "false" "$BARE_LINEAR"

# explicit override wins
LINE_OVR="$(build_canonical_line \
  --ts "2026-05-25T18:00:00Z" --severity INFO \
  --service "catalyst.session" --event-name "x" \
  --linear-ticket "CTL-636" --linear-key "CTL-999")"
OVR_OUT="$(echo "$LINE_OVR" | jq -r '.resource."linear.key"')"
expect_eq "build_canonical_line --linear-key overrides promotion" "CTL-999" "$OVR_OUT"

# project sourced from OTEL_RESOURCE_ATTRIBUTES
LINE_PROJ="$(OTEL_RESOURCE_ATTRIBUTES='catalyst.project=catalyst-workspace,linear.key=CTL-636' \
  build_canonical_line --ts "2026-05-25T18:00:00Z" --severity INFO \
  --service "catalyst.session" --event-name "x")"
PROJ_OUT="$(echo "$LINE_PROJ" | jq -r '.resource."catalyst.project" // ""')"
expect_eq "build_canonical_line sources project from OTEL_RESOURCE_ATTRIBUTES" "catalyst-workspace" "$PROJ_OUT"

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

# --- CTL-374: Claude Code metadata typed attributes ---

CLAUDE_LINE="$(build_canonical_line \
  --ts "2026-05-13T00:00:00.000Z" \
  --severity INFO \
  --service "catalyst.session" \
  --event-name "session.context" \
  --claude-session-id "8f3b1c0e-1234-4abc-9def-0123456789ab" \
  --claude-model "claude-opus-4-7" \
  --claude-context-used-pct 24 \
  --claude-context-tokens 245000 \
  --claude-turn 126)"

CLAUDE_SID="$(echo "$CLAUDE_LINE" | jq -r '.attributes."claude.session.id"')"
expect_eq "build_canonical_line claude.session.id" \
  "8f3b1c0e-1234-4abc-9def-0123456789ab" "$CLAUDE_SID"

CLAUDE_MODEL="$(echo "$CLAUDE_LINE" | jq -r '.attributes."claude.model"')"
expect_eq "build_canonical_line claude.model" "claude-opus-4-7" "$CLAUDE_MODEL"

CLAUDE_PCT="$(echo "$CLAUDE_LINE" | jq -r '.attributes."claude.context.used_pct"')"
expect_eq "build_canonical_line claude.context.used_pct as integer" "24" "$CLAUDE_PCT"

CLAUDE_PCT_TYPE="$(echo "$CLAUDE_LINE" | jq -r '.attributes."claude.context.used_pct" | type')"
expect_eq "build_canonical_line claude.context.used_pct is number" "number" "$CLAUDE_PCT_TYPE"

CLAUDE_TOKENS="$(echo "$CLAUDE_LINE" | jq -r '.attributes."claude.context.tokens"')"
expect_eq "build_canonical_line claude.context.tokens" "245000" "$CLAUDE_TOKENS"

CLAUDE_TOKENS_TYPE="$(echo "$CLAUDE_LINE" | jq -r '.attributes."claude.context.tokens" | type')"
expect_eq "build_canonical_line claude.context.tokens is number" "number" "$CLAUDE_TOKENS_TYPE"

CLAUDE_TURN="$(echo "$CLAUDE_LINE" | jq -r '.attributes."claude.turn"')"
expect_eq "build_canonical_line claude.turn" "126" "$CLAUDE_TURN"

CLAUDE_TURN_TYPE="$(echo "$CLAUDE_LINE" | jq -r '.attributes."claude.turn" | type')"
expect_eq "build_canonical_line claude.turn is number" "number" "$CLAUDE_TURN_TYPE"

# CTL-760: rate-limit 5h/7d used-percentages emitted as NUMERIC typed attributes.
RL_LINE="$(build_canonical_line \
  --ts "2026-06-03T00:00:00.000Z" \
  --severity INFO \
  --service "catalyst.session" \
  --event-name "session.context" \
  --claude-ratelimit-5h-pct 26 \
  --claude-ratelimit-7d-pct 15 \
  --claude-ratelimit-7d-opus-pct 12 \
  --claude-ratelimit-7d-sonnet-pct 9)"

RL_5H="$(echo "$RL_LINE" | jq -r '.attributes."claude.ratelimit.five_hour_pct"')"
expect_eq "build_canonical_line claude.ratelimit.five_hour_pct" "26" "$RL_5H"

RL_5H_TYPE="$(echo "$RL_LINE" | jq -r '.attributes."claude.ratelimit.five_hour_pct" | type')"
expect_eq "build_canonical_line claude.ratelimit.five_hour_pct is number" "number" "$RL_5H_TYPE"

RL_7D="$(echo "$RL_LINE" | jq -r '.attributes."claude.ratelimit.seven_day_pct"')"
expect_eq "build_canonical_line claude.ratelimit.seven_day_pct" "15" "$RL_7D"

RL_7D_TYPE="$(echo "$RL_LINE" | jq -r '.attributes."claude.ratelimit.seven_day_pct" | type')"
expect_eq "build_canonical_line claude.ratelimit.seven_day_pct is number" "number" "$RL_7D_TYPE"

# CTL-763: per-model 7d split — opus + sonnet typed numeric attributes.
RL_OPUS="$(echo "$RL_LINE" | jq -r '.attributes."claude.ratelimit.seven_day_opus_pct"')"
expect_eq "build_canonical_line claude.ratelimit.seven_day_opus_pct" "12" "$RL_OPUS"
RL_OPUS_TYPE="$(echo "$RL_LINE" | jq -r '.attributes."claude.ratelimit.seven_day_opus_pct" | type')"
expect_eq "build_canonical_line seven_day_opus_pct is number" "number" "$RL_OPUS_TYPE"

RL_SONNET="$(echo "$RL_LINE" | jq -r '.attributes."claude.ratelimit.seven_day_sonnet_pct"')"
expect_eq "build_canonical_line claude.ratelimit.seven_day_sonnet_pct" "9" "$RL_SONNET"
RL_SONNET_TYPE="$(echo "$RL_LINE" | jq -r '.attributes."claude.ratelimit.seven_day_sonnet_pct" | type')"
expect_eq "build_canonical_line seven_day_sonnet_pct is number" "number" "$RL_SONNET_TYPE"

# When claude.* flags are NOT passed, the attribute keys must be absent.
BARE_LINE="$(build_canonical_line \
  --ts "2026-05-13T00:00:00.000Z" \
  --severity INFO \
  --service "catalyst.session" \
  --event-name "session.phase")"

HAS_SID="$(echo "$BARE_LINE" | jq 'has("attributes") and (.attributes | has("claude.session.id"))')"
expect_eq "no --claude-session-id → key absent" "false" "$HAS_SID"

HAS_MODEL="$(echo "$BARE_LINE" | jq '.attributes | has("claude.model")')"
expect_eq "no --claude-model → key absent" "false" "$HAS_MODEL"

HAS_PCT="$(echo "$BARE_LINE" | jq '.attributes | has("claude.context.used_pct")')"
expect_eq "no --claude-context-used-pct → key absent" "false" "$HAS_PCT"

HAS_TOKENS="$(echo "$BARE_LINE" | jq '.attributes | has("claude.context.tokens")')"
expect_eq "no --claude-context-tokens → key absent" "false" "$HAS_TOKENS"

HAS_TURN="$(echo "$BARE_LINE" | jq '.attributes | has("claude.turn")')"
expect_eq "no --claude-turn → key absent" "false" "$HAS_TURN"

# CTL-760: rate-limit attrs absent when flags not passed.
HAS_RL5H="$(echo "$BARE_LINE" | jq '.attributes | has("claude.ratelimit.five_hour_pct")')"
expect_eq "no --claude-ratelimit-5h-pct → key absent" "false" "$HAS_RL5H"

HAS_RL7D="$(echo "$BARE_LINE" | jq '.attributes | has("claude.ratelimit.seven_day_pct")')"
expect_eq "no --claude-ratelimit-7d-pct → key absent" "false" "$HAS_RL7D"

# CTL-763: per-model attrs absent when flags not passed.
HAS_RL_OPUS="$(echo "$BARE_LINE" | jq '.attributes | has("claude.ratelimit.seven_day_opus_pct")')"
expect_eq "no --claude-ratelimit-7d-opus-pct → key absent" "false" "$HAS_RL_OPUS"
HAS_RL_SONNET="$(echo "$BARE_LINE" | jq '.attributes | has("claude.ratelimit.seven_day_sonnet_pct")')"
expect_eq "no --claude-ratelimit-7d-sonnet-pct → key absent" "false" "$HAS_RL_SONNET"

# Cost MUST NOT be a typed attribute (PII gate — OTLP forwarder strips body.payload only).
HAS_COST_ATTR="$(echo "$CLAUDE_LINE" | jq '.attributes | has("claude.cost.usd")')"
expect_eq "claude.cost.usd is NEVER a typed attribute (PII gate)" "false" "$HAS_COST_ATTR"

# ── CTL-448: phase-agent event shape validation ────────────────────────────
# The phase-agent dispatcher (Initiative 1 Phase 2) emits two new event names
# via build_canonical_line through phase-agent-emit-complete:
#   phase.<name>.complete.<ticket>
#   phase.<name>.failed.<ticket>
# The broker's phase_lifecycle interest type (CTL-447) only routes events
# matching the regex below — these tests guard the shape against drift.

PHASE_COMPLETE_LINE="$(build_canonical_line \
  --ts "2026-05-17T00:00:00Z" \
  --severity INFO \
  --service "catalyst.phase-agent" \
  --event-name "phase.research.complete.CTL-100" \
  --entity "phase" \
  --action "complete" \
  --orch "orch-test" \
  --worker "CTL-100" \
  --linear-ticket "CTL-100" \
  --payload-json '{"phase":"research","ticket":"CTL-100","status":"complete"}')"

PHASE_EVENT_NAME="$(echo "$PHASE_COMPLETE_LINE" | jq -r '.attributes."event.name"')"
expect_eq "phase.complete event.name" "phase.research.complete.CTL-100" "$PHASE_EVENT_NAME"

PHASE_PATTERN_MATCH="$(printf '%s' "$PHASE_EVENT_NAME" \
  | grep -cE '^phase\.([^.]+)\.(complete|failed)\.([A-Za-z][A-Za-z0-9_]*-[0-9]+)$' || true)"
expect_eq "phase.complete event.name matches broker regex" "1" "$PHASE_PATTERN_MATCH"

PHASE_WORKER="$(echo "$PHASE_COMPLETE_LINE" | jq -r '.attributes."catalyst.worker.ticket"')"
expect_eq "phase.complete worker ticket attribute" "CTL-100" "$PHASE_WORKER"

PHASE_LINEAR="$(echo "$PHASE_COMPLETE_LINE" | jq -r '.attributes."linear.issue.identifier"')"
expect_eq "phase.complete linear.issue.identifier" "CTL-100" "$PHASE_LINEAR"

PHASE_PAYLOAD_STATUS="$(echo "$PHASE_COMPLETE_LINE" | jq -r '.body.payload.status')"
expect_eq "phase.complete body.payload.status" "complete" "$PHASE_PAYLOAD_STATUS"

PHASE_FAILED_LINE="$(build_canonical_line \
  --ts "2026-05-17T00:00:00Z" \
  --severity WARN \
  --service "catalyst.phase-agent" \
  --event-name "phase.verify.failed.CTL-200" \
  --entity "phase" \
  --action "failed" \
  --orch "orch-test" \
  --worker "CTL-200" \
  --linear-ticket "CTL-200" \
  --payload-json '{"phase":"verify","ticket":"CTL-200","status":"failed","failure_reason":"goal cap"}')"

PHASE_FAILED_NAME="$(echo "$PHASE_FAILED_LINE" | jq -r '.attributes."event.name"')"
expect_eq "phase.failed event.name" "phase.verify.failed.CTL-200" "$PHASE_FAILED_NAME"

PHASE_FAILED_MATCH="$(printf '%s' "$PHASE_FAILED_NAME" \
  | grep -cE '^phase\.([^.]+)\.(complete|failed)\.([A-Za-z][A-Za-z0-9_]*-[0-9]+)$' || true)"
expect_eq "phase.failed event.name matches broker regex" "1" "$PHASE_FAILED_MATCH"

PHASE_FAILED_SEVERITY="$(echo "$PHASE_FAILED_LINE" | jq -r '.severityText')"
expect_eq "phase.failed severity = WARN" "WARN" "$PHASE_FAILED_SEVERITY"

PHASE_FAILED_REASON="$(echo "$PHASE_FAILED_LINE" | jq -r '.body.payload.failure_reason')"
expect_eq "phase.failed body.payload.failure_reason" "goal cap" "$PHASE_FAILED_REASON"

# A malformed phase event name (no ticket suffix) must NOT match the regex.
BAD_PHASE_NAME="phase.research.complete"
BAD_MATCH="$(printf '%s' "$BAD_PHASE_NAME" \
  | grep -cE '^phase\.([^.]+)\.(complete|failed)\.([A-Za-z][A-Za-z0-9_]*-[0-9]+)$' || true)"
expect_eq "malformed phase event name does NOT match broker regex" "0" "$BAD_MATCH"

# CTL-761: phase.attempt / phase.revive_count are typed int attributes
LINE_ATT="$(build_canonical_line \
  --ts "2026-06-05T00:00:00Z" --severity INFO \
  --service catalyst.phase-agent --event-name "phase.implement.complete.CTL-761" \
  --phase-attempt 2 --phase-revive-count 1)"
ATT=$(echo "$LINE_ATT" | jq -r '.attributes["phase.attempt"]')
RC=$(echo "$LINE_ATT" | jq -r '.attributes["phase.revive_count"]')
expect_eq "build_canonical_line phase.attempt typed int" "2" "$ATT"
expect_eq "build_canonical_line phase.revive_count typed int" "1" "$RC"
TYPE=$(echo "$LINE_ATT" | jq -r '.attributes["phase.attempt"] | type')
expect_eq "phase.attempt is a JSON number" "number" "$TYPE"

LINE_BARE="$(build_canonical_line \
  --ts "2026-06-05T00:00:00Z" --severity INFO \
  --service catalyst.phase-agent --event-name "phase.implement.complete.CTL-761")"
HAS=$(echo "$LINE_BARE" | jq -r '.attributes | has("phase.attempt")')
expect_eq "phase.attempt omitted when flag absent" "false" "$HAS"

# CTL-1023: catalyst.ticket.type — work-type dimension, ALWAYS present.
LINE_TT="$(build_canonical_line \
  --ts "2026-06-05T00:00:00Z" --severity INFO \
  --service catalyst.phase-agent --event-name "phase.implement.complete.CTL-1023" \
  --ticket-type bug)"
TT=$(echo "$LINE_TT" | jq -r '.attributes["catalyst.ticket.type"]')
expect_eq "build_canonical_line catalyst.ticket.type from --ticket-type" "bug" "$TT"

# Default: omitted/empty --ticket-type → "unknown" (never inconsistently missing).
LINE_TT_BARE="$(build_canonical_line \
  --ts "2026-06-05T00:00:00Z" --severity INFO \
  --service catalyst.phase-agent --event-name "phase.implement.complete.CTL-1023")"
TT_HAS=$(echo "$LINE_TT_BARE" | jq -r '.attributes | has("catalyst.ticket.type")')
TT_DEF=$(echo "$LINE_TT_BARE" | jq -r '.attributes["catalyst.ticket.type"]')
expect_eq "catalyst.ticket.type present even when flag absent" "true" "$TT_HAS"
expect_eq "catalyst.ticket.type defaults to 'unknown'" "unknown" "$TT_DEF"

echo ""
echo "Total: $((PASSES + FAILURES)), Passed: $PASSES, Failed: $FAILURES"
exit "$FAILURES"
