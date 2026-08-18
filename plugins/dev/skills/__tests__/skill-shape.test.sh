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

# ⚠️ THESE TWO NUMBERS ARE A PROXY, AND THE PROXY IS GAMEABLE. The property we
# actually want is "SKILL.md alone is sufficient for the common path, and detail
# is one hop away" — and NO line count can assert that. A skill can satisfy both
# budgets with longer lines and denser prose and be strictly worse to read.
#
# They are kept because a forcing function that is checkable beats an intent that
# is not: 80 lines is roughly the point at which an author stops appending and
# starts asking what belongs in references/. That editorial pressure is the
# product; the number is only how it is applied.
#
# So if you are here to raise one of these: raising it is not automatically
# wrong, but it IS the wrong first move. Defend the intent, not the number —
# move the detail into references/ first, and change the budget only if the
# common path genuinely does not fit. (FLEET peer read, CTL-1993.)
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

# 3. RESERVED SKILL NAMES (CTL-1997). A skill name that collides with live
#    machinery vocabulary reads as "the <machinery> skill" and mis-routes both
#    agents and greps. This is a LIST, not a single hardcoded name, because the
#    first version of this check tested exactly one name and therefore offered
#    the next collision no protection at all — someone would have re-litigated
#    it from scratch without this reasoning (FLEET peer read, CTL-1993).
#
#    TO ADD AN ENTRY: one line, and a comment saying WHAT it collides with. The
#    reason is the load-bearing half — it is what lets a future reader tell a
#    real collision from a name someone merely disliked.
#
#    ⚠️ Only reserve a name NOTHING is currently called: `broker`, `teardown`
#    and `linear` are all live machinery words that are ALSO existing skills,
#    so reserving them would go red on arrival and the fix would be to delete
#    the entry, not to rename 50 call sites.
RESERVED_SKILL_NAMES=(
  # execution-core machinery: worker-dir-gc, sdk-worker-registry, worker-label,
  # worker-transition-event, abort-worker, workers/<ticket>/,
  # worker.session.started. The ROLE word stays — role and code agree; it is the
  # SKILL name that collides. Use phase-agent-contract.
  "worker"
)

echo "── naming"
# An empty list would make this whole section pass vacuously, exactly like the
# zero-skills case guarded above.
if [[ ${#RESERVED_SKILL_NAMES[@]} -eq 0 ]]; then
  fail "RESERVED_SKILL_NAMES is empty — the naming check would pass vacuously"
fi
for reserved in "${RESERVED_SKILL_NAMES[@]}"; do
  if [[ -d "${SKILLS_DIR}/${reserved}" ]]; then
    fail "a skill named '${reserved}' exists — it is a RESERVED name (see RESERVED_SKILL_NAMES for what it collides with, CTL-1997)"
  else
    pass "no skill is named '${reserved}' (reserved)"
  fi
done

echo
echo "skill-shape.test.sh: ${PASSES} passed, ${FAILURES} failed"
[[ "${FAILURES}" -eq 0 ]]
