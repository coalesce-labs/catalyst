#!/usr/bin/env bash
# Tests for the phase-research skill (CTL-450 Initiative 1 Phase 4).
#
# These are contract/E2E tests that verify the skill's SKILL.md adheres to the
# phase-agent template (CTL-448) and that dispatching it via phase-agent-dispatch
# does the right plumbing (claude is stubbed). We can't actually execute the
# skill body in bash — the body is LLM prose — so we verify:
#   - SKILL.md exists with the right frontmatter
#   - The body declares the prelude env-var contract
#   - The body invokes /catalyst-dev:research-codebase (not a reimplementation)
#   - The body calls phase-agent-emit-complete with --phase research
#   - The body references the expected artifact path
#     (thoughts/shared/research/*-<ticket>.md)
#   - Dispatching with --phase research --ticket <T> spawns claude --bg with the
#     right prompt + env when triage.json exists
#   - Dispatching refuses when triage.json is missing
#
# Run: bash plugins/dev/scripts/__tests__/phase-research-e2e.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL="${REPO_ROOT}/plugins/dev/skills/phase-research/SKILL.md"
DISPATCH="${REPO_ROOT}/plugins/dev/scripts/phase-agent-dispatch"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t phase-research-e2e-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  [[ "$expected" == "$actual" ]] && pass "$label" || fail "$label — expected '$expected', got '$actual'"
}
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  [[ "$haystack" == *"$needle"* ]] && pass "$label" || fail "$label — '$needle' not found"
}
assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  [[ "$haystack" != *"$needle"* ]] && pass "$label" || fail "$label — '$needle' unexpectedly present"
}
assert_file_exists() {
  [[ -f "$1" ]] && pass "$2" || fail "$2 — file missing: $1"
}

# ─── Contract: SKILL.md frontmatter + body ─────────────────────────────────
echo "Test 1: phase-research SKILL.md contract"
assert_file_exists "$SKILL" "SKILL.md exists at plugins/dev/skills/phase-research/SKILL.md"

if [[ -f "$SKILL" ]]; then
  BODY=$(cat "$SKILL")
  # Frontmatter
  assert_contains "$BODY" "name: phase-research" "frontmatter declares name: phase-research"
  # CTL-490: phase skills are dispatched via `claude --bg "/catalyst-dev:phase-X ..."`,
  # which the bg session parses as a user slash command. user-invocable MUST be true
  # for the dispatch to resolve.
  assert_contains "$BODY" "user-invocable: true" "frontmatter sets user-invocable: true (CTL-490)"
  assert_contains "$BODY" "Task" "allowed-tools includes Task (for invoking research-codebase)"
  assert_contains "$BODY" "Bash" "allowed-tools includes Bash"

  # Prelude contract — must declare all four env vars from the template
  assert_contains "$BODY" "CATALYST_ORCHESTRATOR_DIR" "prelude reads CATALYST_ORCHESTRATOR_DIR"
  assert_contains "$BODY" "CATALYST_ORCHESTRATOR_ID"  "prelude reads CATALYST_ORCHESTRATOR_ID"
  assert_contains "$BODY" "CATALYST_PHASE"            "prelude reads CATALYST_PHASE"
  assert_contains "$BODY" "CATALYST_TICKET"           "prelude reads CATALYST_TICKET"

  # Prior-phase artifact gate: triage.json
  assert_contains "$BODY" "triage.json" "body references prior triage.json artifact"

  # Body delegates to canonical research-codebase skill
  assert_contains "$BODY" "/catalyst-dev:research-codebase" "body invokes /catalyst-dev:research-codebase"

  # Output artifact path
  assert_contains "$BODY" "thoughts/shared/research/" "body writes to thoughts/shared/research/"

  # Terminal emitter
  assert_contains "$BODY" "phase-agent-emit-complete" "body calls phase-agent-emit-complete"
  assert_contains "$BODY" '--status complete' "body emits --status complete on success"
  assert_contains "$BODY" '--status failed' "body emits --status failed on error path"

  # CTL-558: Linear status write-back moved to the deterministic coordinator —
  # the phase agent no longer carries the linear-transition prose.
  assert_not_contains "$BODY" "--transition researching" "body does NOT self-transition Linear (coordinator owns it, CTL-558)"

  # /goal block (turn cap)
  assert_contains "$BODY" "/goal" "body declares a /goal block"
fi

# ─── E2E: dispatcher launches phase-research when triage.json exists ───────
echo ""
echo "Test 2: phase-agent-dispatch --phase research succeeds with triage.json present"

TEST_DIR="${SCRATCH}/t2"
STUB_DIR="${TEST_DIR}/bin"
ORCH_DIR="${TEST_DIR}/orch"
WORKER_DIR="${ORCH_DIR}/workers/CTL-450"
mkdir -p "$STUB_DIR" "$WORKER_DIR"

cat > "$STUB_DIR/claude" <<'STUB'
#!/usr/bin/env bash
# CTL-490: stub mimics today's real `claude --bg` stdout shape so the
# dispatcher's hex-grep parser finds the job ID. Hex token 'a1b2c3d4'.
LOG="${CLAUDE_STUB_LOG:-/tmp/claude-stub.log}"
{
  echo "--ARGS--"
  printf '%s\n' "$@"
  echo "--ENV--"
  env | grep -E '^CATALYST_(ORCHESTRATOR_(DIR|ID)|PHASE|TICKET)=' | sort
  echo "--END--"
} > "$LOG"
cat <<EOF
backgrounded · a1b2c3d4
  claude agents             list sessions
  claude attach a1b2c3d4    open in this terminal
EOF
STUB
chmod +x "$STUB_DIR/claude"

export CLAUDE_STUB_LOG="${TEST_DIR}/claude.log"
export PATH="${STUB_DIR}:${PATH}"

# Place a triage.json so the dispatcher's prior-artifact gate passes.
echo '{"ticket":"CTL-450","status":"done","classification":"feature"}' > "${WORKER_DIR}/triage.json"

OUT=$("$DISPATCH" --phase research --ticket CTL-450 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
RC=$?
assert_eq "0" "$RC" "dispatch exit code 0"
SIGNAL="${WORKER_DIR}/phase-research.json"
assert_file_exists "$SIGNAL" "signal file phase-research.json written"

if [[ -f "$SIGNAL" ]]; then
  STATUS=$(jq -r '.status' "$SIGNAL")
  PHASE=$(jq -r '.phase' "$SIGNAL")
  JOB=$(jq -r '.bg_job_id' "$SIGNAL")
  assert_eq "running" "$STATUS" "signal.status = running after spawn"
  assert_eq "research" "$PHASE" "signal.phase = research"
  assert_eq "a1b2c3d4" "$JOB" "signal.bg_job_id = hex from stub (CTL-490)"
fi

LOG=$(cat "$CLAUDE_STUB_LOG" 2>/dev/null || echo "")
assert_contains "$LOG" "/catalyst-dev:phase-research CTL-450" "claude invoked with phase-research skill prompt"
assert_contains "$LOG" "CATALYST_PHASE=research" "env carries CATALYST_PHASE=research"
assert_contains "$LOG" "CATALYST_TICKET=CTL-450" "env carries CATALYST_TICKET=CTL-450"

# ─── E2E: dispatcher refuses when triage.json is missing ───────────────────
echo ""
echo "Test 3: phase-agent-dispatch refuses phase-research without triage.json"

TEST_DIR="${SCRATCH}/t3"
ORCH_DIR="${TEST_DIR}/orch"
WORKER_DIR="${ORCH_DIR}/workers/CTL-450"
mkdir -p "$WORKER_DIR"

OUT=$("$DISPATCH" --phase research --ticket CTL-450 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
RC=$?
REFUSED=$(echo "$OUT" | jq -r '.status' 2>/dev/null || echo "")
assert_eq "2" "$RC" "exit code 2 when triage.json missing"
assert_eq "refused" "$REFUSED" "stdout status = refused"
SIGNAL_EXISTS="no"
[[ -f "${WORKER_DIR}/phase-research.json" ]] && SIGNAL_EXISTS="yes"
assert_eq "no" "$SIGNAL_EXISTS" "no signal file written on refusal"

echo ""
echo "─────────────────────────────────────────────"
echo "phase-research-e2e: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
  exit 1
fi
exit 0
