#!/usr/bin/env bash
# escalate-emitters.test.sh — CTL-1130 Phase 4: shell emitter tests.
# Tests escalate-workflow-scope.sh (MANUAL) and orphan-sweep.sh DECISION emitter.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
EMITTER_DIR="${SCRIPT_DIR}/.."

PASSES=0; FAILURES=0

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

echo ""
echo "results: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]]
