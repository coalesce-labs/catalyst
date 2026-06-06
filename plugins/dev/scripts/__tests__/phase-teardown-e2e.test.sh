#!/usr/bin/env bash
# E2E test for plugins/dev/skills/phase-teardown/SKILL.md (CTL-703).
#
# Strategy:
#   1. Build a scratch ORCH_DIR with fixture signal files:
#      - phase-monitor-merge.json (.pr.mergedAt + .pr.ciStatus:"merged")
#      - phase-monitor-deploy.json (status done)
#      - A throwaway git repo + worktree pair
#   2. Stub linearis, linear-transition.sh, worktree-presweep.sh on PATH.
#   3. Extract and run the fenced bash bodies (phase-teardown-safety-gate,
#      phase-teardown-timings, phase-teardown-linear-done, phase-teardown-archive,
#      phase-teardown-worktree-removal, phase-teardown-mirror, phase-teardown-emit).
#   4. Assert outcomes per the spec.
#
# Cases:
#   1. happy path  — merged PR + deploy done → archive, worktree removed,
#                     Linear mirror posted, linear-transition.sh --transition done
#                     invoked exactly once, signal ends with status:"done"
#   2. safety gate — phase-monitor-merge.json shows PR NOT merged →
#                     emits failed, does NOT remove worktree
#   3. idempotency — re-run with .linear-mirror-teardown marker present →
#                     does NOT post second comment
#
# Run: bash plugins/dev/scripts/__tests__/phase-teardown-e2e.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL_FILE="${REPO_ROOT}/plugins/dev/skills/phase-teardown/SKILL.md"
EMIT_HELPER="${REPO_ROOT}/plugins/dev/scripts/lib/phase-emit-complete.sh"
EMIT_WRAPPER="${REPO_ROOT}/plugins/dev/scripts/phase-agent-emit-complete"
# shellcheck source=lib/linearis-stub.sh
source "${SCRIPT_DIR}/lib/linearis-stub.sh"

PASS=0
FAIL=0

ok()         { PASS=$((PASS+1)); printf '  PASS: %s\n' "$1"; }
fail()       { FAIL=$((FAIL+1)); printf '  FAIL: %s\n    %s\n' "$1" "${2:-}"; }
assert_eq()  { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "expected='$2' got='$3'"; fi; }
assert_file_exists() { if [ -f "$2" ]; then ok "$1"; else fail "$1" "missing file: $2"; fi; }
assert_dir_exists()  { if [ -d "$2" ]; then ok "$1"; else fail "$1" "missing dir: $2"; fi; }

[ -f "$SKILL_FILE" ]  || { echo "FAIL: skill missing: $SKILL_FILE";   exit 1; }
[ -f "$EMIT_HELPER" ] || { echo "FAIL: helper missing: $EMIT_HELPER"; exit 1; }

# ─── Extract fenced skill blocks ─────────────────────────────────────────────
# We concatenate all named + unnamed bash fences in document order so the body
# can be run as a single script (variables set in one fence are visible in the
# next, same as production where the model runs the fences in order).

SKILL_BODY_FILE="$(mktemp -t phase-teardown-body.XXXXXX.sh)"
awk '
  /^```bash/ { capture=1; next }
  /^```$/    { if (capture) capture=0; next }
  capture    { print }
' "$SKILL_FILE" > "$SKILL_BODY_FILE"

if [ ! -s "$SKILL_BODY_FILE" ]; then
  echo "FAIL: could not extract any bash blocks from $SKILL_FILE" >&2
  exit 1
fi

TMPROOT="$(mktemp -d -t phase-teardown-test.XXXXXX)"
trap 'rm -rf "$TMPROOT" "$SKILL_BODY_FILE"' EXIT

# ─── Helper: build a throwaway git repo + linked worktree ───────────────────
# Returns the path to the PRIMARY worktree (the repo) via stdout.
# The TICKET worktree is at <primary>/../wt/<ticket>.
make_git_pair() {
  local primary="$1" wt_path="$2" branch="$3"
  git init -q "$primary" 2>/dev/null
  git -C "$primary" config user.email "test@example.com"
  git -C "$primary" config user.name  "Test"
  touch "$primary/README.md"
  git -C "$primary" add README.md
  git -C "$primary" commit -q -m "init" 2>/dev/null
  mkdir -p "$(dirname "$wt_path")"
  # Use -b to create a new branch directly on the worktree (avoids "already
  # used by worktree" when the branch was checked out in the primary).
  # Commit a .gitignore so .catalyst/ (written later by the test) is ignored
  # rather than untracked — git worktree remove refuses dirty trees.
  printf '.catalyst/\n' > "$primary/.gitignore"
  git -C "$primary" add .gitignore
  git -C "$primary" commit -q -m "gitignore" 2>/dev/null
  git -C "$primary" worktree add -q -b "$branch" "$wt_path" 2>/dev/null
}

# ─── Helper: write fixture signal files into worker dir ─────────────────────
write_fixture_signals() {
  local worker="$1" merged="${2:-true}"
  local now; now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local then; then="$(date -u -v-120S +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '120 seconds ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "${now}")"

  # phase-triage.json
  jq -nc --arg s "$then" --arg c "$now" '{status:"done",startedAt:$s,completedAt:$c}' \
    > "$worker/phase-triage.json"

  # phase-research.json
  jq -nc --arg s "$then" --arg c "$now" '{status:"done",startedAt:$s,completedAt:$c}' \
    > "$worker/phase-research.json"

  # phase-monitor-merge.json — merged or not merged
  if [[ "$merged" == "true" ]]; then
    jq -nc --arg now "$now" '{pr:{mergedAt:$now,ciStatus:"merged",mergeCommitSha:"deadbeef"}}' \
      > "$worker/phase-monitor-merge.json"
  else
    jq -nc '{pr:{mergedAt:"",ciStatus:"open",mergeCommitSha:""}}' \
      > "$worker/phase-monitor-merge.json"
  fi

  # phase-monitor-deploy.json
  jq -nc --arg s "$then" --arg c "$now" \
    '{status:"done",deploy_state:"success",startedAt:$s,completedAt:$c}' \
    > "$worker/phase-monitor-deploy.json"

  # phase-teardown.json (signal file — starts as "running")
  jq -nc --arg s "$now" '{status:"running",startedAt:$s}' \
    > "$worker/phase-teardown.json"
}

# ─── Helper: install a linear-transition.sh stub that logs invocations ──────
# Stubs go under <plugin_root>/scripts/ since the skill uses
# "${PLUGIN_ROOT}/scripts/linear-transition.sh".
install_linear_transition_stub() {
  local plugin_root="$1" log_file="$2"
  mkdir -p "$plugin_root/scripts"
  cat > "$plugin_root/scripts/linear-transition.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" >> "${log_file}"
exit 0
EOF
  chmod +x "$plugin_root/scripts/linear-transition.sh"
}

# ─── Helper: install a presweep stub that always succeeds ───────────────────
# Stubs go under <plugin_root>/scripts/lib/ since the skill uses
# "${PLUGIN_ROOT}/scripts/lib/worktree-presweep.sh".
install_presweep_stub() {
  local plugin_root="$1"
  mkdir -p "$plugin_root/scripts/lib"
  cat > "$plugin_root/scripts/lib/worktree-presweep.sh" <<EOF
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$plugin_root/scripts/lib/worktree-presweep.sh"
}

# ─────────────────────────────────────────────────────────────────────────────
# Case 1: happy path — merged PR + deploy done
# Assert: archive created, worktree removed, Linear mirror posted,
#         linear-transition.sh invoked exactly once, signal status=="done"

echo "phase-teardown e2e tests"
echo ""
echo "Case 1: happy path (merged PR, deploy done)"

C1="$TMPROOT/case1"
PRIMARY_GIT="$C1/primary-repo"
WT_PATH="$C1/ticket-wt"
ORCH_DIR="$C1/orch"
WORKER="$ORCH_DIR/workers/CTL-9999"
FAKE_HOME="$C1/home"
mkdir -p "$WORKER" "$FAKE_HOME/catalyst/archives"

write_fixture_signals "$WORKER" "true"
make_git_pair "$PRIMARY_GIT" "$WT_PATH" "ctl-9999-branch"

# Put a .catalyst/config.json in the worktree so linear-transition can find it
mkdir -p "$WT_PATH/.catalyst"
echo '{"catalyst":{"projectKey":"CTL","orchestration":{"keepWorktreeAfterMerge":false}}}' \
  > "$WT_PATH/.catalyst/config.json"

# Set up stub bin dir (scripts dir for linear-transition.sh)
STUB_BIN="$C1/bin"
PLUGIN_ROOT1="$C1/plugin-root"
mkdir -p "$STUB_BIN" "$PLUGIN_ROOT1/scripts/lib"

linearis_stub_install "$STUB_BIN" "$C1/linearis-calls.log"
linear_comment_post_stub_install "$STUB_BIN" "$C1/linear-comment-calls.log"
install_linear_transition_stub "$PLUGIN_ROOT1" "$C1/linear-transition-calls.log"
install_presweep_stub "$PLUGIN_ROOT1"

MONTH=$(date -u +%Y-%m)
mkdir -p "$FAKE_HOME/catalyst/events"
: > "$FAKE_HOME/catalyst/events/${MONTH}.jsonl"

(
  cd "$WT_PATH"
  HOME="$FAKE_HOME" \
  PATH="$STUB_BIN:$PATH" \
  TICKET=CTL-9999 \
  CATALYST_ORCHESTRATOR_DIR="$ORCH_DIR" \
  CATALYST_ORCHESTRATOR_ID="orch-test-1" \
  CATALYST_DIR="$FAKE_HOME/catalyst" \
  ORCH_DIR="$ORCH_DIR" \
  ORCH_ID="orch-test-1" \
  PLUGIN_ROOT="$PLUGIN_ROOT1" \
  PHASE_AGENT_REPO_ROOT="$REPO_ROOT" \
  PHASE_EMIT_HELPER="$EMIT_HELPER" \
  PHASE_EMIT_WRAPPER="$EMIT_WRAPPER" \
  CATALYST_COMMENT_POST_HELPER="$STUB_BIN/linear-comment-post.sh" \
    bash "$SKILL_BODY_FILE" >"$C1/stdout.log" 2>"$C1/stderr.log"
  echo $? > "$C1/exit-code"
)

C1_EXIT="$(cat "$C1/exit-code" 2>/dev/null || echo 99)"
assert_eq "case1: exit code 0" "0" "$C1_EXIT"

# 1a. Archive created
assert_dir_exists "case1: archive dir created" "$FAKE_HOME/catalyst/archives/CTL-9999"
if [ -d "$FAKE_HOME/catalyst/archives/CTL-9999" ]; then
  if ls "$FAKE_HOME/catalyst/archives/CTL-9999/phase-monitor-merge.json" >/dev/null 2>&1; then
    ok "case1: archive contains phase-monitor-merge.json"
  else
    fail "case1: archive contains phase-monitor-merge.json" \
      "ls: $(ls "$FAKE_HOME/catalyst/archives/CTL-9999/" 2>/dev/null || echo empty)"
  fi
fi

# 1b. Worktree removed (the wt directory should no longer exist)
if [ ! -d "$WT_PATH" ]; then
  ok "case1: worktree directory removed"
else
  fail "case1: worktree directory removed" "still exists: $WT_PATH"
fi

# 1c. Linear mirror posted (stub captures body)
if grep -q 'discuss' "$C1/linearis-calls.log" 2>/dev/null \
   || grep -q 'CTL-9999' "$C1/linear-comment-calls.log" 2>/dev/null; then
  ok "case1: Linear mirror comment posted"
else
  fail "case1: Linear mirror comment posted" \
    "linearis log: $(cat "$C1/linearis-calls.log" 2>/dev/null || echo empty); comment log: $(cat "$C1/linear-comment-calls.log" 2>/dev/null || echo empty)"
fi

# Timing summary present in comment body
if grep -qi 'phase\|timing\|triage\|research\|duration' "$C1/linear-comment-calls.log" 2>/dev/null \
   || grep -qi 'phase\|timing\|triage\|research\|duration' "$C1/linearis-calls.log" 2>/dev/null; then
  ok "case1: mirror body contains timing summary"
else
  fail "case1: mirror body contains timing summary" \
    "linearis log: $(cat "$C1/linearis-calls.log" 2>/dev/null | head -20 || echo empty)"
fi

# 1d. linear-transition.sh invoked exactly once with --transition done
TRANSITION_CALLS=0
if [ -f "$C1/linear-transition-calls.log" ]; then
  TRANSITION_CALLS="$(grep -c -- '--transition' "$C1/linear-transition-calls.log" 2>/dev/null || echo 0)"
fi
assert_eq "case1: linear-transition.sh invoked exactly once" "1" "$TRANSITION_CALLS"
if grep -q 'done' "$C1/linear-transition-calls.log" 2>/dev/null; then
  ok "case1: linear-transition.sh called with --transition done"
else
  fail "case1: linear-transition.sh called with --transition done" \
    "log: $(cat "$C1/linear-transition-calls.log" 2>/dev/null || echo empty)"
fi

# 1e. Signal file ends with status:"done" and completedAt
SIGNAL="$WORKER/phase-teardown.json"
if [ -f "$SIGNAL" ]; then
  SIG_STATUS="$(jq -r '.status // empty' "$SIGNAL" 2>/dev/null)"
  assert_eq "case1: signal status==done" "done" "$SIG_STATUS"
  HAS_COMPLETED="$(jq -r 'has("completedAt")' "$SIGNAL" 2>/dev/null)"
  assert_eq "case1: signal has completedAt" "true" "$HAS_COMPLETED"
else
  fail "case1: phase-teardown.json signal file exists" "missing: $SIGNAL"
fi

# 1f. Emitted event
EMITTED="$(jq -r '.attributes."event.name" // empty' \
  "$FAKE_HOME/catalyst/events/${MONTH}.jsonl" 2>/dev/null | grep '^phase\.teardown\.' | tail -1)"
assert_eq "case1: emitted phase.teardown.complete event" \
  "phase.teardown.complete.CTL-9999" "$EMITTED"

# ─────────────────────────────────────────────────────────────────────────────
# Case 2: safety gate — PR NOT merged → emits failed, does NOT remove worktree

echo ""
echo "Case 2: safety gate (PR not merged)"

C2="$TMPROOT/case2"
PRIMARY_GIT2="$C2/primary-repo"
WT_PATH2="$C2/ticket-wt"
ORCH_DIR2="$C2/orch"
WORKER2="$ORCH_DIR2/workers/CTL-9999"
FAKE_HOME2="$C2/home"
mkdir -p "$WORKER2" "$FAKE_HOME2/catalyst/archives"

write_fixture_signals "$WORKER2" "false"  # PR NOT merged
make_git_pair "$PRIMARY_GIT2" "$WT_PATH2" "ctl-9999-branch"

mkdir -p "$WT_PATH2/.catalyst"
echo '{"catalyst":{"projectKey":"CTL","orchestration":{"keepWorktreeAfterMerge":false}}}' \
  > "$WT_PATH2/.catalyst/config.json"

STUB_BIN2="$C2/bin"
PLUGIN_ROOT2="$C2/plugin-root"
mkdir -p "$STUB_BIN2" "$PLUGIN_ROOT2/scripts/lib"

linearis_stub_install "$STUB_BIN2" "$C2/linearis-calls.log"
linear_comment_post_stub_install "$STUB_BIN2" "$C2/linear-comment-calls.log"
install_linear_transition_stub "$PLUGIN_ROOT2" "$C2/linear-transition-calls.log"
install_presweep_stub "$PLUGIN_ROOT2"

MONTH2=$(date -u +%Y-%m)
mkdir -p "$FAKE_HOME2/catalyst/events"
: > "$FAKE_HOME2/catalyst/events/${MONTH2}.jsonl"

(
  cd "$WT_PATH2"
  HOME="$FAKE_HOME2" \
  PATH="$STUB_BIN2:$PATH" \
  TICKET=CTL-9999 \
  CATALYST_ORCHESTRATOR_DIR="$ORCH_DIR2" \
  CATALYST_ORCHESTRATOR_ID="orch-test-2" \
  CATALYST_DIR="$FAKE_HOME2/catalyst" \
  ORCH_DIR="$ORCH_DIR2" \
  ORCH_ID="orch-test-2" \
  PLUGIN_ROOT="$PLUGIN_ROOT2" \
  PHASE_AGENT_REPO_ROOT="$REPO_ROOT" \
  PHASE_EMIT_HELPER="$EMIT_HELPER" \
  PHASE_EMIT_WRAPPER="$EMIT_WRAPPER" \
  CATALYST_COMMENT_POST_HELPER="$STUB_BIN2/linear-comment-post.sh" \
    bash "$SKILL_BODY_FILE" >"$C2/stdout.log" 2>"$C2/stderr.log"
  echo $? > "$C2/exit-code"
)

C2_EXIT="$(cat "$C2/exit-code" 2>/dev/null || echo 0)"
if [ "$C2_EXIT" -ne 0 ]; then
  ok "case2: exits non-zero when PR not merged"
else
  fail "case2: exits non-zero when PR not merged" "expected non-zero exit, got $C2_EXIT"
fi

# Worktree NOT removed
if [ -d "$WT_PATH2" ]; then
  ok "case2: worktree NOT removed (safety gate)"
else
  fail "case2: worktree NOT removed (safety gate)" "worktree was incorrectly deleted: $WT_PATH2"
fi

# Emitted failed event
FAIL_EVENT2="$(jq -r '.attributes."event.name" // empty' \
  "$FAKE_HOME2/catalyst/events/${MONTH2}.jsonl" 2>/dev/null | grep '^phase\.teardown\.' | tail -1)"
assert_eq "case2: emits phase.teardown.failed event" \
  "phase.teardown.failed.CTL-9999" "$FAIL_EVENT2"

# linear-transition.sh NOT called (no Done when safety gate fires)
TRANS_CALLS2=0
if [ -f "$C2/linear-transition-calls.log" ]; then
  TRANS_CALLS2="$(wc -l < "$C2/linear-transition-calls.log" 2>/dev/null | tr -d ' ')"
fi
assert_eq "case2: linear-transition.sh NOT called on safety-gate failure" "0" "$TRANS_CALLS2"

# ─────────────────────────────────────────────────────────────────────────────
# Case 3: idempotency — re-run with .linear-mirror-teardown present → no second post

echo ""
echo "Case 3: idempotency (.linear-mirror-teardown already present)"

C3="$TMPROOT/case3"
PRIMARY_GIT3="$C3/primary-repo"
WT_PATH3="$C3/ticket-wt"
ORCH_DIR3="$C3/orch"
WORKER3="$ORCH_DIR3/workers/CTL-9999"
FAKE_HOME3="$C3/home"
mkdir -p "$WORKER3" "$FAKE_HOME3/catalyst/archives"

write_fixture_signals "$WORKER3" "true"
make_git_pair "$PRIMARY_GIT3" "$WT_PATH3" "ctl-9999-branch"

mkdir -p "$WT_PATH3/.catalyst"
echo '{"catalyst":{"projectKey":"CTL","orchestration":{"keepWorktreeAfterMerge":true}}}' \
  > "$WT_PATH3/.catalyst/config.json"

STUB_BIN3="$C3/bin"
PLUGIN_ROOT3="$C3/plugin-root"
mkdir -p "$STUB_BIN3" "$PLUGIN_ROOT3/scripts/lib"

linearis_stub_install "$STUB_BIN3" "$C3/linearis-calls.log"
linear_comment_post_stub_install "$STUB_BIN3" "$C3/linear-comment-calls.log"
install_linear_transition_stub "$PLUGIN_ROOT3" "$C3/linear-transition-calls.log"
install_presweep_stub "$PLUGIN_ROOT3"

# Pre-write the idempotency marker + reset signal to running
: > "$WORKER3/.linear-mirror-teardown"
jq -nc --arg s "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{status:"running",startedAt:$s}' \
  > "$WORKER3/phase-teardown.json"

MONTH3=$(date -u +%Y-%m)
mkdir -p "$FAKE_HOME3/catalyst/events"
: > "$FAKE_HOME3/catalyst/events/${MONTH3}.jsonl"

(
  cd "$WT_PATH3"
  HOME="$FAKE_HOME3" \
  PATH="$STUB_BIN3:$PATH" \
  TICKET=CTL-9999 \
  CATALYST_ORCHESTRATOR_DIR="$ORCH_DIR3" \
  CATALYST_ORCHESTRATOR_ID="orch-test-3" \
  CATALYST_DIR="$FAKE_HOME3/catalyst" \
  ORCH_DIR="$ORCH_DIR3" \
  ORCH_ID="orch-test-3" \
  PLUGIN_ROOT="$PLUGIN_ROOT3" \
  PHASE_AGENT_REPO_ROOT="$REPO_ROOT" \
  PHASE_EMIT_HELPER="$EMIT_HELPER" \
  PHASE_EMIT_WRAPPER="$EMIT_WRAPPER" \
  CATALYST_COMMENT_POST_HELPER="$STUB_BIN3/linear-comment-post.sh" \
    bash "$SKILL_BODY_FILE" >"$C3/stdout.log" 2>"$C3/stderr.log"
  echo $? > "$C3/exit-code"
)

C3_EXIT="$(cat "$C3/exit-code" 2>/dev/null || echo 99)"
assert_eq "case3: exit code 0 on idempotent re-run" "0" "$C3_EXIT"

# No second comment posted — linearis discuss should NOT appear in the log
if [ ! -f "$C3/linear-comment-calls.log" ] || ! grep -q 'CTL-9999' "$C3/linear-comment-calls.log" 2>/dev/null; then
  # Also check linearis log
  if ! grep -q 'discuss' "$C3/linearis-calls.log" 2>/dev/null; then
    ok "case3: no second comment posted (idempotent)"
  else
    fail "case3: no second comment posted (idempotent)" \
      "linearis discuss called again: $(cat "$C3/linearis-calls.log" 2>/dev/null)"
  fi
else
  fail "case3: no second comment posted (idempotent)" \
    "linear-comment-post called again: $(cat "$C3/linear-comment-calls.log" 2>/dev/null)"
fi

# Signal still ends with status:"done"
SIG3="$WORKER3/phase-teardown.json"
if [ -f "$SIG3" ]; then
  SIG3_STATUS="$(jq -r '.status // empty' "$SIG3" 2>/dev/null)"
  assert_eq "case3: signal status==done on idempotent re-run" "done" "$SIG3_STATUS"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Summary

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
