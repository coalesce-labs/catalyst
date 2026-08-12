#!/usr/bin/env bash
# CAT-222: fail-open repository permission probe and terminal escalation.
[ -n "${_CAT222_MERGE_PERM_LIB:-}" ] && return 0
_CAT222_MERGE_PERM_LIB=1

_CAT257_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./escalate-common.sh
. "${_CAT257_LIB_DIR}/escalate-common.sh"

merge_permission_describe() {
  local repo="${1:-}" body out
  [ -n "$repo" ] || { printf 'unknown UNKNOWN'; return 0; }
  body="$(gh api "repos/${repo}" --jq '.permissions' 2>/dev/null || true)"
  [ -n "$body" ] || { printf 'unknown UNKNOWN'; return 0; }
  out="$(printf '%s' "$body" | jq -r '
    if type != "object" or (has("push") and has("maintain") and has("admin") | not)
    then "unknown UNKNOWN"
    else
      (if .admin == true then "ADMIN" elif .maintain == true then "MAINTAIN"
       elif .push == true then "WRITE" elif (.triage // false) == true then "TRIAGE"
       elif (.pull // false) == true then "READ" else "NONE" end) as $g
      | (if .push == true or .maintain == true or .admin == true then "ok"
         elif .push == false and .maintain == false and .admin == false then "denied"
         else "unknown" end) as $v | "\($v) \($g)"
    end' 2>/dev/null || true)"
  case "$out" in "ok "*|"denied "*|"unknown "*) printf '%s' "$out";; *) printf 'unknown UNKNOWN';; esac
}

merge_permission_probe() {
  local description; description="$(merge_permission_describe "${1:-}")"
  printf '%s' "${description%% *}"
}

merge_denial_is_permission() {
  local err="${1:-}"
  [ -n "$err" ] || return 1
  { grep -qi 'MergePullRequest' <<<"$err" && grep -qi 'permission' <<<"$err"; } ||
    grep -qi 'must have admin rights' <<<"$err"
}

_escalate_merge_permission() {
  local repo="$1" pr="$2" observed="${3:-UNKNOWN}" expl_json
  expl_json="$(escalation_explain_json monitor-merge \
    --ticket "$TICKET" --phase "$PHASE" --type manual \
    --problem "GitHub repository ${repo} reports ${observed} permission; this worker cannot merge PR #${pr}" \
    --call-to-action "Grant write access on ${repo}, or merge PR #${pr} manually." \
    --blocked-capability "merge pull requests in ${repo}" \
    --instructions "$(jq -nc --arg r "$repo" --arg p "$pr" '["grant the worker identity write access to \($r)","or merge PR #\($p) manually"]')" \
    --remediation-then-retry "after access is granted, re-run phase-monitor-merge" \
    --why-not-auto "the worker cannot grant its own repository permissions" \
    --can-execute false --observed "$(jq -nc --arg repo "$repo" --arg permission "$observed" '{repo:$repo,permission:$permission}')")"
  escalation_write_signal_explanation monitor-merge "$SIGNAL_FILE" failed merge_permission_denied "$expl_json" || true
  escalation_emit_terminal monitor-merge "$PHASE" "$TICKET" merge_permission_denied
  escalation_label_needs_human monitor-merge merge_permission_denied "$expl_json"
  escalation_comms_attention monitor-merge "phase-monitor-merge failed: ${repo} reports ${observed} permission — cannot merge PR #${pr}"
  escalation_post_cta_comment monitor-merge '**Merge permission blocked — operator action required**' "$expl_json" '_Posted automatically by phase-monitor-merge escalation (CAT-222/CAT-257)._'
  return 0
}
