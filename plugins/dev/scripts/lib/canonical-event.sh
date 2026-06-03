#!/usr/bin/env bash
# canonical-event.sh — bash helpers for emitting OTel-shaped canonical events
# (CTL-300). Mirrors `plugins/dev/scripts/orch-monitor/lib/canonical-event.ts`
# so trace/span IDs match deterministically across TS and bash producers.
#
# Source this file from any bash producer that writes to
# ~/catalyst/events/YYYY-MM.jsonl, then call:
#
#   build_canonical_line  → echoes one canonical JSONL line on stdout
#   derive_trace_id ORCH SESSION → echoes 32-hex (or empty)
#   derive_span_id  WORKER SESSION → echoes 16-hex (or empty)
#   severity_number SEVERITY    → echoes the OTel number
#   plugin_version              → echoes catalyst-dev plugin version
#
# This module is idempotent: sourcing it twice is a no-op.

if [[ -n "${__CATALYST_CANONICAL_SOURCED:-}" ]]; then
  return 0
fi
__CATALYST_CANONICAL_SOURCED=1

# Resolve plugin.json relative to this file:
#   plugins/dev/scripts/lib/canonical-event.sh
#   plugins/dev/.claude-plugin/plugin.json
# Portable self-path: BASH_SOURCE under bash, prompt-expansion %x under zsh (CTL-618).
__CE_SELF="${BASH_SOURCE[0]:-${(%):-%x}}"
__CE_LIB_DIR="$(cd "$(dirname "$__CE_SELF")" && pwd)"
__CE_PLUGIN_JSON="${__CE_LIB_DIR}/../../.claude-plugin/plugin.json"
__CE_VERSION_CACHED=""

# severity_number SEVERITY
# Map DEBUG/INFO/WARN/ERROR to OTel severity numbers (5/9/13/17).
severity_number() {
  case "$1" in
    DEBUG) echo 5 ;;
    INFO)  echo 9 ;;
    WARN)  echo 13 ;;
    ERROR) echo 17 ;;
    *)     echo 9 ;;
  esac
}

# plugin_version
# Reads version from .claude-plugin/plugin.json, cached after first read.
# Falls back to "0.0.0" when the file is unreadable.
plugin_version() {
  if [[ -n "$__CE_VERSION_CACHED" ]]; then
    printf '%s' "$__CE_VERSION_CACHED"
    return 0
  fi
  if [[ -r "$__CE_PLUGIN_JSON" ]] && command -v jq >/dev/null 2>&1; then
    __CE_VERSION_CACHED="$(jq -r '.version // "0.0.0"' "$__CE_PLUGIN_JSON" 2>/dev/null || echo 0.0.0)"
  else
    __CE_VERSION_CACHED="0.0.0"
  fi
  printf '%s' "$__CE_VERSION_CACHED"
}

# Internal: hex-truncated SHA-256 of a string.
__ce_sha256_hex() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | cut -d' ' -f1
  else
    printf '0000000000000000000000000000000000000000000000000000000000000000'
  fi
}

# derive_trace_id ORCH_ID SESSION_ID
# Echoes 32-hex (32 chars) or empty if both inputs empty.
derive_trace_id() {
  local orch="${1:-}" sess="${2:-}"
  if [[ -n "$orch" ]]; then
    __ce_sha256_hex "$orch" | cut -c1-32
  elif [[ -n "$sess" ]]; then
    __ce_sha256_hex "standalone:${sess}" | cut -c1-32
  fi
}

# derive_span_id WORKER_TICKET SESSION_ID
# Echoes 16-hex (16 chars) or empty if both inputs empty.
derive_span_id() {
  local worker="${1:-}" sess="${2:-}"
  if [[ -n "$worker" ]]; then
    __ce_sha256_hex "$worker" | cut -c1-16
  elif [[ -n "$sess" ]]; then
    __ce_sha256_hex "$sess" | cut -c1-16
  fi
}

# generate_event_id
# Echoes a unique-per-call event identifier. Prefers `uuidgen` (RFC-4122 v4);
# falls back to a timestamp + RANDOM blend when uuidgen is absent. The fallback
# is not RFC-4122-shaped but is collision-resistant at our event volume.
generate_event_id() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr 'A-Z' 'a-z'
  else
    printf '%s-%04x%04x-%04x%04x\n' \
      "$(date -u +%Y%m%dT%H%M%S)" \
      "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM"
  fi
}

# synthesize_event_id TRACE_ID SPAN_ID TS EVENT_NAME
# Echoes a stable 32-hex synthetic id for legacy records that have no `id`.
# Deterministic across runs given the same inputs.
synthesize_event_id() {
  local trace="${1:-}" span="${2:-}" ts="${3:-}" name="${4:-}"
  __ce_sha256_hex "${trace}:${span}:${ts}:${name}" | cut -c1-32
}

# build_canonical_line ARGS...
#
# Emits one canonical JSONL line on stdout. Required flags:
#   --ts ISO              event timestamp (ISO 8601)
#   --severity NAME       DEBUG|INFO|WARN|ERROR
#   --service NAME        e.g. catalyst.session, catalyst.orchestrator
#   --event-name NAME     e.g. session.phase, github.pr.merged
#
# Optional flags:
#   --trace-id HEX        (32-hex); pass empty for ambient
#   --span-id HEX         (16-hex)
#   --entity NAME         event.entity attribute
#   --action NAME         event.action attribute
#   --label STR           event.label attribute
#   --value STR           event.value attribute (string form)
#   --channel webhook|sme.io
#   --orch ID             catalyst.orchestrator.id
#   --worker TICKET       catalyst.worker.ticket
#   --session ID          catalyst.session.id
#   --phase N             catalyst.phase (integer)
#   --vcs-pr N            vcs.pr.number (integer)
#   --vcs-repo NAME       vcs.repository.name
#   --linear-ticket KEY   linear.issue.identifier
#
# CTL-636: optional resource-block orchestration context. When omitted, --orch
# and --linear-ticket are promoted into the resource block automatically, and
# `project` is read from the ambient OTEL_RESOURCE_ATTRIBUTES env. These flags
# override that promotion; each key is omitted from the resource block when its
# resolved value is empty.
#   --project NAME                resource.project
#   --linear-key KEY              resource."linear.key" (default: --linear-ticket)
#   --catalyst-orchestration ID   resource."catalyst.orchestration" (default: --orch)
#   --message STR         body.message
#   --payload-json JSON   body.payload (must be valid JSON; default null)
#   --service-version VER service.version (default = plugin_version)
#
# Claude Code metadata (CTL-374). Cost is intentionally NOT a typed attribute —
# put `cost_usd` in --payload-json instead. The OTLP forwarder strips body.payload
# before sending off the local machine.
#   --claude-session-id ID         claude.session.id (Claude Code session UUID)
#   --claude-model NAME            claude.model (e.g. claude-opus-4-7)
#   --claude-context-used-pct N    claude.context.used_pct (integer)
#   --claude-context-tokens N      claude.context.tokens (integer)
#   --claude-turn N                claude.turn (integer)
#   --claude-ratelimit-5h-pct N    claude.ratelimit.five_hour_pct (integer, CTL-760)
#   --claude-ratelimit-7d-pct N    claude.ratelimit.seven_day_pct (integer, CTL-760)
build_canonical_line() {
  local ts="" severity="" service="" event_name=""
  local trace_id="" span_id=""
  local entity="" action="" label="" value="" channel=""
  local orch="" worker="" session="" phase=""
  local vcs_pr="" vcs_repo="" linear_ticket=""
  local message="" payload="null"
  local service_version=""
  # CTL-636: optional resource-block orchestration context.
  local project="" linear_key="" cat_orch=""
  local claude_session_id="" claude_model=""
  local claude_context_used_pct="" claude_context_tokens="" claude_turn=""
  # CTL-760: rate-limit 5h/7d used-percentages (numeric typed attributes).
  local claude_rl_5h="" claude_rl_7d=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ts)              ts="$2"; shift 2 ;;
      --severity)        severity="$2"; shift 2 ;;
      --service)         service="$2"; shift 2 ;;
      --event-name)      event_name="$2"; shift 2 ;;
      --trace-id)        trace_id="$2"; shift 2 ;;
      --span-id)         span_id="$2"; shift 2 ;;
      --entity)          entity="$2"; shift 2 ;;
      --action)          action="$2"; shift 2 ;;
      --label)           label="$2"; shift 2 ;;
      --value)           value="$2"; shift 2 ;;
      --channel)         channel="$2"; shift 2 ;;
      --orch)            orch="$2"; shift 2 ;;
      --worker)          worker="$2"; shift 2 ;;
      --session)         session="$2"; shift 2 ;;
      --phase)           phase="$2"; shift 2 ;;
      --vcs-pr)          vcs_pr="$2"; shift 2 ;;
      --vcs-repo)        vcs_repo="$2"; shift 2 ;;
      --linear-ticket)   linear_ticket="$2"; shift 2 ;;
      --project)                project="$2"; shift 2 ;;
      --linear-key)             linear_key="$2"; shift 2 ;;
      --catalyst-orchestration) cat_orch="$2"; shift 2 ;;
      --message)         message="$2"; shift 2 ;;
      --payload-json)    payload="${2:-null}"; shift 2 ;;
      --service-version) service_version="$2"; shift 2 ;;
      --claude-session-id)         claude_session_id="$2"; shift 2 ;;
      --claude-model)              claude_model="$2"; shift 2 ;;
      --claude-context-used-pct)   claude_context_used_pct="$2"; shift 2 ;;
      --claude-context-tokens)     claude_context_tokens="$2"; shift 2 ;;
      --claude-turn)               claude_turn="$2"; shift 2 ;;
      --claude-ratelimit-5h-pct)   claude_rl_5h="$2"; shift 2 ;;
      --claude-ratelimit-7d-pct)   claude_rl_7d="$2"; shift 2 ;;
      *) echo "build_canonical_line: unknown flag: $1" >&2; return 1 ;;
    esac
  done

  [[ -n "$ts"         ]] || { echo "build_canonical_line: --ts required" >&2; return 1; }
  [[ -n "$severity"   ]] || { echo "build_canonical_line: --severity required" >&2; return 1; }
  [[ -n "$service"    ]] || { echo "build_canonical_line: --service required" >&2; return 1; }
  [[ -n "$event_name" ]] || { echo "build_canonical_line: --event-name required" >&2; return 1; }
  [[ -n "$service_version" ]] || service_version="$(plugin_version)"

  # CTL-636: promote orchestration context into the resource block. Existing
  # callers already pass --orch / --linear-ticket (which land in attributes);
  # mirror them into resource without a call-site change. Explicit --linear-key /
  # --catalyst-orchestration / --project override. `project` is parsed from the
  # ambient OTEL_RESOURCE_ATTRIBUTES the same way emit-otel-event.sh:82-88 does.
  [[ -n "$linear_key" ]] || linear_key="$linear_ticket"
  [[ -n "$cat_orch" ]]   || cat_orch="$orch"
  if [[ -z "$project" && -n "${OTEL_RESOURCE_ATTRIBUTES:-}" ]]; then
    project="$(printf '%s\n' "$OTEL_RESOURCE_ATTRIBUTES" \
      | grep -oE 'project=[^,]+' | head -1 | cut -d= -f2- || true)"
  fi

  local sev_num event_id
  sev_num="$(severity_number "$severity")"
  event_id="$(generate_event_id)"

  jq -nc \
    --arg ts "$ts" \
    --arg id "$event_id" \
    --arg sev_text "$severity" \
    --argjson sev_num "$sev_num" \
    --arg trace_id "$trace_id" \
    --arg span_id "$span_id" \
    --arg svc_name "$service" \
    --arg svc_ver "$service_version" \
    --arg event_name "$event_name" \
    --arg entity "$entity" \
    --arg action "$action" \
    --arg label "$label" \
    --arg value "$value" \
    --arg channel "$channel" \
    --arg orch "$orch" \
    --arg worker "$worker" \
    --arg session "$session" \
    --arg phase "$phase" \
    --arg vcs_pr "$vcs_pr" \
    --arg vcs_repo "$vcs_repo" \
    --arg linear_ticket "$linear_ticket" \
    --arg project "$project" \
    --arg linear_key "$linear_key" \
    --arg cat_orch "$cat_orch" \
    --arg message "$message" \
    --argjson payload "$payload" \
    --arg claude_session_id "$claude_session_id" \
    --arg claude_model "$claude_model" \
    --arg claude_context_used_pct "$claude_context_used_pct" \
    --arg claude_context_tokens "$claude_context_tokens" \
    --arg claude_turn "$claude_turn" \
    --arg claude_rl_5h "$claude_rl_5h" \
    --arg claude_rl_7d "$claude_rl_7d" \
    '{
      ts: $ts,
      id: $id,
      observedTs: $ts,
      severityText: $sev_text,
      severityNumber: $sev_num,
      traceId: (if $trace_id == "" then null else $trace_id end),
      spanId:  (if $span_id  == "" then null else $span_id  end),
      resource: (
        {
          "service.name": $svc_name,
          "service.namespace": "catalyst",
          "service.version": $svc_ver
        }
        + (if $project    == "" then {} else { "project": $project } end)
        + (if $linear_key == "" then {} else { "linear.key": $linear_key } end)
        + (if $cat_orch   == "" then {} else { "catalyst.orchestration": $cat_orch } end)
      ),
      attributes: (
        { "event.name": $event_name }
        + (if $entity  == "" then {} else { "event.entity": $entity }  end)
        + (if $action  == "" then {} else { "event.action": $action }  end)
        + (if $label   == "" then {} else { "event.label":  $label }   end)
        + (if $value   == "" then {} else { "event.value":  $value }   end)
        + (if $channel == "" then {} else { "event.channel": $channel } end)
        + (if $orch    == "" then {} else { "catalyst.orchestrator.id": $orch } end)
        + (if $worker  == "" then {} else { "catalyst.worker.ticket": $worker } end)
        + (if $session == "" then {} else { "catalyst.session.id": $session } end)
        + (if $phase   == "" then {} else { "catalyst.phase": ($phase | tonumber) } end)
        + (if $vcs_pr  == "" then {} else { "vcs.pr.number": ($vcs_pr | tonumber) } end)
        + (if $vcs_repo == "" then {} else { "vcs.repository.name": $vcs_repo } end)
        + (if $linear_ticket == "" then {} else { "linear.issue.identifier": $linear_ticket } end)
        + (if $claude_session_id == "" then {} else { "claude.session.id": $claude_session_id } end)
        + (if $claude_model == "" then {} else { "claude.model": $claude_model } end)
        + (if $claude_context_used_pct == "" then {} else { "claude.context.used_pct": ($claude_context_used_pct | tonumber) } end)
        + (if $claude_context_tokens == "" then {} else { "claude.context.tokens": ($claude_context_tokens | tonumber) } end)
        + (if $claude_turn == "" then {} else { "claude.turn": ($claude_turn | tonumber) } end)
        + (if $claude_rl_5h == "" then {} else { "claude.ratelimit.five_hour_pct": ($claude_rl_5h | tonumber) } end)
        + (if $claude_rl_7d == "" then {} else { "claude.ratelimit.seven_day_pct": ($claude_rl_7d | tonumber) } end)
      ),
      body: (
        (if $message == "" then {} else { message: $message } end)
        + { payload: $payload }
      )
    }'
}

# canonical_jsonl_append BASE_DIR LINE
# Append a JSONL line to ${BASE_DIR}/YYYY-MM.jsonl. Rotates the existing file
# to *.legacy on first canonical write if the first existing line lacks an
# `attributes` field (legacy v1/v2 detection). Best-effort — write failures
# are silenced.
canonical_jsonl_append() {
  local base_dir="$1" line="$2"
  [[ -n "$base_dir" ]] || return 0
  mkdir -p "$base_dir" 2>/dev/null || return 0
  local month_file
  month_file="${base_dir}/$(date -u +%Y-%m).jsonl"
  if [[ -f "$month_file" ]]; then
    local first
    first="$(head -n 1 "$month_file" 2>/dev/null || true)"
    if [[ -n "$first" ]] && ! printf '%s' "$first" | jq -e 'has("attributes")' >/dev/null 2>&1; then
      mv "$month_file" "${month_file}.legacy" 2>/dev/null || true
    fi
  fi
  printf '%s\n' "$line" >> "$month_file" 2>/dev/null || true
}
