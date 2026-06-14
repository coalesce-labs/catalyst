#!/usr/bin/env bash
# phase-skill-stderr-guard.test.sh — CTL-1111 regression guard.
# Asserts no phase skill swallows the linear-comment-post helper's stderr on its
# comment-post invocation (the `>/dev/null 2>&1` pattern that hid the 2026-06-13 P1).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$(cd "${SCRIPT_DIR}/../../skills" && pwd)"
PASS=0
FAIL=0

# Match a comment-post invocation line (the helper called with TICKET + a *BODY var)
# that still redirects stderr to /dev/null.
OFFENDERS="$(grep -rnE 'COMMENT_POST" "\$\{TICKET\}" "\$\{(MIRROR_BODY|COMMENT_BODY)\}".*2>&1' \
  "${SKILLS_DIR}"/phase-*/SKILL.md 2>/dev/null || true)"

if [[ -z "$OFFENDERS" ]]; then
  echo "PASS: no phase skill swallows linear-comment-post stderr (no >/dev/null 2>&1 on invocation)"
  PASS=$((PASS+1))
else
  echo "FAIL: phase skill(s) still swallow comment-post stderr:"
  printf '%s\n' "$OFFENDERS"
  FAIL=$((FAIL+1))
fi

# Sanity: each phase skill that posts a mirror still discards stdout (>/dev/null
# present on the invocation) so success stays quiet.
DISCARD_COUNT="$(grep -rlE 'COMMENT_POST" "\$\{TICKET\}" "\$\{(MIRROR_BODY|COMMENT_BODY)\}".*>/dev/null' \
  "${SKILLS_DIR}"/phase-*/SKILL.md 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$DISCARD_COUNT" -ge 11 ]]; then
  echo "PASS: all 11 phase skills still discard comment-post stdout"
  PASS=$((PASS+1))
else
  echo "FAIL: expected >=11 skills discarding stdout, found ${DISCARD_COUNT}"
  FAIL=$((FAIL+1))
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
