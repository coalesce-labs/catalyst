#!/usr/bin/env bash
# Tests for the phase-verify skill (CTL-450 Initiative 1 Phase 4).
#
# phase-verify is the only NEW skill in Phase 4 (the others wrap canonical skills).
# It is read-only against application code — it produces a verify.json artifact
# and may only create test files, never application code.
#
# These tests verify:
#   - SKILL.md exists with the right frontmatter + read-only constraint
#   - The body declares the prelude env-var contract
#   - The body reads phase-implement.json as its prior artifact
#   - The body documents the regression_risk / findings / tests_attempted schema
#   - The body explicitly states it does NOT write application code
#   - The body calls phase-agent-emit-complete with --phase verify
#   - Dispatching with --phase verify succeeds when phase-implement.json exists
#   - Dispatching refuses when phase-implement.json is missing
#
# Run: bash plugins/dev/scripts/__tests__/phase-verify-e2e.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL="${REPO_ROOT}/plugins/dev/skills/phase-verify/SKILL.md"
DISPATCH="${REPO_ROOT}/plugins/dev/scripts/phase-agent-dispatch"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t phase-verify-e2e-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

assert_eq() { [[ "$1" == "$2" ]] && pass "$3" || fail "$3 — expected '$1', got '$2'"; }
assert_contains() { [[ "$1" == *"$2"* ]] && pass "$3" || fail "$3 — '$2' not found"; }
assert_file_exists() { [[ -f "$1" ]] && pass "$2" || fail "$2 — file missing: $1"; }

# ─── Contract ───────────────────────────────────────────────────────────────
echo "Test 1: phase-verify SKILL.md contract"
assert_file_exists "$SKILL" "SKILL.md exists at plugins/dev/skills/phase-verify/SKILL.md"

if [[ -f "$SKILL" ]]; then
  BODY=$(cat "$SKILL")
  assert_contains "$BODY" "name: phase-verify" "frontmatter declares name: phase-verify"
  assert_contains "$BODY" "user-invocable: false" "frontmatter sets user-invocable: false"

  # Prelude
  assert_contains "$BODY" "CATALYST_ORCHESTRATOR_DIR" "prelude reads CATALYST_ORCHESTRATOR_DIR"
  assert_contains "$BODY" "CATALYST_TICKET" "prelude reads CATALYST_TICKET"

  # CRITICAL: read-only constraint must be loud
  assert_contains "$BODY" "NEVER write application code" \
    "body declares 'NEVER write application code' constraint"

  # Prior artifact: phase-implement.json
  assert_contains "$BODY" "phase-implement.json" "body reads phase-implement.json as prior artifact"

  # Output artifact: verify.json
  assert_contains "$BODY" "verify.json" "body writes verify.json artifact"

  # Required schema fields
  assert_contains "$BODY" "regression_risk" "verify.json schema includes regression_risk"
  assert_contains "$BODY" "findings"        "verify.json schema includes findings"
  assert_contains "$BODY" "tests_attempted" "verify.json schema includes tests_attempted"

  # Gates referenced
  assert_contains "$BODY" "validate-type-safety"  "body references validate-type-safety gate"
  assert_contains "$BODY" "scan-reward-hacking"   "body references scan-reward-hacking gate"
  assert_contains "$BODY" "code-reviewer"         "body references code-reviewer agent"
  assert_contains "$BODY" "pr-test-analyzer"      "body references pr-test-analyzer agent"
  assert_contains "$BODY" "silent-failure-hunter" "body references silent-failure-hunter agent"

  assert_contains "$BODY" "phase-agent-emit-complete" "body calls phase-agent-emit-complete"
  assert_contains "$BODY" '--status complete' "body emits --status complete on success"

  # Linear intermediate state — verifying (CTL-454)
  assert_contains "$BODY" "verifying" "body transitions Linear ticket to verifying state"

  assert_contains "$BODY" "/goal" "body declares a /goal block"
fi

# ─── E2E: dispatcher launches phase-verify when phase-implement.json exists ─
echo ""
echo "Test 2: phase-agent-dispatch --phase verify succeeds with phase-implement.json present"

TEST_DIR="${SCRATCH}/t2"
STUB_DIR="${TEST_DIR}/bin"
ORCH_DIR="${TEST_DIR}/orch"
WORKER_DIR="${ORCH_DIR}/workers/CTL-450"
mkdir -p "$STUB_DIR" "$WORKER_DIR"

cat > "$STUB_DIR/claude" <<'STUB'
#!/usr/bin/env bash
LOG="${CLAUDE_STUB_LOG:-/tmp/claude-stub.log}"
{
  echo "--ARGS--"; printf '%s\n' "$@"
  echo "--ENV--"; env | grep -E '^CATALYST_(ORCHESTRATOR_(DIR|ID)|PHASE|TICKET)=' | sort
  echo "--END--"
} > "$LOG"
echo "job-verify-003"
STUB
chmod +x "$STUB_DIR/claude"

export CLAUDE_STUB_LOG="${TEST_DIR}/claude.log"
export PATH="${STUB_DIR}:${PATH}"

echo '{"ticket":"CTL-450","phase":"implement","status":"done"}' > "${WORKER_DIR}/phase-implement.json"

OUT=$("$DISPATCH" --phase verify --ticket CTL-450 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
RC=$?
assert_eq "0" "$RC" "dispatch exit code 0"
SIGNAL="${WORKER_DIR}/phase-verify.json"
assert_file_exists "$SIGNAL" "signal file phase-verify.json written"

if [[ -f "$SIGNAL" ]]; then
  assert_eq "running" "$(jq -r '.status' "$SIGNAL")" "signal.status = running"
  assert_eq "verify" "$(jq -r '.phase' "$SIGNAL")" "signal.phase = verify"
  assert_eq "20" "$(jq -r '.turnCap' "$SIGNAL")" "signal.turnCap defaults to 20 (verify)"
  assert_eq "job-verify-003" "$(jq -r '.bg_job_id' "$SIGNAL")" "signal.bg_job_id matches stub"
fi

LOG=$(cat "$CLAUDE_STUB_LOG" 2>/dev/null || echo "")
assert_contains "$LOG" "/catalyst-dev:phase-verify CTL-450" "claude invoked with phase-verify skill prompt"
assert_contains "$LOG" "CATALYST_PHASE=verify" "env carries CATALYST_PHASE=verify"

# ─── E2E: dispatcher refuses without phase-implement.json ──────────────────
echo ""
echo "Test 3: phase-agent-dispatch refuses phase-verify without phase-implement.json"

TEST_DIR="${SCRATCH}/t3"
ORCH_DIR="${TEST_DIR}/orch"
WORKER_DIR="${ORCH_DIR}/workers/CTL-450"
mkdir -p "$WORKER_DIR"

OUT=$("$DISPATCH" --phase verify --ticket CTL-450 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
RC=$?
REFUSED=$(echo "$OUT" | jq -r '.status' 2>/dev/null || echo "")
assert_eq "2" "$RC" "exit code 2 when phase-implement.json missing"
assert_eq "refused" "$REFUSED" "stdout status = refused"

echo ""
echo "─────────────────────────────────────────────"
echo "phase-verify-e2e: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -gt 0 ]] && exit 1
exit 0
