#!/usr/bin/env bash
# skill-shape.test.sh — CTL-1993: the progressive-disclosure shape gate.
#
# WHY: before this, every catalyst-dev skill was a single monolithic SKILL.md —
# 52 of them, up to 2,610 lines. The role skills (steward, concierge) and the
# slimmed phase skills carry their detail in `references/*.md` read on demand
# instead. That shape only survives if something enforces it: a budget nobody
# checks is a budget that drifts back (the same way the agent house-rules block
# drifted in BOTH repos while a tested, idempotent seeder sat unused).
#
# Applies to every skill dir that HAS a references/ dir — so it gates the skills
# that opted into progressive disclosure, and stays silent about the ones that
# have not been converted yet.
#
# Run: bash plugins/dev/skills/__tests__/skill-shape.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

MAX_SKILL_LINES=80
MAX_REFERENCE_LINES=150

PASSES=0; FAILURES=0
pass() { echo "  PASS: $1"; PASSES=$((PASSES + 1)); }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

# Collect the skills that have opted into progressive disclosure.
# `find` (not a glob) so an empty result is empty rather than a literal pattern.
SKILLS=()
while IFS= read -r d; do
  SKILLS+=("$d")
done < <(find "${SKILLS_DIR}" -mindepth 2 -maxdepth 2 -type d -name references | sed 's|/references$||' | sort)

echo "skill-shape: ${#SKILLS[@]} skill(s) with a references/ dir"

# A zero-length input set would let every loop below pass vacuously and print a
# green summary on the strength of no iterations. Fail loudly instead.
if [[ ${#SKILLS[@]} -eq 0 ]]; then
  fail "no skill with a references/ dir was found — the gate would pass vacuously (expected at least steward)"
  echo "skill-shape.test.sh: ${PASSES} passed, ${FAILURES} failed"
  exit 1
fi

for skill_dir in "${SKILLS[@]}"; do
  name="$(basename "${skill_dir}")"
  skill_md="${skill_dir}/SKILL.md"

  echo "── ${name}"

  # 1. SKILL.md exists and fits the budget.
  if [[ ! -f "${skill_md}" ]]; then
    fail "${name}: references/ exists but SKILL.md does not"
    continue
  fi
  lines=$(wc -l < "${skill_md}" | tr -d ' ')
  if [[ "${lines}" -le "${MAX_SKILL_LINES}" ]]; then
    pass "${name}/SKILL.md is ${lines} lines (<= ${MAX_SKILL_LINES})"
  else
    fail "${name}/SKILL.md is ${lines} lines (> ${MAX_SKILL_LINES}) — move detail into references/"
  fi

  # 2. Every reference fits its budget, and is LINKED from SKILL.md.
  #    An unlinked reference is unreachable: nothing tells the agent to read it.
  refs=()
  while IFS= read -r r; do
    refs+=("$r")
  done < <(find "${skill_dir}/references" -maxdepth 1 -type f -name '*.md' | sort)

  if [[ ${#refs[@]} -eq 0 ]]; then
    fail "${name}: references/ is empty"
    continue
  fi

  for ref in "${refs[@]}"; do
    ref_name="$(basename "${ref}")"
    ref_lines=$(wc -l < "${ref}" | tr -d ' ')
    if [[ "${ref_lines}" -le "${MAX_REFERENCE_LINES}" ]]; then
      pass "${name}/references/${ref_name} is ${ref_lines} lines (<= ${MAX_REFERENCE_LINES})"
    else
      fail "${name}/references/${ref_name} is ${ref_lines} lines (> ${MAX_REFERENCE_LINES}) — split it"
    fi

    # -F: the needle is a literal path, not a pattern. /usr/bin/grep: the agent
    # shell's `grep` honours .gitignore and can skip files it never reports.
    if /usr/bin/grep -qF "references/${ref_name}" "${skill_md}"; then
      pass "${name}/SKILL.md links references/${ref_name}"
    else
      fail "${name}/SKILL.md does not link references/${ref_name} — unlinked references are never read"
    fi
  done
done

# 3. No skill may be named `worker` (CTL-1997): `worker` is live execution-core
#    machinery vocabulary (worker-dir-gc, sdk-worker-registry, worker-label,
#    worker-transition-event, workers/<ticket>/ …). The ROLE word stays; the
#    skill name would read as "the worker machinery skill".
echo "── naming"
if [[ -d "${SKILLS_DIR}/worker" ]]; then
  fail "a skill named 'worker' exists — use phase-agent-contract (CTL-1997)"
else
  pass "no skill is named 'worker'"
fi

echo
echo "skill-shape.test.sh: ${PASSES} passed, ${FAILURES} failed"
[[ "${FAILURES}" -eq 0 ]]
