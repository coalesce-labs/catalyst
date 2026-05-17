#!/usr/bin/env bash
# Tests for the morning-briefing CMA Routine wiring (CTL-460).
# Run: bash cma/routines/morning-briefing/__tests__/routine-config.test.sh
#
# Asserts the contract from
# thoughts/shared/plans/2026-05-16-catalyst-phase-agent-architecture.md
# §Initiative 2 Phase 5:
#   1. routine.yaml has the required top-level keys
#   2. agent.yaml's system body includes the full base prompt
#   3. schedule.cron defaults to weekdays 7am
#   4. The prompt references the committed morning-briefing skill
# Plus three structural assertions:
#   5. README.md exists and is non-empty
#   6. The write-back ADR exists with Status + Decision sections
#   7. base-system-prompt.md has the writable-clone §1a block

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
ROUTINE_DIR="${REPO_ROOT}/cma/routines/morning-briefing"
ROUTINE_YAML="${ROUTINE_DIR}/routine.yaml"
AGENT_YAML="${ROUTINE_DIR}/agent.yaml"
BASE_PROMPT="${REPO_ROOT}/cma/agents/base-system-prompt.md"
WRITE_BACK_ADR="${REPO_ROOT}/cma/decisions/2026-05-17-briefing-write-back.md"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [ $# -gt 1 ] && echo "    $2"; }

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
  if grep -qF "Catalyst Pattern Base — System Prompt" <<<"$SYSTEM_BODY" \
     && grep -qF "## 9. Operating principles" <<<"$SYSTEM_BODY"; then
    pass "agent.yaml system body includes base prompt heading + §9"
  else
    fail "agent.yaml system body missing base prompt markers" \
      "expected 'Catalyst Pattern Base — System Prompt' and '## 9. Operating principles'"
  fi
fi

# ---------------------------------------------------------------------------
# Assertion 3: schedule.cron defaults to weekdays 7am
# ---------------------------------------------------------------------------
echo "Assertion 3: schedule.cron default"
if [ -f "$ROUTINE_YAML" ]; then
  CRON=$(read_yaml_field "$ROUTINE_YAML" "data.get('schedule', {}).get('cron', '')")
  CRON_TRIMMED=$(printf '%s' "$CRON" | tr -d '\n')
  if [ "$CRON_TRIMMED" = "0 7 * * 1-5" ]; then
    pass "schedule.cron default is '0 7 * * 1-5' (weekdays 7am)"
  else
    fail "schedule.cron default" "expected '0 7 * * 1-5', got '${CRON_TRIMMED}'"
  fi
fi

# ---------------------------------------------------------------------------
# Assertion 4: prompt references the committed morning-briefing skill
# ---------------------------------------------------------------------------
echo "Assertion 4: prompt references committed skill"
if [ -f "$ROUTINE_YAML" ]; then
  PROMPT=$(read_yaml_field "$ROUTINE_YAML" "data.get('prompt', '')")
  if grep -qF "plugins/dev/skills/morning-briefing/SKILL.md" <<<"$PROMPT"; then
    pass "prompt references plugins/dev/skills/morning-briefing/SKILL.md"
  else
    fail "prompt missing skill reference" \
      "expected 'plugins/dev/skills/morning-briefing/SKILL.md' substring"
  fi
fi

# ---------------------------------------------------------------------------
# Assertion 5: README.md exists and is non-empty
# ---------------------------------------------------------------------------
echo "Assertion 5: README.md exists"
if [ -s "${ROUTINE_DIR}/README.md" ]; then
  pass "README.md exists and is non-empty"
else
  fail "README.md missing or empty" "expected at ${ROUTINE_DIR}/README.md"
fi

# ---------------------------------------------------------------------------
# Assertion 6: write-back ADR exists with Status + Decision sections
# ---------------------------------------------------------------------------
echo "Assertion 6: write-back ADR shape"
if [ ! -f "$WRITE_BACK_ADR" ]; then
  fail "write-back ADR exists" "expected at ${WRITE_BACK_ADR}"
else
  HAS_STATUS=$(grep -c '^[*-] \*\*Status:\*\*\|^## Status' "$WRITE_BACK_ADR" 2>/dev/null || echo 0)
  HAS_DECISION=$(grep -c '^## Decision' "$WRITE_BACK_ADR" 2>/dev/null || echo 0)
  if [ "${HAS_STATUS:-0}" -gt 0 ] && [ "${HAS_DECISION:-0}" -gt 0 ]; then
    pass "write-back ADR has Status and Decision sections"
  else
    fail "write-back ADR missing sections" \
      "Status count=${HAS_STATUS}, Decision count=${HAS_DECISION}"
  fi
fi

# ---------------------------------------------------------------------------
# Assertion 7: base-system-prompt.md has the writable-clone §1a block
# ---------------------------------------------------------------------------
echo "Assertion 7: base prompt §1a writable-clone block"
if [ ! -f "$BASE_PROMPT" ]; then
  fail "base-system-prompt.md exists"
elif grep -qF '## 1a. Optional writable thoughts clone' "$BASE_PROMPT"; then
  pass "base-system-prompt.md includes §1a writable-clone block"
else
  fail "base-system-prompt.md missing §1a" \
    "expected '## 1a. Optional writable thoughts clone' heading"
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
