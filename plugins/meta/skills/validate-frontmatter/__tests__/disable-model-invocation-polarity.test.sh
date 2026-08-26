#!/usr/bin/env bash
# disable-model-invocation-polarity.test.sh — CTL-2231 regression guard.
#
# validate-frontmatter's own guidance had the disable-model-invocation polarity
# BACKWARDS (old Step 2, line 80): "User-invoked skills have
# disable-model-invocation: false". The live rule (.claude/rules/plugin-editing.md,
# docs/frontmatter-standard.md) is the opposite: disable-model-invocation: true is
# what marks a skill user-invoked — it turns OFF model auto-triggering, leaving
# only explicit slash-command invocation. A validator following the old prose
# would tell authors to set every user-invoked skill to the value that lets the
# MODEL auto-trigger it: the opposite of what the author asked for.
#
# This operates on an arbitrary file so it can be pointed at the pre-fix content
# to prove the failure mode, and at the current file to prove the fix:
#   bash disable-model-invocation-polarity.test.sh [FILE]   # default: ../SKILL.md
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-${SCRIPT_DIR}/../SKILL.md}"

if [[ ! -f "${TARGET}" ]]; then
  echo "FAIL: ${TARGET} does not exist"
  exit 1
fi

FAILURES=0

# 1. The inverted claim, verbatim from the pre-CTL-2231 file, must be absent.
if grep -qF 'User-invoked skills have disable-model-invocation: false' "${TARGET}"; then
  echo "FAIL: ${TARGET} still states the INVERTED rule (user-invoked => false)"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: ${TARGET} does not state the inverted rule"
fi

# 2. The corrected claim must be present: user-invoked paired with "true" on the
#    same line, either order (case-insensitive — "User-invoked" vs "user-invoked").
if grep -qiE 'user-invoked.*disable-model-invocation:[[:space:]]*`?true|disable-model-invocation:[[:space:]]*`?true.*user-invoked' "${TARGET}"; then
  echo "PASS: ${TARGET} states the corrected rule (user-invoked => true)"
else
  echo "FAIL: ${TARGET} does not state the corrected rule anywhere"
  FAILURES=$((FAILURES + 1))
fi

echo "disable-model-invocation-polarity: $((2 - FAILURES))/2 passed"
exit "${FAILURES}"
