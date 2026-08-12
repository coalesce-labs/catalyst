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

_CAT257_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./escalate-common.sh
. "${_CAT257_LIB_DIR}/escalate-common.sh"

_escalate_workflow_scope_push() {
  local branch="${1:-$(git rev-parse --abbrev-ref HEAD || echo "$TICKET")}"
  local expl_json
  expl_json="$(escalation_explain_json pr \
    --ticket "$TICKET" --phase "$PHASE" \
    --type manual \
    --problem "git push was rejected: the branch modifies .github/workflows/ but the host token lacks the 'workflow' OAuth scope" \
    --call-to-action "Grant the daemon token 'workflow' scope (gh auth refresh -s workflow) or set CATALYST_WORKFLOW_GITHUB_TOKEN, then re-run phase-pr — or push branch ${TICKET} manually. Which?" \
    --blocked-capability "the host git token lacks the workflow OAuth scope" \
    --instructions "$(jq -nc '["gh auth refresh -s workflow","or set CATALYST_WORKFLOW_GITHUB_TOKEN"]' || echo '[]')" \
    --remediation-then-retry "re-run /catalyst-dev:phase-pr after the scope is granted" \
    --why-not-auto "the daemon cannot grant itself an OAuth scope (capability boundary)" \
    --can-execute false \
    --observed "$(jq -nc --arg b "$branch" '{branch:$b, scope_missing:"workflow"}' || echo '{}')")"
  escalation_write_signal_explanation pr "$SIGNAL_FILE" failed push_rejected_no_workflow_scope "$expl_json" || true
  escalation_emit_terminal pr "$PHASE" "$TICKET" push_rejected_no_workflow_scope
  escalation_comms_attention pr "phase-pr failed: push rejected — missing 'workflow' OAuth scope on branch ${branch}"
  escalation_label_needs_human pr push_rejected_no_workflow_scope "$expl_json"
  escalation_post_cta_comment pr '**Workflow scope push blocked — operator action required**' "$expl_json" '_Posted automatically by phase-pr escalation (CTL-1181)._'
  return 0
}
