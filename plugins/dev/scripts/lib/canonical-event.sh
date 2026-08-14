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

# CTL-852: source host-identity primitives (catalyst_host_name, catalyst_host_id).
# shellcheck source=lib/host-identity.sh
source "${__CE_LIB_DIR}/host-identity.sh"
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
#   --claude-ratelimit-7d-opus-pct N    claude.ratelimit.seven_day_opus_pct (integer, CTL-763)
#   --claude-ratelimit-7d-sonnet-pct N  claude.ratelimit.seven_day_sonnet_pct (integer, CTL-763)
#   --phase-attempt N        phase.attempt (integer, CTL-761)
#   --phase-revive-count N   phase.revive_count (integer, CTL-761)
#   --ticket-type TYPE       catalyst.ticket.type (CTL-1023 work-type dimension;
#                            bug|feature|chore|refactor|docs|test). Defaults to
#                            "unknown" when omitted/empty so the attribute is
#                            CONSISTENTLY present, never sometimes-missing.
# classify_event_stream EVENT_NAME
# Prints "coordination" or "telemetry". CTL-1488: bash mirror of the ESM
# single-source-of-truth classifier at plugins/dev/scripts/lib/event-stream-class.mjs.
# Bash can't `import` ESM, so the allowlist is hand-mirrored the same way this
# file keeps bash/TS in lockstep for trace/span-id derivation. Keep the two in
# sync — canonical-event.test.sh + event-stream-class.test.mjs cross-check them.
# Fail-closed: anything not explicitly allowlisted → telemetry.
classify_event_stream() {
  local name="${1:-}"
  case "$name" in
    # KNOWN_PHASES (namespace-contract.mjs:36) — the canonical 10 pipeline phases.
    phase.triage.*|phase.research.*|phase.plan.*|phase.implement.*|phase.verify.*|\
    phase.review.*|phase.pr.*|phase.monitor-merge.*|phase.monitor-deploy.*|phase.teardown.*|\
    phase.dispatch.*|phase.scheduler.*|phase.advance.*|\
    worker.transition|worker.transition.*|escalation.*|resume.*|linear.*|github.*|comms.*)
      printf 'coordination' ;;
    *)
      printf 'telemetry' ;;
  esac
}

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
  # CTL-763: per-model 7d split.
  local claude_rl_7d_opus="" claude_rl_7d_sonnet=""
  # CTL-761: dispatch attempt + revive count (typed int attributes).
  local phase_attempt="" phase_revive_count=""
  # CTL-1023: work-type dimension (catalyst.ticket.type). Default "unknown" so the
  # attribute is consistently present even when the caller cannot resolve a type.
  local ticket_type=""

  # CTL-1135: caused_by — the id of the triggering event (additive; null when absent).
  local caused_by=""

  # CTL-1457: catalyst.executor — the launch verb that ran the worker (bg | sdk |
  # codex-exec). Additive, omit-when-empty: absent CATALYST_EXECUTOR_ID leaves the
  # event byte-identical to today.
  local executor=""

  # CTL-1403: reads-by-source attributes (linear.read.*). source/result are the
  # low-card metric dimensions (the collector normalizes → bare source/result);
  # op is structured metadata; age_ms is a numeric VALUE (feeds the staleness
  # histogram) emitted only when computable — never faked.
  local linear_read_source="" linear_read_result="" linear_read_op="" linear_read_age_ms=""

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
      --claude-ratelimit-5h-pct)        claude_rl_5h="$2"; shift 2 ;;
      --claude-ratelimit-7d-pct)        claude_rl_7d="$2"; shift 2 ;;
      --claude-ratelimit-7d-opus-pct)   claude_rl_7d_opus="$2"; shift 2 ;;
      --claude-ratelimit-7d-sonnet-pct) claude_rl_7d_sonnet="$2"; shift 2 ;;
      --phase-attempt)       phase_attempt="$2"; shift 2 ;;
      --phase-revive-count)  phase_revive_count="$2"; shift 2 ;;
      --ticket-type)         ticket_type="$2"; shift 2 ;;
      --executor)            executor="$2"; shift 2 ;;
      --caused-by)           caused_by="$2"; shift 2 ;;
      --linear-read-source)  linear_read_source="$2"; shift 2 ;;
      --linear-read-result)  linear_read_result="$2"; shift 2 ;;
      --linear-read-op)      linear_read_op="$2"; shift 2 ;;
      --linear-read-age-ms)  linear_read_age_ms="$2"; shift 2 ;;
      *) echo "build_canonical_line: unknown flag: $1" >&2; return 1 ;;
    esac
  done

  [[ -n "$ts"         ]] || { echo "build_canonical_line: --ts required" >&2; return 1; }
  [[ -n "$severity"   ]] || { echo "build_canonical_line: --severity required" >&2; return 1; }
  [[ -n "$service"    ]] || { echo "build_canonical_line: --service required" >&2; return 1; }
  [[ -n "$event_name" ]] || { echo "build_canonical_line: --event-name required" >&2; return 1; }
  [[ -n "$service_version" ]] || service_version="$(plugin_version)"
  # CTL-1023: the work-type dimension is ALWAYS present — fall back to "unknown"
  # so consumers can group by it without coping with a sometimes-missing key.
  [[ -n "$ticket_type" ]] || ticket_type="unknown"

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

  local sev_num event_id host_name host_id_val node_class_val stream_class
  sev_num="$(severity_number "$severity")"
  event_id="$(generate_event_id)"
  host_name="$(catalyst_host_name)"
  host_id_val="$(catalyst_host_id)"
  node_class_val="$(catalyst_node_class)"  # CTL-1368: the node ROLE core dimension
  stream_class="$(classify_event_stream "$event_name")"  # CTL-1488: coordination/telemetry split

  jq -nc \
    --arg ts "$ts" \
    --arg id "$event_id" \
    --arg sev_text "$severity" \
    --argjson sev_num "$sev_num" \
    --arg trace_id "$trace_id" \
    --arg span_id "$span_id" \
    --arg svc_name "$service" \
    --arg svc_ver "$service_version" \
    --arg host_name "$host_name" \
    --arg host_id "$host_id_val" \
    --arg node_class "$node_class_val" \
    --arg stream_class "$stream_class" \
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
    --arg claude_rl_7d_opus "$claude_rl_7d_opus" \
    --arg claude_rl_7d_sonnet "$claude_rl_7d_sonnet" \
    --arg phase_attempt "$phase_attempt" \
    --arg phase_revive_count "$phase_revive_count" \
    --arg ticket_type "$ticket_type" \
    --arg executor "$executor" \
    --arg caused_by "$caused_by" \
    --arg linear_read_source "$linear_read_source" \
    --arg linear_read_result "$linear_read_result" \
    --arg linear_read_op "$linear_read_op" \
    --arg linear_read_age_ms "$linear_read_age_ms" \
    '{
      ts: $ts,
      id: $id,
      observedTs: $ts,
      severityText: $sev_text,
      severityNumber: $sev_num,
      traceId: (if $trace_id == "" then null else $trace_id end),
      spanId:  (if $span_id  == "" then null else $span_id  end),
      caused_by: (if $caused_by == "" then null else $caused_by end),
      resource: (
        {
          "service.name": $svc_name,
          "service.namespace": "catalyst",
          "service.version": $svc_ver,
          "host.name": $host_name,
          "host.id": $host_id,
          "catalyst.node.class": $node_class
        }
        + (if $project    == "" then {} else { "project": $project } end)
        + (if $linear_key == "" then {} else { "linear.key": $linear_key } end)
        + (if $cat_orch   == "" then {} else { "catalyst.orchestration": $cat_orch } end)
      ),
      attributes: (
        { "event.name": $event_name, "event.stream_class": $stream_class }
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
        + (if $claude_rl_7d_opus   == "" then {} else { "claude.ratelimit.seven_day_opus_pct":   ($claude_rl_7d_opus   | tonumber) } end)
        + (if $claude_rl_7d_sonnet == "" then {} else { "claude.ratelimit.seven_day_sonnet_pct": ($claude_rl_7d_sonnet | tonumber) } end)
        + (if $phase_attempt == "" then {} else { "phase.attempt": ($phase_attempt | tonumber) } end)
        + (if $phase_revive_count == "" then {} else { "phase.revive_count": ($phase_revive_count | tonumber) } end)
        + (if $linear_read_source == "" then {} else { "linear.read.source": $linear_read_source } end)
        + (if $linear_read_result == "" then {} else { "linear.read.result": $linear_read_result } end)
        + (if $linear_read_op     == "" then {} else { "linear.read.op":     $linear_read_op }     end)
        + (if $linear_read_age_ms == "" then {} else { "linear.read.age_ms": ($linear_read_age_ms | tonumber) } end)
        + (if $executor == "" then {} else { "catalyst.executor": $executor } end)
        + { "catalyst.ticket.type": $ticket_type }
      ),
      body: (
        (if $message == "" then {} else { message: $message } end)
        + { payload: $payload }
      )
    }'
}

# ─── CTL-1795: the v1→superset dual envelope (bash half) ─────────────────────
#
# Mirrors execution-core/lib/canonical-event.mjs's buildDualEnvelopeLine. A superset line
# carries BOTH the top-level v1 `event` and a full v2 attributes/body/resource block, so a
# consumer filtering on attributes["event.name"] stops silently seeing a smaller universe —
# while every existing v1 reader keeps reading the same top-level fields it always did.
#
# ONE line, never two: broker/event-name.mjs's getEventName reads `event.event` FIRST, so a v1
# line and a separate v2 twin would both resolve to the same name and both be routed —
# `agent.checkin`/`agent.checkout` would run upsertAgent and _autoRegisterPrLifecycle twice.

# canonical_merge_v1 V1_JSON CANONICAL_LINE
#
# Echo ONE superset JSONL line on stdout: the v1 object's keys first, then every canonical
# field merged over them. jq's `+` is right-biased, so a canonical key always wins a collision;
# `ts` is the only key both shapes carry, and it is then forced back to the v1 value so the two
# halves of one line can never disagree about when the event happened.
#
# Returns 1 (and echoes nothing) when jq is missing or either input fails to parse — the caller
# falls back to the plain v1 line and calls canonical_note_v1_only. Losing an event is never an
# acceptable price for enriching its envelope.
canonical_merge_v1() {
  local v1="$1" canonical="$2"
  command -v jq >/dev/null 2>&1 || return 1
  [[ -n "$v1" && -n "$canonical" ]] || return 1
  printf '%s' "$canonical" | jq -c --argjson v1 "$v1" '
    (($v1.ts // .ts)) as $ts
    | ($v1 + .)
    | .ts = $ts
    | .observedTs = $ts
  ' 2>/dev/null || return 1
}

# _CE_FLAT_ATTR_JQ — the bash mirror of FLAT_ATTRIBUTE_MAP in
# execution-core/lib/canonical-event.mjs (which is itself byte-identical to otel-forward's
# ATTR_MAP in lib/normalize.ts). Bash cannot `import` an ESM constant, so this is a
# hand-written mirror held honest MECHANICALLY by __tests__/dual-envelope.test.sh, which parses
# both sides and asserts set equality — the same one-registry/hand-mirror/cross-stack-parity
# discipline lib/secret-contract.sh and assertion-evidence-parity.test.mjs already use. Drift
# here would silently give a bash-emitted event a different attribute set than the JS emitter
# gives the SAME event name.
_CE_FLAT_ATTR_JQ='{
  "ticket": "catalyst.worker.ticket",
  "phase": "catalyst.worker.phase",
  "bg_job_id": "catalyst.worker.bg_job_id",
  "branch": "catalyst.worker.branch",
  "orch_id": "catalyst.orchestrator.id",
  "dominant_phase": "catalyst.worker.dominant_phase"
}'

# canonical_dual_envelope_line V1_JSON [SERVICE] [SEVERITY]
#
# Echo ONE superset JSONL line built from a flat v1 record `{ts, event, ...fields}` — the bash
# counterpart of buildDualEnvelopeLine in execution-core/lib/canonical-event.mjs, splitting the
# flat fields by the SAME map so a bash-emitted and a JS-emitted event of the same name carry
# the same attributes.
#
# Returns 1 and echoes nothing when jq is missing, the record is nameless, or the record is
# already canonical — every caller falls back to its plain v1 line and calls
# canonical_note_v1_only.
canonical_dual_envelope_line() {
  local v1="$1" service="${2:-catalyst.execution-core}" severity="${3:-INFO}"
  command -v jq >/dev/null 2>&1 || return 1
  [[ -n "$v1" ]] || return 1
  # Fail closed on an already-canonical record: double-wrapping is the one shape this must
  # never produce.
  printf '%s' "$v1" | jq -e 'has("attributes") | not' >/dev/null 2>&1 || return 1

  local name ts attrs payload
  name="$(printf '%s' "$v1" | jq -r 'if (.event | type) == "string" then .event else "" end' 2>/dev/null)" || return 1
  [[ -n "$name" ]] || return 1
  ts="$(printf '%s' "$v1" | jq -r '.ts // ""' 2>/dev/null)" || return 1
  [[ -n "$ts" ]] || ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # `ts` and `event` are envelope fields and never land in either bucket; a mapped key becomes
  # an attribute; everything else lands in body.payload, so nothing is dropped.
  attrs="$(printf '%s' "$v1" | jq -c --argjson m "$_CE_FLAT_ATTR_JQ" '
    reduce (to_entries[]) as $e ({};
      if $e.key == "ts" or $e.key == "event" then .
      elif ($m[$e.key] // null) != null then .[$m[$e.key]] = $e.value
      else . end)' 2>/dev/null)" || return 1
  payload="$(printf '%s' "$v1" | jq -c --argjson m "$_CE_FLAT_ATTR_JQ" '
    reduce (to_entries[]) as $e ({};
      if $e.key == "ts" or $e.key == "event" or ($m[$e.key] // null) != null then .
      else .[$e.key] = $e.value end)
    | if length == 0 then null else . end' 2>/dev/null)" || return 1

  # --message is REQUIRED here, not decorative: build_canonical_line omits body.message entirely
  # when it is empty, and a record with no body.message AND no attributes is the degenerate
  # OTLP LogRecord CTL-1817 exists to prevent. The mjs builder makes `message: name` an
  # invariant; this is the bash statement of the same invariant.
  local line
  line="$(build_canonical_line \
    --ts "$ts" \
    --severity "$severity" \
    --service "$service" \
    --event-name "$name" \
    --message "$name" \
    --payload-json "${payload:-null}" 2>/dev/null)" || return 1
  [[ -n "$line" ]] || return 1

  # Merge the mapped attributes into the canonical block (event.name stays first and is
  # reasserted so a flat field can never displace it), then merge the whole canonical envelope
  # over the v1 keys.
  printf '%s' "$line" | jq -c --argjson v1 "$v1" --argjson extra "$attrs" --arg name "$name" '
    .attributes = ((.attributes + $extra) | ."event.name" = $name)
    | ($v1 + .)
    | .ts = ($v1.ts // .ts)
    | .observedTs = .ts
  ' 2>/dev/null || return 1
}

# canonical_note_v1_only REASON
#
# Record that this process just emitted a RAW v1 line because the canonical path was
# unavailable. This is the DECLARED ASYMMETRY of CTL-1795: build_canonical_line requires jq, so
# "every v1 emit site dual-emits" is structurally unachievable from bash on a jq-less host, and
# the two remaining raw-v1 fallbacks (catalyst-state.sh's jq-less branch,
# emit-worker-status-change.sh's missing-$STATE_SCRIPT branch) exist precisely BECAUSE the
# canonical path is unavailable there. We do not hand-roll a jq-free JSON assembler for it; we
# make the divergence observable instead of silent.
#
# Two breadcrumbs, because neither alone reaches both audiences:
#   · an exported env var — same-shell, for an in-process caller and `catalyst doctor`; the same
#     shape lib/catalyst-deployment-mode.sh uses for CATALYST_DEPLOYMENT_MODE_JQ_MISSING.
#   · ONE stderr line per process — the durable, cross-process half. catalyst-state.sh runs as a
#     separate CLI process, so an exported var dies with it and could never be read back. stderr
#     lands in the caller's launchd-captured `.log`, which Alloy ships to Loki INDEPENDENTLY of
#     the event log — an event-log-sourced signal could not report a degradation of the event log
#     itself. Guarded to once per process so a hot emit path cannot flood the log.
canonical_note_v1_only() {
  local reason="${1:-unknown}"
  export CATALYST_EVENT_ENVELOPE_V1_ONLY=1
  export CATALYST_EVENT_ENVELOPE_V1_ONLY_REASON="$reason"
  if [[ -z "${__CE_V1_ONLY_WARNED:-}" ]]; then
    __CE_V1_ONLY_WARNED=1
    printf '[catalyst] WARNING: emitted a RAW v1 event envelope (%s) — invisible to any consumer reading attributes["event.name"] (CTL-1795)\n' \
      "$reason" >&2
  fi
}

# _canonical_is_sentinel_leak BASE_DIR LINE
# Returns 0 (true) if LINE is a sentinel-stamped event aimed at the default
# production events dir (BASE_DIR resolves to $HOME/catalyst/events). Parity
# with JS isSentinelLeak in broker/config.mjs (CTL-1086).
_canonical_is_sentinel_leak() {
  local base_dir="$1" line="$2"
  local orch sentinels default_dir
  # Parity with JS isSentinelLeak: canonical `.resource["catalyst.orchestration"]`
  # first, then the legacy top-level `.orchestrator` field.
  orch="$(printf '%s' "$line" | jq -r '.resource["catalyst.orchestration"] // .orchestrator // empty' 2>/dev/null)"
  [[ -n "$orch" ]] || return 1
  sentinels="orch-test ${CATALYST_SENTINEL_ORCHIDS:-}"
  case " $sentinels " in *" $orch "*) ;; *) return 1 ;; esac
  default_dir="${HOME}/catalyst/events"
  # Compare resolved real paths so symlinks/trailing slashes don't fool the check.
  [[ "$(cd "$base_dir" 2>/dev/null && pwd -P || echo "$base_dir")" == \
     "$(cd "$default_dir" 2>/dev/null && pwd -P || echo "$default_dir")" ]]
}

# ─── CTL-1809: the one atomic append seam ────────────────────────────────────
#
# `printf '%s\n' "$line" >> "$file"` LOOKS atomic and is not. O_APPEND makes the file
# OFFSET atomic; it does not make a multi-`write(2)` sequence atomic. bash's builtin printf
# flushes through stdio in BUFSIZ-sized chunks — 1024 on macOS, 8192 on glibc, an
# undocumented implementation detail that differs by platform — so a line longer than
# BUFSIZ becomes ⌈n/BUFSIZ⌉ separate write() calls and a concurrent producer's append lands
# BETWEEN them.
#
# Instrument: `__tests__/event-append-atomicity.test.sh` case 3 — the same 8-producer ×
# 150-line harness as cases 1 and 2, run through the naive `printf >>` instead of this
# primitive, counting unparseable + spliced lines out of 1,200. Measured over 20 runs on two
# hosts: 15 on a 12-core M2 laptop (macOS 26.5, bash 5.3) and 5 on a 10-core Mac mini (macOS
# 26.6, bash 3.2, the fleet's stock-macOS shape):
#
#     1,025 B  →   28–134 of 1,200 damaged   (2–11%)
#    19,086 B  →  165–523 of 1,200 damaged  (14–44%)
#
# A RANGE, not a point value, and deliberately so: the count is load- and host-dependent and
# swung ~5× run to run on one host (the 523 came from a run that overlapped other work). Do
# not read a single number off this as a target or a regression threshold. What DOES reproduce
# is the direction — the 19 KB line tore more often than the 1 KB line in 20 of 20 runs, by
# 2.6–7.2× — and case 3 asserts only that the naive path tears at all, which is the property
# that keeps cases 1 and 2 honest.
#
# The relevant constant is stdio BUFSIZ, NOT PIPE_BUF — the destination is a regular file,
# not a pipe, so the familiar "a write below PIPE_BUF is atomic" reasoning does not apply
# here at all.
#
# `/bin/dd obs=1048576` accumulates the entire piped line into ONE output block and issues
# exactly one write(2) for any input up to 1 MiB. dd's own accounting is the direct proof: a
# 262,145-byte input reports `0+1 records out` at obs=1m (one partial output block = one
# write) versus `4+1 records out` at obs=64k. Pipe-side chunking is irrelevant — only dd's
# OUTPUT write touches the log.
#
# THREE deliberate non-choices, each of which was the failure mode of an obvious alternative:
#
#   · `/bin/dd`, not `dd`. Phase-agent workers and launchd jobs run with a restricted PATH,
#     and a PATH-resolved helper that fails to resolve is precisely the silent no-op this
#     guard exists to prevent. An absolute path present on stock macOS and Linux satisfies
#     that structurally, with no fallback branch to be loud about.
#   · No interpreter. A bun/node append helper costs 10–20× dd's per-emit time AND
#     reintroduces the PATH-resolution failure above. Measured here: 3.8 ms/emit for dd vs
#     0.2 ms for raw printf. The bash-writer census is ~200k events/month fleet-wide
#     (~0.077/s), i.e. ~13 CPU-minutes/month. The JS writers — which carry the high-rate
#     families like `recovery.tick` — already use `appendFileSync` and are atomic far past
#     this cap, so they are deliberately untouched.
#   · No size branch. "printf if small, dd if big" is a second code path that ships
#     un-exercised, and it would be exercised only on the large lines that actually tear.
#     Every bash append goes through dd unconditionally.
#
# Hard cap: 262,144 bytes, measured with `wc -c` (BYTES, not characters — a multi-byte
# payload must not slip past a character count). That is 4.2× the all-time observed fleet
# maximum (62,597 B) and inside the range dd is empirically proven atomic over. A cap above
# the proven-atomic bound would be a lie and a cap near the observed max would drop real
# events, which is also why it is deliberately NOT env-overridable.
CATALYST_EVENT_LINE_MAX_BYTES=262144

# _canonical_event_name_of LINE
# Best-effort name for a line we are about to refuse. Reads all three envelope
# discriminators in the house order — attributes["event.name"] ?? event ?? name — because a
# refused line may be in any of them and an anonymous tally is not actionable. Uses sed
# rather than jq: this must work on the jq-less catalyst-state.sh path too, and it is a COLD
# path (only a cap breach reaches it), so the fork is free.
_canonical_event_name_of() {
  local line="$1" n=""
  n="$(printf '%s' "$line" | LC_ALL=C sed -n 's/.*"event\.name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  [[ -n "$n" ]] || n="$(printf '%s' "$line" | LC_ALL=C sed -n 's/.*"event"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  [[ -n "$n" ]] || n="$(printf '%s' "$line" | LC_ALL=C sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  printf '%s' "${n:-(unknown)}"
}

# _canonical_append_oversized_tombstone FILE NAME BYTES
# Durable, in-band record that an event was refused. The stderr WARNING alone rides the
# caller's `.log` (Alloy → Loki), which is the right OUT-of-band channel for "the event log
# itself is degraded" — but it is invisible to every consumer that reads the event log, i.e.
# to the surface where the gap actually appears.
#
# The tombstone carries its OWN event name. Re-emitting the dropped event's name with a
# gutted payload would fire `catalyst-events wait-for` subscribers and the broker's
# phase-lifecycle router on fabricated content — strictly worse than the absence it reports.
# A name-specific waiter therefore still misses its event; nothing in the fleet is within 4×
# of the cap, so this is a tripwire for a pathological producer, not a routing policy.
#
# Hand-built with printf, not jq: the cap must hold on the jq-less path too. The dropped
# event's name is the only untrusted text here and is scrubbed to the event-name charset
# before embedding, since there is no jq available to escape it.
_canonical_append_oversized_tombstone() {
  local file="$1" name="$2" bytes="$3"
  # Recursion guard: the tombstone is appended through the same primitive. It is fixed-size
  # plus a 120-char name so it cannot itself breach the cap — but a guard that does not
  # depend on that arithmetic staying true is cheaper than one that does.
  [[ -z "${__CE_IN_TOMBSTONE:-}" ]] || return 0
  local ts host safe tomb
  ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  host="$(catalyst_host_name 2>/dev/null || echo unknown)"
  safe="$(printf '%s' "$name" | LC_ALL=C tr -c 'A-Za-z0-9._:-' '_' | cut -c1-120)"
  tomb="$(printf '{"ts":"%s","observedTs":"%s","severityText":"ERROR","severityNumber":17,"body":{"message":"event dropped: %s bytes exceeds the %s-byte append cap"},"attributes":{"event.name":"catalyst.event.oversized","event.entity":"event","event.action":"dropped","catalyst.event.oversized.name":"%s","catalyst.event.oversized.bytes":%s,"catalyst.event.oversized.cap":%s},"resource":{"service.name":"catalyst.event-append","host.name":"%s"}}' \
    "$ts" "$ts" "$bytes" "$CATALYST_EVENT_LINE_MAX_BYTES" "$safe" "$bytes" "$CATALYST_EVENT_LINE_MAX_BYTES" "$host")"
  __CE_IN_TOMBSTONE=1 canonical_atomic_append_line "$file" "$tomb" || true
}

# canonical_atomic_append_line FILE LINE
# Append LINE + "\n" to FILE in exactly one write(2). Returns 0 on success, non-zero when
# the line was refused (over the cap) or dd itself failed.
#
# Failure is LOUD and does NOT degrade to printf. A silent degrade would put the tear back
# on exactly the large lines this exists for. Note also that the old call site's
# `2>/dev/null || true` is why nothing on this path was ever audible — these warnings must
# reach the caller's stderr, so no caller may re-silence them.
canonical_atomic_append_line() {
  local file="$1" line="$2"
  [[ -n "$file" ]] || return 1
  local bytes
  bytes="$(printf '%s' "$line" | LC_ALL=C wc -c | tr -d ' ')"
  if [[ "$bytes" -gt "$CATALYST_EVENT_LINE_MAX_BYTES" ]]; then
    local name
    name="$(_canonical_event_name_of "$line")"
    printf '[catalyst] WARNING: refusing to append a %s-byte event (cap %s) — event.name=%s; dropped, NOT truncated (CTL-1809)\n' \
      "$bytes" "$CATALYST_EVENT_LINE_MAX_BYTES" "$name" >&2
    _canonical_append_oversized_tombstone "$file" "$name" "$bytes"
    return 1
  fi
  if ! printf '%s\n' "$line" | /bin/dd obs=1048576 2>/dev/null >>"$file"; then
    printf '[catalyst] WARNING: atomic append to %s FAILED — event lost (CTL-1809)\n' "$file" >&2
    return 1
  fi
  return 0
}

# canonical_jsonl_append BASE_DIR LINE
# Append a JSONL line to ${BASE_DIR}/YYYY-MM.jsonl. Rotates the existing file
# to *.legacy on first canonical write if the first existing line lacks an
# `attributes` field (legacy v1/v2 detection). Best-effort — write failures
# are silenced.
canonical_jsonl_append() {
  local base_dir="$1" line="$2"
  [[ -n "$base_dir" ]] || return 0
  # CTL-1086: drop sentinel(orch-test) events aimed at the default prod log.
  if _canonical_is_sentinel_leak "$base_dir" "$line"; then
    printf '[catalyst] dropped sentinel(orch-test) event from default prod log\n' >&2
    return 0
  fi
  mkdir -p "$base_dir" 2>/dev/null || return 0
  local month_file
  month_file="${base_dir}/$(date -u +%Y-%m).jsonl"
  if [[ -f "$month_file" ]]; then
    local first
    first="$(head -n 1 "$month_file" 2>/dev/null || true)"
    if [[ -n "$first" ]]; then
      # CTL-1813: rotate ONLY for a genuine v1 line — a line that PARSES and simply lacks
      # `attributes`. That migration is the entire purpose of this rotation.
      #
      # An UNPARSEABLE first line is a different thing and must NOT move the live log. The
      # old test conflated them (`jq -e has("attributes")` exits non-zero for both), so one
      # torn line retired the whole month: MEASURED against this function, a single truncated
      # first line moved 499 live events aside, and a SECOND torn line one rotation later
      # overwrote the only surviving copy, because the destination is a fixed name. A torn
      # line is exactly what CTL-1809's bash-append tearing produces above 1025 bytes, so the
      # two defects compose into unrecoverable loss.
      #
      # Quarantining the LINE is also not this function's job — it appends, it does not repair.
      # Refusing to rotate keeps every event in place and leaves the damage visible.
      if printf '%s' "$first" | jq -e . >/dev/null 2>&1; then
        if ! printf '%s' "$first" | jq -e 'has("attributes")' >/dev/null 2>&1; then
          # A genuine legacy log. Rotate to a UNIQUE destination: a fixed `.legacy` is a
          # rescue slot of depth one, and the next rotation clobbers the previous month's
          # only copy.
          # A destination that cannot collide AND cannot be clobbered by a concurrent
          # rotation. `[[ -e ]]` then `mv` is check-then-act: two writers can both see the
          # name free, and POSIX rename() OVERWRITES, so the second would destroy the first's
          # rescue copy — this ticket's own defect, one layer down (Codex #3318 P1).
          #
          # `ln` is the atomic primitive: hard-linking onto an existing path fails EEXIST
          # rather than overwriting, so the name is RESERVED by the link itself. Unlink the
          # source only once the link succeeded; if it fails we simply try the next name and
          # the original is still in place.
          local stamp dest n
          stamp="$(date -u +%Y%m%dT%H%M%SZ)"
          n=0
          while :; do
            if [[ "$n" -eq 0 ]]; then dest="${month_file}.legacy.${stamp}.$$"
            else dest="${month_file}.legacy.${stamp}.$$.${n}"; fi
            if ln "$month_file" "$dest" 2>/dev/null; then
              rm -f "$month_file" 2>/dev/null || true
              printf '[catalyst] rotated legacy event log %s -> %s\n' "$month_file" "$dest" >&2
              break
            fi
            n=$((n + 1))
            # Bounded: an unbounded loop here would spin forever if the directory were
            # unwritable, and a rotation is never worth wedging an append path for.
            if [[ "$n" -gt 50 ]]; then
              printf '[catalyst] WARNING: could not reserve a rotation name for %s — leaving it in place\n' "$month_file" >&2
              break
            fi
          done
        fi
      else
        # Silence is a defect: an unparseable first line means the log has been damaged, and
        # nothing else in this path would ever say so.
        printf '[catalyst] WARNING: first line of %s does not parse as JSON — NOT rotating (events preserved in place)\n' "$month_file" >&2
      fi
    fi
  fi
  # CTL-1809: one write(2), not ⌈n/BUFSIZ⌉ of them. The old `2>/dev/null || true` here is
  # deliberately gone — silencing the primitive's stderr would re-hide the two conditions it
  # exists to report (a refused oversized event, a failed write). The `|| true` stays in
  # spirit: this function's contract is best-effort, so a refusal must not abort the caller.
  canonical_atomic_append_line "$month_file" "$line" || true
}
