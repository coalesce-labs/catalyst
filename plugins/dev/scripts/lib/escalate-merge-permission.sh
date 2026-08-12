#!/usr/bin/env bash
# CAT-222: fail-open repository permission probe and terminal escalation.
[ -n "${_CAT222_MERGE_PERM_LIB:-}" ] && return 0
_CAT222_MERGE_PERM_LIB=1

merge_permission_probe() {
  local repo="${1:-}" body can
  [ -n "$repo" ] || { printf unknown; return 0; }
  body="$(gh api "repos/${repo}" --jq '.permissions' 2>/dev/null || true)"
  [ -n "$body" ] || { printf unknown; return 0; }
  can="$(printf '%s' "$body" | jq -r '
    if type != "object" or (has("push") and has("maintain") and has("admin") | not)
    then "unknown"
    elif .push == true or .maintain == true or .admin == true then "ok"
    elif .push == false and .maintain == false and .admin == false then "denied"
    else "unknown" end' 2>/dev/null || true)"
  case "$can" in ok|denied) printf '%s' "$can";; *) printf unknown;; esac
}

merge_denial_is_permission() {
  local err="${1:-}"
  [ -n "$err" ] || return 1
  { grep -qi 'MergePullRequest' <<<"$err" && grep -qi 'permission' <<<"$err"; } ||
    grep -qi 'must have admin rights' <<<"$err"
}

_escalate_merge_permission() {
  local repo="$1" pr="$2" observed="${3:-READ}" expl_json ts tmp emit
  expl_json="$(node "${PLUGIN_ROOT}/scripts/execution-core/escalation-explain.mjs" \
    --ticket "$TICKET" --phase "$PHASE" --type manual \
    --problem "GitHub repository ${repo} reports ${observed} permission; this worker cannot merge PR #${pr}" \
    --call-to-action "Grant write access on ${repo}, or merge PR #${pr} manually." \
    --blocked-capability "merge pull requests in ${repo}" \
    --instructions "$(jq -nc --arg r "$repo" --arg p "$pr" '["grant the worker identity write access to \($r)","or merge PR #\($p) manually"]')" \
    --remediation-then-retry "after access is granted, re-run phase-monitor-merge" \
    --why-not-auto "the worker cannot grant its own repository permissions" \
    --can-execute false --observed "$(jq -nc --arg repo "$repo" --arg permission "$observed" '{repo:$repo,permission:$permission}')" \
    2>/dev/null || echo '{}')"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; tmp="${SIGNAL_FILE}.tmp.$$"
  jq --arg ts "$ts" --argjson expl "$expl_json" '.status="failed" | .failureReason="merge_permission_denied" | .explanation=$expl | .updatedAt=$ts' "$SIGNAL_FILE" > "$tmp" && mv "$tmp" "$SIGNAL_FILE" || true
  emit="${PLUGIN_ROOT}/scripts/phase-agent-emit-complete"
  [[ -x "$emit" ]] && "$emit" --phase "$PHASE" --ticket "$TICKET" --status failed --reason merge_permission_denied
  local orch="${ORCH_DIR:-${CATALYST_ORCHESTRATOR_DIR:-}}" rt
  rt="$(command -v bun 2>/dev/null || true)"
  [[ -n "$orch" && -n "$rt" ]] && "$rt" "${PLUGIN_ROOT}/scripts/execution-core/label-needs-human.mjs" --ticket "$TICKET" --orch-dir "$orch" --explanation "$expl_json" --reason merge_permission_denied >/dev/null 2>&1 || true
  local post="${CATALYST_COMMENT_POST_HELPER:-${PLUGIN_ROOT}/scripts/lib/linear-comment-post.sh}"
  [[ -x "$post" ]] && "$post" "$TICKET" "**Merge permission blocked — operator action required**

$(printf '%s' "$expl_json" | jq -r '.call_to_action // empty')" >/dev/null 2>&1 || true
}
