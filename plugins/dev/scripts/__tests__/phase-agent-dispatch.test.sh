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

fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
}
pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}

assert_eq() {
	local expected="$1" actual="$2" label="$3"
	if [[ $expected == "$actual" ]]; then
		pass "$label"
	else
		fail "$label — expected '$expected', got '$actual'"
	fi
}

assert_contains() {
	local haystack="$1" needle="$2" label="$3"
	if [[ $haystack == *"$needle"* ]]; then
		pass "$label"
	else
		fail "$label — '$needle' not found in '$haystack'"
	fi
}

assert_not_contains() {
	local haystack="$1" needle="$2" label="$3"
	if [[ $haystack != *"$needle"* ]]; then
		pass "$label"
	else
		fail "$label — '$needle' unexpectedly found in '$haystack'"
	fi
}

if [[ ! -x $DISPATCH ]]; then
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
	cat >"$stub_dir/claude" <<'STUB'
#!/usr/bin/env bash
LOG="${CLAUDE_STUB_LOG:-/tmp/claude-stub.log}"
JOB_ID="${CLAUDE_STUB_JOB_ID:-f124220a}"
# CTL-658: detect a `--resume` invocation so a test can script the resume
# outcome (stderr + exit) independently of the fresh-start fallback spawn that
# may follow in the SAME dispatch.
IS_RESUME=0
for a in "$@"; do [ "$a" = "--resume" ] && IS_RESUME=1; done
{
  echo "--ARGS--"
  printf '%s\n' "$@"
  echo "--ENV--"
  env | grep -E '^(CATALYST_(ORCHESTRATOR_(DIR|ID)|PHASE|TICKET)|OTEL_RESOURCE_ATTRIBUTES)=' | sort
  echo "--END--"
} >> "$LOG"   # CTL-658: append (a resume-then-fresh dispatch invokes claude twice)
# CTL-658: a --resume invocation honors the scripted resume outcome so a test
# can drive launched (empty stderr) / alive (rejection marker) / failed (other
# stderr) paths. A non-resume (fresh-start) invocation always succeeds below.
if [ "$IS_RESUME" = "1" ]; then
  [ -n "${CLAUDE_STUB_RESUME_STDERR:-}" ] && printf '%s\n' "$CLAUDE_STUB_RESUME_STDERR" >&2
  if [ -n "${CLAUDE_STUB_RESUME_EXIT:-}" ] && [ "${CLAUDE_STUB_RESUME_EXIT}" != "0" ]; then
    exit "${CLAUDE_STUB_RESUME_EXIT}"
  fi
fi
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
	# (CTL-689) Point machine-config fallback at a per-test non-existent path so
	# the user's real ~/.config/catalyst/config.json never contaminates assertions.
	export CATALYST_MACHINE_CONFIG="${TEST_DIR}/machine-config-absent.json"
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
# (CTL-689) cd into a scratch proj/ that has no parent .catalyst/config.json so
# the "defaulted to opus" assertion isn't contaminated by the shipped repo config
# when the suite runs from the repo root. (CATALYST_MACHINE_CONFIG already
# neutralized for the machine-level fallback in fresh_env.)
OUT=$(cd "${TEST_DIR}/proj" && "$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>&1)
SIGNAL="${WORKER_DIR}/phase-triage.json"
if [[ ! -f $SIGNAL ]]; then
	fail "signal file created: $SIGNAL"
else
	pass "signal file created at expected path"
	TICKET_FIELD=$(jq -r '.ticket' "$SIGNAL")
	PHASE_FIELD=$(jq -r '.phase' "$SIGNAL")
	MODEL_FIELD=$(jq -r '.model' "$SIGNAL")
	TURN_CAP_FIELD=$(jq -r '.turnCap' "$SIGNAL")
	STATUS_FIELD=$(jq -r '.status' "$SIGNAL")
	assert_eq "CTL-100" "$TICKET_FIELD" "signal.ticket"
	assert_eq "triage" "$PHASE_FIELD" "signal.phase"
	assert_eq "opus" "$MODEL_FIELD" "signal.model defaulted to opus"
	assert_eq "10" "$TURN_CAP_FIELD" "signal.turnCap defaulted to 10 (triage)"
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
[[ -f $CLAUDE_STUB_LOG ]] && LOG_REWRITTEN="yes"
assert_eq "true" "$IDEMPOTENT" "second dispatch reports idempotent: true"
assert_eq "no" "$LOG_REWRITTEN" "second dispatch did NOT re-invoke claude --bg"

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
[[ -f $SIGNAL_RESEARCH ]] && SIGNAL_EXISTS="yes"
assert_eq "2" "$RC" "exit code 2 when prior artifact missing"
assert_eq "refused" "$REFUSED_STATUS" "stdout JSON status = refused"
assert_eq "no" "$SIGNAL_EXISTS" "no signal file written when refused"

# CTL-494 Phase 1: refusal must also emit phase.<name>.failed.<TICKET> to the
# event log so the orchestrator wakes in seconds instead of waiting on the
# 16-minute state-json-stale path.
export CATALYST_DIR="${TEST_DIR}/catalyst-events-root"
mkdir -p "${CATALYST_DIR}/events"

# Re-run the dispatch with the isolated CATALYST_DIR active.
rm -f "$SIGNAL_RESEARCH" # ensure refused, not idempotent
"$DISPATCH" --phase research --ticket CTL-100 \
	--orch-dir "$ORCH_DIR" --orch-id orch-test \
	>"${TEST_DIR}/research2.out" 2>/dev/null
RC2=$?
assert_eq "2" "$RC2" "refusal still exits 2 with isolated CATALYST_DIR"

# Find the JSONL event log (one file per month).
EVENT_FILE=$(ls "${CATALYST_DIR}/events/"*.jsonl 2>/dev/null | head -1)
if [[ -z $EVENT_FILE ]]; then
	fail "event log was not created on refusal"
else
	pass "event log was created on refusal"
	EVENT_LINE=$(grep '"phase.research.failed.CTL-100"' "$EVENT_FILE" | head -1)
	if [[ -z $EVENT_LINE ]]; then
		fail "no phase.research.failed.CTL-100 event in log"
	else
		pass "phase.research.failed.CTL-100 event present in log"
		EVENT_REASON=$(echo "$EVENT_LINE" | jq -r '.body.payload.failure_reason // empty')
		assert_eq "prior_artifact_missing" "$EVENT_REASON" \
			"failed event payload carries failure_reason=prior_artifact_missing"
	fi
fi

# Refusal must still NOT write a signal file (existing contract preserved).
if [[ -f $SIGNAL_RESEARCH ]]; then
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
if [[ -n $DRY_EVENT_FILE ]]; then
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
(cd "${TEST_DIR}/empty-proj" &&
	"$DISPATCH" --phase plan --ticket CTL-100 \
		--orch-dir "$ORCH_DIR" --orch-id orch-test \
		>"${TEST_DIR}/plan.out" 2>/dev/null)
RC_PLAN=$?
assert_eq "2" "$RC_PLAN" "plan-phase refusal also exits 2"
PLAN_EVT_FILE=$(ls "${CATALYST_DIR}/events/"*.jsonl 2>/dev/null | head -1)
if [[ -z $PLAN_EVT_FILE ]]; then
	fail "plan-phase refusal: event log not created"
else
	PLAN_EVT_LINE=$(grep '"phase.plan.failed.CTL-100"' "$PLAN_EVT_FILE" | head -1)
	if [[ -n $PLAN_EVT_LINE ]]; then
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
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase implement --ticket CTL-100 \
		--orch-dir "$ORCH_DIR" --orch-id orch-test --dry-run \
		>"${TEST_DIR}/glob-a.out" 2>/dev/null)
STATUS_A=$(jq -r '.status' "${TEST_DIR}/glob-a.out")
assert_eq "dispatched" "$STATUS_A" "Form A: lowercase ticket at end is accepted"

# Reset for next form
rm -f "${TEST_DIR}/proj/thoughts/shared/plans/"*.md
rm -f "${ORCH_DIR}/workers/CTL-100/phase-implement.json"

# Form B: canonical create-plan form — uppercase ticket + descriptive suffix.
touch "${TEST_DIR}/proj/thoughts/shared/plans/2026-05-18-CTL-100-some-descriptive-name.md"
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase implement --ticket CTL-100 \
		--orch-dir "$ORCH_DIR" --orch-id orch-test --dry-run \
		>"${TEST_DIR}/glob-b.out" 2>/dev/null)
STATUS_B=$(jq -r '.status' "${TEST_DIR}/glob-b.out")
assert_eq "dispatched" "$STATUS_B" "Form B: uppercase ticket + descriptive suffix is accepted"

# Reset
rm -f "${TEST_DIR}/proj/thoughts/shared/plans/"*.md
rm -f "${ORCH_DIR}/workers/CTL-100/phase-implement.json"

# Form C: uppercase + suffix-style "-plan".
touch "${TEST_DIR}/proj/thoughts/shared/plans/2026-05-17-CTL-100-plan.md"
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase implement --ticket CTL-100 \
		--orch-dir "$ORCH_DIR" --orch-id orch-test --dry-run \
		>"${TEST_DIR}/glob-c.out" 2>/dev/null)
STATUS_C=$(jq -r '.status' "${TEST_DIR}/glob-c.out")
assert_eq "dispatched" "$STATUS_C" "Form C: uppercase ticket + -plan suffix is accepted"

# Reset
rm -f "${TEST_DIR}/proj/thoughts/shared/plans/"*.md
rm -f "${ORCH_DIR}/workers/CTL-100/phase-implement.json"

# Form D: lookalike file for a DIFFERENT ticket must NOT match CTL-100.
# Guards against an overly-greedy fix that strips the ticket constraint.
touch "${TEST_DIR}/proj/thoughts/shared/plans/2026-05-18-CTL-200-something.md"
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase implement --ticket CTL-100 \
		--orch-dir "$ORCH_DIR" --orch-id orch-test --dry-run \
		>"${TEST_DIR}/glob-d.out" 2>"${TEST_DIR}/glob-d.err")
RC_D=$?
STATUS_D=$(jq -r '.status' "${TEST_DIR}/glob-d.out")
assert_eq "2" "$RC_D" "Form D: different-ticket plan file does NOT satisfy CTL-100 gate"
assert_eq "refused" "$STATUS_D" "Form D: stdout JSON status = refused"

# ─── Test 6: dispatcher resolves model from config (default + override paths)
echo ""
echo "Test 6: dispatcher resolves model from config (default and override)"
fresh_env t6
cat >"${CONFIG_DIR}/config.json" <<EOF
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
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase implement --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
		>"${TEST_DIR}/m1.out" 2>/dev/null)
MODEL_DEFAULT=$(jq -r '.model' "${TEST_DIR}/m1.out")
assert_eq "sonnet" "$MODEL_DEFAULT" "models.implement default → sonnet"

# Override path: ticket = CTL-999 → modelOverrides.implement.CTL-999 = opus
touch "${TEST_DIR}/proj/thoughts/shared/plans/2026-05-16-ctl-999.md"
mkdir -p "${ORCH_DIR}/workers/CTL-999"
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase implement --ticket CTL-999 --orch-dir "$ORCH_DIR" --orch-id orch-test \
		>"${TEST_DIR}/m2.out" 2>/dev/null)
MODEL_OVERRIDE=$(jq -r '.model' "${TEST_DIR}/m2.out")
assert_eq "opus" "$MODEL_OVERRIDE" "modelOverrides.implement.CTL-999 beats default"

# CLI flag wins both
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase implement --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test --model haiku \
		>"${TEST_DIR}/m3.out" 2>/dev/null)
mkdir -p "${ORCH_DIR}/workers/CTL-100"
# Clean prior signal so this isn't idempotent no-op
rm -f "${ORCH_DIR}/workers/CTL-100/phase-implement.json"
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase implement --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test --model haiku \
		>"${TEST_DIR}/m3.out" 2>/dev/null)
MODEL_CLI=$(jq -r '.model' "${TEST_DIR}/m3.out")
assert_eq "haiku" "$MODEL_CLI" "CLI --model beats config"

# ─── Test 7: dispatcher resolves turn cap from config
echo ""
echo "Test 7: dispatcher resolves turn cap from config"
fresh_env t7
cat >"${CONFIG_DIR}/config.json" <<EOF
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
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
		>"${TEST_DIR}/tc.out" 2>/dev/null)
TC_CONFIG=$(jq -r '.turnCap' "${TEST_DIR}/tc.out")
assert_eq "99" "$TC_CONFIG" "config turnCaps.triage = 99 applied"

# CLI overrides config
rm -f "${ORCH_DIR}/workers/CTL-100/phase-triage.json"
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test --turn-cap 42 \
		>"${TEST_DIR}/tc2.out" 2>/dev/null)
TC_CLI=$(jq -r '.turnCap' "${TEST_DIR}/tc2.out")
assert_eq "42" "$TC_CLI" "CLI --turn-cap beats config"

# Fallback per-phase default
fresh_env t7b
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase research --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
		>"${TEST_DIR}/tc3.out" 2>"${TEST_DIR}/tc3.err")
RC=$?
# research requires triage.json — create it first then re-dispatch
echo '{"ticket":"CTL-100","status":"done"}' >"${WORKER_DIR}/triage.json"
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase research --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
		>"${TEST_DIR}/tc3.out" 2>/dev/null)
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
assert_contains "$LOG" "CATALYST_ORCHESTRATOR_ID=" "env propagates CATALYST_ORCHESTRATOR_ID"
assert_contains "$LOG" "CATALYST_PHASE=triage" "env propagates CATALYST_PHASE"
assert_contains "$LOG" "CATALYST_TICKET=CTL-100" "env propagates CATALYST_TICKET"

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
cat >"${STUB_DIR}/claude" <<'STUB'
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

# ─── Test 10: OTEL_RESOURCE_ATTRIBUTES propagation with projectKey present (CTL-492)
echo ""
echo "Test 10: OTEL_RESOURCE_ATTRIBUTES composed when projectKey is set"
fresh_env t10
cat >"${CONFIG_DIR}/config.json" <<EOF
{
  "catalyst": {
    "projectKey": "test-proj"
  }
}
EOF
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
		>/dev/null 2>&1)
LOG=$(cat "$CLAUDE_STUB_LOG")
assert_contains "$LOG" \
	"OTEL_RESOURCE_ATTRIBUTES=project=test-proj,linear.key=CTL-100,catalyst.orchestration=orch-test,branch=orch-test-CTL-100" \
	"OTEL attrs composed with projectKey + tier-2 branch fallback"

# ─── Test 10b: CATALYST_EXECUTION_CORE drops the orchId prefix (CTL-582) ──────
# Execution-core dispatches one worktree per ticket (~/catalyst/wt/<key>/<TICKET>),
# so the OTEL branch fallback is the bare ticket — not <orchId>-<ticket>.
echo ""
echo "Test 10b: CATALYST_EXECUTION_CORE composes the no-orchId worktree branch"
fresh_env t10b
cat >"${CONFIG_DIR}/config.json" <<EOF
{
  "catalyst": {
    "projectKey": "test-proj"
  }
}
EOF
(cd "${TEST_DIR}/proj" &&
	CATALYST_EXECUTION_CORE=1 "$DISPATCH" --phase triage --ticket CTL-100 \
		--orch-dir "$ORCH_DIR" --orch-id orch-test >/dev/null 2>&1)
LOG=$(cat "$CLAUDE_STUB_LOG")
assert_contains "$LOG" \
	"OTEL_RESOURCE_ATTRIBUTES=project=test-proj,linear.key=CTL-100,catalyst.orchestration=orch-test,branch=CTL-100" \
	"execution-core OTEL branch drops the orchId prefix (CTL-100, not orch-test-CTL-100)"

# ─── Test 11: OTEL_RESOURCE_ATTRIBUTES three-attr form when projectKey absent
echo ""
echo "Test 11: OTEL_RESOURCE_ATTRIBUTES falls back to three-attr form when no projectKey"
fresh_env t11
# Dispatch from a directory with NO .catalyst/config.json — TEST_DIR/proj has
# an empty .catalyst dir created by fresh_env but no config.json file.
rm -rf "${CONFIG_DIR}"
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
		>/dev/null 2>&1)
LOG=$(cat "$CLAUDE_STUB_LOG")
assert_contains "$LOG" \
	"OTEL_RESOURCE_ATTRIBUTES=linear.key=CTL-100,catalyst.orchestration=orch-test" \
	"OTEL attrs three-attr form when no projectKey"
if [[ $LOG == *"OTEL_RESOURCE_ATTRIBUTES="*"project="* ]]; then
	fail "OTEL attrs three-attr form must omit project="
else
	pass "OTEL attrs three-attr form omits project="
fi
if [[ $LOG == *"OTEL_RESOURCE_ATTRIBUTES="*"branch="* ]]; then
	fail "OTEL attrs three-attr form must omit branch="
else
	pass "OTEL attrs three-attr form omits branch="
fi

# ─── Test 12: tier-1 authoritative branch via git -C beats tier-2 constructed name
echo ""
echo "Test 12: tier-1 git -C branch resolution wins over tier-2 constructed name"
fresh_env t12
cat >"${CONFIG_DIR}/config.json" <<EOF
{
  "catalyst": {
    "projectKey": "test-proj"
  }
}
EOF
# Build a real git repo at the worker-worktree location the helper computes.
HOME_FIXTURE="${TEST_DIR}/home"
WORKER_WT="${HOME_FIXTURE}/catalyst/wt/test-proj/orch-test-CTL-100"
mkdir -p "$WORKER_WT"
(
	cd "$WORKER_WT"
	git init -q --initial-branch=main
	git config user.email "test@example.com"
	git config user.name "Test"
	git commit --allow-empty -q -m "init"
	git checkout -q -b bespoke-branch
)
HOME="$HOME_FIXTURE" \
	bash -c "cd '${TEST_DIR}/proj' && '$DISPATCH' --phase triage --ticket CTL-100 --orch-dir '$ORCH_DIR' --orch-id orch-test >/dev/null 2>&1"
LOG=$(cat "$CLAUDE_STUB_LOG")
assert_contains "$LOG" ",branch=bespoke-branch" \
	"tier-1 git branch (bespoke-branch) wins over tier-2 fallback"

# ─── Test 13 (CTL-492 follow-up): tier-1 → tier-2 fall-through when worker-wt
#                                  path exists but is not a git repo
echo ""
echo "Test 13: tier-2 wins when worker-wt path exists without a .git entry"
fresh_env t13
cat >"${CONFIG_DIR}/config.json" <<EOF
{
  "catalyst": {
    "projectKey": "test-proj"
  }
}
EOF
HOME_FIXTURE="${TEST_DIR}/home"
# Materialise the worker-wt directory but DO NOT init a git repo. Mirrors
# the real-world degradation where a previous worktree create failed mid-way
# and left a bare directory.
mkdir -p "${HOME_FIXTURE}/catalyst/wt/test-proj/orch-test-CTL-100"
HOME="$HOME_FIXTURE" \
	bash -c "cd '${TEST_DIR}/proj' && '$DISPATCH' --phase triage --ticket CTL-100 --orch-dir '$ORCH_DIR' --orch-id orch-test >/dev/null 2>&1"
LOG=$(cat "$CLAUDE_STUB_LOG")
assert_contains "$LOG" ",branch=orch-test-CTL-100" \
	"tier-2 constructed branch used when worker-wt has no .git"

# ─── Test 14: --dry-run JSON env array contains the OTEL entry
echo ""
echo "Test 14: --dry-run JSON env array carries OTEL_RESOURCE_ATTRIBUTES"
fresh_env t14
cat >"${CONFIG_DIR}/config.json" <<EOF
{
  "catalyst": {
    "projectKey": "test-proj"
  }
}
EOF
DRY=$(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test --dry-run 2>/dev/null)
OTEL_ENTRY=$(echo "$DRY" | jq -r '.env[] | select(startswith("OTEL_RESOURCE_ATTRIBUTES="))')
assert_eq \
	"OTEL_RESOURCE_ATTRIBUTES=project=test-proj,linear.key=CTL-100,catalyst.orchestration=orch-test,branch=orch-test-CTL-100,task.type=phase-triage,catalyst.exec_context=phase-bg" \
	"$OTEL_ENTRY" \
	"dry-run JSON env array carries the composed OTEL attribute string"

# ─── Test 15 (CTL-495): task.type=phase-<phase> appended to OTEL attrs
echo ""
echo "Test 15: task.type=phase-<phase> is always present in OTEL_RESOURCE_ATTRIBUTES"
fresh_env t15
cat >"${CONFIG_DIR}/config.json" <<EOF
{
  "catalyst": {
    "projectKey": "test-proj"
  }
}
EOF
# Case A: with projectKey set, task.type appears at the end of the composed string.
# implement requires a plan artifact under thoughts/shared/plans/.
mkdir -p "${TEST_DIR}/proj/thoughts/shared/plans"
touch "${TEST_DIR}/proj/thoughts/shared/plans/2026-05-18-ctl-100.md"
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase implement --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
		>/dev/null 2>&1)
LOG=$(cat "$CLAUDE_STUB_LOG")
assert_contains "$LOG" ",task.type=phase-implement" \
	"task.type=phase-implement appended with projectKey present"

# CTL-760: catalyst.exec_context=phase-bg rides the OTEL attrs so every bg
# phase metric slices by launch mode (phase-bg vs interactive).
assert_contains "$LOG" ",catalyst.exec_context=phase-bg" \
	"catalyst.exec_context=phase-bg appended to OTEL_RESOURCE_ATTRIBUTES"

# Case B: phase value flows through verbatim — monitor-deploy (the longest, hyphenated).
fresh_env t15b
cat >"${CONFIG_DIR}/config.json" <<EOF
{
  "catalyst": {
    "projectKey": "test-proj"
  }
}
EOF
# monitor-deploy requires phase-monitor-merge.json signal.
echo '{"ticket":"CTL-100","status":"done","pr":{"mergeCommitSha":"deadbeef"}}' \
	>"${WORKER_DIR}/phase-monitor-merge.json"
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase monitor-deploy --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
		>/dev/null 2>&1)
LOG=$(cat "$CLAUDE_STUB_LOG")
assert_contains "$LOG" ",task.type=phase-monitor-deploy" \
	"task.type=phase-monitor-deploy preserves hyphenated phase name"

# Case C: even without projectKey (short form), task.type is still present.
fresh_env t15c
rm -rf "${CONFIG_DIR}"
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
		>/dev/null 2>&1)
LOG=$(cat "$CLAUDE_STUB_LOG")
assert_contains "$LOG" \
	"OTEL_RESOURCE_ATTRIBUTES=linear.key=CTL-100,catalyst.orchestration=orch-test,task.type=phase-triage,catalyst.exec_context=phase-bg" \
	"task.type appended even when projectKey absent (short form)"

# ─── CTL-511: claude --bg launch failure → signal stalled + phase.*.failed ───
# A launch failure must leave the signal at status="stalled" with NO
# failureReason (so orchestrate-revive Loop 2 redispatches it) and emit
# phase.<name>.failed.<TICKET> (so the broker wakes the orchestrator in
# seconds instead of waiting on the periodic healthcheck).

echo ""
echo "Test 16 (CTL-511): claude --bg non-zero exit → signal stalled + phase.*.failed emitted"
fresh_env t16
export CLAUDE_STUB_EXIT=1
export CATALYST_DIR="${TEST_DIR}/catalyst-events"
mkdir -p "${CATALYST_DIR}/events"
"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
	>"${TEST_DIR}/t16.out" 2>"${TEST_DIR}/t16.err"
RC=$?
assert_eq "1" "$RC" "dispatch exits 1 on claude --bg launch failure"
SIGNAL="${WORKER_DIR}/phase-triage.json"
assert_eq "stalled" "$(jq -r '.status' "$SIGNAL")" "launch failure leaves signal at stalled"
assert_eq "false" "$(jq -r 'has("failureReason")' "$SIGNAL")" \
	"launch-failure signal has no failureReason (Loop 2 redispatch-eligible)"
assert_eq "claude-bg-launch-failed" "$(jq -r '.attentionReason' "$SIGNAL")" \
	"launch-failure signal records attentionReason (the cause string, not failureReason)"
# CTL-511: the signal file says "stalled" (recovery-eligible) but the dispatch
# stdout JSON still reports status="failed" — the synchronous dispatch attempt
# DID fail. The two intentionally diverge: orchestrate-revive reads the signal
# file, not dispatch stdout. Pin both so a future change cannot silently
# collapse them.
assert_eq "failed" "$(jq -r '.status' "${TEST_DIR}/t16.out")" \
	"dispatch stdout reports status=failed (distinct from the stalled signal file)"
if grep -rqs '"phase.triage.failed.CTL-100"' "${CATALYST_DIR}/events/"; then
	pass "launch failure emits phase.triage.failed.CTL-100 event"
else
	fail "no phase.triage.failed.CTL-100 event on launch failure"
fi
unset CLAUDE_STUB_EXIT CATALYST_DIR

echo ""
echo "Test 17 (CTL-511): claude --bg with no hex job id → signal stalled + phase.*.failed emitted"
fresh_env t17
# Override the stub: exit 0 but print no 8-char hex token.
cat >"${STUB_DIR}/claude" <<'STUB'
#!/usr/bin/env bash
echo "started, no job id present"
exit 0
STUB
chmod +x "${STUB_DIR}/claude"
export CATALYST_DIR="${TEST_DIR}/catalyst-events"
mkdir -p "${CATALYST_DIR}/events"
"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
	>"${TEST_DIR}/t17.out" 2>"${TEST_DIR}/t17.err" || true
SIGNAL="${WORKER_DIR}/phase-triage.json"
assert_eq "stalled" "$(jq -r '.status' "$SIGNAL")" "empty job id leaves signal at stalled"
assert_eq "false" "$(jq -r 'has("failureReason")' "$SIGNAL")" \
	"empty-job-id signal has no failureReason (Loop 2 redispatch-eligible)"
assert_eq "claude-bg-empty-job-id" "$(jq -r '.attentionReason' "$SIGNAL")" \
	"empty-job-id signal records attentionReason (the cause string, not failureReason)"
if grep -rqs '"phase.triage.failed.CTL-100"' "${CATALYST_DIR}/events/"; then
	pass "empty job id emits phase.triage.failed.CTL-100 event"
else
	fail "no phase.triage.failed.CTL-100 event on empty job id"
fi
unset CATALYST_DIR

echo ""
echo "Test 18 (CTL-511 regression): a successful launch still ends at status:running"
fresh_env t18
STDOUT=$("$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
SIGNAL="${WORKER_DIR}/phase-triage.json"
assert_eq "running" "$(jq -r '.status' "$SIGNAL")" "successful launch leaves signal at running"
assert_eq "running" "$(echo "$STDOUT" | jq -r '.status')" "successful launch stdout status=running"
assert_eq "f124220a" "$(jq -r '.bg_job_id' "$SIGNAL")" "successful launch records bg_job_id"

echo ""
echo "Test 19 (CTL-511): launch failure still flips signal to stalled when EMIT_COMPLETE is absent"
# The signal-file write (step 1) must not depend on the event emit (step 2).
# If EMIT_COMPLETE resolution ever breaks, recovery must degrade to the slow
# healthcheck path — NOT silently leave the signal frozen at "dispatched".
fresh_env t19
export CLAUDE_STUB_EXIT=1
export CATALYST_EMIT_COMPLETE="${TEST_DIR}/no-such-emit-complete"
"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
	>/dev/null 2>&1
SIGNAL="${WORKER_DIR}/phase-triage.json"
assert_eq "stalled" "$(jq -r '.status' "$SIGNAL")" \
	"signal still reaches stalled when EMIT_COMPLETE is missing (step 1 independent of step 2)"
unset CLAUDE_STUB_EXIT CATALYST_EMIT_COMPLETE

echo ""
echo "Test 20 (CTL-653): remediate dispatches with turnCap 40 + verify.json prior gate"
fresh_env t20_remediate
# remediate's prior artifact is verify.json — create it so the gate passes.
printf '%s\n' '{"regression_risk":7,"findings":[{"severity":"high"}],"tests_attempted":3,"gates":{},"generatedAt":"2026-05-27T00:00:00Z"}' \
	>"${WORKER_DIR}/verify.json"
"$DISPATCH" --phase remediate --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test >/dev/null 2>&1
SIGNAL_REM="${WORKER_DIR}/phase-remediate.json"
if [[ ! -f $SIGNAL_REM ]]; then
	fail "remediate signal file created: $SIGNAL_REM"
else
	pass "remediate signal file created"
	assert_eq "remediate" "$(jq -r '.phase' "$SIGNAL_REM")" "signal.phase = remediate"
	assert_eq "40" "$(jq -r '.turnCap' "$SIGNAL_REM")" "signal.turnCap = 40 (remediate, fix-scoped)"
fi

echo ""
echo "Test 21 (CTL-653): remediate refuses when verify.json (prior artifact) is missing"
fresh_env t21_remediate
# No verify.json → the prior-artifact gate must refuse (exit 2, no signal).
"$DISPATCH" --phase remediate --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
	>"${TEST_DIR}/rem.out" 2>/dev/null
RC_REM=$?
assert_eq "2" "$RC_REM" "exit code 2 when remediate's verify.json is missing"
assert_eq "refused" "$(jq -r '.status' "${TEST_DIR}/rem.out" 2>/dev/null || echo "")" \
	"remediate stdout JSON status = refused"
[[ -f "${WORKER_DIR}/phase-remediate.json" ]] && SIG_REM_EXISTS="yes" || SIG_REM_EXISTS="no"
assert_eq "no" "$SIG_REM_EXISTS" "no remediate signal written when refused"

# ─── CTL-658: --resume-session (daemon resume-on-revive) ────────────────────
# phase-agent-dispatch honors a resolved resume UUID by spawning
# `claude --bg --resume <uuid> "/catalyst-dev:phase-* ..."` — resuming the dead
# session's context AND re-issuing the phase command (CTL-736) so a worker that
# died before its first assistant turn re-executes the phase instead of idling on
# `claude --bg --resume`'s generic "Continue from where you left off." nudge.
# It then classifies the resume stderr: launched / alive / failed-fallback.
# triage is used as the carrier phase because it needs no prior artifact.

echo ""
echo "Test 22 (CTL-658/CTL-736): --resume-session plumbs --resume <uuid> AND re-issues the phase prompt"
fresh_env t22_resume_flag
"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
	--resume-session abc-uuid >"${TEST_DIR}/t22.out" 2>/dev/null
LOG=$(cat "$CLAUDE_STUB_LOG")
assert_contains "$LOG" "--resume" "resume invocation carries --resume flag"
assert_contains "$LOG" "abc-uuid" "resume invocation carries the session uuid"
# CTL-736: the resume now ALSO carries the phase command so an early-death worker
# (killed before its first assistant turn — nothing for the generic nudge to
# anchor on) re-executes the phase rather than idling. Both in the SAME invocation.
assert_contains "$LOG" "/catalyst-dev:phase-triage CTL-100" "resume invocation re-issues the phase prompt (CTL-736)"
ARGS_COUNT=$(grep -c -- '--ARGS--' "$CLAUDE_STUB_LOG")
assert_eq "1" "$ARGS_COUNT" "resume re-issues the prompt in the SAME invocation (not a resume-then-fresh double spawn)"

echo ""
echo "Test 23 (CTL-658): clean resume (empty stderr) → signal running with new bg_job_id, exit 0"
fresh_env t23_resume_launched
export CLAUDE_STUB_JOB_ID="deadbeef"
"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
	--resume-session abc-uuid >"${TEST_DIR}/t23.out" 2>/dev/null
RC23=$?
SIGNAL="${WORKER_DIR}/phase-triage.json"
assert_eq "0" "$RC23" "clean resume exits 0"
assert_eq "running" "$(jq -r '.status' "$SIGNAL")" "clean resume leaves signal at running"
assert_eq "deadbeef" "$(jq -r '.bg_job_id' "$SIGNAL")" "clean resume records the resumed bg_job_id"
unset CLAUDE_STUB_JOB_ID

echo ""
echo "Test 24 (CTL-658): resume rejected as alive → signal stalled (resume-rejected-alive), no fresh spawn, exit non-zero"
fresh_env t24_resume_alive
export CATALYST_DIR="${TEST_DIR}/catalyst-events"
mkdir -p "${CATALYST_DIR}/events"
export CLAUDE_STUB_RESUME_STDERR="Error: session abc-uuid is currently running as a background agent (bg)"
export CLAUDE_STUB_RESUME_EXIT=1
"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
	--resume-session abc-uuid >"${TEST_DIR}/t24.out" 2>/dev/null
RC24=$?
SIGNAL="${WORKER_DIR}/phase-triage.json"
assert_eq "1" "$RC24" "alive-rejected resume exits non-zero"
assert_eq "stalled" "$(jq -r '.status' "$SIGNAL")" "alive-rejected resume flips signal to stalled"
assert_eq "resume-rejected-alive" "$(jq -r '.attentionReason' "$SIGNAL")" \
	"alive-rejected resume records attentionReason=resume-rejected-alive"
assert_eq "resume_rejected_alive" "$(jq -r '.reason' "${TEST_DIR}/t24.out")" \
	"alive-rejected resume stdout JSON reason=resume_rejected_alive"
# CTL-736: the resume attempt itself now carries the phase prompt, so prompt-
# presence no longer distinguishes a resume from a fallback spawn. Assert no
# FALLBACK happened by counting invocations: exactly one (the rejected resume).
ARGS_COUNT=$(grep -c -- '--ARGS--' "$CLAUDE_STUB_LOG")
assert_eq "1" "$ARGS_COUNT" "alive-rejected resume does NOT fall back to a fresh spawn (single invocation)"
unset CLAUDE_STUB_RESUME_STDERR CLAUDE_STUB_RESUME_EXIT CATALYST_DIR

echo ""
echo "Test 25 (CTL-658): hard resume failure → fresh-start fallback in the same invocation"
fresh_env t25_resume_fallback
export CLAUDE_STUB_RESUME_STDERR="boom: unrecoverable resume error"
export CLAUDE_STUB_RESUME_EXIT=1
"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
	--resume-session abc-uuid >"${TEST_DIR}/t25.out" 2>/dev/null
RC25=$?
SIGNAL="${WORKER_DIR}/phase-triage.json"
assert_eq "0" "$RC25" "fallback path exits 0 (the fresh start succeeded)"
assert_eq "running" "$(jq -r '.status' "$SIGNAL")" "fallback leaves signal at running"
LOG=$(cat "$CLAUDE_STUB_LOG")
ARGS_COUNT=$(grep -c -- '--ARGS--' "$CLAUDE_STUB_LOG")
assert_eq "2" "$ARGS_COUNT" "claude was invoked twice (resume, then fresh fallback)"
RESUME_COUNT=$(grep -c -- '--resume' "$CLAUDE_STUB_LOG")
assert_eq "1" "$RESUME_COUNT" "only the first (resume) invocation carried --resume"
assert_contains "$LOG" "/catalyst-dev:phase-triage CTL-100" "fresh fallback invocation carried the phase prompt"
unset CLAUDE_STUB_RESUME_STDERR CLAUDE_STUB_RESUME_EXIT

echo ""
echo "Test 26 (CTL-658): no --resume-session → exactly today's single fresh-start spawn"
fresh_env t26_no_resume
"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
	>"${TEST_DIR}/t26.out" 2>/dev/null
LOG=$(cat "$CLAUDE_STUB_LOG")
ARGS_COUNT=$(grep -c -- '--ARGS--' "$CLAUDE_STUB_LOG")
assert_eq "1" "$ARGS_COUNT" "no-resume dispatch invokes claude exactly once"
assert_not_contains "$LOG" "--resume" "no-resume dispatch carries no --resume flag"
assert_contains "$LOG" "/catalyst-dev:phase-triage CTL-100" "no-resume dispatch carries the fresh phase prompt"

echo ""
echo "Test 27 (CTL-658): --dry-run --resume-session surfaces resumeSession in the JSON"
fresh_env t27_dry_resume
OUT_DRY=$("$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
	--resume-session abc-uuid --dry-run 2>/dev/null)
assert_eq "abc-uuid" "$(jq -r '.resumeSession' <<<"$OUT_DRY")" "dry-run JSON echoes resumeSession"

# ─── CTL-667: front-load merge-conflict surfacing (dispatch-time rebase) ─────
# These cases turn the per-test scratch worktree into a REAL git repo with a
# bare `origin` and exercise the dispatcher's fresh+build-phase rebase block.
# The dispatcher rebases its cwd, so each test cd's into the work clone.
# CATALYST_BASE_BRANCH=main pins the rebase target for determinism.

# Deterministic, non-interactive git for the fixtures.
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@test
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@test
export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true

# git_worktree_fixture <tag> → sets GORIGIN (bare), GUP (upstream editor clone),
# GWORK (the worktree the dispatcher runs in, on branch `work`). Seeds an initial
# commit with shared.txt (conflict target) + a tracked .catalyst/config.json.
git_worktree_fixture() {
	local tag="$1"
	GORIGIN="${TEST_DIR}/${tag}-origin.git"
	GUP="${TEST_DIR}/${tag}-up"
	GWORK="${TEST_DIR}/${tag}-work"
	git init --quiet --bare -b main "$GORIGIN"
	git clone --quiet "$GORIGIN" "$GUP" 2>/dev/null
	(
		cd "$GUP" || exit 1
		printf 'base-line\n' >shared.txt
		mkdir -p .catalyst
		printf '{"committed":true}\n' >.catalyst/config.json
		git add -A
		git commit --quiet -m "initial"
		git push --quiet origin main
	)
	git clone --quiet "$GORIGIN" "$GWORK" 2>/dev/null
	(cd "$GWORK" && git checkout --quiet -b work)
}
# advance_origin_clean → push a non-conflicting commit (new file) to origin/main.
advance_origin_clean() {
	(
		cd "$GUP" && git checkout --quiet main
		printf 'upstream-feature\n' >upstream.txt
		git add -A && git commit --quiet -m "upstream clean feature"
		git push --quiet origin main
	)
}
# advance_origin_conflict → push a commit editing shared.txt's only line.
advance_origin_conflict() {
	(
		cd "$GUP" && git checkout --quiet main
		printf 'upstream-edit\n' >shared.txt
		git add -A && git commit --quiet -m "upstream conflicting edit"
		git push --quiet origin main
	)
}
# seed_local_plan_commit → in GWORK, add the implement-gate plan artifact plus a
# local commit so the rebase has something to replay. Extra arg = a file edit
# applied before the commit (used to construct the conflicting local delta).
seed_local_plan_commit() {
	mkdir -p "${GWORK}/thoughts/shared/plans"
	printf '# plan\n' >"${GWORK}/thoughts/shared/plans/2026-05-27-ctl-100.md"
	printf 'local-feature\n' >"${GWORK}/local.txt"
	(cd "$GWORK" && git add -A && git commit --quiet -m "local work + plan")
}

# ─── Test 28: fresh build phase, clean rebase, behind origin/main → launches on rebased tip
echo ""
echo "Test 28 (CTL-667): fresh build phase clean rebase launches on the rebased tip"
fresh_env t28_rebase_clean
git_worktree_fixture t28
advance_origin_clean
seed_local_plan_commit
(cd "$GWORK" && CATALYST_BASE_BRANCH=main "$DISPATCH" --phase implement --ticket CTL-100 \
	--orch-dir "$ORCH_DIR" --orch-id orch-test >/dev/null 2>&1)
SIGNAL="${WORKER_DIR}/phase-implement.json"
LOG_PRESENT="no"; [[ -s $CLAUDE_STUB_LOG ]] && LOG_PRESENT="yes"
assert_eq "yes" "$LOG_PRESENT" "clean rebase: claude --bg WAS invoked"
BASE_PRESENT="no"; [[ -f "${GWORK}/upstream.txt" ]] && BASE_PRESENT="yes"
assert_eq "yes" "$BASE_PRESENT" "clean rebase: worktree HEAD now carries the new origin/main commit"
assert_eq "running" "$(jq -r '.status' "$SIGNAL")" "clean rebase: signal is the normal launched status (not stalled)"

# ─── Test 29: fresh build phase, conflicting rebase → park stalled, no worker
echo ""
echo "Test 29 (CTL-667): conflicting rebase parks the phase (stalled), no worker launched"
fresh_env t29_rebase_conflict
export CATALYST_DIR="${TEST_DIR}/catalyst-events"
mkdir -p "${CATALYST_DIR}/events"
git_worktree_fixture t29
advance_origin_conflict
mkdir -p "${GWORK}/thoughts/shared/plans"
printf '# plan\n' >"${GWORK}/thoughts/shared/plans/2026-05-27-ctl-100.md"
printf 'local-edit\n' >"${GWORK}/shared.txt"
(cd "$GWORK" && git add -A && git commit --quiet -m "local conflicting edit + plan")
ORIG_HEAD="$(cd "$GWORK" && git rev-parse HEAD)"
(cd "$GWORK" && CATALYST_BASE_BRANCH=main "$DISPATCH" --phase implement --ticket CTL-100 \
	--orch-dir "$ORCH_DIR" --orch-id orch-test >"${TEST_DIR}/t29.out" 2>/dev/null)
RC29=$?
SIGNAL="${WORKER_DIR}/phase-implement.json"
assert_eq "1" "$RC29" "conflict park: dispatcher exits 1"
CLAUDE_INVOKED="no"; [[ -s $CLAUDE_STUB_LOG ]] && CLAUDE_INVOKED="yes"
assert_eq "no" "$CLAUDE_INVOKED" "conflict park: claude --bg was NOT invoked"
assert_eq "stalled" "$(jq -r '.status' "$SIGNAL")" "conflict park: signal status = stalled"
assert_eq "source_conflict_ctl708_unavailable" "$(jq -r '.failureReason' "$SIGNAL")" \
	"conflict park: signal failureReason = source_conflict_ctl708_unavailable (CTL-707)"
NOW_HEAD="$(cd "$GWORK" && git rev-parse HEAD)"
assert_eq "$ORIG_HEAD" "$NOW_HEAD" "conflict park: worktree HEAD back at the original local commit (abort succeeded)"
if grep -rqs '"phase.implement.failed.CTL-100"' "${CATALYST_DIR}/events/"; then
	pass "conflict park: phase.implement.failed.CTL-100 event emitted"
else
	fail "conflict park: no phase.implement.failed.CTL-100 event emitted"
fi
unset CATALYST_DIR

# ─── Test 30: resume dispatch never rebases
echo ""
echo "Test 30 (CTL-667): --resume-session never rebases (HEAD unchanged)"
fresh_env t30_resume_norebase
git_worktree_fixture t30
advance_origin_clean
seed_local_plan_commit
ORIG_HEAD="$(cd "$GWORK" && git rev-parse HEAD)"
(cd "$GWORK" && CATALYST_BASE_BRANCH=main "$DISPATCH" --phase implement --ticket CTL-100 \
	--orch-dir "$ORCH_DIR" --orch-id orch-test --resume-session res-uuid >/dev/null 2>&1)
NOW_HEAD="$(cd "$GWORK" && git rev-parse HEAD)"
assert_eq "$ORIG_HEAD" "$NOW_HEAD" "resume: worktree HEAD unchanged (no fetch/rebase ran)"
LOG=$(cat "$CLAUDE_STUB_LOG")
assert_contains "$LOG" "--resume" "resume: the resume arm ran"

# ─── Test 31: non-build phase never rebases
echo ""
echo "Test 31 (CTL-667): non-build phases (triage, pr) never rebase"
fresh_env t31_nonbuild_norebase
git_worktree_fixture t31
advance_origin_clean
# triage needs no prior artifact.
ORIG_HEAD="$(cd "$GWORK" && git rev-parse HEAD)"
(cd "$GWORK" && CATALYST_BASE_BRANCH=main "$DISPATCH" --phase triage --ticket CTL-100 \
	--orch-dir "$ORCH_DIR" --orch-id orch-test >/dev/null 2>&1)
NOW_HEAD="$(cd "$GWORK" && git rev-parse HEAD)"
assert_eq "$ORIG_HEAD" "$NOW_HEAD" "triage: worktree HEAD unchanged"
assert_eq "yes" "$([[ -s $CLAUDE_STUB_LOG ]] && echo yes || echo no)" "triage: claude invoked normally"
# pr needs review.json as its prior artifact.
rm -f "$CLAUDE_STUB_LOG"
echo '{"ticket":"CTL-100","status":"done"}' >"${WORKER_DIR}/review.json"
(cd "$GWORK" && CATALYST_BASE_BRANCH=main "$DISPATCH" --phase pr --ticket CTL-100 \
	--orch-dir "$ORCH_DIR" --orch-id orch-test >/dev/null 2>&1)
NOW_HEAD2="$(cd "$GWORK" && git rev-parse HEAD)"
assert_eq "$ORIG_HEAD" "$NOW_HEAD2" "pr: worktree HEAD unchanged"
assert_eq "yes" "$([[ -s $CLAUDE_STUB_LOG ]] && echo yes || echo no)" "pr: claude invoked normally"

# ─── Test 32: re-walk idempotency — no rebase on an already-running signal
echo ""
echo "Test 32 (CTL-667): re-walk idempotency exits before the rebase block (HEAD unchanged)"
fresh_env t32_rewalk_norebase
git_worktree_fixture t32
advance_origin_clean
seed_local_plan_commit
ORIG_HEAD="$(cd "$GWORK" && git rev-parse HEAD)"
# Pre-seed the signal as running → the idempotency guard (before the rebase block) fires.
printf '%s\n' '{"ticket":"CTL-100","phase":"implement","status":"running","bg_job_id":"deadbeef"}' \
	>"${WORKER_DIR}/phase-implement.json"
STDOUT=$(cd "$GWORK" && CATALYST_BASE_BRANCH=main "$DISPATCH" --phase implement --ticket CTL-100 \
	--orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
assert_eq "true" "$(echo "$STDOUT" | jq -r '.idempotent // false')" "re-walk: dispatch reports idempotent:true"
NOW_HEAD="$(cd "$GWORK" && git rev-parse HEAD)"
assert_eq "$ORIG_HEAD" "$NOW_HEAD" "re-walk: worktree HEAD unchanged (no rebase ran)"

# ─── Test 33: dirty noise survives a clean dispatch rebase
echo ""
echo "Test 33 (CTL-667): dirty .catalyst/config.json survives a clean dispatch rebase"
fresh_env t33_noise_survives
git_worktree_fixture t33
advance_origin_clean
seed_local_plan_commit
# Dirty the tracked noise file — a plain rebase would refuse without the stash.
printf '{"committed":false,"dirty":true}\n' >"${GWORK}/.catalyst/config.json"
(cd "$GWORK" && CATALYST_BASE_BRANCH=main "$DISPATCH" --phase implement --ticket CTL-100 \
	--orch-dir "$ORCH_DIR" --orch-id orch-test >/dev/null 2>&1)
assert_eq "yes" "$([[ -s $CLAUDE_STUB_LOG ]] && echo yes || echo no)" "noise: dispatch still launched (clean rebase)"
assert_eq '{"committed":false,"dirty":true}' "$(cat "${GWORK}/.catalyst/config.json")" \
	"noise: dirty .catalyst/config.json content intact after the rebase"
BASE_PRESENT="no"; [[ -f "${GWORK}/upstream.txt" ]] && BASE_PRESENT="yes"
assert_eq "yes" "$BASE_PRESENT" "noise: rebase still advanced onto the new base"

# ─── Test 34 (CTL-689): machine-level config fallback resolves keys absent from
# the repo config, and the repo config wins when both define the same key.
#
# Why: the host-wide ~/.config/catalyst/config.json is the canonical source for
# settings (e.g. phase model overrides) that should apply across every repo a
# worker dispatches from. The repo `.catalyst/config.json` may still pin its own
# overrides — those must beat the machine value.
echo ""
echo "Test 34 (CTL-689): machine-config fallback resolves missing repo keys"
fresh_env t34_machine_only
# Write a machine config that pins implement → sonnet. No repo config.
cat >"${TEST_DIR}/machine-config.json" <<'EOF'
{
  "catalyst": {
    "orchestration": {
      "phaseAgents": {
        "models": { "implement": "sonnet" }
      }
    }
  }
}
EOF
export CATALYST_MACHINE_CONFIG="${TEST_DIR}/machine-config.json"
mkdir -p "${TEST_DIR}/proj/thoughts/shared/plans"
: >"${TEST_DIR}/proj/thoughts/shared/plans/2026-05-28-ctl-100.md"
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase implement --ticket CTL-100 \
		--orch-dir "$ORCH_DIR" --orch-id orch-test \
		>"${TEST_DIR}/m34_machine.out" 2>/dev/null)
MODEL_M=$(jq -r '.model' "${TEST_DIR}/m34_machine.out")
assert_eq "sonnet" "$MODEL_M" "machine-only: implement → sonnet (from ~/.config fallback)"

echo ""
echo "Test 34b (CTL-689): repo config beats machine config for the same key"
fresh_env t34_repo_beats_machine
cat >"${TEST_DIR}/machine-config.json" <<'EOF'
{
  "catalyst": {
    "orchestration": {
      "phaseAgents": {
        "models": { "implement": "sonnet" }
      }
    }
  }
}
EOF
export CATALYST_MACHINE_CONFIG="${TEST_DIR}/machine-config.json"
cat >"${CONFIG_DIR}/config.json" <<'EOF'
{
  "catalyst": {
    "orchestration": {
      "phaseAgents": {
        "models": { "implement": "haiku" }
      }
    }
  }
}
EOF
mkdir -p "${TEST_DIR}/proj/thoughts/shared/plans"
: >"${TEST_DIR}/proj/thoughts/shared/plans/2026-05-28-ctl-100.md"
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase implement --ticket CTL-100 \
		--orch-dir "$ORCH_DIR" --orch-id orch-test \
		>"${TEST_DIR}/m34b.out" 2>/dev/null)
MODEL_R=$(jq -r '.model' "${TEST_DIR}/m34b.out")
assert_eq "haiku" "$MODEL_R" "repo wins: implement → haiku (repo) over sonnet (machine)"

echo ""
echo "Test 34c (CTL-689): missing key in BOTH falls through to built-in default"
fresh_env t34_default_fallthrough
# Empty machine config + empty repo config — should default to opus.
echo '{}' >"${TEST_DIR}/machine-config.json"
export CATALYST_MACHINE_CONFIG="${TEST_DIR}/machine-config.json"
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase triage --ticket CTL-100 \
		--orch-dir "$ORCH_DIR" --orch-id orch-test \
		>"${TEST_DIR}/m34c.out" 2>/dev/null)
MODEL_D=$(jq -r '.model' "${TEST_DIR}/m34c.out")
assert_eq "opus" "$MODEL_D" "default fallthrough: triage → opus when neither config sets it"

# ─── CTL-707: 4-layer conflict classifier integration tests ──────────────────
# Extend the CTL-667 git fixture helpers (git_worktree_fixture /
# advance_origin_*) that are already in scope above.

# advance_origin_test_conflict → push a commit adding a test file that will
# conflict with a same-name work-branch test file.
advance_origin_test_conflict() {
	(
		cd "$GUP" && git checkout --quiet main
		mkdir -p src
		printf 'upstream-test\n' >src/ctl707.test.ts
		git add -A && git commit --quiet -m "upstream test"
		git push --quiet origin main
	)
}
# seed_local_test_commit → commit a conflicting test file + plan artifact.
seed_local_test_commit() {
	mkdir -p "${GWORK}/thoughts/shared/plans"
	printf '# plan\n' >"${GWORK}/thoughts/shared/plans/2026-05-28-ctl-100.md"
	mkdir -p "${GWORK}/src"
	printf 'local-test\n' >"${GWORK}/src/ctl707.test.ts"
	(cd "$GWORK" && git add -A && git commit --quiet -m "local test + plan")
}
# advance_origin_thoughts_conflict → push a commit adding a thoughts file.
advance_origin_thoughts_conflict() {
	(
		cd "$GUP" && git checkout --quiet main
		mkdir -p thoughts/shared
		printf 'upstream-research\n' >thoughts/shared/ctl707.md
		git add -A && git commit --quiet -m "upstream thoughts"
		git push --quiet origin main
	)
}
# seed_local_thoughts_commit → commit a conflicting thoughts file + verify-gate.
seed_local_thoughts_commit() {
	local signal_dir="$1"
	mkdir -p "${GWORK}/thoughts/shared"
	printf 'local-research\n' >"${GWORK}/thoughts/shared/ctl707.md"
	# verify needs phase-implement.json as prior artifact
	printf '{"ticket":"CTL-100","phase":"implement","status":"done"}\n' \
		>"${signal_dir}/phase-implement.json"
	(cd "$GWORK" && git add -A && git commit --quiet -m "local thoughts")
}
# seed_local_source_plan_commit → commit a source conflict + research artifact.
seed_local_source_plan_commit() {
	mkdir -p "${GWORK}/thoughts/shared/research"
	printf '# research\n' >"${GWORK}/thoughts/shared/research/2026-05-28-ctl-100.md"
	printf 'local-edit\n' >"${GWORK}/shared.txt"
	(cd "$GWORK" && git add -A && git commit --quiet -m "local source conflict + research")
}

# ─── Test 35 (CTL-707): tests-only conflict → auto-resolve, worker spawned ───
echo ""
echo "Test 35 (CTL-707): tests-only conflict → auto-resolved (additive), worker spawned"
fresh_env t35_tests_only
export CATALYST_DIR="${TEST_DIR}/catalyst-events"
mkdir -p "${CATALYST_DIR}/events"
git_worktree_fixture t35
advance_origin_test_conflict
seed_local_test_commit
(cd "$GWORK" && CATALYST_BASE_BRANCH=main "$DISPATCH" --phase implement --ticket CTL-100 \
	--orch-dir "$ORCH_DIR" --orch-id orch-test >/dev/null 2>&1)
RC35=$?
SIGNAL="${WORKER_DIR}/phase-implement.json"
assert_eq "0" "$RC35" "tests-only: dispatch exits 0"
assert_eq "yes" "$([[ -s $CLAUDE_STUB_LOG ]] && echo yes || echo no)" "tests-only: claude --bg WAS invoked"
SIGNAL_STATUS="$(jq -r '.status // empty' "$SIGNAL" 2>/dev/null || echo "")"
assert_eq "running" "$SIGNAL_STATUS" "tests-only: signal status = running (not stalled)"
unset CATALYST_DIR

# ─── Test 36 (CTL-707): source conflict on implement → stalled, no worker ────
echo ""
echo "Test 36 (CTL-707): source conflict on implement → stalled, no worker"
fresh_env t36_source_implement
export CATALYST_DIR="${TEST_DIR}/catalyst-events"
mkdir -p "${CATALYST_DIR}/events"
git_worktree_fixture t36
advance_origin_conflict
mkdir -p "${GWORK}/thoughts/shared/plans"
printf '# plan\n' >"${GWORK}/thoughts/shared/plans/2026-05-28-ctl-100.md"
printf 'local-edit\n' >"${GWORK}/shared.txt"
(cd "$GWORK" && git add -A && git commit --quiet -m "local conflict + plan")
(cd "$GWORK" && CATALYST_BASE_BRANCH=main "$DISPATCH" --phase implement --ticket CTL-100 \
	--orch-dir "$ORCH_DIR" --orch-id orch-test >"${TEST_DIR}/t36.out" 2>/dev/null)
RC36=$?
SIGNAL="${WORKER_DIR}/phase-implement.json"
assert_eq "1" "$RC36" "source implement: dispatch exits 1"
assert_eq "no" "$([[ -s $CLAUDE_STUB_LOG ]] && echo yes || echo no)" "source implement: claude --bg NOT invoked"
assert_eq "stalled" "$(jq -r '.status' "$SIGNAL")" "source implement: signal stalled"
FAIL_REASON36="$(jq -r '.failureReason' "$SIGNAL")"
assert_eq "source_conflict_ctl708_unavailable" "$FAIL_REASON36" "source implement: failureReason=source_conflict_ctl708_unavailable"
unset CATALYST_DIR

# ─── Test 37 (CTL-707): thoughts conflict on verify → stalled, no worker ─────
echo ""
echo "Test 37 (CTL-707): thoughts conflict on verify → stalled, no worker"
fresh_env t37_thoughts_verify
export CATALYST_DIR="${TEST_DIR}/catalyst-events"
mkdir -p "${CATALYST_DIR}/events"
git_worktree_fixture t37
advance_origin_thoughts_conflict
seed_local_thoughts_commit "$WORKER_DIR"
(cd "$GWORK" && CATALYST_BASE_BRANCH=main "$DISPATCH" --phase verify --ticket CTL-100 \
	--orch-dir "$ORCH_DIR" --orch-id orch-test >"${TEST_DIR}/t37.out" 2>/dev/null)
RC37=$?
SIGNAL="${WORKER_DIR}/phase-verify.json"
# Use the implement signal (it's the prior artifact that was pre-seeded).
SIGNAL="${WORKER_DIR}/phase-implement.json"
VSIGNAL="${WORKER_DIR}/phase-verify.json"
assert_eq "1" "$RC37" "thoughts verify: dispatch exits 1"
assert_eq "no" "$([[ -s $CLAUDE_STUB_LOG ]] && echo yes || echo no)" "thoughts verify: claude --bg NOT invoked"
assert_eq "stalled" "$(jq -r '.status' "$VSIGNAL")" "thoughts verify: signal stalled"
FAIL_REASON37="$(jq -r '.failureReason' "$VSIGNAL")"
assert_eq "thoughts_conflict_with_origin_main" "$FAIL_REASON37" "thoughts verify: failureReason=thoughts_conflict_with_origin_main"
unset CATALYST_DIR

# ─── Test 38 (CTL-707): source conflict on plan → recreate worktree, re-dispatch
# Uses a REAL git linked worktree (git worktree add) so the recreate path can
# resolve REPO_ROOT via --git-common-dir and call create-worktree.sh correctly.
echo ""
echo "Test 38 (CTL-707): source conflict on research → worktree recreated, worker spawned (no --resume)"
fresh_env t38_plan_recreate
export CATALYST_DIR="${TEST_DIR}/catalyst-events"
mkdir -p "${CATALYST_DIR}/events"

# Build fixture: bare origin → main clone (GMAIN) → linked worktree (GWORK).
T38_ORIGIN="${TEST_DIR}/t38-origin.git"
T38_UP="${TEST_DIR}/t38-up"
T38_MAIN="${TEST_DIR}/t38-main"
T38_WT_BASE="${TEST_DIR}/t38-wt"
# GWORK lives at the same path create-worktree.sh will recreate it to.
GWORK="${T38_WT_BASE}/CTL-100"
git init --quiet --bare -b main "$T38_ORIGIN"
git clone --quiet "$T38_ORIGIN" "$T38_UP" 2>/dev/null
(
	cd "$T38_UP"
	printf 'base-line\n' >shared.txt
	mkdir -p .catalyst
	git add -A && git commit --quiet -m "initial"
	git push --quiet origin main
)
git clone --quiet "$T38_ORIGIN" "$T38_MAIN" 2>/dev/null
# Create the linked worktree BEFORE advancing origin so the local commit
# diverges from the initial commit (not origin/main) — this produces a
# genuine conflict when rebased.
mkdir -p "$T38_WT_BASE"
(cd "$T38_MAIN" && git worktree add --quiet -b CTL-100 "$GWORK" main 2>/dev/null)
# Local commit: ONLY change shared.txt (no thoughts file — it doesn't exist yet).
(
	cd "$GWORK"
	printf 'local-edit\n' >shared.txt
	git add shared.txt && git commit --quiet -m "local source change"
)
# Now advance origin/main with the conflicting change + research artifact.
# The thoughts file is added only here, so the rebase conflict is source-only.
(
	cd "$T38_UP" && git checkout --quiet main
	printf 'upstream-edit\n' >shared.txt
	mkdir -p thoughts/shared/research
	printf '# research\n' >thoughts/shared/research/2026-05-28-ctl-100.md
	git add -A && git commit --quiet -m "upstream: conflict + research artifact"
	git push --quiet origin main
)
# Tell the dispatch's recreate path to create the new worktree under the test-local dir.
export CATALYST_RECREATE_WORKTREE_DIR="$T38_WT_BASE"
# Use RESEARCH phase — prior artifact is triage.json (easily seeded) rather than
# plan's research glob. The prior-artifact gate runs BEFORE the rebase block so the
# artifact must exist in the work branch; for research the only gate is triage.json.
printf '{"ticket":"CTL-100","phase":"triage","status":"done"}\n' >"${WORKER_DIR}/triage.json"
ORIG_HEAD="$(cd "$GWORK" && git rev-parse HEAD)"
(cd "$GWORK" && CATALYST_BASE_BRANCH=main "$DISPATCH" --phase research --ticket CTL-100 \
	--orch-dir "$ORCH_DIR" --orch-id orch-test >"${TEST_DIR}/t38.out" 2>/dev/null)
RC38=$?
SIGNAL="${WORKER_DIR}/phase-research.json"
assert_eq "0" "$RC38" "recreate: final dispatch exits 0 (second dispatch succeeds)"
assert_eq "yes" "$([[ -s $CLAUDE_STUB_LOG ]] && echo yes || echo no)" "recreate: claude --bg WAS invoked"
# Verify no --resume flag in any invocation.
LOG38="$(cat "$CLAUDE_STUB_LOG" 2>/dev/null || echo "")"
assert_not_contains "$LOG38" "--resume" "recreate: no --resume-session in claude invocation"
# New worktree HEAD should differ from original (recreated from origin/main).
NEW_HEAD="$(cd "$GWORK" && git rev-parse HEAD 2>/dev/null || echo missing)"
assert_eq "yes" "$([[ "$NEW_HEAD" != "$ORIG_HEAD" ]] && echo yes || echo no)" \
	"recreate: worktree HEAD changed (recreated from origin/main)"
unset CATALYST_DIR
unset CATALYST_RECREATE_WORKTREE_DIR

# ─── Test 39 (CTL-707): fetch failure on plan → proceed un-rebased, worker spawned
echo ""
echo "Test 39 (CTL-707): fetch failure → proceed un-rebased, worker launched"
fresh_env t39_fetch_fail
git_worktree_fixture t39
seed_local_plan_commit
ORIG_HEAD="$(cd "$GWORK" && git rev-parse HEAD)"
# Override base branch to one that does not exist on origin → fetch fails (rc 1).
(cd "$GWORK" && CATALYST_BASE_BRANCH=no-such-branch-ctl707 "$DISPATCH" \
	--phase implement --ticket CTL-100 \
	--orch-dir "$ORCH_DIR" --orch-id orch-test >/dev/null 2>&1)
NOW_HEAD="$(cd "$GWORK" && git rev-parse HEAD)"
assert_eq "$ORIG_HEAD" "$NOW_HEAD" "fetch fail: worktree HEAD unchanged (un-rebased)"
assert_eq "yes" "$([[ -s $CLAUDE_STUB_LOG ]] && echo yes || echo no)" "fetch fail: worker still spawned"

# ─── CTL-736 Phase 1: atomic single-flight generation claim + fencing token ──
# The claim makes a duplicate worker spawn structurally impossible: each
# (ticket, phase, generation) is O_EXCL-claimed, exactly one dispatcher wins.

echo ""
echo "Test 40 (CTL-736): fresh dispatch stamps generation=1 + exports CATALYST_GENERATION"
fresh_env t40_generation
"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test >/dev/null 2>&1
SIGNAL="${WORKER_DIR}/phase-triage.json"
assert_eq "1" "$(jq -r '.generation' "$SIGNAL")" "fresh dispatch: signal.generation = 1"
assert_eq "yes" "$([[ -f "${WORKER_DIR}/triage.claim.1" ]] && echo yes || echo no)" \
	"fresh dispatch: O_EXCL claim file triage.claim.1 created"
# The fencing token reaches the worker env. Use --dry-run (side-effect-free,
# read-only generation) in a SEPARATE fixture so its env array is inspectable.
fresh_env t40_env
DRY=$("$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test --dry-run 2>/dev/null)
GEN_ENTRY=$(echo "$DRY" | jq -r '.env[] | select(startswith("CATALYST_GENERATION="))')
assert_eq "CATALYST_GENERATION=1" "$GEN_ENTRY" "dry-run env array carries CATALYST_GENERATION=1"
assert_eq "no" "$([[ -e "${WORKER_DIR}/triage.claim.1" ]] && echo yes || echo no)" \
	"dry-run never creates a real claim file (preview is side-effect-free)"

echo ""
echo "Test 41 (CTL-736): two concurrent dispatches → exactly one claude --bg spawn"
fresh_env t41_concurrent
# Launch two near-simultaneous dispatches for the same (ticket, phase). The
# O_EXCL claim serializes them: exactly one wins (spawns), the other no-ops.
"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
	>"${TEST_DIR}/c1.out" 2>/dev/null &
"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
	>"${TEST_DIR}/c2.out" 2>/dev/null &
wait
SPAWN_COUNT=$(grep -c -- '--ARGS--' "$CLAUDE_STUB_LOG" 2>/dev/null || echo 0)
assert_eq "1" "$SPAWN_COUNT" "exactly one claude --bg spawn across two concurrent dispatches"
# Exactly one stdout reports a live spawn (status=running); the other no-ops.
RUNNING_COUNT=0
IDEMPOTENT_COUNT=0
for f in "${TEST_DIR}/c1.out" "${TEST_DIR}/c2.out"; do
	S=$(jq -r '.status // empty' "$f" 2>/dev/null || echo "")
	[[ $S == "running" ]] && RUNNING_COUNT=$((RUNNING_COUNT + 1))
	[[ "$(jq -r '.idempotent // false' "$f" 2>/dev/null || echo false)" == "true" ]] && \
		IDEMPOTENT_COUNT=$((IDEMPOTENT_COUNT + 1))
done
assert_eq "1" "$RUNNING_COUNT" "exactly one dispatch reports status=running (the winner)"
assert_eq "1" "$IDEMPOTENT_COUNT" "exactly one dispatch reports idempotent:true (the loser)"

echo ""
echo "Test 42 (CTL-736): a revive (stalled signal) bumps the generation and re-claims"
fresh_env t42_revive
"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test >/dev/null 2>&1
SIGNAL="${WORKER_DIR}/phase-triage.json"
assert_eq "1" "$(jq -r '.generation' "$SIGNAL")" "first dispatch: generation = 1"
# Simulate the daemon's defaultReviveDispatch: flip the signal to stalled.
TMP_REVIVE="${SIGNAL}.tmp"
jq '.status = "stalled" | .attentionReason = "ctl-587-revive-reset"' "$SIGNAL" >"$TMP_REVIVE" && mv "$TMP_REVIVE" "$SIGNAL"
rm -f "$CLAUDE_STUB_LOG" # count only the revive's spawn
"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test >/dev/null 2>&1
assert_eq "2" "$(jq -r '.generation' "$SIGNAL")" "revive: generation bumped to 2"
assert_eq "yes" "$([[ -f "${WORKER_DIR}/triage.claim.2" ]] && echo yes || echo no)" \
	"revive: fresh O_EXCL claim file triage.claim.2 created"
assert_eq "1" "$(grep -c -- '--ARGS--' "$CLAUDE_STUB_LOG" 2>/dev/null || echo 0)" \
	"revive spawned exactly one new worker"

echo ""
echo "Test 43 (CTL-736): fresh dispatch targets a FIXED gen (not high-water+1) → claim-lost, no spawn"
fresh_env t43_fixed_target
# Pre-seed a held claim at generation 1 with NO signal file. A fresh dispatch
# must target generation 1 (fixed by the absent signal) and collide with the
# tombstone — NOT advance to gen 2 off the claim-file high-water mark (which
# would WIN and double-spawn). This deterministically exercises the new
# `claim-lost` loser branch (the concurrent Test 41 loser can also exit via the
# older status short-circuit, so it doesn't pin this branch).
printf '{"generation":1,"claimedAt":"2026-05-30T00:00:00Z"}\n' >"${WORKER_DIR}/triage.claim.1"
STDOUT=$("$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
RC43=$?
assert_eq "0" "$RC43" "fixed-target claim-lost exits 0"
assert_eq "claim-lost" "$(echo "$STDOUT" | jq -r '.status')" "loser stdout status = claim-lost (not a fresh spawn at gen 2)"
assert_eq "true" "$(echo "$STDOUT" | jq -r '.idempotent')" "loser stdout idempotent = true"
assert_eq "1" "$(echo "$STDOUT" | jq -r '.generation')" "loser reports the contested generation = 1 (fixed target)"
assert_eq "no" "$([[ -e "${WORKER_DIR}/triage.claim.2" ]] && echo yes || echo no)" \
	"fresh dispatch did NOT advance to gen 2 (proves target is fixed, not high-water+1)"
assert_eq "no" "$([[ -f "${WORKER_DIR}/phase-triage.json" ]] && echo yes || echo no)" \
	"loser writes no signal file (bows out before the signal write)"
assert_eq "no" "$([[ -s "$CLAUDE_STUB_LOG" ]] && echo yes || echo no)" "loser did NOT spawn claude --bg"

# ─── Test 44 (CTL-747): 8-pt ticket → plan launches with effort:xhigh + /workflows, no opusplan ───
echo ""
echo "Test 44 (CTL-747): 8-pt ticket → plan launches with effort:xhigh + /workflows postamble, no opusplan"
fresh_env t44
mkdir -p "${TEST_DIR}/proj/thoughts/shared/research"
touch "${TEST_DIR}/proj/thoughts/shared/research/2026-05-30-ctl-100.md"
printf '%s\n' '{"estimated_scope":"large","classification":"feature"}' >"${WORKER_DIR}/triage.json"
(cd "${TEST_DIR}/proj" && "$DISPATCH" --phase plan --ticket CTL-100 \
	--orch-dir "$ORCH_DIR" --orch-id orch-test >/dev/null 2>&1)
LOG=$(cat "$CLAUDE_STUB_LOG")
assert_contains "$LOG" "--effort" "large plan: claude invoked with --effort"
T44_EFFORT=$(grep -A1 '^--effort$' "$CLAUDE_STUB_LOG" | sed -n '2p')
assert_eq "xhigh" "$T44_EFFORT" "large plan: --effort value is xhigh"
assert_contains "$LOG" "--append-system-prompt" "large plan: claude invoked with --append-system-prompt"
assert_contains "$LOG" "/workflows" "large plan: append-system-prompt carries the /workflows directive"
if echo "$LOG" | grep -q "opusplan"; then
	fail "large plan: rule must NOT override model to opusplan (CTL-747 dropped it)"
else
	pass "large plan: model not escalated to opusplan"
fi

# ─── Test 45 (CTL-747): 1-pt ticket → plan de-escalates to effort:medium, no /workflows ───
echo ""
echo "Test 45 (CTL-747): 1-pt ticket → plan launches with effort:medium, no /workflows, no opusplan"
fresh_env t45
mkdir -p "${TEST_DIR}/proj/thoughts/shared/research"
touch "${TEST_DIR}/proj/thoughts/shared/research/2026-05-30-ctl-100.md"
printf '%s\n' '{"estimated_scope":"small","classification":"feature"}' >"${WORKER_DIR}/triage.json"
(cd "${TEST_DIR}/proj" && "$DISPATCH" --phase plan --ticket CTL-100 \
	--orch-dir "$ORCH_DIR" --orch-id orch-test >/dev/null 2>&1)
LOG=$(cat "$CLAUDE_STUB_LOG")
T45_EFFORT=$(grep -A1 '^--effort$' "$CLAUDE_STUB_LOG" | sed -n '2p')
assert_eq "medium" "$T45_EFFORT" "small plan: --effort value is medium (1-pt → lt 3 rule)"
if echo "$LOG" | grep -q "/workflows"; then
	fail "small plan: must NOT carry the /workflows escalation"
else
	pass "small plan: no /workflows escalation"
fi
if echo "$LOG" | grep -q "opusplan"; then
	fail "small plan: must NOT escalate model to opusplan"
else
	pass "small plan: model not escalated to opusplan"
fi

# ─── Test 46 (CTL-747): numeric estimate:8 in triage.json → xhigh + /workflows (CTL-746 forward-compat) ───
echo ""
echo "Test 46 (CTL-747): numeric estimate:8 in triage.json → plan escalates to xhigh + /workflows (CTL-746 forward-compat)"
fresh_env t46
mkdir -p "${TEST_DIR}/proj/thoughts/shared/research"
touch "${TEST_DIR}/proj/thoughts/shared/research/2026-05-30-ctl-100.md"
printf '%s\n' '{"estimate":8,"classification":"feature"}' >"${WORKER_DIR}/triage.json"
(cd "${TEST_DIR}/proj" && "$DISPATCH" --phase plan --ticket CTL-100 \
	--orch-dir "$ORCH_DIR" --orch-id orch-test >/dev/null 2>&1)
LOG=$(cat "$CLAUDE_STUB_LOG")
T46_EFFORT=$(grep -A1 '^--effort$' "$CLAUDE_STUB_LOG" | sed -n '2p')
assert_eq "xhigh" "$T46_EFFORT" "numeric estimate:8 → --effort xhigh"
assert_contains "$LOG" "/workflows" "numeric estimate:8 → /workflows postamble"

# ─── Test 47 (CTL-747): un-pointed verify dispatch → NO --effort flag (fail-open, no base) ───
echo ""
echo "Test 47 (CTL-747): un-pointed verify dispatch → NO --effort flag (fail-open, no base)"
fresh_env t47
printf '%s\n' '{"classification":"feature"}' >"${WORKER_DIR}/triage.json"
printf '%s\n' '{"status":"done"}' >"${WORKER_DIR}/phase-implement.json"
(cd "${TEST_DIR}/proj" && "$DISPATCH" --phase verify --ticket CTL-100 \
	--orch-dir "$ORCH_DIR" --orch-id orch-test >/dev/null 2>&1)
LOG=$(cat "$CLAUDE_STUB_LOG")
if echo "$LOG" | grep -q -- "--effort"; then
	fail "un-pointed verify: must NOT pass --effort (no base, fail-open)"
else
	pass "un-pointed verify: no --effort flag"
fi

# ─── CTL-760: per-worker --settings env injection ───────────────────────────
# `claude --bg` is an RPC to the per-user daemon, so the worker inherits the
# daemon's FROZEN env and per-worker OTEL_RESOURCE_ATTRIBUTES is lost. The only
# lever that crosses the RPC is `claude --bg --settings '{"env":{...}}'`, which
# MERGES with ~/.claude/settings.json. The dispatcher composes that settings
# JSON (telemetry toggles + per-worker OTEL_RESOURCE_ATTRIBUTES + a statusLine
# command) and threads it into every spawn.
#
# The stub claude logs all argv under --ARGS-- (one token per line), so we can
# grep the line after `--settings` to recover the composed JSON and assert on it
# with jq. Telemetry toggles are re-asserted from the dispatcher's inherited env,
# so the tests export them before invoking.

# settings_json_from_log → echoes the JSON token logged right after `--settings`
# in $CLAUDE_STUB_LOG (the argv section logs one token per line).
settings_json_from_log() {
	grep -A1 -- '^--settings$' "$CLAUDE_STUB_LOG" | sed -n '2p'
}

echo ""
echo "Test 48 (CTL-760): spawn carries --settings with per-worker OTEL_RESOURCE_ATTRIBUTES in .env"
fresh_env t48
cat >"${CONFIG_DIR}/config.json" <<EOF
{
  "catalyst": {
    "projectKey": "test-proj"
  }
}
EOF
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_ENDPOINT="http://otel.example:4317"
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
		>/dev/null 2>&1)
LOG=$(cat "$CLAUDE_STUB_LOG")
assert_contains "$LOG" "--settings" "spawn argv carries --settings"
SETTINGS_JSON="$(settings_json_from_log)"
SET_OTEL=$(echo "$SETTINGS_JSON" | jq -r '.env["OTEL_RESOURCE_ATTRIBUTES"] // empty' 2>/dev/null)
assert_eq \
	"project=test-proj,linear.key=CTL-100,catalyst.orchestration=orch-test,branch=orch-test-CTL-100,task.type=phase-triage,catalyst.exec_context=phase-bg" \
	"$SET_OTEL" \
	".settings.env.OTEL_RESOURCE_ATTRIBUTES equals the composed attrs"

echo ""
echo "Test 49 (CTL-760): .settings.env carries the telemetry toggles from the dispatcher env"
# Reuse the exports from Test 48 (still in the environment).
SET_TELEMETRY=$(echo "$SETTINGS_JSON" | jq -r '.env["CLAUDE_CODE_ENABLE_TELEMETRY"] // empty' 2>/dev/null)
SET_METRICS=$(echo "$SETTINGS_JSON" | jq -r '.env["OTEL_METRICS_EXPORTER"] // empty' 2>/dev/null)
SET_LOGS=$(echo "$SETTINGS_JSON" | jq -r '.env["OTEL_LOGS_EXPORTER"] // empty' 2>/dev/null)
SET_ENDPOINT=$(echo "$SETTINGS_JSON" | jq -r '.env["OTEL_EXPORTER_OTLP_ENDPOINT"] // empty' 2>/dev/null)
SET_PROTOCOL=$(echo "$SETTINGS_JSON" | jq -r '.env["OTEL_EXPORTER_OTLP_PROTOCOL"] // empty' 2>/dev/null)
assert_eq "1" "$SET_TELEMETRY" ".settings.env.CLAUDE_CODE_ENABLE_TELEMETRY = 1"
assert_eq "otlp" "$SET_METRICS" ".settings.env.OTEL_METRICS_EXPORTER = otlp"
assert_eq "otlp" "$SET_LOGS" ".settings.env.OTEL_LOGS_EXPORTER = otlp"
assert_eq "http://otel.example:4317" "$SET_ENDPOINT" ".settings.env.OTEL_EXPORTER_OTLP_ENDPOINT carried when set"
assert_eq "grpc" "$SET_PROTOCOL" ".settings.env.OTEL_EXPORTER_OTLP_PROTOCOL carried when set"
unset CLAUDE_CODE_ENABLE_TELEMETRY OTEL_METRICS_EXPORTER OTEL_LOGS_EXPORTER \
	OTEL_EXPORTER_OTLP_ENDPOINT OTEL_EXPORTER_OTLP_PROTOCOL

echo ""
echo "Test 50 (CTL-760): unset optional endpoint/protocol are OMITTED from .settings.env (no null keys)"
fresh_env t50
cat >"${CONFIG_DIR}/config.json" <<EOF
{
  "catalyst": {
    "projectKey": "test-proj"
  }
}
EOF
# Explicitly clear the optional OTLP keys so the dispatcher must omit them.
unset OTEL_EXPORTER_OTLP_ENDPOINT OTEL_EXPORTER_OTLP_PROTOCOL
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
		>/dev/null 2>&1)
SETTINGS_JSON="$(settings_json_from_log)"
HAS_ENDPOINT=$(echo "$SETTINGS_JSON" | jq -r '.env | has("OTEL_EXPORTER_OTLP_ENDPOINT")' 2>/dev/null)
HAS_PROTOCOL=$(echo "$SETTINGS_JSON" | jq -r '.env | has("OTEL_EXPORTER_OTLP_PROTOCOL")' 2>/dev/null)
assert_eq "false" "$HAS_ENDPOINT" "unset OTEL_EXPORTER_OTLP_ENDPOINT omitted from .settings.env"
assert_eq "false" "$HAS_PROTOCOL" "unset OTEL_EXPORTER_OTLP_PROTOCOL omitted from .settings.env"
# Settings is still valid JSON even with the optional keys absent.
IS_VALID=$(echo "$SETTINGS_JSON" | jq -e . >/dev/null 2>&1 && echo yes || echo no)
assert_eq "yes" "$IS_VALID" "settings JSON remains valid with optional keys omitted"

echo ""
echo "Test 51 (CTL-760): --settings COEXISTS with --effort / --append-system-prompt (levers branch)"
fresh_env t51
mkdir -p "${TEST_DIR}/proj/thoughts/shared/research"
touch "${TEST_DIR}/proj/thoughts/shared/research/2026-05-30-ctl-100.md"
printf '%s\n' '{"estimated_scope":"large","classification":"feature"}' >"${WORKER_DIR}/triage.json"
(cd "${TEST_DIR}/proj" && "$DISPATCH" --phase plan --ticket CTL-100 \
	--orch-dir "$ORCH_DIR" --orch-id orch-test >/dev/null 2>&1)
LOG=$(cat "$CLAUDE_STUB_LOG")
assert_contains "$LOG" "--settings" "levers branch: --settings present"
assert_contains "$LOG" "--effort" "levers branch: --effort present"
assert_contains "$LOG" "--append-system-prompt" "levers branch: --append-system-prompt present"
SETTINGS_JSON="$(settings_json_from_log)"
LEVERS_OTEL=$(echo "$SETTINGS_JSON" | jq -r '.env["OTEL_RESOURCE_ATTRIBUTES"] // empty' 2>/dev/null)
assert_contains "$LEVERS_OTEL" "task.type=phase-plan" "levers branch: settings still carries the composed OTEL attrs"

echo ""
echo "Test 52 (CTL-760): .settings.statusLine.command ends with catalyst-statusline.sh when present"
fresh_env t52
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
		>/dev/null 2>&1)
SETTINGS_JSON="$(settings_json_from_log)"
SL_CMD=$(echo "$SETTINGS_JSON" | jq -r '.statusLine.command // empty' 2>/dev/null)
SL_TYPE=$(echo "$SETTINGS_JSON" | jq -r '.statusLine.type // empty' 2>/dev/null)
case "$SL_CMD" in
*/catalyst-statusline.sh) pass ".settings.statusLine.command ends with catalyst-statusline.sh" ;;
*) fail ".settings.statusLine.command ends with catalyst-statusline.sh — got '$SL_CMD'" ;;
esac
assert_eq "command" "$SL_TYPE" ".settings.statusLine.type = command"

echo ""
echo "Test 53 (CTL-760): --dry-run JSON includes the composed settings field"
fresh_env t53
cat >"${CONFIG_DIR}/config.json" <<EOF
{
  "catalyst": {
    "projectKey": "test-proj"
  }
}
EOF
DRY=$(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test --dry-run 2>/dev/null)
HAS_SETTINGS=$(echo "$DRY" | jq -r 'has("settings")' 2>/dev/null)
assert_eq "true" "$HAS_SETTINGS" "dry-run JSON has a settings field"
DRY_OTEL=$(echo "$DRY" | jq -r '.settings.env["OTEL_RESOURCE_ATTRIBUTES"] // empty' 2>/dev/null)
assert_eq \
	"project=test-proj,linear.key=CTL-100,catalyst.orchestration=orch-test,branch=orch-test-CTL-100,task.type=phase-triage,catalyst.exec_context=phase-bg" \
	"$DRY_OTEL" \
	"dry-run JSON settings.env carries the composed OTEL attrs"

echo ""
echo "Test 54 (CTL-761): --attempt is persisted to signal file"
fresh_env t54
rm -f "${WORKER_DIR}/phase-implement.json"
mkdir -p "${TEST_DIR}/proj/thoughts/shared/plans"
echo "# plan" >"${TEST_DIR}/proj/thoughts/shared/plans/2026-01-01-ctl-100.md"
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase implement --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
		--attempt 4 >/dev/null 2>&1)
SIGNAL_T54="${WORKER_DIR}/phase-implement.json"
ATT_T54=$(jq -r '.attempt // empty' "$SIGNAL_T54" 2>/dev/null)
assert_eq "4" "$ATT_T54" "signal file carries attempt=4"

echo ""
echo "Test 55 (CTL-761): default (no --attempt) → attempt=1 in signal file"
fresh_env t55
rm -f "${WORKER_DIR}/phase-triage.json"
(cd "${TEST_DIR}/proj" &&
	"$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id orch-test \
		>/dev/null 2>&1)
SIGNAL_T55="${WORKER_DIR}/phase-triage.json"
ATT_T55=$(jq -r '.attempt // empty' "$SIGNAL_T55" 2>/dev/null)
assert_eq "1" "$ATT_T55" "signal file defaults attempt=1"

echo ""
echo "─────────────────────────────────────────────"
echo "phase-agent-dispatch: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
	exit 1
fi
exit 0
