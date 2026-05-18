#!/usr/bin/env bash
# End-to-end tests for orchestrate-revive phase-agent recovery (CTL-493 Phase 4).
#
# Exercises the full healthcheck → revive → re-dispatch chain using fake
# claude/state/dispatch binaries. Each scenario:
#
#   1. Creates a per-phase signal (status=running) + a stale state.json under
#      ~/.claude/jobs/<bg_job_id>/ (via CATALYST_HEALTHCHECK_JOBS_ROOT).
#   2. Runs orchestrate-healthcheck — confirms the signal transitions to
#      status=stalled with attentionReason=state-json-stale.
#   3. Runs orchestrate-revive — confirms the correct decision branch fired
#      (re-dispatch | emit-complete | escalate).
#
# The actual scripts under test are unmodified; only the binaries they call
# are stubbed so we don't touch real Claude state. If Phases 1–3 are correct,
# this file passes without further code changes (per the plan).
#
# Run: bash plugins/dev/scripts/__tests__/orchestrate-revive-phase-e2e.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HEALTHCHECK="${REPO_ROOT}/plugins/dev/scripts/orchestrate-healthcheck"
REVIVE="${REPO_ROOT}/plugins/dev/scripts/orchestrate-revive"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

scratch_setup() {
  SCRATCH="$(mktemp -d -t orchestrate-revive-phase-e2e-XXXXXX)"
  ORCH_DIR="${SCRATCH}/orch"
  FIXTURE_BIN="${SCRATCH}/bin"
  JOBS_ROOT="${SCRATCH}/jobs"
  WORKTREE_BASE="${SCRATCH}/worktrees"
  DISPATCH_LOG="${SCRATCH}/dispatch.log"
  EMIT_LOG="${SCRATCH}/emit.log"
  STATE_LOG="${SCRATCH}/state.log"
  mkdir -p "${ORCH_DIR}/workers/output" "$FIXTURE_BIN" "$JOBS_ROOT" "$WORKTREE_BASE"
  : > "$DISPATCH_LOG"
  : > "$EMIT_LOG"
  : > "$STATE_LOG"

  cat > "${FIXTURE_BIN}/catalyst-state.sh" <<EOF2
#!/usr/bin/env bash
echo "\$@" >> "$STATE_LOG"
EOF2
  chmod +x "${FIXTURE_BIN}/catalyst-state.sh"
  export CATALYST_STATE_SCRIPT="${FIXTURE_BIN}/catalyst-state.sh"

  cat > "${FIXTURE_BIN}/phase-agent-dispatch" <<EOF2
#!/usr/bin/env bash
echo "dispatch-called: \$*" >> "$DISPATCH_LOG"
# Mutate signal: status → dispatched, fresh bg_job_id, mirroring the real
# script's contract.
PHASE=""
TICKET=""
OD=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    --phase) PHASE="\$2"; shift 2 ;;
    --ticket) TICKET="\$2"; shift 2 ;;
    --orch-dir) OD="\$2"; shift 2 ;;
    *) shift ;;
  esac
done
SIG="\$OD/workers/\$TICKET/phase-\$PHASE.json"
if [ -f "\$SIG" ]; then
  TS=\$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq --arg ts "\$TS" --arg bg "fresh-bg-\$\$" \
     '.status = "dispatched" | .bg_job_id = \$bg | .updatedAt = \$ts' \
     "\$SIG" > "\$SIG.tmp" 2>/dev/null && mv "\$SIG.tmp" "\$SIG"
fi
exit 0
EOF2
  chmod +x "${FIXTURE_BIN}/phase-agent-dispatch"
  export CATALYST_PHASE_DISPATCH_BIN="${FIXTURE_BIN}/phase-agent-dispatch"

  cat > "${FIXTURE_BIN}/phase-agent-emit-complete" <<EOF2
#!/usr/bin/env bash
echo "emit-complete-called: \$*" >> "$EMIT_LOG"
exit 0
EOF2
  chmod +x "${FIXTURE_BIN}/phase-agent-emit-complete"
  export CATALYST_PHASE_EMIT_COMPLETE_BIN="${FIXTURE_BIN}/phase-agent-emit-complete"

  export CATALYST_HEALTHCHECK_JOBS_ROOT="$JOBS_ROOT"
  export CATALYST_REVIVE_WORKTREE_BASE="$WORKTREE_BASE"
}

scratch_teardown() {
  rm -rf "$SCRATCH"
  unset SCRATCH ORCH_DIR FIXTURE_BIN JOBS_ROOT WORKTREE_BASE
  unset DISPATCH_LOG EMIT_LOG STATE_LOG
  unset CATALYST_STATE_SCRIPT CATALYST_PHASE_DISPATCH_BIN
  unset CATALYST_PHASE_EMIT_COMPLETE_BIN CATALYST_HEALTHCHECK_JOBS_ROOT
  unset CATALYST_REVIVE_WORKTREE_BASE
}

# make_per_phase_signal TICKET PHASE STATUS BG_ID
make_per_phase_signal() {
  local ticket="$1" phase="$2" status="$3" bg="${4:-bg-$$}"
  local ts; ts=$(now_iso)
  mkdir -p "$ORCH_DIR/workers/$ticket"
  jq -n \
    --arg t "$ticket" --arg p "$phase" --arg s "$status" \
    --arg bg "$bg" --arg ts "$ts" \
    '{ticket:$t, phase:$p, status:$s, orchestrator:"e2e-orch",
      model:"opus", turnCap:25, bg_job_id:$bg,
      startedAt:$ts, updatedAt:$ts}' \
    > "$ORCH_DIR/workers/$ticket/phase-$phase.json"
}

# make_stale_state_json BG_ID — write a state.json under JOBS_ROOT/<bg>/ with
# an mtime 10 minutes in the past so healthcheck's --stale-bg-seconds 60 flags it.
#
# `touch -t` interprets its argument as local time (not UTC), which means a
# `date -u -v-10M` round-trip ends up writing a *future* timestamp on hosts
# whose TZ is east of UTC. Use the relative-offset forms instead:
#   - macOS/BSD: `touch -A -001000` (subtract 10 minutes)
#   - GNU:       `touch -d '10 minutes ago'`
make_stale_state_json() {
  local bg="$1"
  mkdir -p "$JOBS_ROOT/$bg"
  echo '{"state":"running","id":"'"$bg"'"}' > "$JOBS_ROOT/$bg/state.json"
  # macOS first; fall back to GNU.
  touch -A -001000 "$JOBS_ROOT/$bg/state.json" 2>/dev/null \
    || touch -d '10 minutes ago' "$JOBS_ROOT/$bg/state.json" 2>/dev/null \
    || true
}

# ─── Scenario 1: healthcheck marks stalled → revive re-dispatches ───────────
echo "scenario 1 (CTL-493 Phase 4): stalled → re-dispatch"
scratch_setup
make_per_phase_signal "E-1" "implement" "running" "bg-e1"
make_stale_state_json "bg-e1"

"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "e2e-orch" \
  --grace-seconds 0 --stale-bg-seconds 1 > "${SCRATCH}/hc.out" 2>"${SCRATCH}/hc.err"
STATUS_AFTER_HC=$(jq -r '.status' "$ORCH_DIR/workers/E-1/phase-implement.json")
if [ "$STATUS_AFTER_HC" = "stalled" ]; then
  pass "healthcheck transitions running→stalled"
else
  fail "healthcheck transitions to stalled" "got: $STATUS_AFTER_HC stderr: $(cat "${SCRATCH}/hc.err")"
fi

PATH="${FIXTURE_BIN}:$PATH" \
  "$REVIVE" --orch-dir "$ORCH_DIR" --orch-id "e2e-orch" \
  > "${SCRATCH}/rev.out" 2>"${SCRATCH}/rev.err"

if grep -q "dispatch-called.*implement.*E-1" "$DISPATCH_LOG"; then
  pass "revive re-dispatches the stalled phase agent"
else
  fail "revive re-dispatches" "dispatch log: $(cat "$DISPATCH_LOG") rev stderr: $(cat "${SCRATCH}/rev.err")"
fi

PRC=$(jq -r '.phaseReviveCount' "$ORCH_DIR/workers/E-1/phase-implement.json")
if [ "$PRC" = "1" ]; then
  pass "phaseReviveCount bumped to 1 after first revive"
else
  fail "phaseReviveCount=1" "got: $PRC"
fi

STATUS_AFTER_REVIVE=$(jq -r '.status' "$ORCH_DIR/workers/E-1/phase-implement.json")
if [ "$STATUS_AFTER_REVIVE" = "dispatched" ]; then
  pass "signal transitions stalled→dispatched after re-dispatch"
else
  fail "signal transitions stalled→dispatched" "got: $STATUS_AFTER_REVIVE"
fi
scratch_teardown

# ─── Scenario 2: budget exhaustion across multiple revive cycles ────────────
echo "scenario 2 (CTL-493 Phase 4): third revive exhausts budget"
scratch_setup
make_per_phase_signal "E-2" "verify" "stalled" "bg-e2"
# Pre-set phaseReviveCount to 3 so the next revive hits the budget cap.
jq '. + {phaseReviveCount: 3}' "$ORCH_DIR/workers/E-2/phase-verify.json" \
  > "$ORCH_DIR/workers/E-2/phase-verify.json.tmp" \
  && mv "$ORCH_DIR/workers/E-2/phase-verify.json.tmp" \
        "$ORCH_DIR/workers/E-2/phase-verify.json"

PATH="${FIXTURE_BIN}:$PATH" \
  "$REVIVE" --orch-dir "$ORCH_DIR" --orch-id "e2e-orch" \
  --max-phase-revives 3 > "${SCRATCH}/rev.out" 2>"${SCRATCH}/rev.err"

if grep -q "attention.*phase-failed-unrecoverable.*E-2" "$STATE_LOG" \
   && grep -q -- "--actionable false" "$STATE_LOG"; then
  pass "budget-exhausted → attention --actionable false"
else
  fail "budget-exhausted attention" "state log: $(cat "$STATE_LOG")"
fi

if ! grep -q "dispatch-called.*E-2" "$DISPATCH_LOG"; then
  pass "dispatch NOT called after budget exhaustion"
else
  fail "dispatch must not fire when budget exhausted" "log: $(cat "$DISPATCH_LOG")"
fi
scratch_teardown

# ─── Scenario 3: revive iterates multiple workers in one cycle ──────────────
echo "scenario 3 (CTL-493 Phase 4): revive handles multiple stalled workers in one pass"
scratch_setup
make_per_phase_signal "E-3a" "research" "stalled" "bg-e3a"
make_per_phase_signal "E-3b" "verify" "stalled" "bg-e3b"
make_per_phase_signal "E-3c" "plan" "stalled" "bg-e3c"
# Mark E-3b as truly-failed via .failureReason so it should escalate, not re-dispatch.
jq '. + {failureReason: "tests-non-zero-exit"}' \
   "$ORCH_DIR/workers/E-3b/phase-verify.json" > "${SCRATCH}/tmp" \
   && mv "${SCRATCH}/tmp" "$ORCH_DIR/workers/E-3b/phase-verify.json"

PATH="${FIXTURE_BIN}:$PATH" \
  "$REVIVE" --orch-dir "$ORCH_DIR" --orch-id "e2e-orch" \
  > "${SCRATCH}/rev.out" 2>"${SCRATCH}/rev.err"

PMW=$(jq -r '.phaseModeWorkers' "${SCRATCH}/rev.out")
PEL=$(jq -r '.phaseEligible' "${SCRATCH}/rev.out")
PREV=$(jq -r '.phaseRevived' "${SCRATCH}/rev.out")
PESC=$(jq -r '.phaseEscalated' "${SCRATCH}/rev.out")

[ "$PMW" = "3" ] \
  && pass "phaseModeWorkers=3 (all three signals counted)" \
  || fail "phaseModeWorkers=3" "got: $PMW out: $(cat "${SCRATCH}/rev.out")"
[ "$PEL" = "3" ] \
  && pass "phaseEligible=3 (all three stalled)" \
  || fail "phaseEligible=3" "got: $PEL"
[ "$PREV" = "2" ] \
  && pass "phaseRevived=2 (E-3a + E-3c re-dispatched)" \
  || fail "phaseRevived=2" "got: $PREV"
[ "$PESC" = "1" ] \
  && pass "phaseEscalated=1 (E-3b truly-failed)" \
  || fail "phaseEscalated=1" "got: $PESC"

grep -q "dispatch-called.*research.*E-3a" "$DISPATCH_LOG" \
  && pass "E-3a re-dispatched" \
  || fail "E-3a re-dispatched" "log: $(cat "$DISPATCH_LOG")"
grep -q "attention.*phase-failed-unrecoverable.*E-3b" "$STATE_LOG" \
  && pass "E-3b escalated (truly-failed)" \
  || fail "E-3b escalated" "state log: $(cat "$STATE_LOG")"
grep -q "dispatch-called.*plan.*E-3c" "$DISPATCH_LOG" \
  && pass "E-3c re-dispatched" \
  || fail "E-3c re-dispatched" "log: $(cat "$DISPATCH_LOG")"
scratch_teardown

# ─── Scenario 4: missing config still doesn't crash revive ──────────────────
# Documents the worktree-derivation fallback: when no config is present and
# CATALYST_REVIVE_WORKTREE_BASE is unset, the meaningful-progress check
# silently returns "no progress" so the worker is re-dispatched.
echo "scenario 4 (CTL-493 Phase 4): missing config → revive still runs safely"
scratch_setup
unset CATALYST_REVIVE_WORKTREE_BASE
make_per_phase_signal "E-4" "implement" "stalled" "bg-e4"

PATH="${FIXTURE_BIN}:$PATH" \
  "$REVIVE" --orch-dir "$ORCH_DIR" --orch-id "e2e-orch" \
  > "${SCRATCH}/rev.out" 2>"${SCRATCH}/rev.err"
RC=$?

[ "$RC" = "0" ] \
  && pass "revive exits 0 even without worktree-base config" \
  || fail "revive exits 0" "rc=$RC stderr=$(cat "${SCRATCH}/rev.err")"
grep -q "dispatch-called.*implement.*E-4" "$DISPATCH_LOG" \
  && pass "fallback path → re-dispatch fires" \
  || fail "fallback re-dispatch" "log: $(cat "$DISPATCH_LOG")"
scratch_teardown

echo ""
echo "────────────────────────────────────────────────"
echo "E2E Results: ${PASSES} pass, ${FAILURES} fail"
echo "────────────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
