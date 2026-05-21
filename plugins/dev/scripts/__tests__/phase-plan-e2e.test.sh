#!/usr/bin/env bash
# Tests for the phase-plan skill (CTL-450 Initiative 1 Phase 4).
#
# Approach mirrors phase-research-e2e: contract checks on SKILL.md plus an
# integration check against phase-agent-dispatch with claude stubbed. The
# prior-phase artifact for plan is the research document at
# thoughts/shared/research/*-<ticket>.md.
#
# Run: bash plugins/dev/scripts/__tests__/phase-plan-e2e.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL="${REPO_ROOT}/plugins/dev/skills/phase-plan/SKILL.md"
DISPATCH="${REPO_ROOT}/plugins/dev/scripts/phase-agent-dispatch"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t phase-plan-e2e-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

assert_eq() { [[ "$1" == "$2" ]] && pass "$3" || fail "$3 — expected '$1', got '$2'"; }
assert_contains() { [[ "$1" == *"$2"* ]] && pass "$3" || fail "$3 — '$2' not found"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] && pass "$3" || fail "$3 — '$2' unexpectedly present"; }
assert_file_exists() { [[ -f "$1" ]] && pass "$2" || fail "$2 — file missing: $1"; }

# ─── Contract ───────────────────────────────────────────────────────────────
echo "Test 1: phase-plan SKILL.md contract"
assert_file_exists "$SKILL" "SKILL.md exists at plugins/dev/skills/phase-plan/SKILL.md"

if [[ -f "$SKILL" ]]; then
  BODY=$(cat "$SKILL")
  assert_contains "$BODY" "name: phase-plan" "frontmatter declares name: phase-plan"
  # CTL-490: phase skills are dispatched via `claude --bg "/catalyst-dev:phase-X ..."`,
  # which the bg session parses as a user slash command. user-invocable MUST be true.
  assert_contains "$BODY" "user-invocable: true" "frontmatter sets user-invocable: true (CTL-490)"
  assert_contains "$BODY" "disable-model-invocation: false" "frontmatter sets disable-model-invocation: false — invocable by model + user"
  assert_contains "$BODY" "CATALYST_ORCHESTRATOR_DIR" "prelude reads CATALYST_ORCHESTRATOR_DIR"
  assert_contains "$BODY" "CATALYST_TICKET" "prelude reads CATALYST_TICKET"

  # Prior artifact: the research doc
  assert_contains "$BODY" "thoughts/shared/research/" "body references prior research document"

  # Delegates to canonical create-plan
  assert_contains "$BODY" "/catalyst-dev:create-plan" "body invokes /catalyst-dev:create-plan"

  # Output artifact: plan document
  assert_contains "$BODY" "thoughts/shared/plans/" "body writes to thoughts/shared/plans/"

  assert_contains "$BODY" "phase-agent-emit-complete" "body calls phase-agent-emit-complete"
  assert_contains "$BODY" '--status complete' "body emits --status complete on success"
  assert_contains "$BODY" '--status failed' "body emits --status failed on error path"

  # CTL-558: Linear status write-back moved to the deterministic coordinator —
  # the phase agent no longer carries the linear-transition prose.
  assert_not_contains "$BODY" "--transition planning" "body does NOT self-transition Linear (coordinator owns it, CTL-558)"

  assert_contains "$BODY" "/goal" "body declares a /goal block"
fi

# ─── E2E: dispatcher launches phase-plan when research doc present ─────────
echo ""
echo "Test 2: phase-agent-dispatch --phase plan succeeds with research doc present"

TEST_DIR="${SCRATCH}/t2"
STUB_DIR="${TEST_DIR}/bin"
PROJ_DIR="${TEST_DIR}/proj"
ORCH_DIR="${PROJ_DIR}/orch"
WORKER_DIR="${ORCH_DIR}/workers/CTL-450"
RESEARCH_DIR="${PROJ_DIR}/thoughts/shared/research"
mkdir -p "$STUB_DIR" "$WORKER_DIR" "$RESEARCH_DIR"

cat > "$STUB_DIR/claude" <<'STUB'
#!/usr/bin/env bash
# CTL-490: stub mimics today's real `claude --bg` stdout shape so the
# dispatcher's hex-grep parser finds the job ID. Job ID is the 8-char hex
# 'b2c4d6e8' — embedded in the realistic "backgrounded · <hex>" line.
LOG="${CLAUDE_STUB_LOG:-/tmp/claude-stub.log}"
{
  echo "--ARGS--"; printf '%s\n' "$@"
  echo "--ENV--"; env | grep -E '^CATALYST_(ORCHESTRATOR_(DIR|ID)|PHASE|TICKET)=' | sort
  echo "--END--"
} > "$LOG"
cat <<EOF
backgrounded · b2c4d6e8
  claude agents             list sessions
  claude attach b2c4d6e8    open in this terminal
EOF
STUB
chmod +x "$STUB_DIR/claude"

export CLAUDE_STUB_LOG="${TEST_DIR}/claude.log"
export PATH="${STUB_DIR}:${PATH}"

# Plan's prior-artifact gate is a glob: thoughts/shared/research/*-<ticket-lower>.md
# The dispatcher cd's into its caller's cwd to resolve the glob, so we cd into proj.
touch "${RESEARCH_DIR}/2026-05-17-ctl-450.md"

OUT=$(cd "$PROJ_DIR" && "$DISPATCH" --phase plan --ticket CTL-450 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
RC=$?
assert_eq "0" "$RC" "dispatch exit code 0"
SIGNAL="${WORKER_DIR}/phase-plan.json"
assert_file_exists "$SIGNAL" "signal file phase-plan.json written"

if [[ -f "$SIGNAL" ]]; then
  assert_eq "running" "$(jq -r '.status' "$SIGNAL")" "signal.status = running"
  assert_eq "plan" "$(jq -r '.phase' "$SIGNAL")" "signal.phase = plan"
  assert_eq "b2c4d6e8" "$(jq -r '.bg_job_id' "$SIGNAL")" "signal.bg_job_id matches hex from stub (CTL-490)"
fi

LOG=$(cat "$CLAUDE_STUB_LOG" 2>/dev/null || echo "")
assert_contains "$LOG" "/catalyst-dev:phase-plan CTL-450" "claude invoked with phase-plan skill prompt"
assert_contains "$LOG" "CATALYST_PHASE=plan" "env carries CATALYST_PHASE=plan"

# ─── E2E: dispatcher refuses when research doc is missing ──────────────────
echo ""
echo "Test 3: phase-agent-dispatch refuses phase-plan without research doc"

TEST_DIR="${SCRATCH}/t3"
PROJ_DIR="${TEST_DIR}/proj"
ORCH_DIR="${PROJ_DIR}/orch"
WORKER_DIR="${ORCH_DIR}/workers/CTL-450"
mkdir -p "$WORKER_DIR" "${PROJ_DIR}/thoughts/shared/research"
# Note: no research doc placed for CTL-450

OUT=$(cd "$PROJ_DIR" && "$DISPATCH" --phase plan --ticket CTL-450 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
RC=$?
REFUSED=$(echo "$OUT" | jq -r '.status' 2>/dev/null || echo "")
assert_eq "2" "$RC" "exit code 2 when research doc missing"
assert_eq "refused" "$REFUSED" "stdout status = refused"

echo ""
echo "─────────────────────────────────────────────"
echo "phase-plan-e2e: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -gt 0 ]] && exit 1
exit 0
