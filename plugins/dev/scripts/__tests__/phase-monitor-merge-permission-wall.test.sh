#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LIB="${REPO_ROOT}/plugins/dev/scripts/lib/escalate-merge-permission.sh"
SKILL="${REPO_ROOT}/plugins/dev/skills/phase-monitor-merge/SKILL.md"
FAILURES=0; PASSES=0
pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; }
assert_eq() { [[ "$1" == "$2" ]] && pass "$3" || fail "$3 — expected '$2', got '$1'"; }
assert_contains() { [[ "$1" == *"$2"* ]] && pass "$3" || fail "$3 — '$2' not found"; }
TMPROOT="$(mktemp -d)"; trap 'rm -rf "$TMPROOT"' EXIT
source "$LIB"
mk_gh() { local dir="$TMPROOT/bin.$RANDOM"; mkdir -p "$dir"; { echo '#!/usr/bin/env bash'; printf 'printf %%s %q\n' "$1"; echo "exit $2"; } > "$dir/gh"; chmod +x "$dir/gh"; echo "$dir"; }
probe_with() { local bin; bin="$(mk_gh "$1" "$2")"; PATH="$bin:$PATH" merge_permission_probe owner/repo; }
assert_eq "$(probe_with '{"push":false,"maintain":false,"admin":false}' 0)" denied "read-only grant"
assert_eq "$(probe_with '{"push":true,"maintain":false,"admin":false}' 0)" ok "push grant"
assert_eq "$(probe_with '{"push":false,"maintain":false,"admin":true}' 0)" ok "admin grant"
assert_eq "$(probe_with '' 1)" unknown "gh failure fails open"
assert_eq "$(probe_with '{}' 0)" unknown "missing permissions fails open"
assert_denial() { if merge_denial_is_permission "$1"; then assert_eq 0 "$2" "$3"; else assert_eq 1 "$2" "$3"; fi; }
assert_denial 'GraphQL: user does not have the correct permissions to execute `MergePullRequest`' 0 "GraphQL denial"
assert_denial 'HTTP 403: Must have admin rights to Repository.' 0 "admin denial"
assert_denial 'GraphQL: Pull request is not mergeable (mergePullRequest)' 1 "plain unmergeable"
assert_denial 'HTTP 502: Bad gateway' 1 "transient failure"
# --- escalation: exactly one emit, MANUAL (non-degraded) explanation ---
# PLUGIN_ROOT is stubbed so the emit is recorded rather than appended to the
# LIVE event log, and so "exactly once" is assertable.
# shellcheck disable=SC2034  # consumed as globals by the sourced lib
ORCH_ID="test"; TICKET="CAT-999"; PHASE="monitor-merge"
ORCH_DIR="$TMPROOT/orch"; mkdir -p "$ORCH_DIR/workers/$TICKET"
SIGNAL_FILE="$ORCH_DIR/workers/$TICKET/phase-${PHASE}.json"
echo '{"ticket":"CAT-999","phase":"monitor-merge","status":"running"}' > "$SIGNAL_FILE"
EMITLOG="$TMPROOT/emit.log"
STUBROOT="$TMPROOT/stubroot"; mkdir -p "$STUBROOT/scripts/execution-core"
cat > "$STUBROOT/scripts/phase-agent-emit-complete" <<EOS
#!/usr/bin/env bash
echo "\$*" >> "$EMITLOG"
EOS
chmod +x "$STUBROOT/scripts/phase-agent-emit-complete"
cp "${REPO_ROOT}/plugins/dev/scripts/execution-core/escalation-explain.mjs" \
   "${REPO_ROOT}/plugins/dev/scripts/execution-core/escalation-explanation.mjs" \
   "$STUBROOT/scripts/execution-core/"
# shellcheck disable=SC2034  # consumed as globals by the sourced lib
COMMS=""
# shellcheck disable=SC2034  # consumed as a global by the sourced lib
CATALYST_COMMENT_POST_HELPER="/nonexistent"
PLUGIN_ROOT="$STUBROOT" _escalate_merge_permission "coalesce-labs/catalyst" "3218" "READ" >/dev/null 2>&1

assert_eq "$(wc -l < "$EMITLOG" | tr -d ' ')" "1" "emits exactly once (no attempts burned)"
assert_contains "$(cat "$EMITLOG")" "--status failed" "emits status=failed"
assert_contains "$(cat "$EMITLOG")" "merge_permission_denied" "emits the permission failureReason"
SIG="$(cat "$SIGNAL_FILE")"
assert_eq "$(jq -r '.status' <<<"$SIG")" "failed" "signal status=failed"
assert_eq "$(jq -r '.failureReason' <<<"$SIG")" "merge_permission_denied" "signal failureReason set"
assert_eq "$(jq -r '.explanation.escalation_type' <<<"$SIG")" "manual" "explanation is MANUAL, not authorization"
assert_eq "$(jq -r '.explanation.degraded // "false"' <<<"$SIG")" "false" "explanation validates (not degraded)"
assert_contains "$(jq -r '.explanation.problem' <<<"$SIG")" "coalesce-labs/catalyst" "problem names the repository"
assert_contains "$(jq -r '.explanation.blocked_capability' <<<"$SIG")" "merge" "blocked_capability names the missing merge permission"
CTA="$(jq -r '.explanation.call_to_action' <<<"$SIG")"
assert_contains "$CTA" "merge" "CTA is actionable"
if [[ "$(printf '%s' "$CTA" | tr '[:upper:]' '[:lower:]')" == *"authorize"*"retry"* ]]; then
  fail "CTA must never ask the operator to authorize a retry"
else
  pass "CTA never asks the operator to authorize a retry"
fi

BODY="$(cat "$SKILL")"
assert_contains "$BODY" "merge_permission_probe" "preflight wired"
assert_contains "$BODY" "merge_denial_is_permission" "call-site classifier wired"
PRE_LINE="$(grep -n 'merge_permission_probe' "$SKILL" | head -1 | cut -d: -f1)"
MERGE_LINE="$(grep -n 'if ! gh pr merge' "$SKILL" | head -1 | cut -d: -f1)"
[[ "$PRE_LINE" -lt "$MERGE_LINE" ]] && pass "preflight precedes merge" || fail "preflight ordering"
echo "passed=$PASSES failed=$FAILURES"
[[ "$FAILURES" -eq 0 ]]
