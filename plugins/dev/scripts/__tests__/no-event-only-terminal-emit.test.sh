#!/usr/bin/env bash
# no-event-only-terminal-emit.test.sh — CTL-1410 Phase A regression guard.
#
# INVARIANT: no phase-agent SKILL may emit a terminal phase event through the
# event-only `emit_phase_complete` lib helper (plugins/dev/scripts/lib/
# phase-emit-complete.sh). That helper ONLY appends the canonical event; it never
# flips the phase signal file's `status` to done/failed/skipped. Under
# executor=sdk there is no bg reclaim path to synthesize that flip afterwards, so
# a phase that ends via emit_phase_complete strands its slot (the triage +
# monitor-deploy strand CTL-1410 Phase A fixed).
#
# Every terminal path MUST instead go through the production wrapper
# `phase-agent-emit-complete` (which flips the signal in-band). This test greps
# every phase-*/SKILL.md body for a call to the event-only helper and fails if it
# finds one. It is the invariant that makes the SDK success⇒done assumption sound.
#
# Run: bash plugins/dev/scripts/__tests__/no-event-only-terminal-emit.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILLS_DIR="${REPO_ROOT}/plugins/dev/skills"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); printf '  PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  FAIL: %s\n    %s\n' "$1" "$2"; }

echo "no-event-only-terminal-emit guard (CTL-1410 Phase A)"

shopt -s nullglob
SKILL_FILES=("${SKILLS_DIR}"/phase-*/SKILL.md)
shopt -u nullglob

if [[ ${#SKILL_FILES[@]} -eq 0 ]]; then
  fail "discovered phase skills" "no phase-*/SKILL.md found under ${SKILLS_DIR}"
  echo; echo "Results: ${PASS} passed, ${FAIL} failed"; exit 1
fi

# A CALL to the event-only helper looks like `emit_phase_complete --…` (optionally
# indented, possibly preceded by nothing). Prose mentions ("the emit_phase_complete
# helper") carry no flag, and the lib's own `. "$lib"` source line is not a call —
# so anchoring on the trailing `--<flag>` avoids false positives. The negative
# lookbehind-ish char class rules out `foo_emit_phase_complete`.
CALL_RE='(^|[^A-Za-z0-9_])emit_phase_complete[[:space:]]+--'

for skill in "${SKILL_FILES[@]}"; do
  name="$(basename "$(dirname "$skill")")"
  offenders="$(grep -nE "$CALL_RE" "$skill" || true)"
  if [[ -n "$offenders" ]]; then
    fail "${name}: no terminal path calls the event-only emit_phase_complete helper" \
      "offending lines (migrate to the phase-agent-emit-complete wrapper):$(printf '\n%s' "$offenders")"
  else
    ok "${name}: terminal emits go through the wrapper (no event-only emit_phase_complete call)"
  fi
done

echo
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ $FAIL -eq 0 ]] || exit 1
exit 0
