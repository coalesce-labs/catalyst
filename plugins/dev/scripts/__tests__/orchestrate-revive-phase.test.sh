#!/usr/bin/env bash
# Shell tests for orchestrate-revive phase-agent recovery branch (CTL-493).
#
# Phase 2 (this file): structural per-phase iteration. The script must detect
# per-phase signals at workers/<T>/phase-*.json (independent of the legacy
# top-level workers/<T>.json) and report eligible/total counts in its
# dry-run JSON summary. No recovery action yet — Phase 3 adds the decision
# tree.
#
# Phase 3 cases live at the bottom of this file (extends the same fixture).
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

  # Fake state script — logs argv. We need it executable and on PATH for the
  # CTL-493 escalate branch (calls catalyst-state.sh attention ...).
  cat > "${FIXTURE_BIN}/catalyst-state.sh" <<EOF2
#!/usr/bin/env bash
echo "\$@" >> "$STATE_LOG"
EOF2
  chmod +x "${FIXTURE_BIN}/catalyst-state.sh"
  export CATALYST_STATE_SCRIPT="${FIXTURE_BIN}/catalyst-state.sh"

  # Fake phase-agent-dispatch — logs argv. We override the canonical script
  # by placing this on PATH first; orchestrate-revive resolves dispatch via
  # PLUGIN_ROOT (its own SCRIPT_DIR), so we also accept an env override.
  cat > "${FIXTURE_BIN}/phase-agent-dispatch" <<EOF2
#!/usr/bin/env bash
echo "dispatch-called: \$*" >> "$DISPATCH_LOG"
exit 0
EOF2
  chmod +x "${FIXTURE_BIN}/phase-agent-dispatch"
  export CATALYST_PHASE_DISPATCH_BIN="${FIXTURE_BIN}/phase-agent-dispatch"

  # Fake phase-agent-emit-complete — logs argv and mutates the per-phase
  # signal (.status = "done") to match the canonical script's contract.
  cat > "${FIXTURE_BIN}/phase-agent-emit-complete" <<EOF2
#!/usr/bin/env bash
echo "emit-complete-called: \$*" >> "$EMIT_LOG"
# Parse --phase, --ticket, --orch-dir from argv
P=""
T=""
OD=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    --phase) P="\$2"; shift 2 ;;
    --ticket) T="\$2"; shift 2 ;;
    --orch-dir) OD="\$2"; shift 2 ;;
    *) shift ;;
  esac
done
SIG="\$OD/workers/\$T/phase-\$P.json"
if [ -f "\$SIG" ]; then
  TS=\$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq --arg ts "\$ts" '.status = "done" | .completedAt = "\$TS" | .updatedAt = "\$TS"' \
    "\$SIG" > "\$SIG.tmp" 2>/dev/null && mv "\$SIG.tmp" "\$SIG" || true
fi
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

# run_revive [extra args...] — runs orchestrate-revive --dry-run, capturing
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

# ─── Phase 3 tests ─────────────────────────────────────────────────────────────
#
# Phase 3 adds the decision tree (meaningful-progress | re-dispatch | escalate).
# Tests below exercise the real (non-dry-run) iteration loop.

# run_revive [extra args...] — non-dry-run.
run_revive() {
  OUT_JSON="${SCRATCH}/out.json"
  OUT_ERR="${SCRATCH}/out.err"
  PATH="${FIXTURE_BIN}:$PATH" \
    "$REVIVE" --orch-dir "$ORCH_DIR" --orch-id "test-orch" "$@" \
    > "$OUT_JSON" 2>"$OUT_ERR"
}

# make_fake_worktree_with_commits TICKET N — create a fake git worktree with
# N commits ahead of origin/main. Used to simulate "meaningful progress".
make_fake_worktree_with_commits() {
  local ticket="$1" n="$2"
  local wt="$WORKTREE_BASE/test-orch-$ticket"
  mkdir -p "$wt"
  git init -q "$wt"
  git -C "$wt" config user.email "test@test"
  git -C "$wt" config user.name "Test"
  git -C "$wt" config commit.gpgsign false
  git -C "$wt" commit --allow-empty -m base -q
  git -C "$wt" branch -m main 2>/dev/null || true
  # Create a fake origin/main pointing at the base commit so rev-list count > 0.
  git -C "$wt" branch -f origin/main HEAD 2>/dev/null || true
  # rev-list expects refs/remotes/origin/main — create that ref directly.
  mkdir -p "$wt/.git/refs/remotes/origin"
  git -C "$wt" rev-parse HEAD > "$wt/.git/refs/remotes/origin/main"
  for i in $(seq 1 "$n"); do
    git -C "$wt" commit --allow-empty -m "c$i" -q
  done
}

# Helper: set REPO_ROOT-equivalent env so phase_has_meaningful_progress can
# resolve worktreeBase from the test's fake config.
set_repo_root_for_revive() {
  REPO_ROOT_FOR_TEST="${SCRATCH}/repo"
  mkdir -p "$REPO_ROOT_FOR_TEST/.catalyst"
  cat > "$REPO_ROOT_FOR_TEST/.catalyst/config.json" <<EOF2
{
  "catalyst": {
    "git": { "baseBranch": "main" },
    "orchestration": { "worktreeBase": "$WORKTREE_BASE" }
  }
}
EOF2
  export CATALYST_REVIVE_REPO_ROOT="$REPO_ROOT_FOR_TEST"
  WORKTREE_BASE="${SCRATCH}/worktrees"
  mkdir -p "$WORKTREE_BASE"
  export CATALYST_REVIVE_WORKTREE_BASE="$WORKTREE_BASE"
}

# ─── Test A: meaningful progress (commits ahead) → emit-complete invoked ─────
echo "test A (CTL-493 Phase 3): commits ahead → emit-complete invoked"
scratch_setup
WORKTREE_BASE="${SCRATCH}/worktrees"
set_repo_root_for_revive
make_per_phase_signal "T-A" "implement" "stalled"
make_fake_worktree_with_commits "T-A" 2
run_revive
grep -q "emit-complete-called.*implement.*T-A" "$EMIT_LOG" \
  && pass "emit-complete invoked for commits-ahead case" \
  || fail "emit-complete invoked for commits-ahead case" "emit log: $(cat "$EMIT_LOG") stderr: $(cat "$OUT_ERR")"
if [ -s "$DISPATCH_LOG" ]; then
  fail "dispatch must NOT fire when progress is meaningful" "log: $(cat "$DISPATCH_LOG")"
else
  pass "dispatch NOT called (correct: progress signal short-circuited)"
fi
scratch_teardown

# ─── Test B: meaningful progress (.artifact set) → emit-complete invoked ─────
echo "test B (CTL-493 Phase 3): .artifact set → emit-complete invoked"
scratch_setup
WORKTREE_BASE="${SCRATCH}/worktrees"
set_repo_root_for_revive
make_per_phase_signal "T-B" "plan" "stalled" '. + {artifact: "/tmp/plan.md"}'
run_revive
grep -q "emit-complete-called.*plan.*T-B" "$EMIT_LOG" \
  && pass "emit-complete invoked when artifact field present" \
  || fail "emit-complete invoked when artifact field present" "emit log: $(cat "$EMIT_LOG") stderr: $(cat "$OUT_ERR")"
scratch_teardown

# ─── Test C: no progress → phase-agent-dispatch invoked, phaseReviveCount=1 ─
echo "test C (CTL-493 Phase 3): no progress → dispatch + phaseReviveCount=1"
scratch_setup
WORKTREE_BASE="${SCRATCH}/worktrees"
set_repo_root_for_revive
make_per_phase_signal "T-C" "research" "stalled"
# No worktree, no artifact — pure no-progress case.
run_revive
grep -q "dispatch-called.*research.*T-C" "$DISPATCH_LOG" \
  && pass "dispatch invoked for no-progress case" \
  || fail "dispatch invoked for no-progress case" "dispatch log: $(cat "$DISPATCH_LOG") stderr: $(cat "$OUT_ERR")"
RC=$(jq -r '.phaseReviveCount' "$ORCH_DIR/workers/T-C/phase-research.json")
[ "$RC" = "1" ] \
  && pass "phaseReviveCount bumped to 1" \
  || fail "phaseReviveCount=1" "got: '$RC' signal: $(cat "$ORCH_DIR/workers/T-C/phase-research.json")"
scratch_teardown

# ─── Test D: phaseReviveCount >= MAX → attention with actionable=false ───────
echo "test D (CTL-493 Phase 3): budget exhausted → attention --actionable false"
scratch_setup
WORKTREE_BASE="${SCRATCH}/worktrees"
set_repo_root_for_revive
make_per_phase_signal "T-D" "verify" "stalled" '. + {phaseReviveCount: 3}'
run_revive --max-phase-revives 3
grep -q "attention.*phase-failed-unrecoverable.*T-D" "$STATE_LOG" \
  && pass "attention call mentions T-D + phase-failed-unrecoverable" \
  || fail "attention call mentions T-D" "state log: $(cat "$STATE_LOG")"
grep -q -- "--actionable false" "$STATE_LOG" \
  && pass "attention call passes --actionable false" \
  || fail "attention call passes --actionable false" "state log: $(cat "$STATE_LOG")"
if grep -q "dispatch-called.*T-D" "$DISPATCH_LOG"; then
  fail "dispatch must NOT be called when budget exhausted" "log: $(cat "$DISPATCH_LOG")"
else
  pass "dispatch NOT called (budget exhausted)"
fi
scratch_teardown

# ─── Test E: explicit failureReason → truly-failed branch (no dispatch) ─────
echo "test E (CTL-493 Phase 3): failureReason set → escalate without retry"
scratch_setup
WORKTREE_BASE="${SCRATCH}/worktrees"
set_repo_root_for_revive
make_per_phase_signal "T-E" "verify" "stalled" '. + {failureReason: "non-zero-exit"}'
run_revive
grep -q "attention.*phase-failed-unrecoverable.*T-E" "$STATE_LOG" \
  && pass "truly-failed escalates via attention" \
  || fail "truly-failed escalates via attention" "state log: $(cat "$STATE_LOG")"
if grep -q "dispatch-called.*T-E" "$DISPATCH_LOG"; then
  fail "dispatch must NOT be called for truly-failed" "log: $(cat "$DISPATCH_LOG")"
else
  pass "dispatch NOT called for truly-failed"
fi
scratch_teardown

echo ""
echo "─────────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
