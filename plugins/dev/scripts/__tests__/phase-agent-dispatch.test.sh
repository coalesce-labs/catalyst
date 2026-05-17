#!/usr/bin/env bash
# Tests for phase-agent-dispatch (CTL-448 Initiative 1 Phase 2).
#
# Approach: stub the `claude` binary on PATH with a script that captures its
# arguments and writes a fake bg job ID to stdout. Build a fresh scratch
# orch dir per test. Exercise the dispatcher against this fixture and assert
# on the signal file, stdout JSON, and captured `claude` invocation args.
#
# Run: bash plugins/dev/scripts/__tests__/phase-agent-dispatch.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
DISPATCH="${REPO_ROOT}/plugins/dev/scripts/phase-agent-dispatch"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t phase-agent-dispatch-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label"
  else
    fail "$label — expected '$expected', got '$actual'"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$label"
  else
    fail "$label — '$needle' not found in '$haystack'"
  fi
}

if [[ ! -x "$DISPATCH" ]]; then
  echo "FATAL: $DISPATCH not found or not executable" >&2
  exit 1
fi

# ─── Stub claude binary ─────────────────────────────────────────────────────
# The stub writes a fake bg job ID to stdout and logs its args + env to
# $CLAUDE_STUB_LOG for assertions. The bg job ID can be overridden via
# $CLAUDE_STUB_JOB_ID for the "records the bg job id" test.
setup_claude_stub() {
  local stub_dir="$1"
  mkdir -p "$stub_dir"
  cat > "$stub_dir/claude" <<'STUB'
#!/usr/bin/env bash
LOG="${CLAUDE_STUB_LOG:-/tmp/claude-stub.log}"
JOB_ID="${CLAUDE_STUB_JOB_ID:-job-stub-abc123}"
{
  echo "--ARGS--"
  printf '%s\n' "$@"
  echo "--ENV--"
  env | grep -E '^CATALYST_(ORCHESTRATOR_(DIR|ID)|PHASE|TICKET)=' | sort
  echo "--END--"
} > "$LOG"
printf '%s\n' "$JOB_ID"
exit "${CLAUDE_STUB_EXIT:-0}"
STUB
  chmod +x "$stub_dir/claude"
}

# Build a fresh per-test orch fixture and put the stub claude on PATH first.
fresh_env() {
  local tag="$1"
  TEST_DIR="${SCRATCH}/${tag}"
  STUB_DIR="${TEST_DIR}/bin"
  ORCH_DIR="${TEST_DIR}/orch"
  WORKER_DIR="${ORCH_DIR}/workers/CTL-100"
  CONFIG_DIR="${TEST_DIR}/proj/.catalyst"
  mkdir -p "$STUB_DIR" "$WORKER_DIR" "$CONFIG_DIR"
  setup_claude_stub "$STUB_DIR"
  export CLAUDE_STUB_LOG="${TEST_DIR}/claude-stub.log"
  export CLAUDE_STUB_JOB_ID="job-stub-abc123"
  unset CLAUDE_STUB_EXIT
  export PATH="${STUB_DIR}:${PATH}"
}

# ─── Test 1: dispatcher writes the per-phase signal file with the right schema
echo "Test 1: dispatcher writes signal file with correct schema"
fresh_env t1
OUT=$("$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>&1)
SIGNAL="${WORKER_DIR}/phase-triage.json"
if [[ ! -f "$SIGNAL" ]]; then
  fail "signal file created: $SIGNAL"
else
  pass "signal file created at expected path"
  TICKET_FIELD=$(jq -r '.ticket' "$SIGNAL")
  PHASE_FIELD=$(jq -r '.phase' "$SIGNAL")
  MODEL_FIELD=$(jq -r '.model' "$SIGNAL")
  TURN_CAP_FIELD=$(jq -r '.turnCap' "$SIGNAL")
  STATUS_FIELD=$(jq -r '.status' "$SIGNAL")
  assert_eq "CTL-100" "$TICKET_FIELD" "signal.ticket"
  assert_eq "triage"  "$PHASE_FIELD"  "signal.phase"
  assert_eq "opus"    "$MODEL_FIELD"  "signal.model defaulted to opus"
  assert_eq "10"      "$TURN_CAP_FIELD" "signal.turnCap defaulted to 10 (triage)"
  assert_eq "running" "$STATUS_FIELD" "signal.status = running after bg spawn"
fi

# ─── Test 2: dispatcher launches claude --bg with the right env vars
echo ""
echo "Test 2: dispatcher invokes claude --bg with the right args + env"
fresh_env t2
"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test >/dev/null 2>&1
LOG=$(cat "$CLAUDE_STUB_LOG")
assert_contains "$LOG" "--bg" "claude invoked with --bg flag"
assert_contains "$LOG" "--dangerously-skip-permissions" "claude invoked with --dangerously-skip-permissions"
assert_contains "$LOG" "--model" "claude invoked with --model flag"
assert_contains "$LOG" "/catalyst-dev:phase-triage CTL-100 --orch-dir" "prompt includes phase skill + ticket + orch-dir"
assert_contains "$LOG" "CATALYST_ORCHESTRATOR_DIR=${ORCH_DIR}" "env carries CATALYST_ORCHESTRATOR_DIR"
assert_contains "$LOG" "CATALYST_PHASE=triage" "env carries CATALYST_PHASE"
assert_contains "$LOG" "CATALYST_TICKET=CTL-100" "env carries CATALYST_TICKET"

# ─── Test 3: dispatcher records the --bg job ID in the signal file
echo ""
echo "Test 3: dispatcher records bg_job_id in signal file + stdout"
fresh_env t3
export CLAUDE_STUB_JOB_ID="job-xyz-789"
STDOUT=$("$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
SIGNAL="${WORKER_DIR}/phase-triage.json"
JOB_IN_SIGNAL=$(jq -r '.bg_job_id' "$SIGNAL")
JOB_IN_STDOUT=$(echo "$STDOUT" | jq -r '.bg_job_id')
assert_eq "job-xyz-789" "$JOB_IN_SIGNAL" "signal.bg_job_id matches claude stub output"
assert_eq "job-xyz-789" "$JOB_IN_STDOUT" "stdout JSON includes bg_job_id"

# ─── Test 4: dispatcher is idempotent (re-dispatch in-flight phase no-ops)
echo ""
echo "Test 4: dispatcher is idempotent for in-flight phases"
fresh_env t4
"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test >/dev/null 2>&1
# Clear the stub log so we can detect a second invocation.
rm -f "$CLAUDE_STUB_LOG"
STDOUT=$("$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
IDEMPOTENT=$(echo "$STDOUT" | jq -r '.idempotent // false')
LOG_REWRITTEN="no"
[[ -f "$CLAUDE_STUB_LOG" ]] && LOG_REWRITTEN="yes"
assert_eq "true" "$IDEMPOTENT" "second dispatch reports idempotent: true"
assert_eq "no"   "$LOG_REWRITTEN" "second dispatch did NOT re-invoke claude --bg"

# ─── Test 5: dispatcher refuses to launch if prior phase artifact is missing
echo ""
echo "Test 5: dispatcher refuses to launch when prior artifact missing"
fresh_env t5
# Research requires triage.json — don't create one.
"$DISPATCH" --phase research --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test >"${TEST_DIR}/research.out" 2>"${TEST_DIR}/research.err"
RC=$?
STDOUT_JSON=$(cat "${TEST_DIR}/research.out")
REFUSED_STATUS=$(echo "$STDOUT_JSON" | jq -r '.status' 2>/dev/null || echo "")
SIGNAL_RESEARCH="${WORKER_DIR}/phase-research.json"
SIGNAL_EXISTS="no"
[[ -f "$SIGNAL_RESEARCH" ]] && SIGNAL_EXISTS="yes"
assert_eq "2" "$RC" "exit code 2 when prior artifact missing"
assert_eq "refused" "$REFUSED_STATUS" "stdout JSON status = refused"
assert_eq "no" "$SIGNAL_EXISTS" "no signal file written when refused"

# ─── Test 6: dispatcher resolves model from config (default + override paths)
echo ""
echo "Test 6: dispatcher resolves model from config (default and override)"
fresh_env t6
cat > "${CONFIG_DIR}/config.json" <<EOF
{
  "catalyst": {
    "orchestration": {
      "phaseAgents": {
        "models": { "implement": "sonnet" },
        "modelOverrides": {
          "implement": { "CTL-999": "opus" }
        }
      }
    }
  }
}
EOF
# Create the plan artifact so the implement gate passes.
mkdir -p "${TEST_DIR}/proj/thoughts/shared/plans"
touch "${TEST_DIR}/proj/thoughts/shared/plans/2026-05-16-ctl-100.md"
# Default path: ticket = CTL-100 → models.implement = sonnet
( cd "${TEST_DIR}/proj" && \
  "$DISPATCH" --phase implement --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
    >"${TEST_DIR}/m1.out" 2>/dev/null )
MODEL_DEFAULT=$(jq -r '.model' "${TEST_DIR}/m1.out")
assert_eq "sonnet" "$MODEL_DEFAULT" "models.implement default → sonnet"

# Override path: ticket = CTL-999 → modelOverrides.implement.CTL-999 = opus
touch "${TEST_DIR}/proj/thoughts/shared/plans/2026-05-16-ctl-999.md"
mkdir -p "${ORCH_DIR}/workers/CTL-999"
( cd "${TEST_DIR}/proj" && \
  "$DISPATCH" --phase implement --ticket CTL-999 --orch-dir "$ORCH_DIR" --orch-id orch-test \
    >"${TEST_DIR}/m2.out" 2>/dev/null )
MODEL_OVERRIDE=$(jq -r '.model' "${TEST_DIR}/m2.out")
assert_eq "opus" "$MODEL_OVERRIDE" "modelOverrides.implement.CTL-999 beats default"

# CLI flag wins both
( cd "${TEST_DIR}/proj" && \
  "$DISPATCH" --phase implement --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test --model haiku \
    >"${TEST_DIR}/m3.out" 2>/dev/null )
mkdir -p "${ORCH_DIR}/workers/CTL-100"
# Clean prior signal so this isn't idempotent no-op
rm -f "${ORCH_DIR}/workers/CTL-100/phase-implement.json"
( cd "${TEST_DIR}/proj" && \
  "$DISPATCH" --phase implement --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test --model haiku \
    >"${TEST_DIR}/m3.out" 2>/dev/null )
MODEL_CLI=$(jq -r '.model' "${TEST_DIR}/m3.out")
assert_eq "haiku" "$MODEL_CLI" "CLI --model beats config"

# ─── Test 7: dispatcher resolves turn cap from config
echo ""
echo "Test 7: dispatcher resolves turn cap from config"
fresh_env t7
cat > "${CONFIG_DIR}/config.json" <<EOF
{
  "catalyst": {
    "orchestration": {
      "phaseAgents": {
        "turnCaps": { "triage": 99 }
      }
    }
  }
}
EOF
( cd "${TEST_DIR}/proj" && \
  "$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
    >"${TEST_DIR}/tc.out" 2>/dev/null )
TC_CONFIG=$(jq -r '.turnCap' "${TEST_DIR}/tc.out")
assert_eq "99" "$TC_CONFIG" "config turnCaps.triage = 99 applied"

# CLI overrides config
rm -f "${ORCH_DIR}/workers/CTL-100/phase-triage.json"
( cd "${TEST_DIR}/proj" && \
  "$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test --turn-cap 42 \
    >"${TEST_DIR}/tc2.out" 2>/dev/null )
TC_CLI=$(jq -r '.turnCap' "${TEST_DIR}/tc2.out")
assert_eq "42" "$TC_CLI" "CLI --turn-cap beats config"

# Fallback per-phase default
fresh_env t7b
( cd "${TEST_DIR}/proj" && \
  "$DISPATCH" --phase research --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
    >"${TEST_DIR}/tc3.out" 2>"${TEST_DIR}/tc3.err" )
RC=$?
# research requires triage.json — create it first then re-dispatch
echo '{"ticket":"CTL-100","status":"done"}' > "${WORKER_DIR}/triage.json"
( cd "${TEST_DIR}/proj" && \
  "$DISPATCH" --phase research --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
    >"${TEST_DIR}/tc3.out" 2>/dev/null )
TC_FALLBACK=$(jq -r '.turnCap' "${TEST_DIR}/tc3.out")
assert_eq "35" "$TC_FALLBACK" "per-phase default for research is 35"

# ─── Test 8: dispatcher passes humanlayer/thoughts env vars to phase agent
echo ""
echo "Test 8: dispatcher passes CATALYST_* env vars to phase agent process"
fresh_env t8
"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test >/dev/null 2>&1
LOG=$(cat "$CLAUDE_STUB_LOG")
# These are the four contract env vars the phase agent reads:
#   CATALYST_ORCHESTRATOR_DIR — where signal files live
#   CATALYST_ORCHESTRATOR_ID  — broker session correlation
#   CATALYST_PHASE            — which phase this agent is
#   CATALYST_TICKET           — which ticket
# (Thoughts integration is via humanlayer thoughts init at session start —
# the env var name is the same regardless and the env carries the orch dir
# the phase agent uses to resolve all other paths.)
assert_contains "$LOG" "CATALYST_ORCHESTRATOR_DIR=" "env propagates CATALYST_ORCHESTRATOR_DIR"
assert_contains "$LOG" "CATALYST_ORCHESTRATOR_ID="  "env propagates CATALYST_ORCHESTRATOR_ID"
assert_contains "$LOG" "CATALYST_PHASE=triage"      "env propagates CATALYST_PHASE"
assert_contains "$LOG" "CATALYST_TICKET=CTL-100"    "env propagates CATALYST_TICKET"

echo ""
echo "─────────────────────────────────────────────"
echo "phase-agent-dispatch: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
  exit 1
fi
exit 0
