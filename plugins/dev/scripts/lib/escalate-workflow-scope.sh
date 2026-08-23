#!/usr/bin/env bash
# escalate-workflow-scope.sh — CTL-1119: shared helper sourced by phase agents
# that hit draft_pr_push_verify rc=3 (workflow-scope OAuth rejection).
#
# Writes a structured MANUAL explanation (call_to_action) to the signal file via jq,
# then calls phase-agent-emit-complete with status=failed. Callers must have
# already set: PLUGIN_ROOT, SIGNAL_FILE, TICKET, PHASE, ORCH_ID, COMMS (may
# be empty). After this script runs, callers should `exit 1`.
#
# Usage: source this file and call _escalate_workflow_scope_push [BRANCH]

_escalate_workflow_scope_push() {
  local branch="${1:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "$TICKET")}"
  local expl_json
  expl_json="$(node "${PLUGIN_ROOT}/scripts/execution-core/escalation-explain.mjs" \
    --ticket "$TICKET" --phase "$PHASE" \
    --type manual \
    --problem "git push was rejected: the branch modifies .github/workflows/ but the host token lacks the 'workflow' OAuth scope" \
    --call-to-action "Grant the daemon token 'workflow' scope (gh auth refresh -s workflow) or set CATALYST_WORKFLOW_GITHUB_TOKEN, then re-run phase-pr — or push branch ${TICKET} manually. Which?" \
    --blocked-capability "the host git token lacks the workflow OAuth scope" \
    --instructions "$(jq -nc '["gh auth refresh -s workflow","or set CATALYST_WORKFLOW_GITHUB_TOKEN"]' 2>/dev/null || echo '[]')" \
    --remediation-then-retry "re-run /catalyst-dev:phase-pr after the scope is granted" \
    --why-not-auto "the daemon cannot grant itself an OAuth scope (capability boundary)" \
    --can-execute false \
    --observed "$(jq -nc --arg b "$branch" '{branch:$b, scope_missing:"workflow"}' 2>/dev/null || echo '{}')" \
    2>/dev/null || echo '{}')"
  [ -n "$expl_json" ] || expl_json='{}'
  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local tmp="${SIGNAL_FILE}.tmp.$$"
  jq --arg ts "$ts" --argjson expl "$expl_json" \
    '.status="failed" | .failureReason="push_rejected_no_workflow_scope" | .explanation=$expl | .updatedAt=$ts' \
    "$SIGNAL_FILE" > "$tmp" && mv "$tmp" "$SIGNAL_FILE" || true
  local emit="${PLUGIN_ROOT}/scripts/phase-agent-emit-complete"
  if [[ -x "$emit" ]]; then
    "$emit" --phase "$PHASE" --ticket "$TICKET" --status failed \
      --reason "push_rejected_no_workflow_scope"
  fi
  if [[ -n "${COMMS:-}" && -x "${COMMS:-}" ]]; then
    "$COMMS" send "${ORCH_ID}" \
      "phase-pr failed: push rejected — missing 'workflow' OAuth scope on branch ${branch}" \
      --as "$TICKET" --type attention --orch "${ORCH_ID}" >/dev/null 2>&1 || true
  fi

  # PUBLISH the escalation THROUGH the shared guard (CTL-1552/CTL-2159): the
  # belief-owner check + the CTL-2158 classifier + the once-marker in ONE place.
  # It applies NO Linear label any more — SYSTEM trouble retries under the ONE
  # CTL-2156 fleet alert, a genuine ASK becomes one ask ticket carrying `blocks`.
  # The CLI still writes the once-marker via labelOnce (five retry loops read it
  # as their STOP). Best-effort, fail-open. Runs under bun (the execution-core
  # runtime; the guard reaches bun:sqlite).
  local _orch="${ORCH_DIR:-${CATALYST_ORCHESTRATOR_DIR:-}}"
  if [[ -n "${_orch:-}" ]]; then
    # bun ONLY — never node. publish-escalation-cli.mjs transitively imports
    # bun:sqlite, so node exits ERR_UNSUPPORTED_ESM_URL_SCHEME and the fail-open
    # redirect below would silently leave the escalation unpublished.
    local _rt
    _rt="$(command -v bun 2>/dev/null || true)"
    if [[ -n "${_rt:-}" ]]; then
      # Thread the MANUAL explanation already built above. Without it the guard
      # writes a generic "unexplained failure" phase-recovery-pass.json, which the
      # monitor prefers over the failed-phase signal — hiding the actionable
      # OAuth-scope instructions from the Needs-You inbox.
      "$_rt" "${PLUGIN_ROOT}/scripts/execution-core/publish-escalation-cli.mjs" \
        --ticket "${TICKET}" --orch-dir "${_orch}" \
        --explanation "${expl_json}" \
        --reason push_rejected_no_workflow_scope >/dev/null 2>&1 || true
    fi
  fi

  # Post call_to_action to Linear as a comment so the operator sees the CTA.
  local _cta
  _cta="$(printf '%s' "$expl_json" | jq -r '.call_to_action // empty' 2>/dev/null || true)"
  local _comment_post="${CATALYST_COMMENT_POST_HELPER:-${PLUGIN_ROOT}/scripts/lib/linear-comment-post.sh}"
  if [[ -z "${_comment_post:-}" || ! -x "${_comment_post:-}" ]]; then
    _comment_post="$(command -v linear-comment-post.sh 2>/dev/null || true)"
  fi
  if [[ -n "${_cta:-}" && -n "${_comment_post:-}" && -x "${_comment_post:-}" ]]; then
    local _cta_body
    _cta_body="$(printf '**Workflow scope push blocked — operator action required**\n\n%s\n\n_Posted automatically by phase-pr escalation (CTL-1181)._' "${_cta}")"
    "$_comment_post" "${TICKET}" "${_cta_body}" >/dev/null 2>&1 || true
  fi
}
