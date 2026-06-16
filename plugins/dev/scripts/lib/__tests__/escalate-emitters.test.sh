#!/usr/bin/env bash
# escalate-emitters.test.sh — CTL-1130 Phase 4: shell emitter tests.
# Tests escalate-workflow-scope.sh (MANUAL) and orphan-sweep.sh DECISION emitter.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
EMITTER_DIR="${SCRIPT_DIR}/.."

PASSES=0; FAILURES=0

pass() { (( PASSES++ )) || true; echo "  PASS: $1"; }
fail() { (( FAILURES++ )) || true; echo "  FAIL: $1"; }

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: ${label}"
    (( PASSES++ )) || true
  else
    echo "  FAIL: ${label} — expected=$(printf '%q' "$expected") actual=$(printf '%q' "$actual")"
    (( FAILURES++ )) || true
  fi
}

assert_ne() {
  local unexpected="$1" actual="$2" label="$3"
  if [[ "$unexpected" != "$actual" ]]; then
    echo "  PASS: ${label}"
    (( PASSES++ )) || true
  else
    echo "  FAIL: ${label} — should not equal $(printf '%q' "$unexpected")"
    (( FAILURES++ )) || true
  fi
}

# ── Prerequisite: node + jq available ────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "SKIP: node not available"
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP: jq not available"
  exit 0
fi

SHIM="${PLUGIN_ROOT}/scripts/execution-core/escalation-explain.mjs"
if [[ ! -f "$SHIM" ]]; then
  echo "SKIP: escalation-explain.mjs not found at $SHIM"
  exit 0
fi

# ── 1. escalate-workflow-scope.sh emits valid MANUAL JSON ─────────────────────
echo "1. escalate-workflow-scope.sh emits MANUAL typed JSON"
WFSCOPE="${EMITTER_DIR}/escalate-workflow-scope.sh"
if [[ -f "$WFSCOPE" ]]; then
  # Source the helper and call it with a fake SIGNAL_FILE to capture expl_json
  # We test the shim call directly with the same flags the script uses
  EXPL_OUT="$(node "$SHIM" \
    --type manual \
    --problem "git push was rejected: branch modifies .github/workflows/ but the host token lacks the 'workflow' OAuth scope" \
    --call-to-action "Grant the daemon token 'workflow' scope (gh auth refresh -s workflow) or set CATALYST_WORKFLOW_GITHUB_TOKEN, then re-run phase-pr — or push branch CTL-TEST manually. Which?" \
    --blocked-capability "the host git token lacks the workflow OAuth scope" \
    --instructions '["gh auth refresh -s workflow","or set CATALYST_WORKFLOW_GITHUB_TOKEN"]' \
    --remediation-then-retry "re-run /catalyst-dev:phase-pr after the scope is granted" \
    --why-not-auto "the daemon cannot grant itself an OAuth scope (capability boundary)" \
    --can-execute false \
    --observed "$(jq -nc --arg b "CTL-TEST" '{branch:$b, scope_missing:"workflow"}' 2>/dev/null || echo '{}')" \
    2>/dev/null || echo '{}')"
  assert_eq "manual" \
    "$(printf '%s' "$EXPL_OUT" | jq -r '.escalation_type' 2>/dev/null)" \
    "escalate-workflow-scope: escalation_type=manual"
  assert_ne "" \
    "$(printf '%s' "$EXPL_OUT" | jq -r '.blocked_capability' 2>/dev/null)" \
    "escalate-workflow-scope: blocked_capability present"
  assert_ne "null" \
    "$(printf '%s' "$EXPL_OUT" | jq -r '.blocked_capability' 2>/dev/null)" \
    "escalate-workflow-scope: blocked_capability not null"
else
  echo "  SKIP: escalate-workflow-scope.sh not found"
fi

# ── 2. Live-state: inject BRANCH and assert observed.branch matches ───────────
echo "2. escalate-workflow-scope: live-state branch is NOT baked string"
BRANCH_VALUE="CTL-9999-live-branch-test"
LIVE_OUT="$(node "$SHIM" \
  --type manual \
  --problem "push rejected: branch modifies .github/workflows/" \
  --call-to-action "Grant workflow scope or push manually. Which?" \
  --blocked-capability "host token lacks workflow OAuth scope" \
  --instructions '["gh auth refresh -s workflow"]' \
  --remediation-then-retry "re-run after scope granted" \
  --why-not-auto "daemon cannot grant itself an OAuth scope (capability boundary)" \
  --can-execute false \
  --observed "$(jq -nc --arg b "$BRANCH_VALUE" '{branch:$b,scope_missing:"workflow"}' 2>/dev/null || echo '{}')" \
  2>/dev/null || echo '{}')"
assert_eq "$BRANCH_VALUE" \
  "$(printf '%s' "$LIVE_OUT" | jq -r '.observed.branch' 2>/dev/null)" \
  "live-state: observed.branch equals injected value (not baked string)"

# ── 3. orphan-sweep DECISION emitter: options length == 2, no recommendation ──
echo "3. orphan-sweep DECISION emitter: options≥2, no recommendation"
DEC_OUT="$(node "$SHIM" \
  --type decision \
  --problem "orphan-sweep found stale phase signal for CTL-TEST/implement" \
  --call-to-action "re-dispatch CTL-TEST/implement, or mark it abandoned?" \
  --options "$(jq -nc '[{"label":"re-dispatch CTL-TEST/implement","tradeoff":"may re-hit same failure"},{"label":"mark abandoned","tradeoff":"lose partial work"}]' 2>/dev/null || echo '[]')" \
  --why-you "re-dispatch vs abandon is a priority call the orchestrator cannot compute" \
  --observed "$(jq -nc --arg j "testjob123" '{bgJobId:$j,staleMarker:"orphan-sweep-stale"}' 2>/dev/null || echo '{}')" \
  2>/dev/null || echo '{}')"
assert_eq "decision" \
  "$(printf '%s' "$DEC_OUT" | jq -r '.escalation_type' 2>/dev/null)" \
  "orphan-sweep: escalation_type=decision"
OPT_COUNT="$(printf '%s' "$DEC_OUT" | jq '.options | length' 2>/dev/null || echo 0)"
assert_eq "true" \
  "$([[ "${OPT_COUNT:-0}" -ge 2 ]] && echo true || echo false)" \
  "orphan-sweep: options.length ≥ 2"
REC="$(printf '%s' "$DEC_OUT" | jq -r '.recommendation // "null"' 2>/dev/null)"
assert_eq "null" "$REC" "orphan-sweep: no recommendation field"

# ── 4. shellcheck clean ───────────────────────────────────────────────────────
echo "4. shellcheck passes on both emitters"
if command -v shellcheck >/dev/null 2>&1; then
  WFSCOPE_SHELL="${EMITTER_DIR}/escalate-workflow-scope.sh"
  ORPHAN_SWEEP="${PLUGIN_ROOT}/scripts/orphan-sweep.sh"
  SC_PASS=true
  for f in "$WFSCOPE_SHELL" "$ORPHAN_SWEEP"; do
    if [[ -f "$f" ]]; then
      if shellcheck -e SC2317 "$f" >/dev/null 2>&1; then
        echo "  PASS: shellcheck ${f##*/}"
        (( PASSES++ )) || true
      else
        echo "  FAIL: shellcheck ${f##*/}"
        shellcheck -e SC2317 "$f" 2>&1 | head -5
        (( FAILURES++ )) || true
        SC_PASS=false
      fi
    fi
  done
else
  echo "  SKIP: shellcheck not available"
fi

# ── 11. CTL-1181: _escalate_workflow_scope_push side-effects ─────────────────
echo ""
echo "11. CTL-1181: _escalate_workflow_scope_push side-effects"

run_s11() {
  # Creates a fake plugin root with stub escalation-explain.mjs and
  # phase-agent-emit-complete no-op, then runs _escalate_workflow_scope_push
  # in a subshell with per-test stubs for linearis and linear-comment-post.sh.
  # Args: stub_linearis (0|1 exit), stub_commentpost (0|1 exit), set_orch_dir (true|false),
  #       set_cta_token (true|false - whether the cta is non-empty in the stub json)
  local stub_lin_rc="${1:-0}" stub_cp_rc="${2:-0}" set_orch="${3:-true}" set_cta="${4:-true}"
  local scratch
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/s11-XXXXXX")"
  # Fake plugin root structure
  local fpr="${scratch}/plugin_root"
  mkdir -p "${fpr}/scripts/execution-core" "${fpr}/scripts/lib"

  # Minimal escalation-explain.mjs stub (outputs just enough for the helper).
  # Write via printf to avoid heredoc quoting complexity with the JSON string.
  if [[ "$set_cta" == "true" ]]; then
    printf '%s\n' \
      "import process from 'process';" \
      "process.stdout.write(JSON.stringify({escalation_type:'manual',blocked_capability:'workflow-oauth-scope',call_to_action:'Run gh auth refresh -s workflow then re-run phase-pr.'}));" \
      > "${fpr}/scripts/execution-core/escalation-explain.mjs"
  else
    printf '%s\n' \
      "import process from 'process';" \
      "process.stdout.write(JSON.stringify({escalation_type:'manual',blocked_capability:'workflow-oauth-scope',call_to_action:''}));" \
      > "${fpr}/scripts/execution-core/escalation-explain.mjs"
  fi

  # no-op emit-complete
  local emit="${fpr}/scripts/phase-agent-emit-complete"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$emit"; chmod +x "$emit"

  # Stub linearis
  local lin_bin="${scratch}/lin_bin"
  mkdir -p "$lin_bin"
  printf '#!/usr/bin/env bash\nexit %s\n' "$stub_lin_rc" > "${lin_bin}/linearis"
  chmod +x "${lin_bin}/linearis"

  # Stub linear-comment-post.sh (captures args so we can verify)
  local cp_out="${scratch}/cp.out"
  cat > "${fpr}/scripts/lib/linear-comment-post.sh" <<CPSTUB
#!/usr/bin/env bash
printf '%s\t%s\n' "\$1" "\$2" > "${cp_out}"
exit ${stub_cp_rc}
CPSTUB
  chmod +x "${fpr}/scripts/lib/linear-comment-post.sh"

  # Fake signal file
  local sig="${scratch}/phase-implement.json"
  printf '{"status":"running","ticket":"CTL-S11"}\n' > "$sig"

  # Fake orch dir
  local orch_dir="${scratch}/orch_dir"
  mkdir -p "${orch_dir}/workers/CTL-S11"

  # Run helper in subshell
  (
    export PLUGIN_ROOT="$fpr"
    export SIGNAL_FILE="$sig"
    export TICKET="CTL-S11"
    export PHASE="pr"
    export ORCH_ID="CTL-S11"
    export COMMS=""
    [[ "$set_orch" == "true" ]] && export CATALYST_ORCHESTRATOR_DIR="$orch_dir"
    PATH="${lin_bin}:${PATH}"
    source "${EMITTER_DIR}/escalate-workflow-scope.sh"
    _escalate_workflow_scope_push "my-test-branch" >/dev/null 2>&1
  ) || true

  printf '%s' "$scratch"
}

# 11a: signal file gains status=failed after the call
echo "11a: signal file status=failed after _escalate_workflow_scope_push"
S11A_SCRATCH="$(run_s11 0 0 true true)"
S11A_STATUS="$(jq -r '.status' "${S11A_SCRATCH}/phase-implement.json" 2>/dev/null || echo "missing")"
assert_eq "failed" "$S11A_STATUS" "11a: signal file status=failed"
rm -rf "$S11A_SCRATCH"

# 11b: .linear-label-needs-human.applied marker is created when CATALYST_ORCHESTRATOR_DIR set
echo "11b: needs-human marker file created when CATALYST_ORCHESTRATOR_DIR set"
S11B_SCRATCH="$(run_s11 0 0 true true)"
MARKER="${S11B_SCRATCH}/orch_dir/workers/CTL-S11/.linear-label-needs-human.applied"
if [[ -e "$MARKER" ]]; then
  pass "11b: needs-human marker file created"
else
  fail "11b: needs-human marker file NOT created (expected at ${MARKER})"
fi
rm -rf "$S11B_SCRATCH"

# 11c: marker is NOT created when CATALYST_ORCHESTRATOR_DIR is unset
echo "11c: needs-human marker NOT created when CATALYST_ORCHESTRATOR_DIR unset"
S11C_SCRATCH="$(run_s11 0 0 false true)"
MARKER_C="${S11C_SCRATCH}/orch_dir/workers/CTL-S11/.linear-label-needs-human.applied"
if [[ -e "$MARKER_C" ]]; then
  fail "11c: marker created even though CATALYST_ORCHESTRATOR_DIR was unset"
else
  pass "11c: marker not created (CATALYST_ORCHESTRATOR_DIR unset — expected)"
fi
rm -rf "$S11C_SCRATCH"

# 11d: comment-post is called with the ticket and a non-empty body containing the CTA
echo "11d: comment-post invoked with non-empty body containing the CTA"
S11D_SCRATCH="$(run_s11 0 0 true true)"
CP_OUT_D="${S11D_SCRATCH}/cp.out"
if [[ -s "$CP_OUT_D" ]]; then
  CP_TICKET="$(head -1 "$CP_OUT_D" | cut -f1)"
  CP_BODY="$(head -1 "$CP_OUT_D" | cut -f2-)"
  assert_eq "CTL-S11" "$CP_TICKET" "11d: comment-post called with correct ticket"
  if [[ -n "$CP_BODY" && "$CP_BODY" == *"Workflow scope push blocked"* ]]; then
    pass "11d: comment body contains the escalation header"
  else
    fail "11d: comment body missing expected text — got: $(printf '%q' "$CP_BODY")"
  fi
else
  fail "11d: comment-post was not invoked (cp.out is empty or missing)"
fi
rm -rf "$S11D_SCRATCH"

# 11e: comment-post is NOT invoked when the CTA is empty
echo "11e: comment-post NOT invoked when call_to_action is empty"
S11E_SCRATCH="$(run_s11 0 0 true false)"
CP_OUT_E="${S11E_SCRATCH}/cp.out"
if [[ -s "$CP_OUT_E" ]]; then
  fail "11e: comment-post was called despite empty CTA — got: $(cat "$CP_OUT_E")"
else
  pass "11e: comment-post not called when CTA is empty"
fi
rm -rf "$S11E_SCRATCH"

# 11f: the helper is fail-open — a failing linearis does not abort the function
echo "11f: failing linearis does not abort _escalate_workflow_scope_push"
S11F_SCRATCH="$(run_s11 1 0 true true)"
S11F_STATUS="$(jq -r '.status' "${S11F_SCRATCH}/phase-implement.json" 2>/dev/null || echo "missing")"
assert_eq "failed" "$S11F_STATUS" "11f: signal still set to failed even when linearis exits 1"
rm -rf "$S11F_SCRATCH"

echo ""
echo "results: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]]
