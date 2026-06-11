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

assert_file() {
	local path="$1" label="$2"
	if [[ -f $path ]]; then
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
	[[ -f $logfile ]] || {
		echo ""
		return 1
	}
	grep -F '"event.name":"phase.' "$logfile" | tail -n 1
}

# ─── Test 1: phase-implement SKILL.md exists + reads plan + commits per phase
echo "Test 1: phase-implement SKILL.md contract (plan path + TDD per-phase + commits)"
assert_file "$SKILL_IMPLEMENT" "phase-implement/SKILL.md exists"
if [[ -f $SKILL_IMPLEMENT ]]; then
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
if [[ -f $SKILL_IMPLEMENT ]]; then
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
if [[ -z $LINE ]]; then
	fail "Test 3: no event emitted for phase=implement"
else
	EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"')
	SEVERITY=$(echo "$LINE" | jq -r '.severityText')
	PAYLOAD_PHASE=$(echo "$LINE" | jq -r '.body.payload.phase')
	PAYLOAD_TICKET=$(echo "$LINE" | jq -r '.body.payload.ticket')
	assert_eq "phase.implement.complete.CTL-449" "$EVENT_NAME" "event.name = phase.implement.complete.CTL-449"
	assert_eq "INFO" "$SEVERITY" "complete → INFO severity"
	assert_eq "implement" "$PAYLOAD_PHASE" "body.payload.phase = implement"
	assert_eq "CTL-449" "$PAYLOAD_TICKET" "body.payload.ticket = CTL-449"
fi

# ─── Test 4: phase-implement emits phase.implement.failed on /goal turn-cap hit
echo ""
echo "Test 4: phase-agent-emit-complete --phase implement --status failed carries failure_reason"
fresh_env t4
"$EMIT_SCRIPT" --phase implement --ticket CTL-449 --status failed --reason "turn cap hit (75)" >/dev/null 2>&1
LINE=$(read_event_line)
if [[ -z $LINE ]]; then
	fail "Test 4: no event emitted for phase=implement (failed)"
else
	EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"')
	SEVERITY=$(echo "$LINE" | jq -r '.severityText')
	REASON=$(echo "$LINE" | jq -r '.body.payload.failure_reason')
	assert_eq "phase.implement.failed.CTL-449" "$EVENT_NAME" "event.name = phase.implement.failed.CTL-449"
	assert_eq "WARN" "$SEVERITY" "failed → WARN severity"
	assert_eq "turn cap hit (75)" "$REASON" "body.payload.failure_reason carries reason"
fi

# ─── Test 5: phase-pr — delegates to /catalyst-dev:create-pr + emits phase.pr.complete
echo ""
echo "Test 5: phase-pr SKILL.md contract + emit-complete event shape"
assert_file "$SKILL_PR" "phase-pr/SKILL.md exists"
if [[ -f $SKILL_PR ]]; then
	assert_grep '^name: phase-pr$' "$SKILL_PR" "frontmatter: name: phase-pr"
	# Delegates to create-pr which auto-runs describe-pr and moves Linear to
	# inReview (plan §"Phase agents wrap canonical skills").
	assert_grep '/catalyst-dev:create-pr' "$SKILL_PR" "delegates to /catalyst-dev:create-pr"
	assert_grep '^/goal' "$SKILL_PR" "declares a /goal line"
fi

fresh_env t5
"$EMIT_SCRIPT" --phase pr --ticket CTL-449 --status complete >/dev/null 2>&1
LINE=$(read_event_line)
if [[ -z $LINE ]]; then
	fail "Test 5: no event emitted for phase=pr"
else
	EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"')
	PAYLOAD_PHASE=$(echo "$LINE" | jq -r '.body.payload.phase')
	assert_eq "phase.pr.complete.CTL-449" "$EVENT_NAME" "event.name = phase.pr.complete.CTL-449"
	assert_eq "pr" "$PAYLOAD_PHASE" "body.payload.phase = pr"
fi

# ─── Test 6: phase-monitor-merge — reactive PR lifecycle + emits phase.monitor-merge.complete
echo ""
echo "Test 6: phase-monitor-merge SKILL.md reactive listen loop + emit-complete event shape"
assert_file "$SKILL_MONITOR_MERGE" "phase-monitor-merge/SKILL.md exists"
if [[ -f $SKILL_MONITOR_MERGE ]]; then
	assert_grep '^name: phase-monitor-merge$' "$SKILL_MONITOR_MERGE" "frontmatter: name: phase-monitor-merge"
	# Reuses the reactive PR-lifecycle pattern (CTL-228 monitor-events Pattern 3).
	# The listen loop must wait on events rather than polling, so the skill body
	# must reference catalyst-events wait-for and the GitHub event filter.
	assert_grep 'catalyst-events wait-for' "$SKILL_MONITOR_MERGE" "uses catalyst-events wait-for (event-driven loop)"
	assert_grep 'github\.pr\.merged|github\.check_suite|github\.pr_review' "$SKILL_MONITOR_MERGE" \
		"references GitHub PR-lifecycle event names"
	# CTL-703: Linear Done is written by phase-teardown (10th phase), not phase-monitor-merge.
	assert_not_grep 'linear-transition\.sh' "$SKILL_MONITOR_MERGE" \
		"phase-monitor-merge does NOT transition Linear to done (CTL-703: teardown owns it)"
	assert_grep '^/goal' "$SKILL_MONITOR_MERGE" "declares a /goal line"
fi

fresh_env t6
"$EMIT_SCRIPT" --phase monitor-merge --ticket CTL-449 --status complete >/dev/null 2>&1
LINE=$(read_event_line)
if [[ -z $LINE ]]; then
	fail "Test 6: no event emitted for phase=monitor-merge"
else
	EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"')
	PAYLOAD_PHASE=$(echo "$LINE" | jq -r '.body.payload.phase')
	assert_eq "phase.monitor-merge.complete.CTL-449" "$EVENT_NAME" "event.name = phase.monitor-merge.complete.CTL-449"
	assert_eq "monitor-merge" "$PAYLOAD_PHASE" "body.payload.phase = monitor-merge"
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
cat >"${T7}/bin/claude" <<'STUB'
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
: >"$CLAUDE_STUB_LOG_T7"

# Fake catalyst-state.sh — eats argv (we don't assert on it here; covered by
# the existing dispatch test suite).
cat >"${T7}/bin/catalyst-state.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "${T7}/bin/catalyst-state.sh"

# Minimal state.json with one ticket in wave1Pending.
cat >"${T7}/orch/state.json" <<EOF
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
[[ -f $SIGNAL_TRIAGE ]] && pass "phase-triage.json signal written" ||
	fail "phase-triage.json signal written — expected at $SIGNAL_TRIAGE"
LOG=$(cat "$CLAUDE_STUB_LOG_T7" 2>/dev/null || echo "")
if [[ -n $LOG ]]; then
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
echo "Test 8: orchestrate-dispatch-next without --phase uses legacy /catalyst-legacy:oneshot path"
T8="${SCRATCH}/t8"
mkdir -p "${T8}/orch/workers/output" "${T8}/wt/demo-T-1" "${T8}/bin"

# Same stub set as Test 7 but the dispatch path is legacy (-p oneshot) — no --bg.
cat >"${T8}/bin/claude" <<'STUB'
#!/usr/bin/env bash
LOG="${CLAUDE_STUB_LOG}"
echo "args: $*" >> "$LOG"
sleep 30 &
disown $! 2>/dev/null || true
STUB
chmod +x "${T8}/bin/claude"
CLAUDE_STUB_LOG_T8="${T8}/claude.log"
: >"$CLAUDE_STUB_LOG_T8"

cat >"${T8}/bin/catalyst-state.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "${T8}/bin/catalyst-state.sh"

cat >"${T8}/orch/state.json" <<EOF
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
[[ -f "${T8}/orch/workers/T-1.json" ]] && pass "legacy worker signal file written" ||
	fail "legacy worker signal file written"
LOG=$(cat "$CLAUDE_STUB_LOG_T8" 2>/dev/null || echo "")
if [[ -n $LOG ]]; then
	if grep -q -- "-p .*catalyst-legacy:oneshot" <<<"$LOG"; then
		pass "legacy path runs claude -p /catalyst-legacy:oneshot"
	else
		fail "legacy path runs claude -p /catalyst-legacy:oneshot — log: $LOG"
	fi
	if grep -q -- "--bg" <<<"$LOG"; then
		fail "legacy path must NOT use --bg — log: $LOG"
	else
		pass "legacy path does NOT use --bg"
	fi
else
	fail "claude stub captured no invocation"
fi

# ─── Test 9 (CTL-748): phase-implement keeps daemon-resume orientation but
#     no longer self-writes a turn-cap handoff or self-emits turn-cap-exhausted.
echo ""
echo "Test 9 (CTL-748): phase-implement SKILL.md keeps continuation Prelude, drops self-stop handoff write"
if [[ -f $SKILL_IMPLEMENT ]]; then
	# Prelude still orients a daemon-resumed continuation worker: it reads
	# CATALYST_IS_CONTINUATION / CATALYST_HANDOFF_PATH so a --resume session
	# picks up where the previous one left off (CTL-613 daemon-side resume).
	assert_grep 'CATALYST_IS_CONTINUATION' "$SKILL_IMPLEMENT" "Prelude checks CATALYST_IS_CONTINUATION env var"
	assert_grep 'CATALYST_HANDOFF_PATH' "$SKILL_IMPLEMENT" "Prelude reads CATALYST_HANDOFF_PATH"
	# CTL-748 removed the skill-side self-stop machinery: the failure block no
	# longer writes a turn-cap-continuation handoff or self-emits
	# turn-cap-exhausted. The turn cap is now enforced daemon-side.
	assert_not_grep 'turn-cap-exhausted' "$SKILL_IMPLEMENT" "skill body no longer self-emits turn-cap-exhausted"
	assert_not_grep 'turn-cap-continuation' "$SKILL_IMPLEMENT" "skill body no longer writes a turn-cap-continuation handoff"
	assert_not_grep '[-][-]handoff-path' "$SKILL_IMPLEMENT" "skill body no longer passes --handoff-path"
	# /goal block no longer carries turn-cap self-stop language (CTL-748).
	assert_not_grep 'OR I have stopped after .*turn' "$SKILL_IMPLEMENT" "/goal block has no turn-cap self-stop clause"
fi

# Test 10 (CTL-484): the new emitter status round-trips through the canonical
# event log and the per-phase signal file when invoked with --handoff-path.
echo ""
echo "Test 10 (CTL-484): emit-complete --status turn-cap-exhausted --handoff-path round-trip"
fresh_env t10
SIGNAL_T10="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-449/phase-implement.json"
echo '{"status":"running","ticket":"CTL-449","phase":"implement"}' >"$SIGNAL_T10"
HANDOFF_T10="thoughts/shared/handoffs/CTL-449/2026-05-17_18-00-00_turn-cap-continuation.md"
"$EMIT_SCRIPT" --phase implement --ticket CTL-449 --status turn-cap-exhausted \
	--reason "turn cap hit (75)" --handoff-path "$HANDOFF_T10" >/dev/null 2>&1
LINE=$(read_event_line)
if [[ -z $LINE ]]; then
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
if [[ -f $SKILL_IMPLEMENT ]]; then
	assert_grep 'phase-implement-mirror' "$SKILL_IMPLEMENT" "body contains uniquely-named mirror fence"
	assert_grep '\.linear-mirror-' "$SKILL_IMPLEMENT" "body references the per-phase marker file"
	assert_grep 'linear-comment-post.sh' "$SKILL_IMPLEMENT" "body calls linear-comment-post.sh"
	assert_grep 'linear-comment-post failed \(continuing\)' "$SKILL_IMPLEMENT" "body has fail-open warning string"
fi

# ─── Test 12 (CTL-632): runtime mirror exercises ──────────────────────────
echo ""
echo "Test 12 (CTL-632): phase-implement mirror — happy/fail-open/idempotent/no-base"

MIRROR_BODY_FILE="${SCRATCH}/mirror-body.sh"
awk '
  /^```bash phase-implement-mirror$/ {capture=1; next}
  /^```$/ {if (capture) {capture=0}}
  capture { print }
' "$SKILL_IMPLEMENT" >"$MIRROR_BODY_FILE"

if [[ -s $MIRROR_BODY_FILE ]]; then
	pass "mirror block extractable from SKILL.md"
else
	fail 'mirror block extractable — no ```bash phase-implement-mirror``` fence found'
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
		echo "base" >base.txt
		git add base.txt
		git commit --quiet -m "base commit"
		if [[ $with_base == "yes" ]]; then
			# Set up an origin/main ref that lags behind, so the mirror's
			# BASE_REF fallback chain works (try origin/main first).
			git update-ref refs/remotes/origin/main HEAD
		fi
		# Make a feature commit on top so HEAD..origin/main is non-empty.
		git checkout --quiet -b feature
		echo "change one" >a.txt
		git add a.txt
		git commit --quiet -m "feat: first commit"
		echo "change two" >b.txt
		git add b.txt
		git commit --quiet -m "feat: second commit"
	)
}

run_implement_mirror() {
	local case_name="$1" stub_kind="$2" preseed_marker="${3-}" git_base="${4:-yes}"
	local case_dir="${SCRATCH}/imp-mirror-${case_name}"
	local worker_dir="${case_dir}/orch/workers/CTL-449"
	local repo_dir="${case_dir}/repo"
	mkdir -p "$case_dir/bin" "$worker_dir"

	build_git_fixture "$repo_dir" "$git_base"

	linearis_stub_install "$case_dir/bin" "$case_dir/linearis-calls.log"
	if [[ $stub_kind == "ok" ]]; then
		linear_comment_post_stub_install "$case_dir/bin" "$case_dir/comment-post-calls.log"
	else
		linear_comment_post_stub_install_failing "$case_dir/bin" "$case_dir/comment-post-calls.log"
	fi

	if [[ -n $preseed_marker ]]; then
		: >"$worker_dir/.linear-mirror-implement"
	fi

	(
		cd "$repo_dir" || exit 1
		PATH="$case_dir/bin:$PATH" \
			PLUGIN_ROOT="${REPO_ROOT}/plugins/dev" \
			CATALYST_COMMENT_POST_HELPER="$case_dir/bin/linear-comment-post.sh" \
			ORCH_DIR="${case_dir}/orch" \
			TICKET="CTL-449" \
			PHASE="implement" \
			bash "$MIRROR_BODY_FILE" >"$case_dir/stdout.log" 2>"$case_dir/stderr.log"
		echo "$?" >"$case_dir/exit-code"
	)
	echo "$case_dir"
}

# Case A: happy — git fixture has origin/main, two commits on feature.
CASE_A="$(run_implement_mirror happy ok '' yes)"
assert_eq "0" "$(cat "$CASE_A/exit-code")" "mirror-implement happy: exit 0"
LOG_A="$CASE_A/comment-post-calls.log"
if grep -q 'CTL-449' "$LOG_A" 2>/dev/null; then
	pass "mirror-implement happy: comment posted"
else
	fail "mirror-implement happy: comment post" "log:$(printf '\n%s' "$(cat "$LOG_A" 2>/dev/null)")"
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
# CTL-632 follow-on: file/line breakdown (fixture adds a.txt + b.txt = 2 files
# added, 1 line each = +2 / -0).
if grep -qE 'Files.*2 added, 0 modified, 0 deleted' "$LOG_A" 2>/dev/null; then
	pass "mirror-implement happy: renders files added/modified/deleted breakdown"
else
	fail "mirror-implement happy: files breakdown" "log:$(printf '\n%s' "$(cat "$LOG_A" 2>/dev/null)")"
fi
if grep -qE 'Lines.*\+2 / -0' "$LOG_A" 2>/dev/null; then
	pass "mirror-implement happy: renders lines added/deleted"
else
	fail "mirror-implement happy: lines added/deleted" "log:$(printf '\n%s' "$(cat "$LOG_A" 2>/dev/null)")"
fi
if grep -qE '(Branch|feature)' "$LOG_A" 2>/dev/null; then
	pass "mirror-implement happy: body contains branch name"
else
	fail "mirror-implement happy: branch" "log:$(printf '\n%s' "$(cat "$LOG_A" 2>/dev/null)")"
fi
MARKER_A="$CASE_A/orch/workers/CTL-449/.linear-mirror-implement"
[[ -e $MARKER_A ]] && pass "mirror-implement happy: marker written" || fail "marker missing $MARKER_A"

# Case B: fail-open.
CASE_B="$(run_implement_mirror failopen fail '' yes)"
assert_eq "0" "$(cat "$CASE_B/exit-code")" "mirror-implement fail-open: exit 0"
MARKER_B="$CASE_B/orch/workers/CTL-449/.linear-mirror-implement"
[[ ! -e $MARKER_B ]] && pass "mirror-implement fail-open: no marker" || fail "marker should not exist"
if grep -q 'linear-comment-post failed (continuing)' "$CASE_B/stderr.log" 2>/dev/null; then
	pass "mirror-implement fail-open: warning to stderr"
else
	fail "mirror-implement fail-open: warning" "stderr:$(printf '\n%s' "$(cat "$CASE_B/stderr.log" 2>/dev/null)")"
fi

# Case C: idempotent.
CASE_C="$(run_implement_mirror idempot ok seed yes)"
assert_eq "0" "$(cat "$CASE_C/exit-code")" "mirror-implement idempotent: exit 0"
LOG_C="$CASE_C/comment-post-calls.log"
if [[ ! -f $LOG_C ]] || ! grep -q 'CTL-449' "$LOG_C" 2>/dev/null; then
	pass "mirror-implement idempotent: comment post skipped"
else
	fail "mirror-implement idempotent: comment post" "marker not honored"
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
		echo "x" >x.txt
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
linear_comment_post_stub_install "$CASE_D_DIR/bin" "$CASE_D_DIR/comment-post-calls.log"

(
	cd "$REPO_D" || exit 1
	PATH="$CASE_D_DIR/bin:$PATH" \
		PLUGIN_ROOT="${REPO_ROOT}/plugins/dev" \
		CATALYST_COMMENT_POST_HELPER="$CASE_D_DIR/bin/linear-comment-post.sh" \
		ORCH_DIR="${CASE_D_DIR}/orch" \
		TICKET="CTL-449" \
		PHASE="implement" \
		bash "$MIRROR_BODY_FILE" >"$CASE_D_DIR/stdout.log" 2>"$CASE_D_DIR/stderr.log"
	echo "$?" >"$CASE_D_DIR/exit-code"
)

assert_eq "0" "$(cat "$CASE_D_DIR/exit-code")" "mirror-implement no-base: exit 0"
LOG_D="$CASE_D_DIR/comment-post-calls.log"
if grep -q 'CTL-449' "$LOG_D" 2>/dev/null; then
	pass "mirror-implement no-base: still posts (the chosen arm)"
else
	fail "mirror-implement no-base: comment post" "log:$(printf '\n%s' "$(cat "$LOG_D" 2>/dev/null)")"
fi
if grep -q '_base branch unknown_' "$LOG_D" 2>/dev/null; then
	pass "mirror-implement no-base: body renders fallback marker"
else
	fail "mirror-implement no-base: fallback" "log:$(printf '\n%s' "$(cat "$LOG_D" 2>/dev/null)")"
fi

# ─── Test 13 (CTL-608): phase-implement empty-branch self-emit gate ───────
echo ""
echo "Test 13 (CTL-608): phase-implement contract — empty-branch gate present"
if [[ -f $SKILL_IMPLEMENT ]]; then
	# The gate must live in its own uniquely-named fence so this harness can
	# extract+run it, exactly like the mirror fence (Test 12).
	assert_grep 'phase-implement-empty-branch-gate' "$SKILL_IMPLEMENT" "body contains uniquely-named empty-branch gate fence"
	assert_grep 'rev-list --count' "$SKILL_IMPLEMENT" "gate counts commits-ahead via rev-list --count"
	assert_grep 'empty_branch:' "$SKILL_IMPLEMENT" "gate emits failure reason prefixed empty_branch:"
fi

# ─── Test 14 (CTL-608): empty-branch gate runtime — empty/non-empty/no-base ─
echo ""
echo "Test 14 (CTL-608): phase-implement empty-branch gate — empty/non-empty/base-unknown"

GATE_BODY_FILE="${SCRATCH}/empty-branch-gate.sh"
awk '
  /^```bash phase-implement-empty-branch-gate$/ {capture=1; next}
  /^```$/ {if (capture) {capture=0}}
  capture { print }
' "$SKILL_IMPLEMENT" >"$GATE_BODY_FILE"

if [[ -s $GATE_BODY_FILE ]]; then
	pass "empty-branch gate extractable from SKILL.md"
else
	fail 'empty-branch gate extractable — no ```bash phase-implement-empty-branch-gate``` fence found'
fi

# Stub phase-agent-emit-complete under $PLUGIN_ROOT/scripts/ — the gate calls
# "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" directly. Captures argv to
# $EMIT_CAPTURE so the gate's --status / --reason can be asserted.
install_emit_stub() {
	local plugin_root="$1"
	mkdir -p "$plugin_root/scripts"
	cat >"$plugin_root/scripts/phase-agent-emit-complete" <<'STUB'
#!/usr/bin/env bash
# CTL-608 test stub: capture argv so the gate's terminal emit can be asserted.
echo "$*" >> "${EMIT_CAPTURE:-/dev/null}"
exit 0
STUB
	chmod +x "$plugin_root/scripts/phase-agent-emit-complete"
}

# Empty branch: HEAD == origin/main (0 commits ahead).
build_git_fixture_empty() {
	local repo_dir="$1"
	mkdir -p "$repo_dir"
	(
		cd "$repo_dir" || exit 1
		git init --quiet --initial-branch=main
		git config user.email "test@example.com"
		git config user.name "Test"
		echo "base" >base.txt
		git add base.txt
		git commit --quiet -m "base commit"
		git update-ref refs/remotes/origin/main HEAD
		# Branch sits exactly at origin/main — nothing committed ahead.
		git checkout --quiet -b feature
	)
}

run_empty_branch_gate() {
	local case_name="$1" fixture_fn="$2"
	local case_dir="${SCRATCH}/imp-gate-${case_name}"
	local repo_dir="${case_dir}/repo"
	local plugin_root="${case_dir}/plugin"
	mkdir -p "$case_dir"
	"$fixture_fn" "$repo_dir"
	install_emit_stub "$plugin_root"
	(
		cd "$repo_dir" || exit 1
		EMIT_CAPTURE="${case_dir}/emit-capture.log" \
			PLUGIN_ROOT="$plugin_root" \
			PHASE="implement" \
			TICKET="CTL-449" \
			COMMS="" \
			CHANNEL="orch-e2e" \
			ORCH_ID="orch-e2e" \
			bash "$GATE_BODY_FILE" >"$case_dir/stdout.log" 2>"$case_dir/stderr.log"
		echo "$?" >"$case_dir/exit-code"
	)
	echo "$case_dir"
}

# Case E — empty branch: gate must emit --status failed (empty_branch:) + exit 1.
CASE_E="$(run_empty_branch_gate empty build_git_fixture_empty)"
assert_eq "1" "$(cat "$CASE_E/exit-code")" "gate empty-branch: exit 1"
if grep -q -- '--status failed' "$CASE_E/emit-capture.log" 2>/dev/null; then
	pass "gate empty-branch: emits --status failed"
else
	fail "gate empty-branch: --status failed" "capture:$(printf '\n%s' "$(cat "$CASE_E/emit-capture.log" 2>/dev/null)")"
fi
if grep -q 'empty_branch:' "$CASE_E/emit-capture.log" 2>/dev/null; then
	pass "gate empty-branch: reason prefixed empty_branch:"
else
	fail "gate empty-branch: reason" "capture:$(printf '\n%s' "$(cat "$CASE_E/emit-capture.log" 2>/dev/null)")"
fi

# Case F — non-empty branch (origin/main + 2 commits ahead): gate falls through,
# exit 0, no --status failed captured.
CASE_F="$(run_empty_branch_gate nonempty build_git_fixture)"
assert_eq "0" "$(cat "$CASE_F/exit-code")" "gate non-empty: exit 0 (falls through)"
if grep -q -- '--status failed' "$CASE_F/emit-capture.log" 2>/dev/null; then
	fail "gate non-empty: must NOT emit --status failed" "capture:$(printf '\n%s' "$(cat "$CASE_F/emit-capture.log" 2>/dev/null)")"
else
	pass "gate non-empty: no --status failed (gate is silent on success)"
fi

# Case G — base unknown (no origin/main, no main): fail-open, exit 0, warn on
# stderr, no --status failed.
CASE_G="$(run_empty_branch_gate nobase build_git_fixture_no_base)"
assert_eq "0" "$(cat "$CASE_G/exit-code")" "gate base-unknown: exit 0 (fail-open)"
if grep -q -- '--status failed' "$CASE_G/emit-capture.log" 2>/dev/null; then
	fail "gate base-unknown: must NOT emit --status failed" "capture:$(printf '\n%s' "$(cat "$CASE_G/emit-capture.log" 2>/dev/null)")"
else
	pass "gate base-unknown: no --status failed"
fi
if grep -q 'could not resolve integration base' "$CASE_G/stderr.log" 2>/dev/null; then
	pass "gate base-unknown: warns on stderr"
else
	fail "gate base-unknown: warning" "stderr:$(printf '\n%s' "$(cat "$CASE_G/stderr.log" 2>/dev/null)")"
fi

# ─── Test 15 (CTL-632): phase-pr + phase-monitor-merge mirror blocks present ──
echo ""
echo "Test 15 (CTL-632): phase-pr + phase-monitor-merge contract — mirror blocks present"
if [[ -f $SKILL_PR ]]; then
	assert_grep 'phase-pr-mirror' "$SKILL_PR" "phase-pr: body contains uniquely-named mirror fence"
	assert_grep '\.linear-mirror-' "$SKILL_PR" "phase-pr: references the per-phase marker file"
	assert_grep 'linear-comment-post.sh' "$SKILL_PR" "phase-pr: calls linear-comment-post.sh"
	assert_grep 'phase-pr: linear-comment-post failed \(continuing\)' "$SKILL_PR" "phase-pr: fail-open warning string"
	assert_grep 'verify\.json' "$SKILL_PR" "phase-pr: surfaces verify.json pre-merge verification"
fi
if [[ -f $SKILL_MONITOR_MERGE ]]; then
	assert_grep 'phase-monitor-merge-mirror' "$SKILL_MONITOR_MERGE" "phase-monitor-merge: body contains uniquely-named mirror fence"
	assert_grep '\.linear-mirror-' "$SKILL_MONITOR_MERGE" "phase-monitor-merge: references the per-phase marker file"
	assert_grep 'linear-comment-post.sh' "$SKILL_MONITOR_MERGE" "phase-monitor-merge: calls linear-comment-post.sh"
	assert_grep 'phase-monitor-merge: linear-comment-post failed \(continuing\)' "$SKILL_MONITOR_MERGE" "phase-monitor-merge: fail-open warning string"
	assert_grep 'statusCheckRollup' "$SKILL_MONITOR_MERGE" "phase-monitor-merge: summarizes CI check rollup"
fi

# ─── Test 16 (CTL-632): phase-pr mirror runtime — happy/fail-open/idempotent ──
echo ""
echo "Test 16 (CTL-632): phase-pr mirror — happy / fail-open / idempotent (with gh stub)"

PR_MIRROR_FILE="${SCRATCH}/pr-mirror-body.sh"
awk '
  /^```bash phase-pr-mirror$/ {capture=1; next}
  /^```$/ {if (capture) {capture=0}}
  capture { print }
' "$SKILL_PR" >"$PR_MIRROR_FILE"
if [[ -s $PR_MIRROR_FILE ]]; then
	pass "phase-pr mirror block extractable from SKILL.md"
else
	fail 'phase-pr mirror block extractable — no ```bash phase-pr-mirror``` fence found'
fi

# gh stub: `gh pr view <n> --json ...` returns canned PR metadata.
install_gh_stub() {
	local bin_dir="$1"
	mkdir -p "$bin_dir"
	cat >"${bin_dir}/gh" <<'STUB'
#!/usr/bin/env bash
# Minimal gh stub for phase mirror e2e: supports `gh pr view <n> --json ...`.
if [[ "$1" == "pr" && "$2" == "view" ]]; then
  cat <<'JSON'
{
  "title": "CTL-449: do the thing",
  "url": "https://github.com/acme/repo/pull/42",
  "files": [{"path":"a.ts"},{"path":"b.ts"},{"path":"c.ts"}],
  "additions": 120,
  "deletions": 7,
  "commits": [{"oid":"1"},{"oid":"2"}],
  "baseRefName": "main",
  "createdAt": "2026-05-27T10:00:00Z",
  "statusCheckRollup": [
    {"__typename":"CheckRun","conclusion":"SUCCESS"},
    {"__typename":"CheckRun","conclusion":"SUCCESS"},
    {"__typename":"StatusContext","state":"SUCCESS"}
  ],
  "reviews": [
    {"author":{"login":"chatgpt-codex-connector"},"state":"COMMENTED"},
    {"author":{"login":"ryan"},"state":"APPROVED"}
  ]
}
JSON
  exit 0
fi
exit 0
STUB
	chmod +x "${bin_dir}/gh"
}

# Writes the phase-pr signal file (with .pr) + optional verify.json into a worker dir.
seed_pr_worker() {
	local worker_dir="$1" with_verify="${2:-yes}"
	mkdir -p "$worker_dir"
	cat >"${worker_dir}/phase-pr.json" <<'JSON'
{"status":"running","ticket":"CTL-449","phase":"pr","pr":{"number":42,"url":"https://github.com/acme/repo/pull/42"}}
JSON
	if [[ $with_verify == "yes" ]]; then
		cat >"${worker_dir}/verify.json" <<'JSON'
{"regression_risk":3,"tests_attempted":5,"gates":{"tests":{"status":"pass","summary":"192 passed / 0 failed"},"typecheck":{"status":"pass","summary":"tsc clean"},"lint":{"status":"pass"}},"findings":[]}
JSON
	fi
}

run_pr_mirror() {
	local case_name="$1" stub_kind="$2" preseed_marker="${3-}" with_verify="${4:-yes}"
	local case_dir="${SCRATCH}/pr-mirror-${case_name}"
	local worker_dir="${case_dir}/orch/workers/CTL-449"
	mkdir -p "$case_dir/bin"
	seed_pr_worker "$worker_dir" "$with_verify"
	install_gh_stub "$case_dir/bin"
	linearis_stub_install "$case_dir/bin" "$case_dir/linearis-calls.log"
	if [[ $stub_kind == "ok" ]]; then
		linear_comment_post_stub_install "$case_dir/bin" "$case_dir/comment-post-calls.log"
	else
		linear_comment_post_stub_install_failing "$case_dir/bin" "$case_dir/comment-post-calls.log"
	fi
	[[ -n $preseed_marker ]] && : >"$worker_dir/.linear-mirror-pr"
	(
		PATH="$case_dir/bin:$PATH" \
			ORCH_DIR="${case_dir}/orch" \
			TICKET="CTL-449" \
			PHASE="pr" \
			bash "$PR_MIRROR_FILE" >"$case_dir/stdout.log" 2>"$case_dir/stderr.log"
		echo "$?" >"$case_dir/exit-code"
	)
	echo "$case_dir"
}

# Case PR-A: happy — gh returns PR metadata, verify.json present.
CASE_PRA="$(run_pr_mirror happy ok '' yes)"
assert_eq "0" "$(cat "$CASE_PRA/exit-code")" "mirror-pr happy: exit 0"
LOG_PRA="$CASE_PRA/comment-post-calls.log"
assert_grep 'CTL-449' "$LOG_PRA" "mirror-pr happy: comment posted"
assert_grep 'Phase PR' "$LOG_PRA" "mirror-pr happy: body has 'Phase PR' header"
assert_grep 'Files changed.*3' "$LOG_PRA" "mirror-pr happy: renders changed-file count"
assert_grep 'Regression risk.*3' "$LOG_PRA" "mirror-pr happy: surfaces verify.json regression risk"
[[ -e "$CASE_PRA/orch/workers/CTL-449/.linear-mirror-pr" ]] && pass "mirror-pr happy: marker written" || fail "mirror-pr happy: marker missing"

# Case PR-B: fail-open — linear-comment-post fails, no marker, warning on stderr.
CASE_PRB="$(run_pr_mirror failopen fail '' yes)"
assert_eq "0" "$(cat "$CASE_PRB/exit-code")" "mirror-pr fail-open: exit 0"
[[ ! -e "$CASE_PRB/orch/workers/CTL-449/.linear-mirror-pr" ]] && pass "mirror-pr fail-open: no marker" || fail "mirror-pr fail-open: marker should not exist"
assert_grep 'phase-pr: linear-comment-post failed \(continuing\)' "$CASE_PRB/stderr.log" "mirror-pr fail-open: warning to stderr"

# Case PR-C: idempotent — marker preseeded, comment post skipped.
CASE_PRC="$(run_pr_mirror idempot ok seed yes)"
assert_eq "0" "$(cat "$CASE_PRC/exit-code")" "mirror-pr idempotent: exit 0"
if [[ ! -f "$CASE_PRC/comment-post-calls.log" ]] || ! grep -q 'CTL-449' "$CASE_PRC/comment-post-calls.log" 2>/dev/null; then
	pass "mirror-pr idempotent: comment post skipped"
else
	fail "mirror-pr idempotent: comment post should have been skipped (marker not honored)"
fi

# Case PR-D: no verify.json — still posts, renders the fail-soft fallback line.
CASE_PRD="$(run_pr_mirror noverify ok '' no)"
assert_eq "0" "$(cat "$CASE_PRD/exit-code")" "mirror-pr no-verify: exit 0"
assert_grep 'CTL-449' "$CASE_PRD/comment-post-calls.log" "mirror-pr no-verify: still posts"
assert_grep 'no verify.json found' "$CASE_PRD/comment-post-calls.log" "mirror-pr no-verify: renders fallback line"

# ─── Test 17 (CTL-632): phase-monitor-merge mirror runtime ────────────────────
echo ""
echo "Test 17 (CTL-632): phase-monitor-merge mirror — happy / fail-open / idempotent"

MM_MIRROR_FILE="${SCRATCH}/mm-mirror-body.sh"
awk '
  /^```bash phase-monitor-merge-mirror$/ {capture=1; next}
  /^```$/ {if (capture) {capture=0}}
  capture { print }
' "$SKILL_MONITOR_MERGE" >"$MM_MIRROR_FILE"
if [[ -s $MM_MIRROR_FILE ]]; then
	pass "phase-monitor-merge mirror block extractable from SKILL.md"
else
	fail 'phase-monitor-merge mirror block extractable — no ```bash phase-monitor-merge-mirror``` fence found'
fi

seed_mm_worker() {
	local worker_dir="$1"
	mkdir -p "$worker_dir"
	cat >"${worker_dir}/phase-monitor-merge.json" <<'JSON'
{"status":"running","ticket":"CTL-449","phase":"monitor-merge","pr":{"number":42,"mergeCommitSha":"deadbeef1234","mergedAt":"2026-05-27T12:00:00Z","ciStatus":"merged"}}
JSON
}

run_mm_mirror() {
	local case_name="$1" stub_kind="$2" preseed_marker="${3-}"
	local case_dir="${SCRATCH}/mm-mirror-${case_name}"
	local worker_dir="${case_dir}/orch/workers/CTL-449"
	mkdir -p "$case_dir/bin"
	seed_mm_worker "$worker_dir"
	install_gh_stub "$case_dir/bin"
	linearis_stub_install "$case_dir/bin" "$case_dir/linearis-calls.log"
	if [[ $stub_kind == "ok" ]]; then
		linear_comment_post_stub_install "$case_dir/bin" "$case_dir/comment-post-calls.log"
	else
		linear_comment_post_stub_install_failing "$case_dir/bin" "$case_dir/comment-post-calls.log"
	fi
	[[ -n $preseed_marker ]] && : >"$worker_dir/.linear-mirror-monitor-merge"
	(
		PATH="$case_dir/bin:$PATH" \
			ORCH_DIR="${case_dir}/orch" \
			TICKET="CTL-449" \
			PHASE="monitor-merge" \
			bash "$MM_MIRROR_FILE" >"$case_dir/stdout.log" 2>"$case_dir/stderr.log"
		echo "$?" >"$case_dir/exit-code"
	)
	echo "$case_dir"
}

# Case MM-A: happy — gh returns CI rollup (3 SUCCESS) + 1 bot review.
CASE_MMA="$(run_mm_mirror happy ok '')"
assert_eq "0" "$(cat "$CASE_MMA/exit-code")" "mirror-monitor-merge happy: exit 0"
LOG_MMA="$CASE_MMA/comment-post-calls.log"
assert_grep 'CTL-449' "$LOG_MMA" "mirror-monitor-merge happy: comment posted"
assert_grep 'Phase Monitor-Merge' "$LOG_MMA" "mirror-monitor-merge happy: body has header"
assert_grep '3/3 checks passed' "$LOG_MMA" "mirror-monitor-merge happy: renders CI rollup"
assert_grep 'deadbeef1234' "$LOG_MMA" "mirror-monitor-merge happy: renders merge commit SHA"
assert_grep 'Time to merge.*2h 0m' "$LOG_MMA" "mirror-monitor-merge happy: computes time-to-merge (10:00→12:00 = 2h)"
assert_grep 'Bot reviews handled.*1' "$LOG_MMA" "mirror-monitor-merge happy: counts bot (Codex) reviews"
[[ -e "$CASE_MMA/orch/workers/CTL-449/.linear-mirror-monitor-merge" ]] && pass "mirror-monitor-merge happy: marker written" || fail "mirror-monitor-merge happy: marker missing"

# Case MM-B: fail-open.
CASE_MMB="$(run_mm_mirror failopen fail '')"
assert_eq "0" "$(cat "$CASE_MMB/exit-code")" "mirror-monitor-merge fail-open: exit 0"
[[ ! -e "$CASE_MMB/orch/workers/CTL-449/.linear-mirror-monitor-merge" ]] && pass "mirror-monitor-merge fail-open: no marker" || fail "mirror-monitor-merge fail-open: marker should not exist"
assert_grep 'phase-monitor-merge: linear-comment-post failed \(continuing\)' "$CASE_MMB/stderr.log" "mirror-monitor-merge fail-open: warning to stderr"

# Case MM-C: idempotent.
CASE_MMC="$(run_mm_mirror idempot ok seed)"
assert_eq "0" "$(cat "$CASE_MMC/exit-code")" "mirror-monitor-merge idempotent: exit 0"
if [[ ! -f "$CASE_MMC/comment-post-calls.log" ]] || ! grep -q 'CTL-449' "$CASE_MMC/comment-post-calls.log" 2>/dev/null; then
	pass "mirror-monitor-merge idempotent: comment post skipped"
else
	fail "mirror-monitor-merge idempotent: comment post should have been skipped (marker not honored)"
fi

# ─── Test 18 (CTL-632 footer): mirror appends the metadata footer ─────────────
echo ""
echo "Test 18 (CTL-632 footer): implement mirror appends footer when PLUGIN_ROOT + bg fixture present"
# Structural: every phase mirror skill wires the shared footer helper.
for skill in "$SKILL_IMPLEMENT" "$SKILL_PR" "$SKILL_MONITOR_MERGE"; do
	assert_grep 'phase-mirror-footer\.sh' "$skill" "$(basename "$(dirname "$skill")"): wires phase-mirror-footer.sh"
done

# Runtime: run the extracted implement mirror block with PLUGIN_ROOT pointed at
# the real plugin + a bg-job fixture, and confirm the footer lands in the body.
FOOT_DIR="${SCRATCH}/imp-mirror-footer"
FOOT_WORKER="${FOOT_DIR}/orch/workers/CTL-449"
FOOT_REPO="${FOOT_DIR}/repo"
FOOT_JOBS="${FOOT_DIR}/jobs"
mkdir -p "$FOOT_DIR/bin" "$FOOT_WORKER" "${FOOT_JOBS}/abcd1234"
build_git_fixture "$FOOT_REPO" yes
linearis_stub_install "$FOOT_DIR/bin" "$FOOT_DIR/linearis-calls.log"
linear_comment_post_stub_install "$FOOT_DIR/bin" "$FOOT_DIR/comment-post-calls.log"
cat >"${FOOT_WORKER}/phase-implement.json" <<'JSON'
{"status":"running","ticket":"CTL-449","phase":"implement","bg_job_id":"abcd1234","catalystSessionId":"sess_FOOTERTEST","model":"opus"}
JSON
cat >"${FOOT_DIR}/conv.jsonl" <<'JSONL'
{"type":"assistant","message":{"model":"claude-opus-4-7","content":[{"type":"tool_use","name":"Task","input":{}}]}}
{"type":"system","subtype":"turn_duration","durationMs":125000}
{"type":"assistant","message":{"model":"claude-opus-4-7","content":[{"type":"text","text":"done"}]}}
JSONL
cat >"${FOOT_JOBS}/abcd1234/state.json" <<JSON
{"sessionId":"abcd1234-aaaa-bbbb-cccc-000011112222","cwd":"/tmp/wt/CTL-449","linkScanPath":"${FOOT_DIR}/conv.jsonl"}
JSON
(
	cd "$FOOT_REPO" || exit 1
	env -u CLAUDE_CODE_SESSION_ID -u CATALYST_SESSION_ID \
		PATH="$FOOT_DIR/bin:$PATH" \
		ORCH_DIR="${FOOT_DIR}/orch" \
		TICKET="CTL-449" \
		PHASE="implement" \
		PLUGIN_ROOT="${REPO_ROOT}/plugins/dev" \
		CATALYST_BG_JOBS_DIR="${FOOT_JOBS}" \
		CATALYST_COMMENT_POST_HELPER="${FOOT_DIR}/bin/linear-comment-post.sh" \
		bash "$MIRROR_BODY_FILE" >"$FOOT_DIR/stdout.log" 2>"$FOOT_DIR/stderr.log"
	echo "$?" >"$FOOT_DIR/exit-code"
)
assert_eq "0" "$(cat "$FOOT_DIR/exit-code")" "mirror-footer: exit 0"
LOG_FOOT="$FOOT_DIR/comment-post-calls.log"
assert_grep '^---$' "$LOG_FOOT" "mirror-footer: footer separator present in body"
assert_grep 'model `claude-opus-4-7`' "$LOG_FOOT" "mirror-footer: footer renders model from JSONL"
assert_grep '1 sub-agent\(s\) launched' "$LOG_FOOT" "mirror-footer: footer counts sub-agents"
assert_grep 'active 2m 5s' "$LOG_FOOT" "mirror-footer: footer renders active working duration"
assert_grep 'catalyst session `sess_FOOTERTEST`' "$LOG_FOOT" "mirror-footer: footer renders catalyst session id"
assert_grep 'session uuid `abcd1234-aaaa-bbbb-cccc-000011112222`' "$LOG_FOOT" "mirror-footer: footer renders long session uuid"

# ─── Test 19 (CTL-709): phase-implement draft-pr block contract ───────────────
echo ""
echo "Test 19 (CTL-709): phase-implement contract — draft-pr block present + wired correctly"
if [[ -f $SKILL_IMPLEMENT ]]; then
	# Uniquely-named fence must exist so the harness can extract + run it.
	assert_grep 'phase-implement-draft-pr' "$SKILL_IMPLEMENT" "body contains uniquely-named phase-implement-draft-pr fence"
	# Must source lib/draft-pr.sh.
	assert_grep 'draft-pr\.sh' "$SKILL_IMPLEMENT" "fence sources lib/draft-pr.sh"
	# Must gate on draft_pr_enabled.
	assert_grep 'draft_pr_enabled' "$SKILL_IMPLEMENT" "fence gates on draft_pr_enabled (config knob)"
	# Must call draft_pr_push and draft_pr_ensure.
	assert_grep 'draft_pr_push' "$SKILL_IMPLEMENT" "fence calls draft_pr_push"
	assert_grep 'draft_pr_ensure' "$SKILL_IMPLEMENT" "fence calls draft_pr_ensure"
	# Must write .draftPr into signal file via jq atomic tmp-mv.
	assert_grep '\.draftPr' "$SKILL_IMPLEMENT" "fence writes .draftPr into signal file"
	# Must be fail-open: no bare exit 1 inside the fence on PR failure.
	DRAFT_PR_FENCE_BODY="${SCRATCH}/t19-draft-pr-fence.sh"
	awk '
    /^```bash phase-implement-draft-pr$/ {grab=1; next}
    grab && /^```[ \t]*$/ {grab=0}
    grab {print}
  ' "$SKILL_IMPLEMENT" >"$DRAFT_PR_FENCE_BODY"
	if [[ -s $DRAFT_PR_FENCE_BODY ]]; then
		pass "Test 19: draft-pr fence extractable from SKILL.md"
		# Fail-open: no bare `exit 1` that would kill the phase on PR failure.
		if grep -qE '^\s*exit 1' "$DRAFT_PR_FENCE_BODY" 2>/dev/null; then
			fail "Test 19: draft-pr fence must not contain bare 'exit 1' (fail-open required)"
		else
			pass "Test 19: draft-pr fence is fail-open (no bare exit 1)"
		fi
		# No emit-complete inside the draft-pr fence (that belongs to terminal emit).
		if grep -q 'emit-complete' "$DRAFT_PR_FENCE_BODY" 2>/dev/null; then
			fail "Test 19: draft-pr fence must not call emit-complete (phase wiring concern)"
		else
			pass "Test 19: draft-pr fence does not call emit-complete"
		fi
	else
		fail 'Test 19: draft-pr fence not extractable — no ```bash phase-implement-draft-pr``` fence found'
	fi
fi

# ─── Test 20 (CTL-709): draft-pr fence ordering ───────────────────────────────
echo ""
echo "Test 20 (CTL-709): phase-implement-draft-pr fence appears after empty-branch gate and before terminal emit"
if [[ -f $SKILL_IMPLEMENT ]]; then
	LINE_GATE=$(grep -n 'phase-implement-empty-branch-gate' "$SKILL_IMPLEMENT" | head -1 | cut -d: -f1)
	LINE_DRAFT=$(grep -n 'phase-implement-draft-pr' "$SKILL_IMPLEMENT" | head -1 | cut -d: -f1)
	# Use the EMIT= variable assignment in the terminal emit block (not the prose mention).
	LINE_EMIT=$(grep -n 'EMIT=.*phase-agent-emit-complete' "$SKILL_IMPLEMENT" | head -1 | cut -d: -f1)
	if [[ -n $LINE_GATE && -n $LINE_DRAFT && -n $LINE_EMIT ]]; then
		if [[ $LINE_DRAFT -gt $LINE_GATE ]]; then
			pass "Test 20: draft-pr fence is AFTER empty-branch gate (line $LINE_DRAFT > $LINE_GATE)"
		else
			fail "Test 20: draft-pr fence must appear AFTER empty-branch gate (draft=$LINE_DRAFT gate=$LINE_GATE)"
		fi
		if [[ $LINE_DRAFT -lt $LINE_EMIT ]]; then
			pass "Test 20: draft-pr fence is BEFORE terminal --status complete (line $LINE_DRAFT < $LINE_EMIT)"
		else
			fail "Test 20: draft-pr fence must appear BEFORE terminal emit (draft=$LINE_DRAFT emit=$LINE_EMIT)"
		fi
	else
		fail "Test 20: could not locate all three anchors (gate=$LINE_GATE draft=$LINE_DRAFT emit=$LINE_EMIT)"
	fi
fi

# ─── Test 21 (CTL-709): draft-pr fence behavior — enabled + commits → push + draft PR
echo ""
echo "Test 21 (CTL-709): draft-pr fence behavior — enabled + commits → push + draft PR"
DRAFT_FENCE_FILE="${SCRATCH}/t21-fence.sh"
awk '
  /^```bash phase-implement-draft-pr$/ {grab=1; next}
  grab && /^```[ \t]*$/ {grab=0}
  grab {print}
' "$SKILL_IMPLEMENT" >"$DRAFT_FENCE_FILE" 2>/dev/null || true

if [[ ! -s $DRAFT_FENCE_FILE ]]; then
	fail "Test 21: skipped — draft-pr fence not yet extractable"
else
	pass "Test 21: draft-pr fence extractable"

	# Minimal git repo with one commit + stubbed gh/git for the fence.
	build_git_fixture_one_commit() {
		local repo_dir="$1"
		local bare_dir="${repo_dir}-bare.git"
		mkdir -p "$repo_dir"
		git init --quiet "$bare_dir" --bare -b main
		(
			cd "$repo_dir" || exit 1
			git init --quiet --initial-branch=main
			git config user.email "test@example.com"
			git config user.name "Test"
			echo "base" >base.txt
			git add base.txt
			git commit --quiet -m "base commit"
			git remote add origin "$bare_dir"
			git push --quiet origin main
			git checkout --quiet -b CTL-709
			echo "change" >change.txt
			git add change.txt
			git commit --quiet -m "feat: implement draft-pr"
		)
	}

	T21_DIR="${SCRATCH}/t21"
	T21_REPO="${T21_DIR}/repo"
	T21_BIN="${T21_DIR}/bin"
	T21_PLUGIN="${T21_DIR}/plugin"
	T21_SIGNAL_DIR="${T21_DIR}/orch/workers/CTL-709"
	mkdir -p "$T21_BIN" "$T21_PLUGIN/scripts/lib" "$T21_SIGNAL_DIR"
	build_git_fixture_one_commit "$T21_REPO"

	# Copy real lib so the fence can source it.
	cp "${REPO_ROOT}/plugins/dev/scripts/lib/draft-pr.sh" "${T21_PLUGIN}/scripts/lib/draft-pr.sh"

	# gh stub: view exits 1 (no existing PR), create --draft returns URL.
	T21_GH_LOG="${T21_DIR}/gh.log"
	cat >"${T21_BIN}/gh" <<GHSTUB
#!/usr/bin/env bash
printf '%s\n' "\$@" >> "${T21_GH_LOG}"
if [[ "\$1" == "pr" && "\$2" == "view" ]]; then exit 1; fi
if [[ "\$1" == "pr" && "\$2" == "create" ]]; then
  echo "https://github.com/test/repo/pull/77"
  exit 0
fi
if [[ "\$1" == "repo" && "\$2" == "view" ]]; then
  echo '{"defaultBranchRef":{"name":"main"}}'
  exit 0
fi
exit 0
GHSTUB
	chmod +x "${T21_BIN}/gh"

	# Signal file with required variables.
	T21_SIGNAL="${T21_SIGNAL_DIR}/phase-implement.json"
	printf '{"status":"running","ticket":"CTL-709","phase":"implement"}\n' >"$T21_SIGNAL"

	# No config → draftPr.enabled defaults to true.
	(
		cd "$T21_REPO" || exit 1
		git push -u origin HEAD --quiet 2>/dev/null || true
		PATH="${T21_BIN}:${PATH}" \
			PLUGIN_ROOT="${T21_PLUGIN}" \
			SIGNAL_FILE="$T21_SIGNAL" \
			TICKET="CTL-709" \
			PHASE="implement" \
			ORCH_DIR="${T21_DIR}/orch" \
			bash "$DRAFT_FENCE_FILE" >"${T21_DIR}/stdout.log" 2>"${T21_DIR}/stderr.log"
		echo "$?" >"${T21_DIR}/exit-code"
	)

	assert_eq "0" "$(cat "${T21_DIR}/exit-code")" "Test 21: draft-pr fence exits 0 (enabled + commits)"
	if grep -q '\-\-draft' "$T21_GH_LOG" 2>/dev/null; then
		pass "Test 21: gh pr create --draft was called"
	else
		fail "Test 21: gh pr create --draft should be called — log: $(cat "$T21_GH_LOG" 2>/dev/null)"
	fi
	# Signal file should have .draftPr.number
	DRAFT_PR_NUM="$(jq -r '.draftPr.number // empty' "$T21_SIGNAL" 2>/dev/null || true)"
	if [[ -n $DRAFT_PR_NUM ]]; then
		pass "Test 21: signal file has .draftPr.number set (=$DRAFT_PR_NUM)"
	else
		fail "Test 21: signal file .draftPr.number should be set — signal: $(cat "$T21_SIGNAL" 2>/dev/null)"
	fi
fi

# ─── Test 22 (CTL-709): draft-pr fence behavior — disabled → no-op
echo ""
echo "Test 22 (CTL-709): draft-pr fence behavior — draftPr.enabled=false → no-op"
if [[ ! -s $DRAFT_FENCE_FILE ]]; then
	fail "Test 22: skipped — draft-pr fence not extractable"
else
	T22_DIR="${SCRATCH}/t22"
	T22_REPO="${T22_DIR}/repo"
	T22_BIN="${T22_DIR}/bin"
	T22_PLUGIN="${T22_DIR}/plugin"
	T22_SIGNAL_DIR="${T22_DIR}/orch/workers/CTL-709"
	mkdir -p "$T22_BIN" "$T22_PLUGIN/scripts/lib" "$T22_SIGNAL_DIR"
	build_git_fixture_one_commit "$T22_REPO"

	cp "${REPO_ROOT}/plugins/dev/scripts/lib/draft-pr.sh" "${T22_PLUGIN}/scripts/lib/draft-pr.sh"

	# gh stub that fails loudly if called unexpectedly.
	T22_GH_LOG="${T22_DIR}/gh.log"
	cat >"${T22_BIN}/gh" <<GHSTUB
#!/usr/bin/env bash
printf '%s\n' "\$@" >> "${T22_GH_LOG}"
echo "gh should NOT be called when draftPr.enabled=false" >&2
exit 1
GHSTUB
	chmod +x "${T22_BIN}/gh"

	T22_SIGNAL="${T22_SIGNAL_DIR}/phase-implement.json"
	printf '{"status":"running","ticket":"CTL-709","phase":"implement"}\n' >"$T22_SIGNAL"

	T22_CONFIG="${T22_DIR}/config.json"
	printf '{"catalyst":{"orchestration":{"draftPr":{"enabled":false}}}}\n' >"$T22_CONFIG"

	(
		cd "$T22_REPO" || exit 1
		PATH="${T22_BIN}:${PATH}" \
			PLUGIN_ROOT="${T22_PLUGIN}" \
			SIGNAL_FILE="$T22_SIGNAL" \
			TICKET="CTL-709" \
			PHASE="implement" \
			ORCH_DIR="${T22_DIR}/orch" \
			CATALYST_CONFIG_PATH="$T22_CONFIG" \
			bash "$DRAFT_FENCE_FILE" >"${T22_DIR}/stdout.log" 2>"${T22_DIR}/stderr.log"
		echo "$?" >"${T22_DIR}/exit-code"
	)

	assert_eq "0" "$(cat "${T22_DIR}/exit-code")" "Test 22: draft-pr fence exits 0 when disabled"
	if [[ -f $T22_GH_LOG ]] && grep -q '.' "$T22_GH_LOG" 2>/dev/null; then
		fail "Test 22: gh must NOT be called when draftPr.enabled=false — log: $(cat "$T22_GH_LOG")"
	else
		pass "Test 22: gh NOT called (feature disabled)"
	fi
	DRAFT_PR_FIELD="$(jq -r '.draftPr // "absent"' "$T22_SIGNAL" 2>/dev/null || echo 'absent')"
	if [[ $DRAFT_PR_FIELD == "absent" || $DRAFT_PR_FIELD == "null" ]]; then
		pass "Test 22: .draftPr field absent in signal when disabled"
	else
		fail "Test 22: .draftPr should be absent when disabled — got: $DRAFT_PR_FIELD"
	fi
fi

# ─── Test 23 (CTL-709): draft-pr fence behavior — gh create fails → fail-open
echo ""
echo "Test 23 (CTL-709): draft-pr fence — gh pr create fails entirely → fail-open, phase still completes"
if [[ ! -s $DRAFT_FENCE_FILE ]]; then
	fail "Test 23: skipped — draft-pr fence not extractable"
else
	T23_DIR="${SCRATCH}/t23"
	T23_REPO="${T23_DIR}/repo"
	T23_BIN="${T23_DIR}/bin"
	T23_PLUGIN="${T23_DIR}/plugin"
	T23_SIGNAL_DIR="${T23_DIR}/orch/workers/CTL-709"
	mkdir -p "$T23_BIN" "$T23_PLUGIN/scripts/lib" "$T23_SIGNAL_DIR"
	build_git_fixture_one_commit "$T23_REPO"

	cp "${REPO_ROOT}/plugins/dev/scripts/lib/draft-pr.sh" "${T23_PLUGIN}/scripts/lib/draft-pr.sh"

	# gh stub: all operations fail.
	T23_GH_LOG="${T23_DIR}/gh.log"
	cat >"${T23_BIN}/gh" <<GHSTUB
#!/usr/bin/env bash
printf '%s\n' "\$@" >> "${T23_GH_LOG}"
echo "gh stub: all operations fail" >&2
exit 1
GHSTUB
	chmod +x "${T23_BIN}/gh"

	T23_SIGNAL="${T23_SIGNAL_DIR}/phase-implement.json"
	printf '{"status":"running","ticket":"CTL-709","phase":"implement"}\n' >"$T23_SIGNAL"

	(
		cd "$T23_REPO" || exit 1
		git push -u origin HEAD --quiet 2>/dev/null || true
		PATH="${T23_BIN}:${PATH}" \
			PLUGIN_ROOT="${T23_PLUGIN}" \
			SIGNAL_FILE="$T23_SIGNAL" \
			TICKET="CTL-709" \
			PHASE="implement" \
			ORCH_DIR="${T23_DIR}/orch" \
			bash "$DRAFT_FENCE_FILE" >"${T23_DIR}/stdout.log" 2>"${T23_DIR}/stderr.log"
		echo "$?" >"${T23_DIR}/exit-code"
	)

	assert_eq "0" "$(cat "${T23_DIR}/exit-code")" "Test 23: fence exits 0 even when gh fails (fail-open)"
	DRAFT_PR_FIELD="$(jq -r '.draftPr // "absent"' "$T23_SIGNAL" 2>/dev/null || echo 'absent')"
	if [[ $DRAFT_PR_FIELD == "absent" || $DRAFT_PR_FIELD == "null" ]]; then
		pass "Test 23: .draftPr absent/null in signal when gh fails"
	else
		fail "Test 23: .draftPr should be absent when gh fails — got: $DRAFT_PR_FIELD"
	fi
fi

# ─── Test 24 (CTL-783): implement-plan early draft-pr fence contract ──────────
SKILL_IMPLEMENT_PLAN="${REPO_ROOT}/plugins/dev/skills/implement-plan/SKILL.md"
echo ""
echo "Test 24 (CTL-783): implement-plan early draft-pr fence contract"
if [[ -f $SKILL_IMPLEMENT_PLAN ]]; then
	# A. fence present + uniquely named
	assert_grep '```bash implement-plan-draft-pr-early' "$SKILL_IMPLEMENT_PLAN" \
		"Test 24A: implement-plan-draft-pr-early fence present and uniquely named"
	# B. sources lib/draft-pr.sh
	assert_grep 'draft-pr\.sh' "$SKILL_IMPLEMENT_PLAN" \
		"Test 24B: fence sources lib/draft-pr.sh"
	# C. gated on CATALYST_PHASE being set
	EARLY_FENCE_BODY="${SCRATCH}/t24-early-fence.sh"
	awk '
    /^```bash implement-plan-draft-pr-early$/ {grab=1; next}
    grab && /^```[ \t]*$/ {grab=0}
    grab {print}
  ' "$SKILL_IMPLEMENT_PLAN" >"$EARLY_FENCE_BODY"
	if [[ -s $EARLY_FENCE_BODY ]]; then
		pass "Test 24: implement-plan-draft-pr-early fence extractable"
		assert_grep 'CATALYST_PHASE' "$EARLY_FENCE_BODY" \
			"Test 24C: fence is gated on CATALYST_PHASE (interactive runs unaffected)"
		# D. gated on draft_pr_enabled
		assert_grep 'draft_pr_enabled' "$EARLY_FENCE_BODY" \
			"Test 24D: fence gates on draft_pr_enabled (config knob)"
		# E. calls draft_pr_push AND draft_pr_ensure
		assert_grep 'draft_pr_push' "$EARLY_FENCE_BODY" \
			"Test 24E: fence calls draft_pr_push"
		assert_grep 'draft_pr_ensure' "$EARLY_FENCE_BODY" \
			"Test 24E: fence calls draft_pr_ensure"
		# F. fail-open: no bare exit 1
		if grep -qE '^\s*exit 1' "$EARLY_FENCE_BODY" 2>/dev/null; then
			fail "Test 24F: fence must not contain bare 'exit 1' (fail-open required)"
		else
			pass "Test 24F: fence is fail-open (no bare exit 1)"
		fi
		# G. does NOT call phase-agent-emit-complete
		if grep -q 'emit-complete' "$EARLY_FENCE_BODY" 2>/dev/null; then
			fail "Test 24G: fence must not call emit-complete (phase wiring concern)"
		else
			pass "Test 24G: fence does not call emit-complete"
		fi
		# H. does NOT write .draftPr (signal writes belong to phase-implement End block)
		if grep -q '\.draftPr' "$EARLY_FENCE_BODY" 2>/dev/null; then
			fail "Test 24H: fence must not write .draftPr (signal writes belong to phase-implement End block)"
		else
			pass "Test 24H: fence does not write .draftPr (correct separation)"
		fi
		# I. runtime: extract + run fence with CATALYST_PHASE=implement, no-PR stub → gh pr create called once;
		#    re-run with existing-PR stub → no second create.
		T24_DIR="${SCRATCH}/t24-runtime"
		mkdir -p "$T24_DIR"
		T24_REPO="${T24_DIR}/repo"
		T24_BARE="${T24_DIR}/repo-bare.git"
		T24_BIN="${T24_DIR}/bin"
		T24_GH_LOG="${T24_DIR}/gh.log"
		T24_PLUGIN="${T24_DIR}/plugin"
		mkdir -p "${T24_PLUGIN}/scripts/lib"
		cp "${REPO_ROOT}/plugins/dev/scripts/lib/draft-pr.sh" "${T24_PLUGIN}/scripts/lib/draft-pr.sh"
		git init --quiet "$T24_BARE" --bare -b main
		git clone --quiet "$T24_BARE" "$T24_REPO"
		(
			cd "$T24_REPO"
			git config user.email "test@example.com"
			git config user.name "Test"
			echo "base" >base.txt
			git add base.txt
			git commit --quiet -m "base"
			git push --quiet origin main
			git checkout --quiet -b feature
			echo "work" >work.txt
			git add work.txt
			git commit --quiet -m "feat(dev): CTL-783 add draft pr early"
			git push --quiet -u origin HEAD
		) 2>/dev/null
		mkdir -p "$T24_BIN"
		cat >"${T24_BIN}/gh" <<GHSTUB
#!/usr/bin/env bash
printf '%s\n' "\$@" >> "${T24_GH_LOG}"
if [[ "\$1" == "pr" && "\$2" == "view" ]]; then exit 1; fi
if [[ "\$1" == "pr" && "\$2" == "create" ]]; then
  echo "https://github.com/test/repo/pull/42"; exit 0
fi
if [[ "\$1" == "repo" && "\$2" == "view" ]]; then
  echo '{"defaultBranchRef":{"name":"main"}}'; exit 0
fi
exit 0
GHSTUB
		chmod +x "${T24_BIN}/gh"
		(
			cd "$T24_REPO"
			PATH="${T24_BIN}:${PATH}" \
				CLAUDE_PLUGIN_ROOT="${T24_PLUGIN}" \
				CATALYST_PHASE=implement \
				CATALYST_TICKET=CTL-783 \
				bash "$EARLY_FENCE_BODY" >"${T24_DIR}/stdout1.log" 2>"${T24_DIR}/stderr1.log"
			echo "$?" >"${T24_DIR}/exit1"
		) || true
		assert_eq "0" "$(cat "${T24_DIR}/exit1" 2>/dev/null)" "Test 24I: fence exits 0 (enabled + commits)"
		if grep -q 'create' "${T24_GH_LOG}" 2>/dev/null; then
			pass "Test 24I: gh pr create called on first run"
		else
			fail "Test 24I: gh pr create should be called — log: $(cat "${T24_GH_LOG}" 2>/dev/null)"
		fi
		# Re-run with existing-PR stub: assert NO second create
		T24_BIN2="${T24_DIR}/bin2"
		T24_GH_LOG2="${T24_DIR}/gh2.log"
		mkdir -p "$T24_BIN2"
		cat >"${T24_BIN2}/gh" <<GHSTUB2
#!/usr/bin/env bash
printf '%s\n' "\$@" >> "${T24_GH_LOG2}"
if [[ "\$1" == "pr" && "\$2" == "view" ]]; then
  printf '{"number":42,"url":"https://github.com/test/repo/pull/42","isDraft":true}\n'; exit 0
fi
if [[ "\$1" == "pr" && "\$2" == "create" ]]; then
  echo "gh stub: create unexpectedly called" >&2; exit 1
fi
exit 0
GHSTUB2
		chmod +x "${T24_BIN2}/gh"
		(
			cd "$T24_REPO"
			PATH="${T24_BIN2}:${PATH}" \
				CLAUDE_PLUGIN_ROOT="${T24_PLUGIN}" \
				CATALYST_PHASE=implement \
				CATALYST_TICKET=CTL-783 \
				bash "$EARLY_FENCE_BODY" >"${T24_DIR}/stdout2.log" 2>"${T24_DIR}/stderr2.log"
			echo "$?" >"${T24_DIR}/exit2"
		) || true
		assert_eq "0" "$(cat "${T24_DIR}/exit2" 2>/dev/null)" "Test 24I: fence exits 0 on idempotent run"
		if grep -q 'create' "${T24_GH_LOG2}" 2>/dev/null; then
			fail "Test 24I: gh pr create must NOT be called on idempotent run — log: $(cat "${T24_GH_LOG2}" 2>/dev/null)"
		else
			pass "Test 24I: gh pr create NOT called (idempotent)"
		fi
		# J. runtime gate: CATALYST_PHASE unset → gh log empty (no push, no create)
		T24_GH_LOG3="${T24_DIR}/gh3.log"
		T24_BIN3="${T24_DIR}/bin3"
		mkdir -p "$T24_BIN3"
		cat >"${T24_BIN3}/gh" <<GHSTUB3
#!/usr/bin/env bash
printf '%s\n' "\$@" >> "${T24_GH_LOG3}"; exit 0
GHSTUB3
		chmod +x "${T24_BIN3}/gh"
		(
			cd "$T24_REPO"
			PATH="${T24_BIN3}:${PATH}" \
				CLAUDE_PLUGIN_ROOT="${T24_PLUGIN}" \
				CATALYST_PHASE="" \
				bash "$EARLY_FENCE_BODY" >"${T24_DIR}/stdout3.log" 2>"${T24_DIR}/stderr3.log"
			echo "$?" >"${T24_DIR}/exit3"
		) || true
		assert_eq "0" "$(cat "${T24_DIR}/exit3" 2>/dev/null)" "Test 24J: fence exits 0 when CATALYST_PHASE unset"
		if [[ -s ${T24_GH_LOG3} ]]; then
			fail "Test 24J: gh must NOT be called when CATALYST_PHASE unset — log: $(cat "${T24_GH_LOG3}" 2>/dev/null)"
		else
			pass "Test 24J: gh NOT called when CATALYST_PHASE unset (interactive mode)"
		fi
	else
		fail "Test 24: implement-plan-draft-pr-early fence not extractable (not yet implemented)"
	fi
else
	fail "Test 24: implement-plan/SKILL.md not found"
fi

# Test 24 extension: phase-implement prose mentions implement-plan opens draft PR early
echo ""
echo "Test 24 ext: phase-implement prose mentions early draft PR from implement-plan (backstop note)"
if [[ -f $SKILL_IMPLEMENT ]]; then
	if grep -q 'implement-plan-draft-pr-early\|backstop' "$SKILL_IMPLEMENT" 2>/dev/null; then
		pass "Test 24 ext: phase-implement references implement-plan-draft-pr-early or backstop"
	else
		fail "Test 24 ext: phase-implement should mention implement-plan-draft-pr-early or call End-block fence a backstop"
	fi
fi

# ─── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────"
echo "phase-implement-e2e: ${PASSES} passed, ${FAILURES} failed"
echo "─────────────────────────────────────────────"
[[ $FAILURES -eq 0 ]]
