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
# The stub mimics today's real `claude --bg` stdout format (CTL-490):
#
#   backgrounded · <hex>
#     claude agents             list sessions
#     claude attach <hex>       open in this terminal
#
# It also logs its args + env to $CLAUDE_STUB_LOG for assertions. The bg job
# ID can be overridden via $CLAUDE_STUB_JOB_ID — must be a lowercase 8-char hex
# string so the dispatcher's `grep -oE '[a-f0-9]{8}'` matches it.
#
# NOTE: This stub asserts the dispatcher's `BG_JOB_ID` parser. It does NOT
# exercise the `claude --bg "/catalyst-dev:phase-X ..."` skill-resolution path
# (Bug 1 in CTL-490) — that gap requires a real `claude --bg` round-trip and
# is verified manually per the ticket's acceptance test.
setup_claude_stub() {
  local stub_dir="$1"
  mkdir -p "$stub_dir"
  cat > "$stub_dir/claude" <<'STUB'
#!/usr/bin/env bash
LOG="${CLAUDE_STUB_LOG:-/tmp/claude-stub.log}"
JOB_ID="${CLAUDE_STUB_JOB_ID:-f124220a}"
{
  echo "--ARGS--"
  printf '%s\n' "$@"
  echo "--ENV--"
  env | grep -E '^CATALYST_(ORCHESTRATOR_(DIR|ID)|PHASE|TICKET)=' | sort
  echo "--END--"
} > "$LOG"
# Mimic today's `claude --bg` multi-line stdout — the hex job ID lives on
# line 1 after the bullet character; subsequent lines list helper commands.
cat <<EOF
backgrounded · ${JOB_ID}
  claude agents             list sessions
  claude attach ${JOB_ID}    open in this terminal
EOF
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
  export CLAUDE_STUB_JOB_ID="f124220a"
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
export CLAUDE_STUB_JOB_ID="a1b2c3d4"
STDOUT=$("$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
SIGNAL="${WORKER_DIR}/phase-triage.json"
JOB_IN_SIGNAL=$(jq -r '.bg_job_id' "$SIGNAL")
JOB_IN_STDOUT=$(echo "$STDOUT" | jq -r '.bg_job_id')
assert_eq "a1b2c3d4" "$JOB_IN_SIGNAL" "signal.bg_job_id matches claude stub output"
assert_eq "a1b2c3d4" "$JOB_IN_STDOUT" "stdout JSON includes bg_job_id"

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

# CTL-494 Phase 1: refusal must also emit phase.<name>.failed.<TICKET> to the
# event log so the orchestrator wakes in seconds instead of waiting on the
# 16-minute state-json-stale path.
export CATALYST_DIR="${TEST_DIR}/catalyst-events-root"
mkdir -p "${CATALYST_DIR}/events"

# Re-run the dispatch with the isolated CATALYST_DIR active.
rm -f "$SIGNAL_RESEARCH"  # ensure refused, not idempotent
"$DISPATCH" --phase research --ticket CTL-100 \
  --orch-dir "$ORCH_DIR" --orch-id orch-test \
  >"${TEST_DIR}/research2.out" 2>/dev/null
RC2=$?
assert_eq "2" "$RC2" "refusal still exits 2 with isolated CATALYST_DIR"

# Find the JSONL event log (one file per month).
EVENT_FILE=$(ls "${CATALYST_DIR}/events/"*.jsonl 2>/dev/null | head -1)
if [[ -z "$EVENT_FILE" ]]; then
  fail "event log was not created on refusal"
else
  pass "event log was created on refusal"
  EVENT_LINE=$(grep '"phase.research.failed.CTL-100"' "$EVENT_FILE" | head -1)
  if [[ -z "$EVENT_LINE" ]]; then
    fail "no phase.research.failed.CTL-100 event in log"
  else
    pass "phase.research.failed.CTL-100 event present in log"
    EVENT_REASON=$(echo "$EVENT_LINE" | jq -r '.body.payload.failure_reason // empty')
    assert_eq "prior_artifact_missing" "$EVENT_REASON" \
      "failed event payload carries failure_reason=prior_artifact_missing"
  fi
fi

# Refusal must still NOT write a signal file (existing contract preserved).
if [[ -f "$SIGNAL_RESEARCH" ]]; then
  fail "signal file written despite refusal"
else
  pass "signal file still not written when refused (with event log active)"
fi

# CTL-494 Phase 1: --dry-run refusal must NOT emit to the event log.
rm -f "${CATALYST_DIR}/events/"*.jsonl
"$DISPATCH" --phase research --ticket CTL-100 \
  --orch-dir "$ORCH_DIR" --orch-id orch-test --dry-run \
  >"${TEST_DIR}/research-dry.out" 2>/dev/null
RC_DRY=$?
assert_eq "2" "$RC_DRY" "--dry-run refusal still exits 2"
DRY_EVENT_FILE=$(ls "${CATALYST_DIR}/events/"*.jsonl 2>/dev/null | head -1)
if [[ -n "$DRY_EVENT_FILE" ]]; then
  fail "--dry-run refusal should not emit event (got $DRY_EVENT_FILE)"
else
  pass "--dry-run refusal does not emit event"
fi

# CTL-494 Phase 1: failed-event emission is phase-agnostic — the same code
# path produces phase.plan.failed.<TICKET> when the plan gate refuses. The
# plan's manual-verification step (§Phase 1 Manual #1) asked for this with
# `--phase plan` against a missing research doc; automate it here so a
# future regression that hardcodes "research" in the event name is caught.
# The plan phase's prior artifact is a glob under thoughts/shared/research/;
# run from an isolated empty project dir so the relaxed glob can't ambiently
# match a real research file in the host repo.
rm -f "${CATALYST_DIR}/events/"*.jsonl 2>/dev/null
mkdir -p "${TEST_DIR}/empty-proj"
( cd "${TEST_DIR}/empty-proj" && \
  "$DISPATCH" --phase plan --ticket CTL-100 \
    --orch-dir "$ORCH_DIR" --orch-id orch-test \
    >"${TEST_DIR}/plan.out" 2>/dev/null )
RC_PLAN=$?
assert_eq "2" "$RC_PLAN" "plan-phase refusal also exits 2"
PLAN_EVT_FILE=$(ls "${CATALYST_DIR}/events/"*.jsonl 2>/dev/null | head -1)
if [[ -z "$PLAN_EVT_FILE" ]]; then
  fail "plan-phase refusal: event log not created"
else
  PLAN_EVT_LINE=$(grep '"phase.plan.failed.CTL-100"' "$PLAN_EVT_FILE" | head -1)
  if [[ -n "$PLAN_EVT_LINE" ]]; then
    pass "plan-phase refusal emits phase.plan.failed.CTL-100"
  else
    fail "plan-phase refusal: no phase.plan.failed.CTL-100 line in event log"
  fi
fi

# CTL-494 Phase 1: emit-complete failing must not mask the refusal exit code.
# The dispatcher's call uses `|| true` and `--orch-dir/--orch-id`. Force the
# emit-complete to fail by pointing CATALYST_DIR at a path that cannot be
# created. The dispatcher must still exit 2 with status=refused.
export CATALYST_DIR="/dev/null/cannot-create-here"
rm -f "${ORCH_DIR}/workers/CTL-100/phase-research.json"
"$DISPATCH" --phase research --ticket CTL-100 \
  --orch-dir "$ORCH_DIR" --orch-id orch-test \
  >"${TEST_DIR}/research-emit-fail.out" 2>"${TEST_DIR}/research-emit-fail.err"
RC_EMIT_FAIL=$?
STATUS_EMIT_FAIL=$(jq -r '.status' "${TEST_DIR}/research-emit-fail.out" 2>/dev/null || echo "")
assert_eq "2" "$RC_EMIT_FAIL" "emit-complete failure does not mask exit 2"
assert_eq "refused" "$STATUS_EMIT_FAIL" "emit-complete failure preserves status=refused in stdout"

# Clean up env for subsequent tests.
unset CATALYST_DIR

# ─── Test 5b: dispatcher accepts both lowercase-tail and uppercase-suffix plan filenames (CTL-494 Phase 2)
echo ""
echo "Test 5b: dispatcher accepts canonical + phase-plan filename conventions"
fresh_env t5b

mkdir -p "${TEST_DIR}/proj/thoughts/shared/plans"

# Form A: phase-plan prose form — lowercase, ticket at end, no descriptive suffix.
touch "${TEST_DIR}/proj/thoughts/shared/plans/2026-05-18-ctl-100.md"
( cd "${TEST_DIR}/proj" && \
  "$DISPATCH" --phase implement --ticket CTL-100 \
    --orch-dir "$ORCH_DIR" --orch-id orch-test --dry-run \
    >"${TEST_DIR}/glob-a.out" 2>/dev/null )
STATUS_A=$(jq -r '.status' "${TEST_DIR}/glob-a.out")
assert_eq "dispatched" "$STATUS_A" "Form A: lowercase ticket at end is accepted"

# Reset for next form
rm -f "${TEST_DIR}/proj/thoughts/shared/plans/"*.md
rm -f "${ORCH_DIR}/workers/CTL-100/phase-implement.json"

# Form B: canonical create-plan form — uppercase ticket + descriptive suffix.
touch "${TEST_DIR}/proj/thoughts/shared/plans/2026-05-18-CTL-100-some-descriptive-name.md"
( cd "${TEST_DIR}/proj" && \
  "$DISPATCH" --phase implement --ticket CTL-100 \
    --orch-dir "$ORCH_DIR" --orch-id orch-test --dry-run \
    >"${TEST_DIR}/glob-b.out" 2>/dev/null )
STATUS_B=$(jq -r '.status' "${TEST_DIR}/glob-b.out")
assert_eq "dispatched" "$STATUS_B" "Form B: uppercase ticket + descriptive suffix is accepted"

# Reset
rm -f "${TEST_DIR}/proj/thoughts/shared/plans/"*.md
rm -f "${ORCH_DIR}/workers/CTL-100/phase-implement.json"

# Form C: uppercase + suffix-style "-plan".
touch "${TEST_DIR}/proj/thoughts/shared/plans/2026-05-17-CTL-100-plan.md"
( cd "${TEST_DIR}/proj" && \
  "$DISPATCH" --phase implement --ticket CTL-100 \
    --orch-dir "$ORCH_DIR" --orch-id orch-test --dry-run \
    >"${TEST_DIR}/glob-c.out" 2>/dev/null )
STATUS_C=$(jq -r '.status' "${TEST_DIR}/glob-c.out")
assert_eq "dispatched" "$STATUS_C" "Form C: uppercase ticket + -plan suffix is accepted"

# Reset
rm -f "${TEST_DIR}/proj/thoughts/shared/plans/"*.md
rm -f "${ORCH_DIR}/workers/CTL-100/phase-implement.json"

# Form D: lookalike file for a DIFFERENT ticket must NOT match CTL-100.
# Guards against an overly-greedy fix that strips the ticket constraint.
touch "${TEST_DIR}/proj/thoughts/shared/plans/2026-05-18-CTL-200-something.md"
( cd "${TEST_DIR}/proj" && \
  "$DISPATCH" --phase implement --ticket CTL-100 \
    --orch-dir "$ORCH_DIR" --orch-id orch-test --dry-run \
    >"${TEST_DIR}/glob-d.out" 2>"${TEST_DIR}/glob-d.err" )
RC_D=$?
STATUS_D=$(jq -r '.status' "${TEST_DIR}/glob-d.out")
assert_eq "2"       "$RC_D"     "Form D: different-ticket plan file does NOT satisfy CTL-100 gate"
assert_eq "refused" "$STATUS_D" "Form D: stdout JSON status = refused"

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

# ─── Test 9: BG_JOB_ID parser extracts hex from realistic `claude --bg` output
# Regression guard for CTL-490 Bug 2. The bug was `awk 'NR==1 {print $1}'`
# capturing the literal word "backgrounded" from today's CLI format. This test
# uses a hand-crafted fixture that mirrors the exact stdout shape from the
# ticket repro, independent of the stub claude binary, so it stays accurate
# even if the stub format ever drifts.
echo ""
echo "Test 9: BG_JOB_ID parser handles realistic claude --bg stdout format"
fresh_env t9
# Override the stub with one that emits the verbatim format from CTL-490's
# forensic transcript. The hex token here is the real job ID from that
# failed run — using it makes the regression report grep-able to the ticket.
cat > "${STUB_DIR}/claude" <<'STUB'
#!/usr/bin/env bash
cat <<EOF
backgrounded · f124220a
  claude agents             list sessions
  claude attach f124220a    open in this terminal
  claude kill   f124220a    stop the session
EOF
exit 0
STUB
chmod +x "${STUB_DIR}/claude"
STDOUT=$("$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
SIGNAL="${WORKER_DIR}/phase-triage.json"
JOB_IN_SIGNAL=$(jq -r '.bg_job_id' "$SIGNAL")
JOB_IN_STDOUT=$(echo "$STDOUT" | jq -r '.bg_job_id')
assert_eq "f124220a" "$JOB_IN_SIGNAL" "parser extracts hex from 'backgrounded · <hex>' line"
assert_eq "f124220a" "$JOB_IN_STDOUT" "parser does NOT capture the literal word 'backgrounded'"

echo ""
echo "─────────────────────────────────────────────"
echo "phase-agent-dispatch: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
  exit 1
fi
exit 0
