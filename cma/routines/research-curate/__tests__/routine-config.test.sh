#!/usr/bin/env bash
# Tests for the research-curate CMA Routine wiring (CTL-469).
# Run: bash cma/routines/research-curate/__tests__/routine-config.test.sh
#
# Asserts the contract from
# thoughts/shared/plans/2026-05-16-catalyst-phase-agent-architecture.md
# §Initiative 4 Phase 3:
#   1. routine.yaml has the required top-level keys
#   2. agent.yaml's system body includes the full base prompt
#   3. schedule.cron defaults to Sunday 9pm (0 21 * * 0)
#   4. The prompt references the committed research-curate skill
#   5. routine.yaml's env.THOUGHTS_WRITABLE_BRANCH equals routines/curation
# Plus two structural assertions mirroring morning-briefing:
#   6. README.md exists and is non-empty
#   7. The write-back ADR mentions research-curate + routines/curation
#      (i.e. the ADR was updated to cover both Routines)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
ROUTINE_DIR="${REPO_ROOT}/cma/routines/research-curate"
ROUTINE_YAML="${ROUTINE_DIR}/routine.yaml"
AGENT_YAML="${ROUTINE_DIR}/agent.yaml"
BASE_PROMPT="${REPO_ROOT}/cma/agents/base-system-prompt.md"
WRITE_BACK_ADR="${REPO_ROOT}/cma/decisions/2026-05-17-briefing-write-back.md"

FAILURES=0
PASSES=0

pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	[ $# -gt 1 ] && echo "    $2"
}

read_yaml_field() {
	# Args: <yaml-file> <python-expression-on-`data`>
	# Returns the field as a string. Empty string if missing or null.
	python3 -c "
import sys, yaml
with open(sys.argv[1]) as f:
    data = yaml.safe_load(f) or {}
val = $2
if val is None:
    print('')
elif isinstance(val, (dict, list)):
    print(yaml.safe_dump(val))
else:
    print(val)
" "$1"
}

# ---------------------------------------------------------------------------
# Assertion 1: routine.yaml has the required top-level keys
# ---------------------------------------------------------------------------
echo "Assertion 1: routine.yaml schema"
if [ ! -f "$ROUTINE_YAML" ]; then
	fail "routine.yaml exists" "expected at ${ROUTINE_YAML}"
else
	MISSING_KEYS=$(python3 -c "
import sys, yaml
with open(sys.argv[1]) as f:
    data = yaml.safe_load(f) or {}
required = ['name', 'agent', 'schedule', 'repositories', 'prompt']
missing = [k for k in required if k not in data]
print(','.join(missing))
" "$ROUTINE_YAML")
	if [ -z "$MISSING_KEYS" ]; then
		pass "routine.yaml has required top-level keys (name, agent, schedule, repositories, prompt)"
	else
		fail "routine.yaml missing keys" "missing: ${MISSING_KEYS}"
	fi
fi

# ---------------------------------------------------------------------------
# Assertion 2: agent.yaml's system body includes the full base prompt
# ---------------------------------------------------------------------------
echo "Assertion 2: agent.yaml extends base system prompt"
if [ ! -f "$AGENT_YAML" ]; then
	fail "agent.yaml exists" "expected at ${AGENT_YAML}"
elif [ ! -f "$BASE_PROMPT" ]; then
	fail "base-system-prompt.md exists" "expected at ${BASE_PROMPT}"
else
	SYSTEM_BODY=$(read_yaml_field "$AGENT_YAML" "data.get('system', '')")
	# The base prompt's H1 and §9 heading are stable markers — both must appear.
	if grep -qF "Catalyst Pattern Base — System Prompt" <<<"$SYSTEM_BODY" &&
		grep -qF "## 9. Operating principles" <<<"$SYSTEM_BODY"; then
		pass "agent.yaml system body includes base prompt heading + §9"
	else
		fail "agent.yaml system body missing base prompt markers" \
			"expected 'Catalyst Pattern Base — System Prompt' and '## 9. Operating principles'"
	fi
fi

# ---------------------------------------------------------------------------
# Assertion 3: schedule.cron defaults to Sunday 9pm (0 21 * * 0)
# ---------------------------------------------------------------------------
echo "Assertion 3: schedule.cron default"
if [ -f "$ROUTINE_YAML" ]; then
	CRON=$(read_yaml_field "$ROUTINE_YAML" "data.get('schedule', {}).get('cron', '')")
	CRON_TRIMMED=$(printf '%s' "$CRON" | tr -d '\n')
	if [ "$CRON_TRIMMED" = "0 21 * * 0" ]; then
		pass "schedule.cron default is '0 21 * * 0' (Sunday 9pm)"
	else
		fail "schedule.cron default" "expected '0 21 * * 0', got '${CRON_TRIMMED}'"
	fi
fi

# ---------------------------------------------------------------------------
# Assertion 4: prompt references the committed research-curate skill
# ---------------------------------------------------------------------------
echo "Assertion 4: prompt references committed skill"
if [ -f "$ROUTINE_YAML" ]; then
	PROMPT=$(read_yaml_field "$ROUTINE_YAML" "data.get('prompt', '')")
	if grep -qF "plugins/dev/skills/research-curate/SKILL.md" <<<"$PROMPT"; then
		pass "prompt references plugins/dev/skills/research-curate/SKILL.md"
	else
		fail "prompt missing skill reference" \
			"expected 'plugins/dev/skills/research-curate/SKILL.md' substring"
	fi
fi

# ---------------------------------------------------------------------------
# Assertion 5: env.THOUGHTS_WRITABLE_BRANCH = routines/curation
# ---------------------------------------------------------------------------
echo "Assertion 5: write-back branch is routines/curation"
if [ -f "$ROUTINE_YAML" ]; then
	BRANCH=$(read_yaml_field "$ROUTINE_YAML" "data.get('env', {}).get('THOUGHTS_WRITABLE_BRANCH', '')")
	BRANCH_TRIMMED=$(printf '%s' "$BRANCH" | tr -d '\n')
	if [ "$BRANCH_TRIMMED" = "routines/curation" ]; then
		pass "env.THOUGHTS_WRITABLE_BRANCH = 'routines/curation'"
	else
		fail "env.THOUGHTS_WRITABLE_BRANCH" "expected 'routines/curation', got '${BRANCH_TRIMMED}'"
	fi
fi

# ---------------------------------------------------------------------------
# Assertion 6: README.md exists and is non-empty
# ---------------------------------------------------------------------------
echo "Assertion 6: README.md exists"
if [ -s "${ROUTINE_DIR}/README.md" ]; then
	pass "README.md exists and is non-empty"
else
	fail "README.md missing or empty" "expected at ${ROUTINE_DIR}/README.md"
fi

# ---------------------------------------------------------------------------
# Assertion 7: write-back ADR mentions research-curate + routines/curation
# (proves the ADR was updated to cover both Routines)
# ---------------------------------------------------------------------------
echo "Assertion 7: write-back ADR covers research-curate"
if [ ! -f "$WRITE_BACK_ADR" ]; then
	fail "write-back ADR exists" "expected at ${WRITE_BACK_ADR}"
else
	HAS_NAME=$(grep -c 'research-curate' "$WRITE_BACK_ADR" 2>/dev/null || echo 0)
	HAS_BRANCH=$(grep -c 'routines/curation' "$WRITE_BACK_ADR" 2>/dev/null || echo 0)
	if [ "${HAS_NAME:-0}" -gt 0 ] && [ "${HAS_BRANCH:-0}" -gt 0 ]; then
		pass "write-back ADR mentions research-curate and routines/curation"
	else
		fail "write-back ADR missing research-curate coverage" \
			"research-curate count=${HAS_NAME}, routines/curation count=${HAS_BRANCH}"
	fi
fi

# ---------------------------------------------------------------------------
echo
echo "------------------------------------------------------------"
echo "  Passed: ${PASSES}"
echo "  Failed: ${FAILURES}"
echo "------------------------------------------------------------"

if [ "$FAILURES" -gt 0 ]; then
	exit 1
fi
exit 0
