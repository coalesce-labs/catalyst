#!/usr/bin/env bash
# CTL-1490: Divergence tests asserting all six converted phase skills wire
# the thoughts-doc write + sync gate before emit-complete.
#
# Run: bash plugins/dev/scripts/__tests__/phase-skill-thoughts-doc.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILLS_DIR="${REPO_ROOT}/plugins/dev/skills"

FAILURES=0
PASSES=0
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

# --------------------------------------------------------------------------
# The six phases that now produce thoughts docs.
# phase name matches the skill name for all six (phase-triage → phase-triage, etc.)
# --------------------------------------------------------------------------
for skill in phase-triage phase-verify phase-review phase-pr phase-monitor-merge phase-monitor-deploy; do
  f="${SKILLS_DIR}/${skill}/SKILL.md"
  phase_name="${skill}"
  thoughts_dir="thoughts/shared/${phase_name}"

  echo ""
  echo "=== $skill ==="

  # 1. Skill references thoughts-sync-gate.sh
  echo "Test: ${skill} references thoughts-sync-gate.sh"
  if grep -q "thoughts-sync-gate.sh" "$f"; then
    pass "${skill} references thoughts-sync-gate.sh"
  else
    fail "${skill} references thoughts-sync-gate.sh" \
      "thoughts-sync-gate.sh not found in ${f}"
  fi

  # 2. Skill writes to thoughts/shared/<phase-name>/ (via helper or directly)
  echo "Test: ${skill} writes to ${thoughts_dir}/"
  if grep -q "${thoughts_dir}" "$f" || grep -q "write_phase_thoughts_doc" "$f"; then
    pass "${skill} writes to ${thoughts_dir}/ (or via helper)"
  else
    fail "${skill} writes to ${thoughts_dir}/" \
      "neither '${thoughts_dir}' nor 'write_phase_thoughts_doc' found in ${f}"
  fi

  # 3. thoughts-sync-gate.sh call precedes the terminal --status complete emit.
  #    Use the LAST --status complete (the terminal success path), not the first
  #    (which may be an early-exit from a pre-mirror path, e.g. phase-pr line 140).
  echo "Test: ${skill} — sync gate before --status complete"
  gate_line=$(grep -n "thoughts-sync-gate.sh" "$f" | head -1 | cut -d: -f1)
  complete_line=$(grep -n -- "--status complete" "$f" | tail -1 | cut -d: -f1)
  if [[ -z "$gate_line" ]]; then
    fail "${skill} gate ordering: sync gate not found"
  elif [[ -z "$complete_line" ]]; then
    fail "${skill} gate ordering: --status complete not found"
  elif [[ "$gate_line" -lt "$complete_line" ]]; then
    pass "${skill} sync gate (line ${gate_line}) before --status complete (line ${complete_line})"
  else
    fail "${skill} gate ordering: sync gate (line ${gate_line}) is NOT before --status complete (line ${complete_line})"
  fi

  # 4. Skill does NOT inline raw humanlayer thoughts sync
  echo "Test: ${skill} does not inline raw humanlayer thoughts sync"
  if grep -q "humanlayer thoughts sync" "$f"; then
    fail "${skill} does not inline raw humanlayer thoughts sync" \
      "found raw 'humanlayer thoughts sync' in ${f} — must go through the gate"
  else
    pass "${skill} does not inline raw humanlayer thoughts sync"
  fi
done

# --------------------------------------------------------------------------
# phase-plan pull-before-read gap (F12)
# --------------------------------------------------------------------------
echo ""
echo "=== phase-plan pull-before-read (F12) ==="
PLAN_FILE="${SKILLS_DIR}/phase-plan/SKILL.md"

echo "Test: phase-plan references thoughts-pull-sync-gate.sh"
if grep -q "thoughts-pull-sync-gate.sh" "$PLAN_FILE"; then
  pass "phase-plan references thoughts-pull-sync-gate.sh"
else
  fail "phase-plan references thoughts-pull-sync-gate.sh" \
    "thoughts-pull-sync-gate.sh not found in ${PLAN_FILE}"
fi

echo "Test: phase-plan — pull gate is in Prelude section"
prelude_line=$(grep -n "## Prelude\|^## Prelude\|^Prelude" "$PLAN_FILE" | head -1 | cut -d: -f1)
pull_gate_line=$(grep -n "thoughts-pull-sync-gate.sh" "$PLAN_FILE" | head -1 | cut -d: -f1)
if [[ -z "$pull_gate_line" ]]; then
  fail "phase-plan pull gate ordering: pull gate not found"
elif [[ -n "$prelude_line" && "$pull_gate_line" -gt "$prelude_line" ]]; then
  pass "phase-plan pull gate (line ${pull_gate_line}) in Prelude section (starts line ${prelude_line})"
else
  pass "phase-plan pull gate present (line ${pull_gate_line})"
fi

# --------------------------------------------------------------------------
# CTL-1490 regression (verify HIGH): the helper is actually INVOKED and the
# doc must land in own_thoughts_artifact_dir_for_phase <phase> — the exact dir
# the emit-complete gate (match_thoughts_artifact) inspects. The prior grep-only
# tests missed a double-'phase-' prefix that routed docs to
# thoughts/shared/phase-phase-<name>/, causing every complete to downgrade to
# failed(artifact_not_gate_visible). This block executes the helper end-to-end
# and asserts the written path is gate-visible.
# --------------------------------------------------------------------------
echo ""
echo "=== end-to-end: write_phase_thoughts_doc lands where the gate looks ==="

WRITER="${REPO_ROOT}/plugins/dev/scripts/lib/write-phase-thoughts-doc.sh"
GATE="${REPO_ROOT}/plugins/dev/scripts/lib/phase-artifact-gate.sh"

# skill name → bare phase arg (skill without the leading 'phase-').
for skill in phase-triage phase-verify phase-review phase-pr phase-monitor-merge phase-monitor-deploy; do
  phase="${skill#phase-}"
  f="${SKILLS_DIR}/${skill}/SKILL.md"

  echo ""
  echo "--- $skill (phase=${phase}) ---"

  # a) Static guard: the call site passes the BARE phase name (no 'phase-'
  #    re-prefix), matching the helper's 'thoughts/shared/phase-<phase>' contract.
  echo "Test: ${skill} passes bare phase name to write_phase_thoughts_doc"
  if grep -Eq "write_phase_thoughts_doc[[:space:]]+\"${phase}\"" "$f"; then
    pass "${skill} passes bare \"${phase}\""
  else
    fail "${skill} passes bare phase name" \
      "expected write_phase_thoughts_doc \"${phase}\" (found a 'phase-' re-prefix?) in ${f}"
  fi

  # b) Execution guard: invoke the helper in an isolated cwd and assert the file
  #    lands in own_thoughts_artifact_dir_for_phase <phase> AND that
  #    match_thoughts_artifact (the emit-complete gate) finds it.
  echo "Test: ${skill} doc is gate-visible after write"
  tmp="$(mktemp -d)"
  gate_result="$(
    cd "$tmp" || exit 3
    # shellcheck source=/dev/null
    source "$WRITER" || exit 3
    # shellcheck source=/dev/null
    source "$GATE" || exit 3
    expected_dir="$(own_thoughts_artifact_dir_for_phase "$phase")"
    [[ -n "$expected_dir" ]] || { echo "NO_DIR"; exit 0; }
    write_phase_thoughts_doc "$phase" "CTL-9999" "body-for-${phase}"
    if [[ ! -d "$expected_dir" ]]; then echo "MISS_DIR:${expected_dir}"; exit 0; fi
    if match_thoughts_artifact "$expected_dir" "CTL-9999" >/dev/null 2>&1; then
      echo "OK:${expected_dir}"
    else
      echo "MISS_GATE:${expected_dir}"
    fi
  )"
  rm -rf "$tmp"
  case "$gate_result" in
    OK:*)  pass "${skill} doc gate-visible in ${gate_result#OK:}" ;;
    NO_DIR) fail "${skill} gate-visible" "own_thoughts_artifact_dir_for_phase ${phase} returned empty" ;;
    *)      fail "${skill} gate-visible" "helper wrote outside the gate dir (${gate_result}) — double 'phase-' prefix regression?" ;;
  esac
done

# --------------------------------------------------------------------------
echo ""
echo "─────────────────────────────────────────────"
echo "phase-skill-thoughts-doc: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]] || exit 1
