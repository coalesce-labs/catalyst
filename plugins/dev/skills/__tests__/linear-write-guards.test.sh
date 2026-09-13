#!/usr/bin/env bash
# linear-write-guards.test.sh — CTL-2306 Phase 1: research-codebase's Linear
# writes are guarded IN THE STEP, not only in a trailing section.
#
# WHY: a phase container holds no Linear credential and its prompt forbids
# linearis. research-codebase's two in-flow write steps (the research-state
# transition in Step 2 and the "Linear comment" in step 8b) carried no guard;
# only the `## Linear Integration` section at the bottom said "skip silently".
# A model following the numbered steps reaches the unguarded instruction first,
# so today the prompt override is the only thing standing between those steps
# and a failed or wrongly-attributed write. implement-plan already carries the
# guard in-step; this pins research-codebase to the same shape.
#
# Run: bash plugins/dev/skills/__tests__/linear-write-guards.test.sh
# Bash-3.2 safe.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RESEARCH="${SKILLS_DIR}/research-codebase/SKILL.md"
IMPLEMENT="${SKILLS_DIR}/implement-plan/SKILL.md"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); printf '  PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  FAIL: %s\n    %s\n' "$1" "${2:-}"; }

for f in "$RESEARCH" "$IMPLEMENT"; do
  [ -f "$f" ] || { echo "FATAL: subject not found: $f" >&2; exit 1; }
done

# assert_guarded <label> <file> <fixed-string that identifies the step line>
# The step is ONE markdown line (a bullet or a bold sub-step); both guards must
# be on that same line so they cannot drift apart from the instruction.
assert_guarded() {
  local label="$1" file="$2" anchor="$3" line
  line="$(grep -F -- "$anchor" "$file" | head -1)"
  if [ -z "$line" ]; then
    fail "$label" "no line contains the anchor: $anchor"
    return
  fi
  case "$line" in
    *CATALYST_PHASE*) ;;
    *) fail "$label" "the step does not skip when CATALYST_PHASE is set: ${line:0:160}"; return ;;
  esac
  case "$line" in
    *"skip silently"*) ok "$label" ;;
    *) fail "$label" "the step does not skip silently when linearis is unavailable: ${line:0:160}" ;;
  esac
}

echo "Linear write steps carry their own guards (CTL-2306)"

# Positive control: the same probe passes on the step that is already guarded.
assert_guarded "control: implement-plan's in-progress transition is guarded in-step" \
  "$IMPLEMENT" 'to `stateMap.inProgress` from config using Linearis CLI'

assert_guarded "research-codebase: the research-state transition (Step 2) is guarded in-step" \
  "$RESEARCH" 'update it to the configured research state'
assert_guarded "research-codebase: the research-complete comment (8b) is guarded in-step" \
  "$RESEARCH" '**8b. Linear comment**'

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
