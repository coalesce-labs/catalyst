#!/usr/bin/env bash
# Shell tests for orchestrate-revive phase-agent recovery branch (CTL-493).
#
# Phase 2 (this file): structural per-phase iteration. The script must detect
# per-phase signals at workers/<T>/phase-*.json (independent of the legacy
# top-level workers/<T>.json) and report eligible/total counts in its JSON
# summary. No recovery action yet — Phase 3 (added in a follow-up commit)
# layers the decision tree.
#
# Run: bash plugins/dev/scripts/__tests__/orchestrate-revive-phase.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
REVIVE="${REPO_ROOT}/plugins/dev/scripts/orchestrate-revive"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

scratch_setup() {
  SCRATCH="$(mktemp -d -t orchestrate-revive-phase-XXXXXX)"
  ORCH_DIR="${SCRATCH}/orch"
  FIXTURE_BIN="${SCRATCH}/bin"
  DISPATCH_LOG="${SCRATCH}/dispatch.log"
  EMIT_LOG="${SCRATCH}/emit.log"
  STATE_LOG="${SCRATCH}/state.log"
  mkdir -p "${ORCH_DIR}/workers/output" "$FIXTURE_BIN" "${SCRATCH}/worktrees"
  : > "$DISPATCH_LOG"
  : > "$EMIT_LOG"
  : > "$STATE_LOG"

  # Fake state script — logs argv. Tests that need to assert no recovery action
  # was triggered just check this log stays empty.
  cat > "${FIXTURE_BIN}/catalyst-state.sh" <<EOF2
#!/usr/bin/env bash
echo "\$@" >> "$STATE_LOG"
EOF2
  chmod +x "${FIXTURE_BIN}/catalyst-state.sh"
  export CATALYST_STATE_SCRIPT="${FIXTURE_BIN}/catalyst-state.sh"

  # Fake phase-agent-dispatch — logs argv. Phase 2 must NOT invoke this.
  cat > "${FIXTURE_BIN}/phase-agent-dispatch" <<EOF2
#!/usr/bin/env bash
echo "dispatch-called: \$*" >> "$DISPATCH_LOG"
exit 0
EOF2
  chmod +x "${FIXTURE_BIN}/phase-agent-dispatch"
  export CATALYST_PHASE_DISPATCH_BIN="${FIXTURE_BIN}/phase-agent-dispatch"

  # Fake phase-agent-emit-complete — logs argv. Phase 2 must NOT invoke this.
  cat > "${FIXTURE_BIN}/phase-agent-emit-complete" <<EOF2
#!/usr/bin/env bash
echo "emit-complete-called: \$*" >> "$EMIT_LOG"
exit 0
EOF2
  chmod +x "${FIXTURE_BIN}/phase-agent-emit-complete"
  export CATALYST_PHASE_EMIT_COMPLETE_BIN="${FIXTURE_BIN}/phase-agent-emit-complete"

  # Stub a never-used claude binary — phase 2 iteration must NOT spawn claude.
  cat > "${FIXTURE_BIN}/claude" <<'EOF2'
#!/usr/bin/env bash
echo "claude-should-not-be-called: $*" >&2
exit 99
EOF2
  chmod +x "${FIXTURE_BIN}/claude"
  export CATALYST_REVIVE_CLAUDE_BIN="${FIXTURE_BIN}/claude"
}

scratch_teardown() {
  rm -rf "$SCRATCH"
  unset SCRATCH ORCH_DIR FIXTURE_BIN DISPATCH_LOG EMIT_LOG STATE_LOG
  unset CATALYST_STATE_SCRIPT CATALYST_PHASE_DISPATCH_BIN
  unset CATALYST_PHASE_EMIT_COMPLETE_BIN CATALYST_REVIVE_CLAUDE_BIN
}

# make_per_phase_signal TICKET PHASE STATUS [EXTRA_JQ]
# Writes ${ORCH_DIR}/workers/<TICKET>/phase-<PHASE>.json with the production
# signal shape (matches phase-agent-dispatch's signal contract).
make_per_phase_signal() {
  local ticket="$1" phase="$2" status="$3" extra="${4:-.}"
  local ts; ts=$(now_iso)
  mkdir -p "$ORCH_DIR/workers/$ticket"
  jq -n \
    --arg t "$ticket" --arg p "$phase" --arg s "$status" --arg ts "$ts" \
    --arg pid "$$" \
    '{ticket:$t, phase:$p, status:$s, orchestrator:"test-orch",
      model:"opus", turnCap:25, bg_job_id:("fake-bg-"+$pid),
      startedAt:$ts, updatedAt:$ts}' \
    | jq "$extra" \
    > "$ORCH_DIR/workers/$ticket/phase-$phase.json"
}

# run_revive_dry [extra args...] — runs orchestrate-revive --dry-run, capturing
# stdout (the JSON summary) into $OUT_JSON and stderr into $OUT_ERR.
run_revive_dry() {
  OUT_JSON="${SCRATCH}/out.json"
  OUT_ERR="${SCRATCH}/out.err"
  PATH="${FIXTURE_BIN}:$PATH" \
    "$REVIVE" --orch-dir "$ORCH_DIR" --orch-id "test-orch" --dry-run "$@" \
    > "$OUT_JSON" 2>"$OUT_ERR"
}

# ─── Test 1: structural detection — workers/<T>/phase-*.json triggers branch ─
echo "test 1 (CTL-493 Phase 2): structural detection reports phase-mode worker"
scratch_setup
make_per_phase_signal "T-1" "implement" "stalled"
run_revive_dry
PHASE_MODE=$(jq -r '.phaseModeWorkers // empty' "$OUT_JSON")
[ "$PHASE_MODE" = "1" ] \
  && pass "phaseModeWorkers=1 reported" \
  || fail "phaseModeWorkers=1" "got: '$PHASE_MODE' stdout: $(cat "$OUT_JSON") stderr: $(cat "$OUT_ERR")"
grep -q "phase-mode worker detected: T-1" "$OUT_ERR" \
  && pass "stderr logs detection" \
  || fail "stderr logs detection" "stderr: $(cat "$OUT_ERR")"
scratch_teardown

# ─── Test 2: no per-phase dir → no false positives ───────────────────────────
echo "test 2 (CTL-493 Phase 2): no phase-* signals → phaseModeWorkers=0"
scratch_setup
# Empty orch dir — no signals at all.
run_revive_dry
PHASE_MODE=$(jq -r '.phaseModeWorkers // 0' "$OUT_JSON")
[ "$PHASE_MODE" = "0" ] \
  && pass "phaseModeWorkers=0 when no signals exist" \
  || fail "phaseModeWorkers=0" "got: '$PHASE_MODE'"
scratch_teardown

# ─── Test 3: signal exists but status != stalled → not eligible ──────────────
echo "test 3 (CTL-493 Phase 2): status=running → phaseModeWorkers=1, eligible=0"
scratch_setup
make_per_phase_signal "T-2" "implement" "running"
run_revive_dry
PHASE_MODE=$(jq -r '.phaseModeWorkers // empty' "$OUT_JSON")
ELIGIBLE=$(jq -r '.phaseEligible // empty' "$OUT_JSON")
[ "$PHASE_MODE" = "1" ] \
  && pass "phaseModeWorkers=1 (signal counted)" \
  || fail "phaseModeWorkers=1" "got: '$PHASE_MODE'"
[ "$ELIGIBLE" = "0" ] \
  && pass "phaseEligible=0 (running ≠ stalled)" \
  || fail "phaseEligible=0" "got: '$ELIGIBLE'"
scratch_teardown

# ─── Test 4: mixed signals — one stalled + one running across two tickets ───
echo "test 4 (CTL-493 Phase 2): mixed statuses → only stalled counted as eligible"
scratch_setup
make_per_phase_signal "T-3" "research" "stalled"
make_per_phase_signal "T-4" "implement" "running"
run_revive_dry
PHASE_MODE=$(jq -r '.phaseModeWorkers // empty' "$OUT_JSON")
ELIGIBLE=$(jq -r '.phaseEligible // empty' "$OUT_JSON")
[ "$PHASE_MODE" = "2" ] \
  && pass "phaseModeWorkers=2 (both signals counted)" \
  || fail "phaseModeWorkers=2" "got: '$PHASE_MODE'"
[ "$ELIGIBLE" = "1" ] \
  && pass "phaseEligible=1 (only stalled)" \
  || fail "phaseEligible=1" "got: '$ELIGIBLE'"
scratch_teardown

# ─── Test 5: Phase 2 must NOT spawn claude or call dispatch/emit-complete ────
echo "test 5 (CTL-493 Phase 2): dry-run only — no recovery action triggered"
scratch_setup
make_per_phase_signal "T-5" "verify" "stalled"
run_revive_dry
if [ -s "$DISPATCH_LOG" ]; then
  fail "dispatch must not be called in Phase 2 dry-run" "log: $(cat "$DISPATCH_LOG")"
else
  pass "dispatch NOT invoked"
fi
if [ -s "$EMIT_LOG" ]; then
  fail "emit-complete must not be called in Phase 2 dry-run" "log: $(cat "$EMIT_LOG")"
else
  pass "emit-complete NOT invoked"
fi
scratch_teardown

echo ""
echo "─────────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
