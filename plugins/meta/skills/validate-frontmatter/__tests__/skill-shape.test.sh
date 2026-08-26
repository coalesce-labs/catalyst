#!/usr/bin/env bash
# skill-shape.test.sh — CTL-2231: skill-local progressive-disclosure gate for
# validate-frontmatter, plus content assertions for the two defects this ticket
# fixed.
#
# WHY SKILL-LOCAL: plugins/dev/skills/__tests__/skill-shape.test.sh globs only
# plugins/dev/skills/*/references — a catalyst-meta skill never moves that
# count. plugins/foundry/skills/setup-catalyst/__tests__/skill-shape.test.sh set
# the precedent for a skill carrying its own local gate; this mirrors it, scoped
# to this one skill.
#
# Run: bash plugins/meta/skills/validate-frontmatter/__tests__/skill-shape.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="${SCRIPT_DIR}/.."
SKILL_MD="${SKILL_DIR}/SKILL.md"

MAX_SKILL_LINES=80
MAX_REFERENCE_LINES=150

PASSES=0; FAILURES=0
pass() { echo "  PASS: $1"; PASSES=$((PASSES + 1)); }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

if [[ ! -f "${SKILL_MD}" ]]; then
  fail "SKILL.md does not exist at ${SKILL_MD}"
  echo "skill-shape.test.sh: ${PASSES} passed, ${FAILURES} failed"
  exit 1
fi

lines=$(wc -l < "${SKILL_MD}" | tr -d ' ')
if [[ "${lines}" -le "${MAX_SKILL_LINES}" ]]; then
  pass "SKILL.md is ${lines} lines (<= ${MAX_SKILL_LINES})"
else
  fail "SKILL.md is ${lines} lines (> ${MAX_SKILL_LINES}) — move detail into references/"
fi

refs=()
while IFS= read -r r; do
  refs+=("$r")
done < <(find "${SKILL_DIR}/references" -maxdepth 1 -type f -name '*.md' 2>/dev/null | sort)

if [[ ${#refs[@]} -eq 0 ]]; then
  fail "references/ is empty or missing — this skill was rewritten to use progressive disclosure"
else
  for ref in "${refs[@]}"; do
    ref_name="$(basename "${ref}")"
    ref_lines=$(wc -l < "${ref}" | tr -d ' ')
    if [[ "${ref_lines}" -le "${MAX_REFERENCE_LINES}" ]]; then
      pass "references/${ref_name} is ${ref_lines} lines (<= ${MAX_REFERENCE_LINES})"
    else
      fail "references/${ref_name} is ${ref_lines} lines (> ${MAX_REFERENCE_LINES}) — split it"
    fi
    # -F: literal path, not a pattern. /usr/bin/grep: honours .gitignore-free read.
    if /usr/bin/grep -qF "references/${ref_name}" "${SKILL_MD}"; then
      pass "SKILL.md links references/${ref_name}"
    else
      fail "SKILL.md does not link references/${ref_name} — unlinked references are never read"
    fi
  done
fi

# CTL-2231 defect #2: the "Commands" shape this repo no longer has must be gone
# as an active validation section, not merely trimmed. Anchor on HEADINGS
# (`^#+ `) so a sentence that mentions the retired phrase in passing (e.g. this
# skill's own checklist explaining what to delete on sight) doesn't false-fail —
# only a live "## Command Frontmatter" / "### Commands Specifically" section
# would. Concatenate SKILL.md + all references so this holds regardless of
# which file the content ended up in.
ALL_CONTENT="$(cat "${SKILL_MD}" "${SKILL_DIR}"/references/*.md 2>/dev/null)"

if grep -qE '^#+[[:space:]]*(Command Frontmatter|Commands Specifically|Commands:)' <<<"${ALL_CONTENT}"; then
  fail "still validates a 'Commands' shape — this repo has skills only (.claude/rules/plugin-editing.md)"
else
  pass "does not validate a 'Commands' shape"
fi

if grep -qF 'skills only' <<<"${ALL_CONTENT}"; then
  pass "states the skills-only shape rule (points at the retired Commands check)"
else
  fail "does not state the skills-only shape rule"
fi

echo
echo "skill-shape.test.sh: ${PASSES} passed, ${FAILURES} failed"
[[ "${FAILURES}" -eq 0 ]]
