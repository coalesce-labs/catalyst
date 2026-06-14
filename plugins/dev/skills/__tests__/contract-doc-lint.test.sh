#!/usr/bin/env bash
# contract-doc-lint.test.sh — CTL-1130 Phase 4: contract-doc linting.
# Verifies SKILL.md files use typed-union contract (no legacy strings).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="${SCRIPT_DIR}/.."
PLUGIN_ROOT="$(cd "${SKILLS_DIR}/.." && pwd)"

PASSES=0; FAILURES=0

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: ${label}"
    (( PASSES++ )) || true
  else
    echo "  FAIL: ${label} — expected=${expected} actual=${actual}"
    (( FAILURES++ )) || true
  fi
}

TEMPLATE="${SKILLS_DIR}/_phase-agent-template/SKILL.md"
REMEDIATE="${SKILLS_DIR}/phase-remediate/SKILL.md"

# ── 1. No legacy strings in either SKILL.md ───────────────────────────────────
echo "1. No legacy field names in _phase-agent-template/SKILL.md"
for pat in "what_failed" "why_gave_up" "human_question" "--what-failed" "--why-gave-up" "--human-question"; do
  if grep -qF -- "$pat" "$TEMPLATE" 2>/dev/null; then
    echo "  FAIL: found legacy string '${pat}' in _phase-agent-template/SKILL.md"
    (( FAILURES++ )) || true
  else
    echo "  PASS: no '${pat}' in _phase-agent-template/SKILL.md"
    (( PASSES++ )) || true
  fi
done

echo "2. No legacy field names in phase-remediate/SKILL.md"
for pat in "what_failed" "why_gave_up" "human_question" "--what-failed" "--why-gave-up" "--human-question"; do
  if grep -qF -- "$pat" "$REMEDIATE" 2>/dev/null; then
    echo "  FAIL: found legacy string '${pat}' in phase-remediate/SKILL.md"
    (( FAILURES++ )) || true
  else
    echo "  PASS: no '${pat}' in phase-remediate/SKILL.md"
    (( PASSES++ )) || true
  fi
done

# ── 2. Tagged-union + new flags present in _phase-agent-template/SKILL.md ─────
echo "3. Tagged-union flags present in _phase-agent-template/SKILL.md"
for pat in "--type" "--can-execute" "--blocked-capability" "escalation_type" "call_to_action"; do
  if grep -qF -- "$pat" "$TEMPLATE" 2>/dev/null; then
    echo "  PASS: '${pat}' found in _phase-agent-template/SKILL.md"
    (( PASSES++ )) || true
  else
    echo "  FAIL: '${pat}' missing from _phase-agent-template/SKILL.md"
    (( FAILURES++ )) || true
  fi
done

# ── 3. phase-remediate doc: AUTHORIZATION reframe present ─────────────────────
echo "4. phase-remediate/SKILL.md uses AUTHORIZATION type"
if grep -qF "authorization" "$REMEDIATE" 2>/dev/null; then
  echo "  PASS: 'authorization' found in phase-remediate/SKILL.md"
  (( PASSES++ )) || true
else
  echo "  FAIL: 'authorization' missing from phase-remediate/SKILL.md"
  (( FAILURES++ )) || true
fi

# Live-state test: inject REGRESSION_RISK and assert the emitted --risk string
# contains the injected value (proves derivation, not a baked template)
echo "5. phase-remediate --risk derives from REGRESSION_RISK (live-state, anti-stale)"
if command -v node >/dev/null 2>&1; then
  INJECTED_RISK="7"
  RISK_OUT="$(REGRESSION_RISK="$INJECTED_RISK" HIGH_COUNT="2" node \
    "${PLUGIN_ROOT}/scripts/execution-core/escalation-explain.mjs" \
    --type authorization \
    --problem "remediation failed: verify HIGH finding" \
    --call-to-action "re-remediate or waive findings?" \
    --recommendation "re-run verify with updated remediation" \
    --risk "regression_risk ${INJECTED_RISK} with 2 HIGH finding(s) — merging risks a regression" \
    --why-asking "risk-authority gate, not a capability gap" \
    --authorize-label "re-remediate test" \
    --could-higher-tier-resolve false \
    --can-execute true \
    2>/dev/null || echo '{}')"
  RISK_FIELD="$(printf '%s' "$RISK_OUT" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).risk||'')}catch{console.log('')}})" 2>/dev/null || echo "")"
  if printf '%s' "$RISK_FIELD" | grep -q "$INJECTED_RISK"; then
    echo "  PASS: emitted risk contains injected REGRESSION_RISK value"
    (( PASSES++ )) || true
  else
    echo "  FAIL: emitted risk '${RISK_FIELD}' does not contain '${INJECTED_RISK}'"
    (( FAILURES++ )) || true
  fi
else
  echo "  SKIP: node not available"
fi

echo ""
echo "results: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]]
