#!/usr/bin/env bash
# Tests for the phase-review skill (CTL-450 Initiative 1 Phase 4).
#
# phase-review wraps the gstack /review skill (NOT /ultrareview — that one stays
# user-triggered). It reads the prior verify.json, runs /review against the diff,
# writes ${ORCH_DIR}/workers/<TICKET>/review.json, and creates at most ONE
# remediation commit for HIGH-severity findings with deterministic fixes.
#
# Run: bash plugins/dev/scripts/__tests__/phase-review-e2e.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL="${REPO_ROOT}/plugins/dev/skills/phase-review/SKILL.md"
DISPATCH="${REPO_ROOT}/plugins/dev/scripts/phase-agent-dispatch"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t phase-review-e2e-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

assert_eq() { [[ "$1" == "$2" ]] && pass "$3" || fail "$3 — expected '$1', got '$2'"; }
assert_contains() { [[ "$1" == *"$2"* ]] && pass "$3" || fail "$3 — '$2' not found"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] && pass "$3" || fail "$3 — '$2' WAS present (must not be)"; }
assert_file_exists() { [[ -f "$1" ]] && pass "$2" || fail "$2 — file missing: $1"; }

# ─── Contract ───────────────────────────────────────────────────────────────
echo "Test 1: phase-review SKILL.md contract"
assert_file_exists "$SKILL" "SKILL.md exists at plugins/dev/skills/phase-review/SKILL.md"

if [[ -f "$SKILL" ]]; then
  BODY=$(cat "$SKILL")
  assert_contains "$BODY" "name: phase-review" "frontmatter declares name: phase-review"
  # CTL-490: phase skills are dispatched via `claude --bg "/catalyst-dev:phase-X ..."`,
  # which the bg session parses as a user slash command. user-invocable MUST be true.
  assert_contains "$BODY" "user-invocable: true" "frontmatter sets user-invocable: true (CTL-490)"
  assert_contains "$BODY" "disable-model-invocation: false" "frontmatter sets disable-model-invocation: false — invocable by model + user"

  # Allowed-tools must include Edit (since we may write remediation commits)
  assert_contains "$BODY" "Edit" "allowed-tools includes Edit (for remediation commits)"

  # Prelude
  assert_contains "$BODY" "CATALYST_ORCHESTRATOR_DIR" "prelude reads CATALYST_ORCHESTRATOR_DIR"
  assert_contains "$BODY" "CATALYST_TICKET" "prelude reads CATALYST_TICKET"

  # Prior artifact: verify.json from phase-verify
  assert_contains "$BODY" "verify.json" "body reads prior verify.json artifact"

  # Output artifact: review.json
  assert_contains "$BODY" "review.json" "body writes review.json artifact"

  # Schema fields
  assert_contains "$BODY" "remediationCommit" "review.json schema includes remediationCommit"
  assert_contains "$BODY" "reviewPassed"      "review.json schema includes reviewPassed"

  # Delegates to /review — must not invoke /ultrareview
  assert_contains "$BODY" "/review" "body invokes /review (gstack)"
  assert_not_contains "$BODY" "Invoke /ultrareview" "body does NOT instruct invoking /ultrareview"
  # Either no mention of ultrareview or only a no-op directive — assert the
  # body acknowledges and forbids it.
  assert_contains "$BODY" "ultrareview" "body acknowledges ultrareview (to forbid it)"

  assert_contains "$BODY" "phase-agent-emit-complete" "body calls phase-agent-emit-complete"
  assert_contains "$BODY" '--status complete' "body emits --status complete on success"

  # CTL-558: Linear status write-back moved to the deterministic coordinator —
  # the phase agent no longer carries the linear-transition prose.
  assert_not_contains "$BODY" "--transition reviewing" "body does NOT self-transition Linear (coordinator owns it, CTL-558)"

  assert_contains "$BODY" "/goal" "body declares a /goal block"

  # Remediation commit cap: at most ONE
  assert_contains "$BODY" "at most ONE" "body documents at-most-one-remediation-commit constraint"
fi

# ─── E2E: dispatcher launches phase-review when verify.json present ────────
echo ""
echo "Test 2: phase-agent-dispatch --phase review succeeds with verify.json present"

TEST_DIR="${SCRATCH}/t2"
STUB_DIR="${TEST_DIR}/bin"
ORCH_DIR="${TEST_DIR}/orch"
WORKER_DIR="${ORCH_DIR}/workers/CTL-450"
mkdir -p "$STUB_DIR" "$WORKER_DIR"

cat > "$STUB_DIR/claude" <<'STUB'
#!/usr/bin/env bash
# CTL-490: stub mimics today's real `claude --bg` stdout shape. Hex 'd4e5f607'.
LOG="${CLAUDE_STUB_LOG:-/tmp/claude-stub.log}"
{
  echo "--ARGS--"; printf '%s\n' "$@"
  echo "--ENV--"; env | grep -E '^CATALYST_(ORCHESTRATOR_(DIR|ID)|PHASE|TICKET)=' | sort
  echo "--END--"
} > "$LOG"
cat <<EOF
backgrounded · d4e5f607
  claude agents             list sessions
  claude attach d4e5f607    open in this terminal
EOF
STUB
chmod +x "$STUB_DIR/claude"

export CLAUDE_STUB_LOG="${TEST_DIR}/claude.log"
export PATH="${STUB_DIR}:${PATH}"

cat > "${WORKER_DIR}/verify.json" <<EOF
{"regression_risk": 3, "findings": [], "tests_attempted": 0, "gates": {}}
EOF

OUT=$("$DISPATCH" --phase review --ticket CTL-450 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
RC=$?
assert_eq "0" "$RC" "dispatch exit code 0"
SIGNAL="${WORKER_DIR}/phase-review.json"
assert_file_exists "$SIGNAL" "signal file phase-review.json written"

if [[ -f "$SIGNAL" ]]; then
  assert_eq "running" "$(jq -r '.status' "$SIGNAL")" "signal.status = running"
  assert_eq "review" "$(jq -r '.phase' "$SIGNAL")" "signal.phase = review"
  assert_eq "25" "$(jq -r '.turnCap' "$SIGNAL")" "signal.turnCap defaults to 25 (review)"
  assert_eq "d4e5f607" "$(jq -r '.bg_job_id' "$SIGNAL")" "signal.bg_job_id matches hex from stub (CTL-490)"
fi

LOG=$(cat "$CLAUDE_STUB_LOG" 2>/dev/null || echo "")
assert_contains "$LOG" "/catalyst-dev:phase-review CTL-450" "claude invoked with phase-review skill prompt"
assert_contains "$LOG" "CATALYST_PHASE=review" "env carries CATALYST_PHASE=review"

# ─── E2E: dispatcher refuses without verify.json ───────────────────────────
echo ""
echo "Test 3: phase-agent-dispatch refuses phase-review without verify.json"

TEST_DIR="${SCRATCH}/t3"
ORCH_DIR="${TEST_DIR}/orch"
WORKER_DIR="${ORCH_DIR}/workers/CTL-450"
mkdir -p "$WORKER_DIR"

OUT=$("$DISPATCH" --phase review --ticket CTL-450 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
RC=$?
REFUSED=$(echo "$OUT" | jq -r '.status' 2>/dev/null || echo "")
assert_eq "2" "$RC" "exit code 2 when verify.json missing"
assert_eq "refused" "$REFUSED" "stdout status = refused"

echo ""
echo "─────────────────────────────────────────────"
echo "phase-review-e2e: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -gt 0 ]] && exit 1
exit 0
