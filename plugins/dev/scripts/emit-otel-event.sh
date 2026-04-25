#!/usr/bin/env bash
# emit-otel-event.sh — Send one OTLP log record to the Claude Code collector.
#
# Used by catalyst-session.sh `end` and catalyst-state.sh `gc` to emit the
# `claude_code.session.outcome` event that closes the AI-native estimation
# feedback loop (CTL-157). The event lands in Loki under `{job="claude_code"}`
# because the collector upserts `service.name=claude-code` on its resource
# processor — we also set it explicitly in the resource attributes for
# robustness when talking directly to alternate backends.
#
# Usage:
#   emit-otel-event.sh --event <name> --outcome <enum> --session-id <id>
#                      [--reason <text>] [--linear-key <key>] [--attr k=v ...]
#
# --outcome must be one of: success, fail, timeout, abandoned.
#
# Transport: OTLP/HTTP (port 4318) to OTEL_EXPORTER_OTLP_ENDPOINT. When that
# env var is unset or the POST fails, we exit 0 silently — the caller is a
# session-end code path and must never be blocked by telemetry problems.

set -uo pipefail

VALID_OUTCOMES=(success fail timeout abandoned)

is_valid_outcome() {
  local v="$1" x
  for x in "${VALID_OUTCOMES[@]}"; do
    [[ "$x" == "$v" ]] && return 0
  done
  return 1
}

die() { echo "error: $*" >&2; exit 1; }

# ─── Parse args ─────────────────────────────────────────────────────────────

EVENT=""
OUTCOME=""
SESSION_ID=""
REASON=""
LINEAR_KEY=""
EXTRA_ATTRS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --event)       EVENT="$2"; shift 2 ;;
    --outcome)     OUTCOME="$2"; shift 2 ;;
    --session-id)  SESSION_ID="$2"; shift 2 ;;
    --reason)      REASON="$2"; shift 2 ;;
    --linear-key)  LINEAR_KEY="$2"; shift 2 ;;
    --attr)        EXTRA_ATTRS+=("$2"); shift 2 ;;
    -h|--help)     grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             die "unknown flag: $1" ;;
  esac
done

[[ -n "$EVENT" ]]      || die "--event is required"
[[ -n "$OUTCOME" ]]    || die "--outcome is required"
[[ -n "$SESSION_ID" ]] || die "--session-id is required"
is_valid_outcome "$OUTCOME" || die "--outcome must be one of: ${VALID_OUTCOMES[*]}"

# ─── Silent no-op when collector not configured ─────────────────────────────

if [[ -z "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]]; then
  exit 0
fi

# ─── Derive HTTP URL from env endpoint ──────────────────────────────────────
# OTEL_EXPORTER_OTLP_ENDPOINT is commonly gRPC (port 4317). OTLP/HTTP lives
# on :4318 and requires the /v1/logs path suffix. Swap the port when present;
# otherwise use the endpoint verbatim and still append /v1/logs.

BASE_URL="${OTEL_EXPORTER_OTLP_ENDPOINT%/}"
BASE_URL="${BASE_URL//:4317/:4318}"
URL="${BASE_URL}/v1/logs"

# ─── Build OTLP log payload ─────────────────────────────────────────────────

# Fallback: if --linear-key not passed but OTEL_RESOURCE_ATTRIBUTES has one,
# extract it. This lets callers that inherit the env automatically tag events
# without rewriting every call site.
if [[ -z "$LINEAR_KEY" && -n "${OTEL_RESOURCE_ATTRIBUTES:-}" ]]; then
  LINEAR_KEY=$(printf '%s\n' "$OTEL_RESOURCE_ATTRIBUTES" \
    | grep -oE 'linear\.key=[^,]+' \
    | head -1 \
    | cut -d= -f2- \
    || true)
fi

# Nanoseconds since epoch (macOS date doesn't support %N, so compute via bash).
NS=$(( $(date -u +%s) * 1000000000 ))

# Build resource attributes.
RES_ATTRS_JSON=$(jq -nc --arg svc "claude-code" '[{key:"service.name",value:{stringValue:$svc}}]')
if [[ -n "$LINEAR_KEY" ]]; then
  RES_ATTRS_JSON=$(echo "$RES_ATTRS_JSON" \
    | jq -c --arg k "$LINEAR_KEY" '. + [{key:"linear.key",value:{stringValue:$k}}]')
fi

# Build log record attributes.
LOG_ATTRS_JSON=$(jq -nc \
  --arg event "$EVENT" \
  --arg outcome "$OUTCOME" \
  --arg sid "$SESSION_ID" \
  '[{key:"event.name",value:{stringValue:$event}},
    {key:"outcome",value:{stringValue:$outcome}},
    {key:"session_id",value:{stringValue:$sid}}]')

if [[ -n "$REASON" ]]; then
  LOG_ATTRS_JSON=$(echo "$LOG_ATTRS_JSON" \
    | jq -c --arg r "$REASON" '. + [{key:"reason",value:{stringValue:$r}}]')
fi

for kv in "${EXTRA_ATTRS[@]}"; do
  key="${kv%%=*}"
  val="${kv#*=}"
  [[ -n "$key" && "$key" != "$kv" ]] || continue
  LOG_ATTRS_JSON=$(echo "$LOG_ATTRS_JSON" \
    | jq -c --arg k "$key" --arg v "$val" '. + [{key:$k,value:{stringValue:$v}}]')
done

PAYLOAD=$(jq -nc \
  --argjson res_attrs "$RES_ATTRS_JSON" \
  --argjson log_attrs "$LOG_ATTRS_JSON" \
  --arg event "$EVENT" \
  --arg ns "$NS" \
  '{resourceLogs:[
      {resource:{attributes:$res_attrs},
       scopeLogs:[
         {scope:{name:"catalyst.orchestrator"},
          logRecords:[
            {timeUnixNano:$ns,
             observedTimeUnixNano:$ns,
             severityNumber:9,
             severityText:"INFO",
             body:{stringValue:$event},
             attributes:$log_attrs}
          ]}
       ]}
    ]}')

# ─── POST ───────────────────────────────────────────────────────────────────
# --fail → non-zero on HTTP error (picked up by `|| true`).
# --max-time 2 → never block a session-end code path for long.
curl --silent --fail --max-time 2 \
  -H "Content-Type: application/json" \
  --data "$PAYLOAD" \
  "$URL" >/dev/null 2>&1 || true

exit 0
