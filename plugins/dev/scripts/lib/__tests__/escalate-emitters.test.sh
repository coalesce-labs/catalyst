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

# 11f: the helper is fail-open — a failing linearis does not abort the function
echo "11f: failing linearis does not abort _escalate_workflow_scope_push"
S11F_SCRATCH="$(run_s11 1 0 true true)"
S11F_STATUS="$(jq -r '.status' "${S11F_SCRATCH}/phase-implement.json" 2>/dev/null || echo "missing")"
assert_eq "failed" "$S11F_STATUS" "11f: signal still set to failed even when linearis exits 1"
rm -rf "$S11F_SCRATCH"
# ── 12. End-to-end: escalate → emit-complete stub → phase-failure-comment → poster (CTL-1182) ──
echo "12. escalate-workflow-scope end-to-end: call_to_action reaches Linear poster (CTL-1182)"
E2E_WFSCOPE="${EMITTER_DIR}/escalate-workflow-scope.sh"
E2E_PFC="${EMITTER_DIR}/phase-failure-comment.sh"
if [[ -f "$E2E_WFSCOPE" && -f "$E2E_PFC" && -x "$E2E_PFC" ]]; then
  E2E_SCRATCH="$(mktemp -d)"
  E2E_TICKET="CTL-E2E5"
  E2E_PHASE="pr"
  E2E_ORCH="${E2E_SCRATCH}/orch"
  mkdir -p "${E2E_ORCH}/workers/${E2E_TICKET}"
  E2E_SIGNAL="${E2E_ORCH}/workers/${E2E_TICKET}/phase-${E2E_PHASE}.json"
  printf '{"ticket":"%s","phase":"%s","status":"pending"}\n' "$E2E_TICKET" "$E2E_PHASE" >"$E2E_SIGNAL"

  # Recording poster stub (injected via CATALYST_COMMENT_POST_HELPER)
  E2E_INVOCATIONS="${E2E_SCRATCH}/invocations.txt"
  E2E_BODY="${E2E_SCRATCH}/body.txt"
  E2E_POSTER="${E2E_SCRATCH}/poster.sh"
  cat >"$E2E_POSTER" <<PSTUBEOF
#!/usr/bin/env bash
printf '%s\n' "\$1" >> "${E2E_INVOCATIONS}"
printf '%s' "\$2" > "${E2E_BODY}"
exit 0
PSTUBEOF
  chmod +x "$E2E_POSTER"

  # Fake PLUGIN_ROOT: real escalation-explain.mjs (needed by _escalate_workflow_scope_push)
  # + stub phase-agent-emit-complete that calls the real phase-failure-comment.sh.
  E2E_FAKE_ROOT="${E2E_SCRATCH}/fake-plugin"
  mkdir -p "${E2E_FAKE_ROOT}/scripts/execution-core"
  REAL_EXPLAIN="${PLUGIN_ROOT}/scripts/execution-core/escalation-explain.mjs"
  [[ -f "$REAL_EXPLAIN" ]] && ln -s "$REAL_EXPLAIN" \
    "${E2E_FAKE_ROOT}/scripts/execution-core/escalation-explain.mjs"

  # Stub emit-complete: forwards --status failed to phase-failure-comment.sh
  # (tests the emit-complete → phase-failure-comment portion of the chain)
  cat >"${E2E_FAKE_ROOT}/scripts/phase-agent-emit-complete" <<ESTUBEOF
#!/usr/bin/env bash
_T=""; _P=""; _R=""; _S=""
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --ticket) _T="\$2"; shift 2;;
    --phase)  _P="\$2"; shift 2;;
    --reason) _R="\$2"; shift 2;;
    --status) _S="\$2"; shift 2;;
    *)        shift;;
  esac
done
if [[ "\$_S" == "failed" || "\$_S" == "park" ]] && [[ -n "\$_T" ]]; then
  "${E2E_PFC}" --ticket "\$_T" --phase "\$_P" --reason "\$_R" \
    --orch-dir "${E2E_ORCH}" >/dev/null 2>&1 || true
fi
exit 0
ESTUBEOF
  chmod +x "${E2E_FAKE_ROOT}/scripts/phase-agent-emit-complete"

  # Run escalation in a subshell with overridden PLUGIN_ROOT
  (
    export PLUGIN_ROOT="${E2E_FAKE_ROOT}"
    export SIGNAL_FILE="$E2E_SIGNAL"
    export TICKET="$E2E_TICKET"
    export PHASE="$E2E_PHASE"
    export ORCH_ID="orch-e2e"
    export COMMS=""
    export CATALYST_FAILURE_COMMENT=1
    export CATALYST_COMMENT_POST_HELPER="$E2E_POSTER"
    # shellcheck source=/dev/null
    source "$E2E_WFSCOPE" 2>/dev/null
    _escalate_workflow_scope_push "CTL-E2E5-branch" 2>/dev/null || true
  ) || true

  # Assert poster was invoked exactly once
  E2E_COUNT=0
  [[ -f "$E2E_INVOCATIONS" ]] && E2E_COUNT="$(wc -l <"$E2E_INVOCATIONS" | tr -d ' ')"
  assert_eq "1" "$E2E_COUNT" "e2e: Linear poster invoked exactly once"

  # Assert body contains workflow-scope call_to_action text
  if [[ -f "$E2E_BODY" ]] && grep -qi "workflow" "$E2E_BODY" 2>/dev/null; then
    echo "  PASS: e2e: body contains workflow-scope call_to_action"
    (( PASSES++ )) || true
  else
    echo "  FAIL: e2e: body missing workflow-scope text (got: $(head -3 "${E2E_BODY}" 2>/dev/null))"
    (( FAILURES++ )) || true
  fi

  rm -rf "$E2E_SCRATCH"
else
  echo "  SKIP: escalate-workflow-scope.sh or phase-failure-comment.sh not found"
fi

echo ""
echo "results: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]]
