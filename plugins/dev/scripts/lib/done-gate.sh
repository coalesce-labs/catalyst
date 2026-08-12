#!/usr/bin/env bash
# CAT-45 Done-write gate. Source-safe and fail-open only for infrastructure absence.
[[ -n "${_CATALYST_DONE_GATE_LOADED:-}" ]] && return 0
_CATALYST_DONE_GATE_LOADED=1

done_gate_check() {
  local ticket="$1" target="$2" config="$3" verified="${4:-}" override="${5:-}"
  _CATALYST_DONE_GATE_MODE="${CATALYST_DONE_GATE:-shadow}"
  case "$_CATALYST_DONE_GATE_MODE" in off|shadow|enforce) ;; *) _CATALYST_DONE_GATE_MODE=shadow ;; esac
  _CATALYST_DONE_GATE_DECISION=allow; _CATALYST_DONE_GATE_REASON=""; _CATALYST_DONE_GATE_EVIDENCE='{}'
  [[ "$_CATALYST_DONE_GATE_MODE" == off ]] && { _CATALYST_DONE_GATE_DECISION=disabled; return 0; }
  [[ "$target" == "Done" ]] || return 0
  [[ -n "$verified" ]] && { _CATALYST_DONE_GATE_DECISION=verified; _CATALYST_DONE_GATE_REASON="$verified"; return 0; }
  [[ -n "$override" ]] && { _CATALYST_DONE_GATE_DECISION=override; _CATALYST_DONE_GATE_REASON="$override"; return 0; }
  local runtime="" repo_root=""
  command -v jq >/dev/null 2>&1 || { _CATALYST_DONE_GATE_DECISION=unavailable; _CATALYST_DONE_GATE_REASON=jq-unavailable; return 0; }
  runtime="$(command -v bun 2>/dev/null || command -v node 2>/dev/null || true)"
  [[ -n "$runtime" ]] || { _CATALYST_DONE_GATE_DECISION=unavailable; _CATALYST_DONE_GATE_REASON=js-runtime-unavailable; return 0; }
  [[ -n "$config" ]] && repo_root="$(cd "$(dirname "$config")" 2>/dev/null && pwd || true)"
  [[ -n "$repo_root" ]] || { _CATALYST_DONE_GATE_DECISION=unavailable; _CATALYST_DONE_GATE_REASON=repo-root-unavailable; return 0; }
  local module="${SCRIPT_DIR}/execution-core/merged-work-evidence.mjs"
  _CATALYST_DONE_GATE_EVIDENCE="$($runtime "$module" "$ticket" "$repo_root" "${CATALYST_ORCHESTRATOR_DIR:-}" "${CATALYST_BRANCH_HINT:-}" 2>/dev/null || true)"
  [[ -n "$_CATALYST_DONE_GATE_EVIDENCE" ]] || _CATALYST_DONE_GATE_EVIDENCE='{"verdict":"unverifiable-infrastructure","ok":true,"reason":"resolver-empty"}'
  local ok reason
  ok="$(jq -r '.ok // true' <<<"$_CATALYST_DONE_GATE_EVIDENCE")"; reason="$(jq -r '.reason // .verdict // "unknown"' <<<"$_CATALYST_DONE_GATE_EVIDENCE")"
  _CATALYST_DONE_GATE_REASON="$reason"
  if [[ "$ok" == false ]]; then
    if [[ "$_CATALYST_DONE_GATE_MODE" == enforce ]]; then _CATALYST_DONE_GATE_DECISION=refuse; return 3; fi
    _CATALYST_DONE_GATE_DECISION=would-refuse
  fi
  return 0
}
