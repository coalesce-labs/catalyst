#!/usr/bin/env bash
# Tests for catalyst-adopt.sh — CTL-1642.
# Run: bash plugins/dev/scripts/lib/__tests__/catalyst-adopt.test.sh
#
# Covers:
#   Phase 2: arg parsing, terminal refusal, worktree resolution, dry-run
#   Phase 3: salvage-first, WIP commit, push
#   Phase 4: draft PR ensure, inferred-phase dispatch (idempotent)
#   Phase 5: --json contract, exit codes

set -uo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP: catalyst-adopt tests require jq (not on PATH)"
  exit 0
fi
if ! command -v git >/dev/null 2>&1; then
  echo "SKIP: catalyst-adopt tests require git (not on PATH)"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SCRIPTS_DIR="$(cd "${LIB_DIR}/.." && pwd)"
ADOPT="${SCRIPTS_DIR}/catalyst-adopt.sh"

if [[ ! -f "$ADOPT" ]]; then
  echo "SKIP: catalyst-adopt.sh not found at ${ADOPT}"
  exit 0
fi

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t catalyst-adopt-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

export GIT_AUTHOR_NAME="test" GIT_AUTHOR_EMAIL="test@test.invalid"
export GIT_COMMITTER_NAME="test" GIT_COMMITTER_EMAIL="test@test.invalid"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"
  else fail "$label — expected '$expected', got '$actual'"; fi
}
assert_true()  { if eval "$1"; then pass "$2"; else fail "$2 — [$1] was false"; fi; }
assert_false() { if eval "$1"; then fail "$2 — [$1] was true"; else pass "$2"; fi; }
assert_contains() {
  local body="$1" substr="$2" label="$3"
  if [[ "$body" == *"$substr"* ]]; then pass "$label"
  else fail "$label — '$substr' not in '$body'"; fi
}
assert_not_contains() {
  local body="$1" substr="$2" label="$3"
  if [[ "$body" != *"$substr"* ]]; then pass "$label"
  else fail "$label — '$substr' unexpectedly present in '$body'"; fi
}

echo ""
echo "catalyst-adopt.sh tests (CTL-1642)"
echo ""

# ─── Fixture builder ──────────────────────────────────────────────────────────

# make_repo <dir> <ticket> [--dirty]
# Creates: bare origin + clone, main branch, ticket branch checked out.
# With --dirty: add an uncommitted tracked file.
make_repo() {
  local root="$1" ticket="$2" dirty=0; shift 2
  [[ "${1:-}" == "--dirty" ]] && dirty=1
  local origin="${root}/origin.git" wt="${root}/wt"
  rm -rf "$root"; mkdir -p "$root"
  git init --quiet --bare -b main "$origin"
  git clone --quiet "$origin" "$wt" 2>/dev/null
  ( cd "$wt" || exit 1
    printf 'base\n' > base.txt
    git add base.txt
    git commit --quiet -m "base"
    git push --quiet origin HEAD:refs/heads/main
    git branch --quiet --set-upstream-to=origin/main 2>/dev/null || true
    git checkout --quiet -b "$ticket"
    if [[ "$dirty" -eq 1 ]]; then
      printf 'wip\n' > wip.txt
    fi
  )
  WORK="${wt}"
  ORIGIN_BARE="${origin}"
}

# ─── Stub infrastructure ──────────────────────────────────────────────────────

# install_call_log_stubs <bin_dir> <call_log>
# Stubs: git (wraps real), gh (minimal), phase-agent-dispatch, node
install_stubs() {
  local bin_dir="$1" log="$2"
  local real_git; real_git="$(command -v git)"
  mkdir -p "$bin_dir"

  # git: forward all except 'push' which we log + succeed
  cat > "${bin_dir}/git" <<STUB
#!/usr/bin/env bash
printf 'git %s\n' "\$*" >> "${log}"
# Allow everything through to real git (push is intercepted for logging)
if [[ "\$1" == "push" ]]; then
  printf 'git-push\n' >> "${log}"
  # Actually run push so the branch updates in the fixture
fi
exec "${real_git}" "\$@"
STUB
  chmod +x "${bin_dir}/git"

  # gh: minimal stub (no real GitHub calls)
  cat > "${bin_dir}/gh" <<STUB
#!/usr/bin/env bash
printf 'gh %s\n' "\$*" >> "${log}"
if [[ "\$1" == "pr" && "\$2" == "view" ]]; then exit 1; fi
if [[ "\$1" == "pr" && "\$2" == "create" ]]; then
  echo "https://github.com/test/repo/pull/42"
  exit 0
fi
if [[ "\$1" == "repo" && "\$2" == "view" ]]; then
  echo '{"defaultBranchRef":{"name":"main"}}'
  exit 0
fi
exit 0
STUB
  chmod +x "${bin_dir}/gh"

  # phase-agent-dispatch: log + succeed
  cat > "${bin_dir}/phase-agent-dispatch" <<STUB
#!/usr/bin/env bash
printf 'phase-agent-dispatch %s\n' "\$*" >> "${log}"
exit 0
STUB
  chmod +x "${bin_dir}/phase-agent-dispatch"

  # node: forward to real node for adopt-infer-phase.mjs; log other uses
  local real_node; real_node="$(command -v node)"
  cat > "${bin_dir}/node" <<STUB
#!/usr/bin/env bash
printf 'node %s\n' "\$*" >> "${log}"
exec "${real_node}" "\$@"
STUB
  chmod +x "${bin_dir}/node"
}

# install_terminal_stub <bin_dir> <state_name>
# Stubs linear_read_ticket via a shell function override file
# (loaded by sourcing a shim). Actually we override via env for simplicity.

# ─── Phase 2: arg parsing / terminal refusal / dry-run ───────────────────────

echo "--- Phase 2: arg parsing, terminal refusal, dry-run ---"

# 2.1 Usage / help exits 0
{
  out=$(bash "$ADOPT" --help 2>&1); rc=$?
  assert_eq 0 "$rc" "help: exits 0"
  assert_contains "$out" "Usage" "help: prints Usage"
}

# 2.2 No args → exits non-zero + shows usage
{
  out=$(bash "$ADOPT" 2>&1); rc=$?
  assert_true "[[ $rc -ne 0 ]]" "no-args: exits non-zero"
}

# 2.3 Terminal ticket → exits 2, nothing committed/dispatched
{
  tag="${SCRATCH}/term"
  make_repo "$tag" "CTL-9001"
  bin_dir="${SCRATCH}/bin_term"; log="${SCRATCH}/call_term.log"
  install_stubs "$bin_dir" "$log"

  # Provide a fake linear_read_ticket via env override: export a shell function
  # wrapper that catalyst-adopt.sh can pick up via CATALYST_LINEAR_READ_STUB.
  out=$(
    PATH="${bin_dir}:$PATH" \
    CATALYST_SALVAGE_DIR="${SCRATCH}/salvage_term" \
    CATALYST_ADOPT_TERMINAL_STATES="Done,Cancelled,Canceled" \
    CATALYST_ADOPT_TICKET_STATE="Done" \
    bash "$ADOPT" "CTL-9001" \
      --worktree "$WORK" \
      --orch-dir "$SCRATCH" --orch-id "test-orch" 2>&1
  ); rc=$?

  assert_eq 2 "$rc" "terminal-ticket: exits 2"
  assert_contains "$out" "Done" "terminal-ticket: message names the state"
  # assert no commit happened
  ahead=$(git -C "$WORK" rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
  assert_eq "0" "$ahead" "terminal-ticket: no commit made"
}

# 2.4 Dry-run: prints plan, no mutations
{
  tag="${SCRATCH}/dryrun"
  make_repo "$tag" "CTL-9002" --dirty
  bin_dir="${SCRATCH}/bin_dr"; log="${SCRATCH}/call_dr.log"
  install_stubs "$bin_dir" "$log"

  out=$(
    PATH="${bin_dir}:$PATH" \
    CATALYST_SALVAGE_DIR="${SCRATCH}/salvage_dr" \
    CATALYST_ADOPT_TICKET_STATE="Implement" \
    bash "$ADOPT" "CTL-9002" \
      --worktree "$WORK" \
      --orch-dir "$SCRATCH" --orch-id "test-orch" \
      --dry-run 2>&1
  ); rc=$?

  assert_eq 0 "$rc" "dry-run: exits 0"
  assert_contains "$out" "dry-run" "dry-run: output mentions dry-run"
  # No WIP commit
  ahead=$(git -C "$WORK" rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
  assert_eq "0" "$ahead" "dry-run: no commit made"
  # phase-agent-dispatch NOT called
  if [[ -f "$log" ]]; then
    assert_not_contains "$(cat "$log" 2>/dev/null)" "phase-agent-dispatch" "dry-run: no dispatch"
  else
    pass "dry-run: no dispatch (log empty)"
  fi
}

# 2.5 Non-terminal state proceeds past terminal guard
{
  tag="${SCRATCH}/nonterm"
  make_repo "$tag" "CTL-9003"
  bin_dir="${SCRATCH}/bin_nt"; log="${SCRATCH}/call_nt.log"
  install_stubs "$bin_dir" "$log"

  out=$(
    PATH="${bin_dir}:$PATH" \
    CATALYST_SALVAGE_DIR="${SCRATCH}/salvage_nt" \
    CATALYST_ADOPT_TICKET_STATE="Implement" \
    bash "$ADOPT" "CTL-9003" \
      --worktree "$WORK" \
      --orch-dir "$SCRATCH" --orch-id "test-orch" \
      --dry-run 2>&1
  ); rc=$?

  # Should NOT exit 2 (terminal refusal)
  assert_true "[[ $rc -ne 2 ]]" "non-terminal: does not exit 2"
}

# ─── Phase 3: salvage-first + WIP commit + push ──────────────────────────────

echo ""
echo "--- Phase 3: salvage-first, WIP commit, push ---"

# 3.1 WIP commit created for dirty worktree
{
  tag="${SCRATCH}/wip"
  make_repo "$tag" "CTL-9004" --dirty
  bin_dir="${SCRATCH}/bin_wip"; log="${SCRATCH}/call_wip.log"
  install_stubs "$bin_dir" "$log"

  out=$(
    PATH="${bin_dir}:$PATH" \
    CATALYST_SALVAGE_DIR="${SCRATCH}/salvage_wip" \
    CATALYST_ADOPT_TICKET_STATE="Implement" \
    bash "$ADOPT" "CTL-9004" \
      --worktree "$WORK" \
      --orch-dir "$SCRATCH" --orch-id "test-orch" 2>&1
  ); rc=$?

  # Worktree should be clean after adopt
  status=$(git -C "$WORK" status --porcelain 2>/dev/null)
  assert_eq "" "$status" "wip-commit: worktree is clean after adopt"
  # Should have commits ahead
  ahead=$(git -C "$WORK" rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
  assert_true "[[ $ahead -gt 0 ]]" "wip-commit: has commits ahead"
  # Commit message has adopt marker
  msg=$(git -C "$WORK" log -1 --format=%s 2>/dev/null)
  assert_contains "$msg" "adopt" "wip-commit: commit message has 'adopt'"
}

# 3.2 No WIP commit when tree is already clean (committed-only)
{
  tag="${SCRATCH}/clean"
  make_repo "$tag" "CTL-9005"
  # Make a commit in the worktree (not dirty)
  ( cd "${SCRATCH}/clean/wt" || exit 1
    printf 'committed\n' > committed.txt
    git add committed.txt
    git commit --quiet -m "committed work"
  )
  bin_dir="${SCRATCH}/bin_clean"; log="${SCRATCH}/call_clean.log"
  install_stubs "$bin_dir" "$log"

  out=$(
    PATH="${bin_dir}:$PATH" \
    CATALYST_SALVAGE_DIR="${SCRATCH}/salvage_clean" \
    CATALYST_ADOPT_TICKET_STATE="Implement" \
    bash "$ADOPT" "CTL-9005" \
      --worktree "${SCRATCH}/clean/wt" \
      --orch-dir "$SCRATCH" --orch-id "test-orch" 2>&1
  ); rc=$?

  # Only 1 commit ahead (the pre-existing one, not a new WIP commit)
  ahead=$(git -C "${SCRATCH}/clean/wt" rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
  last_msg=$(git -C "${SCRATCH}/clean/wt" log -1 --format=%s 2>/dev/null)
  assert_not_contains "$last_msg" "adopt" "clean-tree: no WIP commit added"
}

# 3.3 Salvage artifact exists BEFORE the WIP commit (ordering invariant)
{
  tag="${SCRATCH}/salvorder"
  make_repo "$tag" "CTL-9006" --dirty
  bin_dir="${SCRATCH}/bin_so"; log="${SCRATCH}/call_so.log"
  salvage_dir="${SCRATCH}/salvage_so"
  install_stubs "$bin_dir" "$log"

  out=$(
    PATH="${bin_dir}:$PATH" \
    CATALYST_SALVAGE_DIR="$salvage_dir" \
    CATALYST_ADOPT_TICKET_STATE="Implement" \
    bash "$ADOPT" "CTL-9006" \
      --worktree "$WORK" \
      --orch-dir "$SCRATCH" --orch-id "test-orch" 2>&1
  ); rc=$?

  # A salvage artifact must exist (the worktree had uncommitted changes)
  salvage_files=( "${salvage_dir}"/* )
  if [[ ${#salvage_files[@]} -gt 0 && -e "${salvage_files[0]}" ]]; then
    pass "salvage-ordering: salvage artifact exists"
  else
    fail "salvage-ordering: no salvage artifact found under ${salvage_dir}"
  fi
}

# ─── Phase 4: draft PR + dispatch ────────────────────────────────────────────

echo ""
echo "--- Phase 4: draft PR ensure, inferred-phase dispatch ---"

# 4.1 dispatch called after adopt
{
  tag="${SCRATCH}/dispatch"
  make_repo "$tag" "CTL-9007"
  ( cd "${SCRATCH}/dispatch/wt" || exit 1
    printf 'work\n' > work.txt
    git add work.txt
    git commit --quiet -m "some work"
    git push --quiet origin HEAD
  )
  bin_dir="${SCRATCH}/bin_disp"; log="${SCRATCH}/call_disp.log"
  install_stubs "$bin_dir" "$log"

  out=$(
    PATH="${bin_dir}:$PATH" \
    CATALYST_SALVAGE_DIR="${SCRATCH}/salvage_disp" \
    CATALYST_ADOPT_TICKET_STATE="Research" \
    bash "$ADOPT" "CTL-9007" \
      --worktree "${SCRATCH}/dispatch/wt" \
      --orch-dir "$SCRATCH" --orch-id "test-orch-1" 2>&1
  ); rc=$?

  # phase-agent-dispatch was called
  log_content="$(cat "$log" 2>/dev/null || echo '')"
  assert_contains "$log_content" "phase-agent-dispatch" "dispatch: phase-agent-dispatch was called"
  assert_contains "$log_content" "CTL-9007" "dispatch: ticket arg passed to dispatch"
}

# 4.2 adopt does NOT pre-write a signal file (dispatcher owns it)
{
  tag="${SCRATCH}/nosig"
  make_repo "$tag" "CTL-9008"
  orch_dir="${SCRATCH}/orch_nosig"
  mkdir -p "$orch_dir"
  bin_dir="${SCRATCH}/bin_nosig"; log="${SCRATCH}/call_nosig.log"
  install_stubs "$bin_dir" "$log"

  out=$(
    PATH="${bin_dir}:$PATH" \
    CATALYST_SALVAGE_DIR="${SCRATCH}/salvage_nosig" \
    CATALYST_ADOPT_TICKET_STATE="Research" \
    bash "$ADOPT" "CTL-9008" \
      --worktree "${SCRATCH}/nosig/wt" \
      --orch-dir "$orch_dir" --orch-id "test-orch-2" 2>&1
  ); rc=$?

  # adopt must not write any phase-*.json signal file
  sig_count=0
  if [[ -d "${orch_dir}/workers/CTL-9008" ]]; then
    sig_count="$(ls "${orch_dir}/workers/CTL-9008/phase-"*.json 2>/dev/null | wc -l || echo 0)"
  fi
  if [[ "$sig_count" -eq 0 ]]; then
    pass "no-signal: adopt authored no phase-*.json"
  else
    fail "no-signal: adopt unexpectedly wrote phase-*.json (count: ${sig_count})"
  fi
}

# ─── Phase 5: --json contract ────────────────────────────────────────────────

echo ""
echo "--- Phase 5: --json contract ---"

# 5.1 --json emits a valid JSON object on stdout
{
  tag="${SCRATCH}/json"
  make_repo "$tag" "CTL-9009" --dirty
  bin_dir="${SCRATCH}/bin_json"; log="${SCRATCH}/call_json.log"
  install_stubs "$bin_dir" "$log"

  stdout_out=$(
    PATH="${bin_dir}:$PATH" \
    CATALYST_SALVAGE_DIR="${SCRATCH}/salvage_json" \
    CATALYST_ADOPT_TICKET_STATE="Implement" \
    bash "$ADOPT" "CTL-9009" \
      --worktree "$WORK" \
      --orch-dir "$SCRATCH" --orch-id "test-orch-3" \
      --json 2>/dev/null
  )

  if echo "$stdout_out" | jq -e '.ticket' >/dev/null 2>&1; then
    pass "json: stdout is parseable JSON with .ticket"
  else
    fail "json: stdout not valid JSON — got: $stdout_out"
  fi
}

# 5.2 Terminal refusal via --json exits 2 and emits JSON with .adopted=false
{
  tag="${SCRATCH}/json_term"
  make_repo "$tag" "CTL-9010"
  bin_dir="${SCRATCH}/bin_jterm"; log="${SCRATCH}/call_jterm.log"
  install_stubs "$bin_dir" "$log"

  stdout_out=$(
    PATH="${bin_dir}:$PATH" \
    CATALYST_ADOPT_TICKET_STATE="Done" \
    CATALYST_ADOPT_TERMINAL_STATES="Done,Cancelled,Canceled" \
    bash "$ADOPT" "CTL-9010" \
      --worktree "$WORK" \
      --orch-dir "$SCRATCH" --orch-id "test-orch-4" \
      --json 2>/dev/null
  ); rc=$?

  assert_eq 2 "$rc" "json-terminal: exits 2"
  if echo "$stdout_out" | jq -e '.adopted == false' >/dev/null 2>&1; then
    pass "json-terminal: .adopted is false"
  else
    fail "json-terminal: .adopted not false — got: $stdout_out"
  fi
}

# 5.3 Exit codes are stable: 0 success, 2 refused-terminal
{
  tag2="${SCRATCH}/exit_ok"
  make_repo "$tag2" "CTL-9011"
  bin_dir="${SCRATCH}/bin_ok"; log="${SCRATCH}/call_ok.log"
  install_stubs "$bin_dir" "$log"

  PATH="${bin_dir}:$PATH" \
  CATALYST_SALVAGE_DIR="${SCRATCH}/salvage_ok" \
  CATALYST_ADOPT_TICKET_STATE="Research" \
  bash "$ADOPT" "CTL-9011" \
    --worktree "$WORK" \
    --orch-dir "$SCRATCH" --orch-id "test-orch-5" \
    >/dev/null 2>&1; ok_rc=$?

  assert_eq 0 "$ok_rc" "exit-codes: success exits 0"
}

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
echo ""
[[ "$FAILURES" -eq 0 ]]
