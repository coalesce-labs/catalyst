#!/usr/bin/env bash
# Tests for the Phase-3 phase-agent skills (CTL-449 Initiative 1 Phase 3):
#   - plugins/dev/skills/phase-implement/SKILL.md
#   - plugins/dev/skills/phase-pr/SKILL.md
#   - plugins/dev/skills/phase-monitor-merge/SKILL.md
# and the `--phase` flag added to plugins/dev/scripts/orchestrate-dispatch-next.
#
# Approach (per plan §Initiative 1 Phase 3):
#   * Structural contract — grep each SKILL.md to assert the template prelude,
#     /goal line, prior-artifact gate, delegation to the canonical skill, and
#     the standard phase-agent-emit-complete end block are present.
#   * Event-emission contract — invoke phase-agent-emit-complete with each new
#     phase name (implement / pr / monitor-merge) and assert the resulting
#     canonical JSONL line carries the right event.name + payload.phase. This
#     end-to-end test catches regressions in the broker phase_lifecycle route
#     keying off the event name pattern (CTL-447).
#
# The full "phase agent runs claude --bg, reads plan, commits, opens PR"
# round-trip cannot be exercised in a unit test (it requires a live claude
# session, a writable LinearAPI token, a real GitHub repo, and real-time
# webhook delivery). We assert the agent-side contract that the dispatcher
# (CTL-448) + canonical event log (CTL-300) + broker route (CTL-447) depend
# on; the actual `--bg` round-trip is covered by the manual verification
# steps in the plan's Success Criteria.
#
# Run: bash plugins/dev/scripts/__tests__/phase-implement-e2e.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
EMIT_SCRIPT="${REPO_ROOT}/plugins/dev/scripts/phase-agent-emit-complete"
DISPATCH_SCRIPT="${REPO_ROOT}/plugins/dev/scripts/orchestrate-dispatch-next"
PHASE_DISPATCH="${REPO_ROOT}/plugins/dev/scripts/phase-agent-dispatch"
SKILL_IMPLEMENT="${REPO_ROOT}/plugins/dev/skills/phase-implement/SKILL.md"
SKILL_PR="${REPO_ROOT}/plugins/dev/skills/phase-pr/SKILL.md"
SKILL_MONITOR_MERGE="${REPO_ROOT}/plugins/dev/skills/phase-monitor-merge/SKILL.md"
# shellcheck source=lib/linearis-stub.sh
source "${SCRIPT_DIR}/lib/linearis-stub.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t phase-implement-e2e-XXXXXX)"
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

assert_file() {
  local path="$1" label="$2"
  if [[ -f "$path" ]]; then
    pass "$label"
  else
    fail "$label — file missing: $path"
  fi
}

assert_grep() {
  local pattern="$1" file="$2" label="$3"
  if grep -q -E "$pattern" "$file" 2>/dev/null; then
    pass "$label"
  else
    fail "$label — pattern '$pattern' not found in $(basename "$file")"
  fi
}
assert_not_grep() {
  local pattern="$1" file="$2" label="$3"
  if grep -q -E -- "$pattern" "$file" 2>/dev/null; then
    fail "$label — pattern '$pattern' unexpectedly present in $(basename "$file")"
  else
    pass "$label"
  fi
}

# Per-test sandbox for emit-complete invocations.
fresh_env() {
  local tag="$1"
  TEST_DIR="${SCRATCH}/${tag}"
  mkdir -p "${TEST_DIR}/catalyst/events"
  mkdir -p "${TEST_DIR}/orch/workers/CTL-449"
  export CATALYST_DIR="${TEST_DIR}/catalyst"
  export CATALYST_ORCHESTRATOR_DIR="${TEST_DIR}/orch"
  export CATALYST_ORCHESTRATOR_ID="orch-e2e"
  export CATALYST_SESSION_ID="sess_e2e_${tag}"
}

read_event_line() {
  local month
  month=$(date -u +%Y-%m)
  local logfile="${CATALYST_DIR}/events/${month}.jsonl"
  [[ -f "$logfile" ]] || { echo ""; return 1; }
  grep -F '"event.name":"phase.' "$logfile" | tail -n 1
}

# ─── Test 1: phase-implement SKILL.md exists + reads plan + commits per phase
echo "Test 1: phase-implement SKILL.md contract (plan path + TDD per-phase + commits)"
assert_file "$SKILL_IMPLEMENT" "phase-implement/SKILL.md exists"
if [[ -f "$SKILL_IMPLEMENT" ]]; then
  assert_grep '^name: phase-implement$' "$SKILL_IMPLEMENT" "frontmatter: name: phase-implement"
  # CTL-490: phase skills are dispatched via `claude --bg "/catalyst-dev:phase-X ..."`,
  # which the bg session parses as a user slash command. Both flags must permit
  # invocation by humans (slash) AND the model (Skill tool) so the dispatcher
  # path and any direct invocation both resolve.
  assert_grep '^user-invocable: true' "$SKILL_IMPLEMENT" "frontmatter: user-invocable: true (CTL-490)"
  assert_grep '^disable-model-invocation: false' "$SKILL_IMPLEMENT" "frontmatter: disable-model-invocation: false (CTL-490)"
  # Reads the plan from the canonical thoughts/ location (per plan §"per-phase artifact").
  # phase-agent-dispatch already validates the prior artifact glob, but the skill
  # body must also reference the path so it can read+pass it to implement-plan.
  assert_grep 'thoughts/shared/plans' "$SKILL_IMPLEMENT" "skill body references thoughts/shared/plans"
  # Delegates the heavy lifting to the canonical skill (architectural
  # commitment #3 in plan §"Implementation Approach").
  assert_grep '/catalyst-dev:implement-plan' "$SKILL_IMPLEMENT" "delegates to /catalyst-dev:implement-plan"
fi

# ─── Test 2: phase-implement does NOT self-transition Linear + has correct /goal
echo ""
echo "Test 2: phase-implement leaves Linear write-back to the coordinator (CTL-558)"
if [[ -f "$SKILL_IMPLEMENT" ]]; then
  # CTL-558: Linear status write-back moved to the deterministic coordinator
  # (execution-core scheduler / orchestrate-phase-advance). The phase agent no
  # longer shells linear-transition.sh.
  assert_not_grep 'linear-transition\.sh' "$SKILL_IMPLEMENT" "does NOT shell linear-transition.sh"
  assert_not_grep '[-][-]transition inProgress' "$SKILL_IMPLEMENT" "does NOT self-transition Linear to inProgress"
  # /goal condition exists and matches the plan's transcript-evaluable shape
  # (git diff non-empty AND tests pass).
  assert_grep '^/goal' "$SKILL_IMPLEMENT" "declares a /goal line"
  assert_grep 'git diff' "$SKILL_IMPLEMENT" "/goal references git diff (diff non-empty)"
fi

# ─── Test 3: phase-implement emits phase.implement.complete.<TICKET> on success
echo ""
echo "Test 3: phase-agent-emit-complete --phase implement emits correct event shape"
fresh_env t3
"$EMIT_SCRIPT" --phase implement --ticket CTL-449 --status complete >/dev/null 2>&1
LINE=$(read_event_line)
if [[ -z "$LINE" ]]; then
  fail "Test 3: no event emitted for phase=implement"
else
  EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"')
  SEVERITY=$(echo "$LINE" | jq -r '.severityText')
  PAYLOAD_PHASE=$(echo "$LINE" | jq -r '.body.payload.phase')
  PAYLOAD_TICKET=$(echo "$LINE" | jq -r '.body.payload.ticket')
  assert_eq "phase.implement.complete.CTL-449" "$EVENT_NAME" "event.name = phase.implement.complete.CTL-449"
  assert_eq "INFO"      "$SEVERITY"       "complete → INFO severity"
  assert_eq "implement" "$PAYLOAD_PHASE"  "body.payload.phase = implement"
  assert_eq "CTL-449"   "$PAYLOAD_TICKET" "body.payload.ticket = CTL-449"
fi

# ─── Test 4: phase-implement emits phase.implement.failed on /goal turn-cap hit
echo ""
echo "Test 4: phase-agent-emit-complete --phase implement --status failed carries failure_reason"
fresh_env t4
"$EMIT_SCRIPT" --phase implement --ticket CTL-449 --status failed --reason "turn cap hit (75)" >/dev/null 2>&1
LINE=$(read_event_line)
if [[ -z "$LINE" ]]; then
  fail "Test 4: no event emitted for phase=implement (failed)"
else
  EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"')
  SEVERITY=$(echo "$LINE" | jq -r '.severityText')
  REASON=$(echo "$LINE" | jq -r '.body.payload.failure_reason')
  assert_eq "phase.implement.failed.CTL-449" "$EVENT_NAME" "event.name = phase.implement.failed.CTL-449"
  assert_eq "WARN"               "$SEVERITY" "failed → WARN severity"
  assert_eq "turn cap hit (75)"  "$REASON"   "body.payload.failure_reason carries reason"
fi

# ─── Test 5: phase-pr — delegates to /catalyst-dev:create-pr + emits phase.pr.complete
echo ""
echo "Test 5: phase-pr SKILL.md contract + emit-complete event shape"
assert_file "$SKILL_PR" "phase-pr/SKILL.md exists"
if [[ -f "$SKILL_PR" ]]; then
  assert_grep '^name: phase-pr$' "$SKILL_PR" "frontmatter: name: phase-pr"
  # Delegates to create-pr which auto-runs describe-pr and moves Linear to
  # inReview (plan §"Phase agents wrap canonical skills").
  assert_grep '/catalyst-dev:create-pr' "$SKILL_PR" "delegates to /catalyst-dev:create-pr"
  assert_grep '^/goal' "$SKILL_PR" "declares a /goal line"
fi

fresh_env t5
"$EMIT_SCRIPT" --phase pr --ticket CTL-449 --status complete >/dev/null 2>&1
LINE=$(read_event_line)
if [[ -z "$LINE" ]]; then
  fail "Test 5: no event emitted for phase=pr"
else
  EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"')
  PAYLOAD_PHASE=$(echo "$LINE" | jq -r '.body.payload.phase')
  assert_eq "phase.pr.complete.CTL-449" "$EVENT_NAME" "event.name = phase.pr.complete.CTL-449"
  assert_eq "pr"                        "$PAYLOAD_PHASE" "body.payload.phase = pr"
fi

# ─── Test 6: phase-monitor-merge — reactive PR lifecycle + emits phase.monitor-merge.complete
echo ""
echo "Test 6: phase-monitor-merge SKILL.md reactive listen loop + emit-complete event shape"
assert_file "$SKILL_MONITOR_MERGE" "phase-monitor-merge/SKILL.md exists"
if [[ -f "$SKILL_MONITOR_MERGE" ]]; then
  assert_grep '^name: phase-monitor-merge$' "$SKILL_MONITOR_MERGE" "frontmatter: name: phase-monitor-merge"
  # Reuses the reactive PR-lifecycle pattern (CTL-228 monitor-events Pattern 3).
  # The listen loop must wait on events rather than polling, so the skill body
  # must reference catalyst-events wait-for and the GitHub event filter.
  assert_grep 'catalyst-events wait-for' "$SKILL_MONITOR_MERGE" "uses catalyst-events wait-for (event-driven loop)"
  assert_grep 'github\.pr\.merged|github\.check_suite|github\.pr_review' "$SKILL_MONITOR_MERGE" \
    "references GitHub PR-lifecycle event names"
  # Transitions Linear to done on merge (per plan §Linear Integration table).
  assert_grep 'linear-transition\.sh' "$SKILL_MONITOR_MERGE" "calls linear-transition.sh"
  assert_grep '\bdone\b' "$SKILL_MONITOR_MERGE" "transitions Linear to done"
  assert_grep '^/goal' "$SKILL_MONITOR_MERGE" "declares a /goal line"
fi

fresh_env t6
"$EMIT_SCRIPT" --phase monitor-merge --ticket CTL-449 --status complete >/dev/null 2>&1
LINE=$(read_event_line)
if [[ -z "$LINE" ]]; then
  fail "Test 6: no event emitted for phase=monitor-merge"
else
  EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"')
  PAYLOAD_PHASE=$(echo "$LINE" | jq -r '.body.payload.phase')
  assert_eq "phase.monitor-merge.complete.CTL-449" "$EVENT_NAME" "event.name = phase.monitor-merge.complete.CTL-449"
  assert_eq "monitor-merge"                        "$PAYLOAD_PHASE" "body.payload.phase = monitor-merge"
fi

# ─── Test 7: orchestrate-dispatch-next --phase routes through phase-agent-dispatch
# The legacy path runs `claude -p` directly; the new --phase path delegates to
# phase-agent-dispatch which runs `claude --bg`. We exercise the dispatcher
# end-to-end with a stub claude that captures argv and assert the --bg flag is
# present iff --phase is set. Backward compatibility (no --phase) is covered by
# the existing orchestrate-dispatch-next.test.sh — this test only covers the new
# routing branch.
echo ""
echo "Test 7: orchestrate-dispatch-next --phase delegates to phase-agent-dispatch (--bg path)"
T7="${SCRATCH}/t7"
mkdir -p "${T7}/orch/workers/output" "${T7}/wt/demo-T-1" "${T7}/bin"

# Stub claude — logs argv. The dispatch path is:
#   orchestrate-dispatch-next --phase implement → phase-agent-dispatch → claude --bg
# so the captured argv must include "--bg" plus the phase prompt
# "/catalyst-dev:phase-implement T-1 …".
cat > "${T7}/bin/claude" <<'STUB'
#!/usr/bin/env bash
# CTL-490: mimic today's real `claude --bg` stdout shape so the dispatcher's
# hex-grep parser finds an 8-char hex job ID (e7f8a9b0 here).
LOG="${CLAUDE_STUB_LOG}"
{
  echo "args: $*"
  env | grep -E '^CATALYST_(ORCHESTRATOR_(DIR|ID)|PHASE|TICKET|COMMS_CHANNEL|SESSION_ID)=' | sort
} >> "$LOG"
cat <<EOF
backgrounded · e7f8a9b0
  claude agents             list sessions
  claude attach e7f8a9b0    open in this terminal
EOF
exit 0
STUB
chmod +x "${T7}/bin/claude"
CLAUDE_STUB_LOG_T7="${T7}/claude.log"
: > "$CLAUDE_STUB_LOG_T7"

# Fake catalyst-state.sh — eats argv (we don't assert on it here; covered by
# the existing dispatch test suite).
cat > "${T7}/bin/catalyst-state.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "${T7}/bin/catalyst-state.sh"

# Minimal state.json with one ticket in wave1Pending.
cat > "${T7}/orch/state.json" <<EOF
{
  "orchestrator": "demo",
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "baseBranch": "main",
  "worktreeBase": "${T7}/wt",
  "maxParallel": 1,
  "totalWaves": 1,
  "currentWave": 1,
  "queue": {"wave1Pending": ["T-1"]},
  "workers": {}
}
EOF

# Required: the worker's wave briefing dir / artifact existence is the prior-
# artifact gate's concern, NOT orchestrate-dispatch-next's. The dispatcher only
# checks for the worktree dir, which we made above. For --phase implement, the
# downstream phase-agent-dispatch will refuse because thoughts/shared/plans/*-t-1.md
# doesn't exist. So we exercise --phase triage instead (no prior artifact gate
# per phase-agent-dispatch's prior_artifact_for_phase table).
CLAUDE_STUB_LOG="$CLAUDE_STUB_LOG_T7" \
  CATALYST_STATE_SCRIPT="${T7}/bin/catalyst-state.sh" \
  CATALYST_DISPATCH_CLAUDE_BIN="${T7}/bin/claude" \
  CATALYST_DISPATCH_HEALTHCHECK="" \
  "$DISPATCH_SCRIPT" \
    --orch-dir "${T7}/orch" \
    --phase triage \
    >"${T7}/out" 2>"${T7}/err"
RC=$?

assert_eq "0" "$RC" "dispatcher exits 0 with --phase triage"
SIGNAL_TRIAGE="${T7}/orch/workers/T-1/phase-triage.json"
[[ -f "$SIGNAL_TRIAGE" ]] && pass "phase-triage.json signal written" \
  || fail "phase-triage.json signal written — expected at $SIGNAL_TRIAGE"
LOG=$(cat "$CLAUDE_STUB_LOG_T7" 2>/dev/null || echo "")
if [[ -n "$LOG" ]]; then
  if grep -q -- "--bg" <<<"$LOG"; then
    pass "claude invoked with --bg (event-driven dispatch path)"
  else
    fail "claude invoked with --bg (event-driven dispatch path) — log: $LOG"
  fi
  if grep -q "/catalyst-dev:phase-triage T-1" <<<"$LOG"; then
    pass "prompt is /catalyst-dev:phase-triage with ticket"
  else
    fail "prompt is /catalyst-dev:phase-triage with ticket — log: $LOG"
  fi
  if grep -q "CATALYST_PHASE=triage" <<<"$LOG"; then
    pass "env carries CATALYST_PHASE=triage"
  else
    fail "env carries CATALYST_PHASE=triage — log: $LOG"
  fi
else
  fail "claude stub captured no invocation"
fi

# ─── Test 8: orchestrate-dispatch-next without --phase preserves legacy path
echo ""
echo "Test 8: orchestrate-dispatch-next without --phase uses legacy /catalyst-dev:oneshot path"
T8="${SCRATCH}/t8"
mkdir -p "${T8}/orch/workers/output" "${T8}/wt/demo-T-1" "${T8}/bin"

# Same stub set as Test 7 but the dispatch path is legacy (-p oneshot) — no --bg.
cat > "${T8}/bin/claude" <<'STUB'
#!/usr/bin/env bash
LOG="${CLAUDE_STUB_LOG}"
echo "args: $*" >> "$LOG"
sleep 30 &
disown $! 2>/dev/null || true
STUB
chmod +x "${T8}/bin/claude"
CLAUDE_STUB_LOG_T8="${T8}/claude.log"
: > "$CLAUDE_STUB_LOG_T8"

cat > "${T8}/bin/catalyst-state.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "${T8}/bin/catalyst-state.sh"

cat > "${T8}/orch/state.json" <<EOF
{
  "orchestrator": "demo",
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "baseBranch": "main",
  "worktreeBase": "${T8}/wt",
  "maxParallel": 1,
  "totalWaves": 1,
  "currentWave": 1,
  "queue": {"wave1Pending": ["T-1"]},
  "workers": {}
}
EOF

CLAUDE_STUB_LOG="$CLAUDE_STUB_LOG_T8" \
  CATALYST_STATE_SCRIPT="${T8}/bin/catalyst-state.sh" \
  CATALYST_DISPATCH_CLAUDE_BIN="${T8}/bin/claude" \
  CATALYST_DISPATCH_HEALTHCHECK="" \
  "$DISPATCH_SCRIPT" \
    --orch-dir "${T8}/orch" \
    >"${T8}/out" 2>"${T8}/err"
RC=$?

assert_eq "0" "$RC" "dispatcher exits 0 without --phase (legacy path)"
# Legacy signal file at workers/T-1.json, not workers/T-1/phase-*.json
[[ -f "${T8}/orch/workers/T-1.json" ]] && pass "legacy worker signal file written" \
  || fail "legacy worker signal file written"
LOG=$(cat "$CLAUDE_STUB_LOG_T8" 2>/dev/null || echo "")
if [[ -n "$LOG" ]]; then
  if grep -q -- "-p .*catalyst-dev:oneshot" <<<"$LOG"; then
    pass "legacy path runs claude -p /catalyst-dev:oneshot"
  else
    fail "legacy path runs claude -p /catalyst-dev:oneshot — log: $LOG"
  fi
  if grep -q -- "--bg" <<<"$LOG"; then
    fail "legacy path must NOT use --bg — log: $LOG"
  else
    pass "legacy path does NOT use --bg"
  fi
else
  fail "claude stub captured no invocation"
fi

# ─── Test 9 (CTL-484): phase-implement turn-cap handoff write + new emit shape
echo ""
echo "Test 9 (CTL-484): phase-implement SKILL.md has continuation preamble + handoff write block"
if [[ -f "$SKILL_IMPLEMENT" ]]; then
  # Prelude check for CATALYST_IS_CONTINUATION — the resumed worker reads
  # CATALYST_HANDOFF_PATH and orients without re-walking the plan.
  assert_grep 'CATALYST_IS_CONTINUATION' "$SKILL_IMPLEMENT" "Prelude checks CATALYST_IS_CONTINUATION env var"
  assert_grep 'CATALYST_HANDOFF_PATH'    "$SKILL_IMPLEMENT" "Prelude reads CATALYST_HANDOFF_PATH"
  # Failure block has a turn-cap branch that writes a handoff and emits
  # --status turn-cap-exhausted --handoff-path <path>.
  assert_grep 'turn-cap-exhausted' "$SKILL_IMPLEMENT" "skill body references turn-cap-exhausted status"
  assert_grep 'turn-cap-continuation\.md|turn-cap-continuation' "$SKILL_IMPLEMENT" "writes handoff named turn-cap-continuation.md"
  assert_grep '\-\-handoff-path' "$SKILL_IMPLEMENT" "passes --handoff-path to phase-agent-emit-complete"
  # /goal block updated to describe the new cap-exit behavior.
  assert_grep 'turn-cap-exhausted|continuation' "$SKILL_IMPLEMENT" "/goal block references turn-cap-exhausted or continuation"
fi

# Test 10 (CTL-484): the new emitter status round-trips through the canonical
# event log and the per-phase signal file when invoked with --handoff-path.
echo ""
echo "Test 10 (CTL-484): emit-complete --status turn-cap-exhausted --handoff-path round-trip"
fresh_env t10
SIGNAL_T10="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-449/phase-implement.json"
echo '{"status":"running","ticket":"CTL-449","phase":"implement"}' > "$SIGNAL_T10"
HANDOFF_T10="thoughts/shared/handoffs/CTL-449/2026-05-17_18-00-00_turn-cap-continuation.md"
"$EMIT_SCRIPT" --phase implement --ticket CTL-449 --status turn-cap-exhausted \
  --reason "turn cap hit (75)" --handoff-path "$HANDOFF_T10" >/dev/null 2>&1
LINE=$(read_event_line)
if [[ -z "$LINE" ]]; then
  fail "Test 10: no event emitted for turn-cap-exhausted"
else
  EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"')
  PAYLOAD_HANDOFF=$(echo "$LINE" | jq -r '.body.payload.handoff_path')
  assert_eq "phase.implement.turn-cap-exhausted.CTL-449" "$EVENT_NAME" "event.name uses .turn-cap-exhausted suffix"
  assert_eq "$HANDOFF_T10" "$PAYLOAD_HANDOFF" "body.payload.handoff_path round-trips"
fi
SIGNAL_STATUS=$(jq -r '.status' "$SIGNAL_T10")
SIGNAL_HANDOFF=$(jq -r '.handoffPath' "$SIGNAL_T10")
assert_eq "turn-cap-exhausted" "$SIGNAL_STATUS" "per-phase signal status = turn-cap-exhausted"
assert_eq "$HANDOFF_T10" "$SIGNAL_HANDOFF" "per-phase signal .handoffPath set"

# ─── Test 11 (CTL-632): phase-implement Linear comment-mirror block ──────
echo ""
echo "Test 11 (CTL-632): phase-implement contract — mirror block present"
if [[ -f "$SKILL_IMPLEMENT" ]]; then
  assert_grep 'phase-implement-mirror' "$SKILL_IMPLEMENT" "body contains uniquely-named mirror fence"
  assert_grep '\.linear-mirror-' "$SKILL_IMPLEMENT" "body references the per-phase marker file"
  assert_grep 'linearis issues discuss' "$SKILL_IMPLEMENT" "body calls linearis issues discuss"
  assert_grep 'linearis discuss failed \(continuing\)' "$SKILL_IMPLEMENT" "body has fail-open warning string"
fi

# ─── Test 12 (CTL-632): runtime mirror exercises ──────────────────────────
echo ""
echo "Test 12 (CTL-632): phase-implement mirror — happy/fail-open/idempotent/no-base"

MIRROR_BODY_FILE="${SCRATCH}/mirror-body.sh"
awk '
  /^```bash phase-implement-mirror$/ {capture=1; next}
  /^```$/ {if (capture) {capture=0}}
  capture { print }
' "$SKILL_IMPLEMENT" > "$MIRROR_BODY_FILE"

if [[ -s "$MIRROR_BODY_FILE" ]]; then
  pass "mirror block extractable from SKILL.md"
else
  fail "mirror block extractable — no \`\`\`bash phase-implement-mirror\`\`\` fence found"
fi

# Build a throwaway git repo so the mirror block's git rev-parse / merge-base
# / log / diff calls have something to operate on.
build_git_fixture() {
  local repo_dir="$1" with_base="${2:-yes}"
  mkdir -p "$repo_dir"
  (
    cd "$repo_dir" || exit 1
    git init --quiet --initial-branch=main
    git config user.email "test@example.com"
    git config user.name "Test"
    echo "base" > base.txt
    git add base.txt
    git commit --quiet -m "base commit"
    if [[ "$with_base" == "yes" ]]; then
      # Set up an origin/main ref that lags behind, so the mirror's
      # BASE_REF fallback chain works (try origin/main first).
      git update-ref refs/remotes/origin/main HEAD
    fi
    # Make a feature commit on top so HEAD..origin/main is non-empty.
    git checkout --quiet -b feature
    echo "change one" > a.txt
    git add a.txt
    git commit --quiet -m "feat: first commit"
    echo "change two" > b.txt
    git add b.txt
    git commit --quiet -m "feat: second commit"
  )
}

run_implement_mirror() {
  local case_name="$1" stub_kind="$2" preseed_marker="${3:-}" git_base="${4:-yes}"
  local case_dir="${SCRATCH}/imp-mirror-${case_name}"
  local worker_dir="${case_dir}/orch/workers/CTL-449"
  local repo_dir="${case_dir}/repo"
  mkdir -p "$case_dir/bin" "$worker_dir"

  build_git_fixture "$repo_dir" "$git_base"

  if [[ "$stub_kind" == "ok" ]]; then
    linearis_stub_install "$case_dir/bin" "$case_dir/linearis-calls.log"
  else
    linearis_stub_install_failing "$case_dir/bin" "$case_dir/linearis-calls.log"
  fi

  if [[ -n "$preseed_marker" ]]; then
    : > "$worker_dir/.linear-mirror-implement"
  fi

  (
    cd "$repo_dir" || exit 1
    PATH="$case_dir/bin:$PATH" \
      ORCH_DIR="${case_dir}/orch" \
      TICKET="CTL-449" \
      PHASE="implement" \
      bash "$MIRROR_BODY_FILE" >"$case_dir/stdout.log" 2>"$case_dir/stderr.log"
    echo "$?" > "$case_dir/exit-code"
  )
  echo "$case_dir"
}

# Case A: happy — git fixture has origin/main, two commits on feature.
CASE_A="$(run_implement_mirror happy ok '' yes)"
assert_eq "0" "$(cat "$CASE_A/exit-code")" "mirror-implement happy: exit 0"
LOG_A="$CASE_A/linearis-calls.log"
if grep -q '^discuss$' "$LOG_A" 2>/dev/null; then
  pass "mirror-implement happy: discuss landed"
else
  fail "mirror-implement happy: discuss" "log:$(printf '\n%s' "$(cat "$LOG_A" 2>/dev/null)")"
fi
if grep -q 'Phase Implement' "$LOG_A" 2>/dev/null; then
  pass "mirror-implement happy: body contains 'Phase Implement' header"
else
  fail "mirror-implement happy: header" "log:$(printf '\n%s' "$(cat "$LOG_A" 2>/dev/null)")"
fi
if grep -qE 'feat: (first|second) commit' "$LOG_A" 2>/dev/null; then
  pass "mirror-implement happy: body contains commit subjects"
else
  fail "mirror-implement happy: commit subjects" "log:$(printf '\n%s' "$(cat "$LOG_A" 2>/dev/null)")"
fi
if grep -qE '(Branch|feature)' "$LOG_A" 2>/dev/null; then
  pass "mirror-implement happy: body contains branch name"
else
  fail "mirror-implement happy: branch" "log:$(printf '\n%s' "$(cat "$LOG_A" 2>/dev/null)")"
fi
MARKER_A="$CASE_A/orch/workers/CTL-449/.linear-mirror-implement"
[[ -e "$MARKER_A" ]] && pass "mirror-implement happy: marker written" || fail "marker missing $MARKER_A"

# Case B: fail-open.
CASE_B="$(run_implement_mirror failopen fail '' yes)"
assert_eq "0" "$(cat "$CASE_B/exit-code")" "mirror-implement fail-open: exit 0"
MARKER_B="$CASE_B/orch/workers/CTL-449/.linear-mirror-implement"
[[ ! -e "$MARKER_B" ]] && pass "mirror-implement fail-open: no marker" || fail "marker should not exist"
if grep -q 'linearis discuss failed (continuing)' "$CASE_B/stderr.log" 2>/dev/null; then
  pass "mirror-implement fail-open: warning to stderr"
else
  fail "mirror-implement fail-open: warning" "stderr:$(printf '\n%s' "$(cat "$CASE_B/stderr.log" 2>/dev/null)")"
fi

# Case C: idempotent.
CASE_C="$(run_implement_mirror idempot ok seed yes)"
assert_eq "0" "$(cat "$CASE_C/exit-code")" "mirror-implement idempotent: exit 0"
LOG_C="$CASE_C/linearis-calls.log"
if [[ ! -f "$LOG_C" ]] || ! grep -q '^discuss$' "$LOG_C" 2>/dev/null; then
  pass "mirror-implement idempotent: discuss skipped"
else
  fail "mirror-implement idempotent: discuss" "marker not honored"
fi

# Case D: no-base-branch — fixture omits origin/main; delete main too so the
# block falls through to the `_base branch unknown_` arm. The mirror block must
# still post (the plan picks the "post anyway" arm).
build_git_fixture_no_base() {
  local repo_dir="$1"
  mkdir -p "$repo_dir"
  (
    cd "$repo_dir" || exit 1
    git init --quiet --initial-branch=feature
    git config user.email "test@example.com"
    git config user.name "Test"
    echo "x" > x.txt
    git add x.txt
    git commit --quiet -m "feat: solo commit"
    # No main, no origin/main.
  )
}

CASE_D_DIR="${SCRATCH}/imp-mirror-nobase"
WORKER_D="${CASE_D_DIR}/orch/workers/CTL-449"
REPO_D="${CASE_D_DIR}/repo"
mkdir -p "$CASE_D_DIR/bin" "$WORKER_D"
build_git_fixture_no_base "$REPO_D"
linearis_stub_install "$CASE_D_DIR/bin" "$CASE_D_DIR/linearis-calls.log"

(
  cd "$REPO_D" || exit 1
  PATH="$CASE_D_DIR/bin:$PATH" \
    ORCH_DIR="${CASE_D_DIR}/orch" \
    TICKET="CTL-449" \
    PHASE="implement" \
    bash "$MIRROR_BODY_FILE" >"$CASE_D_DIR/stdout.log" 2>"$CASE_D_DIR/stderr.log"
  echo "$?" > "$CASE_D_DIR/exit-code"
)

assert_eq "0" "$(cat "$CASE_D_DIR/exit-code")" "mirror-implement no-base: exit 0"
LOG_D="$CASE_D_DIR/linearis-calls.log"
if grep -q '^discuss$' "$LOG_D" 2>/dev/null; then
  pass "mirror-implement no-base: still posts (the chosen arm)"
else
  fail "mirror-implement no-base: discuss" "log:$(printf '\n%s' "$(cat "$LOG_D" 2>/dev/null)")"
fi
if grep -q '_base branch unknown_' "$LOG_D" 2>/dev/null; then
  pass "mirror-implement no-base: body renders fallback marker"
else
  fail "mirror-implement no-base: fallback" "log:$(printf '\n%s' "$(cat "$LOG_D" 2>/dev/null)")"
fi

# ─── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────"
echo "phase-implement-e2e: ${PASSES} passed, ${FAILURES} failed"
echo "─────────────────────────────────────────────"
[[ $FAILURES -eq 0 ]]
