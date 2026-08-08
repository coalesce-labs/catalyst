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
# The phase-teardown-failure-template fence is excluded: it is an ad-hoc
# template the agent runs on fatal errors, not sequential body — concatenated
# after the emit block's `exit 0` it would be unreachable dead code.
awk '
  /^```bash phase-teardown-failure-template/ { next }
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

# CTL-1417: hermeticity floor (belt outside the per-case HOME="$FAKE_HOME"
# subshells below). Isolate HOME and neuter global/system git config so no code
# path outside those subshells can resolve a production $HOME/catalyst/wt/...
# target to the operator's real worktree — the worktree self-deletion vector.
export HOME="${TMPROOT}/home"
mkdir -p "$HOME"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
# Red canary: fail loudly if the isolation is ever not in effect.
[[ "$HOME" == "$TMPROOT"/* ]] || {
	echo "FAIL: HOME not isolated to scratch"
	exit 1
}

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
  # "earlier" not "then" — `then` as a variable name is fragile (shellcheck SC1010)
  local earlier; earlier="$(date -u -v-120S +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '120 seconds ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "${now}")"

  # phase-triage.json
  jq -nc --arg s "$earlier" --arg c "$now" '{status:"done",startedAt:$s,completedAt:$c}' \
    > "$worker/phase-triage.json"

  # phase-research.json
  jq -nc --arg s "$earlier" --arg c "$now" '{status:"done",startedAt:$s,completedAt:$c}' \
    > "$worker/phase-research.json"

  # phase-pr.json — current run's PR opener (CTL-1667 gate uses this)
  jq -nc '{status:"done",pr:{number:9999}}' > "$worker/phase-pr.json"

  # phase-monitor-merge.json — merged or not merged
  if [[ "$merged" == "true" ]]; then
    jq -nc --arg now "$now" '{pr:{number:9999,mergedAt:$now,ciStatus:"merged",mergeCommitSha:"deadbeef"}}' \
      > "$worker/phase-monitor-merge.json"
  else
    jq -nc '{pr:{number:9999,mergedAt:"",ciStatus:"open",mergeCommitSha:""}}' \
      > "$worker/phase-monitor-merge.json"
  fi

  # phase-monitor-deploy.json
  jq -nc --arg s "$earlier" --arg c "$now" \
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
ORCH_DIR1="$C1/orch"
WORKER="$ORCH_DIR1/workers/CTL-9999"
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

# CTL-1667: install a gh stub that reports PR#9999 as MERGED (the happy-path gate)
cat > "$STUB_BIN/gh" <<'GH1'
#!/usr/bin/env bash
printf '{"state":"MERGED","mergedAt":"2026-01-01T00:00:00Z","number":9999}\n'
GH1
chmod +x "$STUB_BIN/gh"

MONTH=$(date -u +%Y-%m)
mkdir -p "$FAKE_HOME/catalyst/events"
: > "$FAKE_HOME/catalyst/events/${MONTH}.jsonl"

(
  cd "$WT_PATH" || exit 1
  HOME="$FAKE_HOME" \
  PATH="$STUB_BIN:$PATH" \
  TICKET=CTL-9999 \
  CATALYST_ORCHESTRATOR_DIR="$ORCH_DIR1" \
  CATALYST_ORCHESTRATOR_ID="orch-test-1" \
  CATALYST_DIR="$FAKE_HOME/catalyst" \
  ORCH_DIR="$ORCH_DIR1" \
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
  cd "$WT_PATH2" || exit 1
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

# CTL-1667: install a gh stub for Case 3 (idempotent re-run; mirror already posted)
cat > "$STUB_BIN3/gh" <<'GH3'
#!/usr/bin/env bash
printf '{"state":"MERGED","mergedAt":"2026-01-01T00:00:00Z","number":9999}\n'
GH3
chmod +x "$STUB_BIN3/gh"

# Pre-write the idempotency marker + reset signal to running
: > "$WORKER3/.linear-mirror-teardown"
jq -nc --arg s "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{status:"running",startedAt:$s}' \
  > "$WORKER3/phase-teardown.json"

MONTH3=$(date -u +%Y-%m)
mkdir -p "$FAKE_HOME3/catalyst/events"
: > "$FAKE_HOME3/catalyst/events/${MONTH3}.jsonl"

(
  cd "$WT_PATH3" || exit 1
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

# keepWorktreeAfterMerge=true → the worktree AND its branch must survive the run.
# Pairs with Case 1's keep=false→removed arm so a regression flipping/dropping
# the KEEP_WT guard fails the suite instead of passing undetected.
assert_dir_exists "case3: worktree kept (keepWorktreeAfterMerge=true)" "$WT_PATH3"
if git -C "$PRIMARY_GIT3" rev-parse --verify --quiet ctl-9999-branch >/dev/null 2>&1; then
  ok "case3: branch kept (keepWorktreeAfterMerge=true)"
else
  fail "case3: branch kept (keepWorktreeAfterMerge=true)" "branch ctl-9999-branch was deleted"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Cases 4 + 5: prior-artifact guards in the skill body itself.
# (Test 60 in the dispatch suite covers the DISPATCHER gate; these cover the
# skill body's own guards.) Each omits one required artifact and asserts the
# failed event, the specific failureReason, and that the worktree is NOT removed.

run_prior_artifact_case() {
  # $1 = case label, $2 = artifact file to delete, $3 = expected failureReason
  local label="$1" omit_file="$2" want_reason="$3"
  local CDIR="$TMPROOT/$label"
  local PRIMARY_GITX="$CDIR/primary-repo" WT_PATHX="$CDIR/ticket-wt"
  local ORCH_DIRX="$CDIR/orch" FAKE_HOMEX="$CDIR/home"
  local WORKERX="$ORCH_DIRX/workers/CTL-9999"
  mkdir -p "$WORKERX" "$FAKE_HOMEX/catalyst/archives"

  write_fixture_signals "$WORKERX" "true"
  rm -f "$WORKERX/$omit_file"
  make_git_pair "$PRIMARY_GITX" "$WT_PATHX" "ctl-9999-branch"

  mkdir -p "$WT_PATHX/.catalyst"
  echo '{"catalyst":{"projectKey":"CTL","orchestration":{"keepWorktreeAfterMerge":false}}}' \
    > "$WT_PATHX/.catalyst/config.json"

  local STUB_BINX="$CDIR/bin" PLUGIN_ROOTX="$CDIR/plugin-root"
  mkdir -p "$STUB_BINX" "$PLUGIN_ROOTX/scripts/lib"
  linearis_stub_install "$STUB_BINX" "$CDIR/linearis-calls.log"
  linear_comment_post_stub_install "$STUB_BINX" "$CDIR/linear-comment-calls.log"
  install_linear_transition_stub "$PLUGIN_ROOTX" "$CDIR/linear-transition-calls.log"
  install_presweep_stub "$PLUGIN_ROOTX"

  local MONTHX; MONTHX=$(date -u +%Y-%m)
  mkdir -p "$FAKE_HOMEX/catalyst/events"
  : > "$FAKE_HOMEX/catalyst/events/${MONTHX}.jsonl"

  (
    cd "$WT_PATHX" || exit 1
    HOME="$FAKE_HOMEX" \
    PATH="$STUB_BINX:$PATH" \
    TICKET=CTL-9999 \
    CATALYST_ORCHESTRATOR_DIR="$ORCH_DIRX" \
    CATALYST_ORCHESTRATOR_ID="orch-test-$label" \
    CATALYST_DIR="$FAKE_HOMEX/catalyst" \
    ORCH_DIR="$ORCH_DIRX" \
    ORCH_ID="orch-test-$label" \
    PLUGIN_ROOT="$PLUGIN_ROOTX" \
    PHASE_AGENT_REPO_ROOT="$REPO_ROOT" \
    PHASE_EMIT_HELPER="$EMIT_HELPER" \
    PHASE_EMIT_WRAPPER="$EMIT_WRAPPER" \
    CATALYST_COMMENT_POST_HELPER="$STUB_BINX/linear-comment-post.sh" \
      bash "$SKILL_BODY_FILE" >"$CDIR/stdout.log" 2>"$CDIR/stderr.log"
    echo $? > "$CDIR/exit-code"
  )

  local EXITX; EXITX="$(cat "$CDIR/exit-code" 2>/dev/null || echo 0)"
  if [ "$EXITX" -ne 0 ]; then
    ok "$label: exits non-zero when $omit_file absent"
  else
    fail "$label: exits non-zero when $omit_file absent" "expected non-zero exit, got $EXITX"
  fi

  local EVX
  EVX="$(jq -r '.attributes."event.name" // empty' \
    "$FAKE_HOMEX/catalyst/events/${MONTHX}.jsonl" 2>/dev/null | grep '^phase\.teardown\.' | tail -1)"
  assert_eq "$label: emits phase.teardown.failed event" \
    "phase.teardown.failed.CTL-9999" "$EVX"

  local REASONX
  REASONX="$(jq -r '.failureReason // empty' "$WORKERX/phase-teardown.json" 2>/dev/null)"
  assert_eq "$label: signal failureReason==$want_reason" "$want_reason" "$REASONX"

  if [ -d "$WT_PATHX" ]; then
    ok "$label: worktree NOT removed (prior-artifact guard)"
  else
    fail "$label: worktree NOT removed (prior-artifact guard)" "worktree was incorrectly deleted: $WT_PATHX"
  fi
}

echo ""
echo "Case 4: prior-artifact guard (phase-monitor-deploy.json absent)"
run_prior_artifact_case "case4" "phase-monitor-deploy.json" "prior_artifact_missing:monitor_deploy"

echo ""
echo "Case 5: prior-artifact guard (phase-monitor-merge.json absent)"
run_prior_artifact_case "case5" "phase-monitor-merge.json" "prior_artifact_missing:monitor_merge"

# ─────────────────────────────────────────────────────────────────────────────
# Cases B1–B4 (CTL-1667): current-PR-merged gate in the safety gate.
#
# The new gate requires:
#   - phase-monitor-merge.json .pr.number == phase-pr.json .pr.number  (identity)
#   - AND gh pr view <N> reports MERGED  (live truth, injectable via CATALYST_TEARDOWN_GH_BIN)
#
# Approach: injectable `gh` stub (CATALYST_TEARDOWN_GH_BIN) so no real `gh` needed.

# Helper: write a per-case gh stub that reads from a fixture file.
# The fixture file must contain a JSON object with at least {state, mergedAt}.
install_gh_stub() {
  local bin_dir="$1" fixture="$2"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/gh-stub" <<GHSTUB
#!/usr/bin/env bash
# Stub: gh pr view <N> --json state,mergedAt
cat "${fixture}"
GHSTUB
  chmod +x "$bin_dir/gh-stub"
}

# Helper: build a shared teardown fixture (git pair + stubs) for CTL-1667 cases.
# Sets CDIR, WORKERB, WT_PATHB, ORCH_DIRB, FAKE_HOMEB, STUB_BINB, PLUGIN_ROOTB.
setup_b_case() {
  local label="$1"
  CDIR="$TMPROOT/$label"
  local PRIMARY_GITB="$CDIR/primary-repo"
  WT_PATHB="$CDIR/ticket-wt"
  ORCH_DIRB="$CDIR/orch"
  FAKE_HOMEB="$CDIR/home"
  WORKERB="$ORCH_DIRB/workers/CTL-9999"
  mkdir -p "$WORKERB" "$FAKE_HOMEB/catalyst/archives"
  make_git_pair "$PRIMARY_GITB" "$WT_PATHB" "ctl-9999-branch"
  mkdir -p "$WT_PATHB/.catalyst"
  echo '{"catalyst":{"projectKey":"CTL","orchestration":{"keepWorktreeAfterMerge":false}}}' \
    > "$WT_PATHB/.catalyst/config.json"
  STUB_BINB="$CDIR/bin"
  PLUGIN_ROOTB="$CDIR/plugin-root"
  mkdir -p "$STUB_BINB" "$PLUGIN_ROOTB/scripts/lib"
  linearis_stub_install "$STUB_BINB" "$CDIR/linearis-calls.log"
  linear_comment_post_stub_install "$STUB_BINB" "$CDIR/linear-comment-calls.log"
  install_linear_transition_stub "$PLUGIN_ROOTB" "$CDIR/linear-transition-calls.log"
  install_presweep_stub "$PLUGIN_ROOTB"
  local MONTHB; MONTHB=$(date -u +%Y-%m)
  mkdir -p "$FAKE_HOMEB/catalyst/events"
  : > "$FAKE_HOMEB/catalyst/events/${MONTHB}.jsonl"
}

run_b_case() {
  local label="$1"
  (
    cd "$WT_PATHB" || exit 1
    HOME="$FAKE_HOMEB" \
    PATH="$STUB_BINB:$PATH" \
    TICKET=CTL-9999 \
    CATALYST_ORCHESTRATOR_DIR="$ORCH_DIRB" \
    CATALYST_ORCHESTRATOR_ID="orch-test-$label" \
    CATALYST_DIR="$FAKE_HOMEB/catalyst" \
    ORCH_DIR="$ORCH_DIRB" \
    ORCH_ID="orch-test-$label" \
    PLUGIN_ROOT="$PLUGIN_ROOTB" \
    PHASE_AGENT_REPO_ROOT="$REPO_ROOT" \
    PHASE_EMIT_HELPER="$EMIT_HELPER" \
    PHASE_EMIT_WRAPPER="$EMIT_WRAPPER" \
    CATALYST_COMMENT_POST_HELPER="$STUB_BINB/linear-comment-post.sh" \
    CATALYST_TEARDOWN_GH_BIN="$STUB_BINB/gh-stub" \
      bash "$SKILL_BODY_FILE" >"$CDIR/stdout.log" 2>"$CDIR/stderr.log"
    echo $? > "$CDIR/exit-code"
  )
}

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case B1 (CTL-1667): current PR (200) MERGED, numbers match → gate PASSES"
setup_b_case "caseb1"
# phase-pr.json — current run's PR
jq -n '{status:"done",pr:{number:200}}' > "$WORKERB/phase-pr.json"
# phase-monitor-merge.json — same PR, mergedAt present
NOW_B1="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -nc --arg t "$NOW_B1" '{pr:{number:200,mergedAt:$t,ciStatus:"merged"}}' \
  > "$WORKERB/phase-monitor-merge.json"
# phase-monitor-deploy.json
jq -nc --arg t "$NOW_B1" '{status:"done",deploy_state:"success",startedAt:$t,completedAt:$t}' \
  > "$WORKERB/phase-monitor-deploy.json"
# phase-teardown.json (running)
jq -nc --arg t "$NOW_B1" '{status:"running",startedAt:$t}' > "$WORKERB/phase-teardown.json"
# gh stub: MERGED
GH_FIX_B1="$TMPROOT/caseb1-gh-fixture.json"
jq -n --arg t "$NOW_B1" '{state:"MERGED",mergedAt:$t,number:200}' > "$GH_FIX_B1"
install_gh_stub "$STUB_BINB" "$GH_FIX_B1"
run_b_case "caseb1"
B1_EXIT="$(cat "$CDIR/exit-code" 2>/dev/null || echo 99)"
assert_eq "case B1: exit code 0 (gate passes for merged current PR)" "0" "$B1_EXIT"
B1_EMITTED="$(jq -r '.attributes."event.name" // empty' \
  "$FAKE_HOMEB/catalyst/events/$(date -u +%Y-%m).jsonl" 2>/dev/null | grep '^phase\.teardown\.' | tail -1)"
assert_eq "case B1: emits teardown.complete" "phase.teardown.complete.CTL-9999" "$B1_EMITTED"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case B2 (CTL-1667): STALE merge signal (PR#100 merged) but current PR#200 is OPEN → FAILS"
setup_b_case "caseb2"
NOW_B2="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -n '{status:"done",pr:{number:200}}' > "$WORKERB/phase-pr.json"
# Old run's phase-monitor-merge signal (PR#100 was merged)
jq -nc --arg t "$NOW_B2" '{pr:{number:100,mergedAt:$t,ciStatus:"merged"}}' \
  > "$WORKERB/phase-monitor-merge.json"
jq -nc --arg t "$NOW_B2" '{status:"done",deploy_state:"success",startedAt:$t,completedAt:$t}' \
  > "$WORKERB/phase-monitor-deploy.json"
jq -nc --arg t "$NOW_B2" '{status:"running",startedAt:$t}' > "$WORKERB/phase-teardown.json"
# gh stub: current PR#200 is OPEN
GH_FIX_B2="$TMPROOT/caseb2-gh-fixture.json"
jq -n '{state:"OPEN",mergedAt:null,number:200}' > "$GH_FIX_B2"
install_gh_stub "$STUB_BINB" "$GH_FIX_B2"
run_b_case "caseb2"
B2_EXIT="$(cat "$CDIR/exit-code" 2>/dev/null || echo 0)"
if [ "$B2_EXIT" -ne 0 ]; then
  ok "case B2: exits non-zero (stale merge signal / current PR open)"
else
  fail "case B2: exits non-zero (stale merge signal / current PR open)" "got exit 0"
fi
if [ -d "$WT_PATHB" ]; then
  ok "case B2: worktree NOT removed"
else
  fail "case B2: worktree NOT removed" "worktree was deleted"
fi
B2_EMITTED="$(jq -r '.attributes."event.name" // empty' \
  "$FAKE_HOMEB/catalyst/events/$(date -u +%Y-%m).jsonl" 2>/dev/null | grep '^phase\.teardown\.' | tail -1)"
assert_eq "case B2: emits teardown.failed" "phase.teardown.failed.CTL-9999" "$B2_EMITTED"
B2_TRANS=0
[ -f "$CDIR/linear-transition-calls.log" ] && \
  B2_TRANS="$(wc -l < "$CDIR/linear-transition-calls.log" 2>/dev/null | tr -d ' ' || echo 0)"
assert_eq "case B2: linear-transition NOT called" "0" "$B2_TRANS"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case B3 (CTL-1667): PR numbers match (200) but GitHub says OPEN → FAILS"
setup_b_case "caseb3"
NOW_B3="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -n '{status:"done",pr:{number:200}}' > "$WORKERB/phase-pr.json"
# monitor-merge signals PR#200 as merged (disk says so) — but live GitHub disagrees
jq -nc --arg t "$NOW_B3" '{pr:{number:200,mergedAt:$t,ciStatus:"merged"}}' \
  > "$WORKERB/phase-monitor-merge.json"
jq -nc --arg t "$NOW_B3" '{status:"done",deploy_state:"success",startedAt:$t,completedAt:$t}' \
  > "$WORKERB/phase-monitor-deploy.json"
jq -nc --arg t "$NOW_B3" '{status:"running",startedAt:$t}' > "$WORKERB/phase-teardown.json"
GH_FIX_B3="$TMPROOT/caseb3-gh-fixture.json"
jq -n '{state:"OPEN",mergedAt:null,number:200}' > "$GH_FIX_B3"
install_gh_stub "$STUB_BINB" "$GH_FIX_B3"
run_b_case "caseb3"
B3_EXIT="$(cat "$CDIR/exit-code" 2>/dev/null || echo 0)"
if [ "$B3_EXIT" -ne 0 ]; then
  ok "case B3: exits non-zero (gh says OPEN despite disk saying merged)"
else
  fail "case B3: exits non-zero (gh says OPEN despite disk saying merged)" "got exit 0"
fi
B3_EMITTED="$(jq -r '.attributes."event.name" // empty' \
  "$FAKE_HOMEB/catalyst/events/$(date -u +%Y-%m).jsonl" 2>/dev/null | grep '^phase\.teardown\.' | tail -1)"
assert_eq "case B3: emits teardown.failed" "phase.teardown.failed.CTL-9999" "$B3_EMITTED"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case B4 (CTL-1667): gh errors (non-zero exit) → FAIL-CLOSED pr_not_merged"
setup_b_case "caseb4"
NOW_B4="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -n '{status:"done",pr:{number:200}}' > "$WORKERB/phase-pr.json"
jq -nc --arg t "$NOW_B4" '{pr:{number:200,mergedAt:$t,ciStatus:"merged"}}' \
  > "$WORKERB/phase-monitor-merge.json"
jq -nc --arg t "$NOW_B4" '{status:"done",deploy_state:"success",startedAt:$t,completedAt:$t}' \
  > "$WORKERB/phase-monitor-deploy.json"
jq -nc --arg t "$NOW_B4" '{status:"running",startedAt:$t}' > "$WORKERB/phase-teardown.json"
# gh stub: exits non-zero (simulates failure)
mkdir -p "$STUB_BINB"
cat > "$STUB_BINB/gh-stub" <<'GHFAIL'
#!/usr/bin/env bash
echo "gh: error: could not reach GitHub" >&2
exit 1
GHFAIL
chmod +x "$STUB_BINB/gh-stub"
run_b_case "caseb4"
B4_EXIT="$(cat "$CDIR/exit-code" 2>/dev/null || echo 0)"
if [ "$B4_EXIT" -ne 0 ]; then
  ok "case B4: exits non-zero (gh failure → fail-closed)"
else
  fail "case B4: exits non-zero (gh failure → fail-closed)" "got exit 0 — should fail-closed"
fi
B4_EMITTED="$(jq -r '.attributes."event.name" // empty' \
  "$FAKE_HOMEB/catalyst/events/$(date -u +%Y-%m).jsonl" 2>/dev/null | grep '^phase\.teardown\.' | tail -1)"
assert_eq "case B4: emits teardown.failed on gh error" "phase.teardown.failed.CTL-9999" "$B4_EMITTED"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case B5 (CTL-1667 review fix, round 3): EMPTY/malformed merge PR number → FAILS (fail-closed identity)"
setup_b_case "caseb5"
NOW_B5="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -n '{status:"done",pr:{number:200}}' > "$WORKERB/phase-pr.json"
# Legacy/malformed monitor-merge signal: file exists (passes the prior-artifact
# guard) but carries no .pr.number at all.
jq -nc --arg t "$NOW_B5" '{mergedAt:$t,ciStatus:"merged"}' \
  > "$WORKERB/phase-monitor-merge.json"
jq -nc --arg t "$NOW_B5" '{status:"done",deploy_state:"success",startedAt:$t,completedAt:$t}' \
  > "$WORKERB/phase-monitor-deploy.json"
jq -nc --arg t "$NOW_B5" '{status:"running",startedAt:$t}' > "$WORKERB/phase-teardown.json"
# gh stub: current PR#200 IS merged — the empty merge artifact is the ONLY
# thing that should block this from passing.
GH_FIX_B5="$TMPROOT/caseb5-gh-fixture.json"
jq -n --arg t "$NOW_B5" '{state:"MERGED",mergedAt:$t,number:200}' > "$GH_FIX_B5"
install_gh_stub "$STUB_BINB" "$GH_FIX_B5"
run_b_case "caseb5"
B5_EXIT="$(cat "$CDIR/exit-code" 2>/dev/null || echo 0)"
if [ "$B5_EXIT" -ne 0 ]; then
  ok "case B5: exits non-zero (empty merge-signal PR number → fail-closed)"
else
  fail "case B5: exits non-zero (empty merge-signal PR number → fail-closed)" "got exit 0"
fi
if [ -d "$WT_PATHB" ]; then
  ok "case B5: worktree NOT removed"
else
  fail "case B5: worktree NOT removed" "worktree was deleted"
fi
B5_EMITTED="$(jq -r '.attributes."event.name" // empty' \
  "$FAKE_HOMEB/catalyst/events/$(date -u +%Y-%m).jsonl" 2>/dev/null | grep '^phase\.teardown\.' | tail -1)"
assert_eq "case B5: emits teardown.failed" "phase.teardown.failed.CTL-9999" "$B5_EMITTED"
B5_TRANS=0
[ -f "$CDIR/linear-transition-calls.log" ] && \
  B5_TRANS="$(wc -l < "$CDIR/linear-transition-calls.log" 2>/dev/null | tr -d ' ' || echo 0)"
assert_eq "case B5: linear-transition NOT called" "0" "$B5_TRANS"

# ─────────────────────────────────────────────────────────────────────────────
# Summary

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
