#!/usr/bin/env bash
# CAT-257: fail-open, never-silent primitives shared by escalation helpers.
[ -n "${_CATALYST_ESCALATE_COMMON_LIB:-}" ] && return 0
_CATALYST_ESCALATE_COMMON_LIB=1

_escalate_warn() { printf 'escalate[%s]: %s\n' "${1:-?}" "${2:-}" >&2; }

escalation_explain_json() {
  local ctx="$1"; shift
  local shim="${PLUGIN_ROOT:-}/scripts/execution-core/escalation-explain.mjs"
  local errf="" out="" err="" rc=0
  errf="$(mktemp "${TMPDIR:-/tmp}/escalate-explain.XXXXXX" 2>/dev/null || true)"
  if [ -n "$errf" ]; then
    out="$(node "$shim" "$@" 2>"$errf")" || rc=$?
    err="$(tr '\n' ' ' < "$errf" 2>/dev/null || true)"
    rm -f "$errf"
  else
    _escalate_warn "$ctx" "mktemp failed; running escalation-explain without stderr capture"
    out="$(node "$shim" "$@")" || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    _escalate_warn "$ctx" "escalation-explain.mjs exited ${rc}; falling back to {} — stderr: ${err:-<empty>}"
    out=""
  elif [ -z "$out" ]; then
    _escalate_warn "$ctx" "escalation-explain.mjs exited 0 with EMPTY stdout; falling back to {} — stderr: ${err:-<empty>}"
  elif ! printf '%s' "$out" | jq -e . >/dev/null 2>&1; then
    _escalate_warn "$ctx" "escalation-explain.mjs stdout is not valid JSON; falling back to {} — stdout: $(printf '%s' "$out" | head -c 200)"
    out=""
  fi
  [ -n "$out" ] || out='{}'
  printf '%s' "$out"
}

escalation_write_signal_explanation() {
  local ctx="$1" sig="$2" state="$3" reason="$4" expl="$5"
  if [ -z "$sig" ] || [ ! -f "$sig" ]; then
    _escalate_warn "$ctx" "signal file missing (${sig:-<unset>}); terminal explanation NOT written"
    return 1
  fi
  if [ -z "$expl" ]; then
    _escalate_warn "$ctx" "empty explanation JSON; substituting {} (operator will see a DEGRADED decision ask)"
    expl='{}'
  elif ! printf '%s' "$expl" | jq -e . >/dev/null 2>&1; then
    _escalate_warn "$ctx" "explanation JSON is unparseable; substituting {} (operator will see a DEGRADED decision ask)"
    expl='{}'
  fi
  local ts tmp
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; tmp="${sig}.tmp.$$"
  if jq --arg ts "$ts" --arg st "$state" --arg rsn "$reason" --argjson expl "$expl" \
      '.status=$st | .failureReason=$rsn | .explanation=$expl | .updatedAt=$ts' \
      "$sig" > "$tmp" 2>/dev/null && mv "$tmp" "$sig"; then
    return 0
  fi
  rm -f "$tmp"
  _escalate_warn "$ctx" "jq write of the terminal explanation FAILED; ${sig} left unchanged (phase-agent-emit-complete is the only remaining backstop for .status)"
  return 1
}

escalation_emit_terminal() {
  local ctx="$1" phase="$2" ticket="$3" reason="$4"
  local emit="${PLUGIN_ROOT:-}/scripts/phase-agent-emit-complete" rc=0
  if [ ! -x "$emit" ]; then
    _escalate_warn "$ctx" "phase-agent-emit-complete NOT executable at ${emit}; NO terminal event emitted for ${ticket}/${phase} (reason=${reason}) — recovery will attribute this as no-progress"
    return 0
  fi
  "$emit" --phase "$phase" --ticket "$ticket" --status failed --reason "$reason" || rc=$?
  [ "$rc" -eq 0 ] || _escalate_warn "$ctx" "phase-agent-emit-complete exited ${rc} for ${ticket}/${phase} (reason=${reason})"
  return 0
}

escalation_comms_attention() {
  local ctx="$1" msg="$2" comms_path="${COMMS:-}"
  [ -n "$comms_path" ] || return 0
  if [ ! -x "$comms_path" ]; then
    _escalate_warn "$ctx" "COMMS set to ${comms_path} but not executable; no attention message sent"
    return 0
  fi
  "$comms_path" send "${ORCH_ID:-}" "$msg" --as "${TICKET:-}" --type attention --orch "${ORCH_ID:-}" >/dev/null 2>&1 || _escalate_warn "$ctx" "comms attention send failed"
  return 0
}

escalation_label_needs_human() {
  local ctx="$1" reason="$2" expl="$3"
  local orch="${ORCH_DIR:-${CATALYST_ORCHESTRATOR_DIR:-}}" runtime
  [ -n "$orch" ] || { _escalate_warn "$ctx" "no ORCH_DIR; needs-human label NOT applied"; return 0; }
  runtime="$(command -v bun 2>/dev/null || true)"
  [ -n "$runtime" ] || { _escalate_warn "$ctx" "bun not on PATH; needs-human label NOT applied"; return 0; }
  "$runtime" "${PLUGIN_ROOT}/scripts/execution-core/label-needs-human.mjs" --ticket "${TICKET}" --orch-dir "$orch" --explanation "$expl" --reason "$reason" >/dev/null 2>&1 || _escalate_warn "$ctx" "label-needs-human.mjs failed; needs-human may be unapplied"
  return 0
}

escalation_post_cta_comment() {
  local ctx="$1" heading="$2" expl="$3" footer="$4" cta post body
  cta="$(printf '%s' "$expl" | jq -r '.call_to_action // empty' 2>/dev/null || true)"
  if [ -z "$cta" ]; then _escalate_warn "$ctx" "explanation carries no call_to_action; Linear comment NOT posted"; return 0; fi
  post="${CATALYST_COMMENT_POST_HELPER:-${PLUGIN_ROOT}/scripts/lib/linear-comment-post.sh}"
  if [ -z "$post" ] || [ ! -x "$post" ]; then post="$(command -v linear-comment-post.sh 2>/dev/null || true)"; fi
  if [ -z "$post" ] || [ ! -x "$post" ]; then _escalate_warn "$ctx" "no executable linear-comment-post.sh; CTA NOT posted to Linear"; return 0; fi
  body="$(printf '%s\n\n%s\n\n%s' "$heading" "$cta" "$footer")"
  "$post" "${TICKET}" "$body" >/dev/null || _escalate_warn "$ctx" "linear-comment-post.sh failed"
  return 0
}
