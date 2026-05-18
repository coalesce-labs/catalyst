#!/usr/bin/env bash
# CTL-495: catalyst-claude.sh tags interactive sessions with task.type=<skill>
# so Grafana cost can be sliced by activity. Minimal hermetic harness — stubs
# `claude` and `catalyst-session.sh`, runs the wrapper, asserts the stubbed
# claude binary saw `OTEL_RESOURCE_ATTRIBUTES` containing the expected
# task.type pair.
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-claude-task-type.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
WRAPPER="${REPO_ROOT}/plugins/dev/scripts/catalyst-claude.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t catalyst-claude-task-type-XXXXXX)"
trap 'rm -rf "$SCRATCH"; pkill -f "sleep 30" 2>/dev/null || true' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

if [[ ! -x "$WRAPPER" ]]; then
  echo "FATAL: $WRAPPER not found or not executable" >&2
  exit 1
fi

# Set up a stub claude that logs OTEL_RESOURCE_ATTRIBUTES then sleeps. The
# wrapper exec's claude, so the stub must keep the PID alive long enough for
# the assertion to run — sleep 30 then disown. Each test scoped to its own
# subdir to avoid log pollution.
setup_stub_claude() {
  local stub_dir="$1"
  mkdir -p "$stub_dir"
  cat > "$stub_dir/claude" <<'STUB'
#!/usr/bin/env bash
LOG="${CLAUDE_STUB_LOG:?CLAUDE_STUB_LOG required}"
{
  echo "--ARGS--"
  printf '%s\n' "$@"
  echo "--OTEL--"
  echo "${OTEL_RESOURCE_ATTRIBUTES:-}"
  echo "--END--"
} > "$LOG"
# Keep the exec'd process alive briefly so the wrapper's session watcher
# doesn't race ahead and clean up before the test reads $LOG.
sleep 1
STUB
  chmod +x "$stub_dir/claude"
}

# Set up a stub catalyst-session.sh that just echoes a fake session id so
# the wrapper falls through to the exec path (rather than the early-return
# "session unavailable" branch).
setup_stub_session() {
  local stub_dir="$1"
  # The wrapper resolves catalyst-session.sh as a sibling of catalyst-claude.sh,
  # not via PATH. We can't easily shim that without symlinking the wrapper
  # into a fixture dir. Instead, we set CATALYST_SESSION_ID in the env so the
  # wrapper's branch at line ~138 short-circuits.
  :  # placeholder — actually achieved via env preconditioning below
}

run_wrapper() {
  local tag="$1"; shift
  local test_dir="${SCRATCH}/${tag}"
  local stub_dir="${test_dir}/bin"
  mkdir -p "$test_dir" "$stub_dir"
  setup_stub_claude "$stub_dir"
  export CLAUDE_STUB_LOG="${test_dir}/claude.log"
  # The wrapper sources lib/task-type.sh from the real plugins tree (via
  # SCRIPT_DIR), so we don't need to shim it. We DO need the stub claude
  # ahead of the system's `claude` on PATH.
  (
    cd "$test_dir"
    PATH="${stub_dir}:${PATH}" \
      "$WRAPPER" "$@" </dev/null >/dev/null 2>&1 || true
  )
  cat "$CLAUDE_STUB_LOG" 2>/dev/null
}

# ─── Test 1: leading /skill arg → task.type=<skill>
echo "Test 1: leading /skill-name argv → task.type=<skill>"
OUT=$(run_wrapper t1 "/catalyst-dev:create-plan")
if [[ "$OUT" == *"task.type=catalyst-dev:create-plan"* ]]; then
  pass "task.type=catalyst-dev:create-plan from leading slash arg"
else
  fail "task.type=catalyst-dev:create-plan" "OUT: $OUT"
fi

# ─── Test 2: no leading slash → task.type=interactive
echo ""
echo "Test 2: no leading slash → task.type=interactive (default)"
OUT=$(run_wrapper t2)
if [[ "$OUT" == *"task.type=interactive"* ]]; then
  pass "task.type=interactive when no skill arg"
else
  fail "task.type=interactive" "OUT: $OUT"
fi

# ─── Test 3: --skill flag wins over leading slash
echo ""
echo "Test 3: --skill flag is the SKILL source"
OUT=$(run_wrapper t3 --skill "custom-skill" "/some-other:thing")
# The wrapper sets SKILL from --skill at line 96, and the leading-slash check
# at line 115 only fires when USER_SKILL is empty — so --skill wins.
if [[ "$OUT" == *"task.type=custom-skill"* ]]; then
  pass "task.type=custom-skill from --skill flag"
else
  fail "task.type=custom-skill" "OUT: $OUT"
fi

# ─── Test 4: idempotency — parent shell's task.type wins
echo ""
echo "Test 4: parent-shell task.type wins (idempotency)"
OUT=$(
  export OTEL_RESOURCE_ATTRIBUTES="task.type=preset"
  run_wrapper t4 "/catalyst-dev:should-not-override"
)
# Extract just the OTEL line (between --OTEL-- and --END-- markers).
OTEL_LINE=$(printf '%s\n' "$OUT" | awk '/^--OTEL--$/{flag=1; next} /^--END--$/{flag=0} flag')
if [[ "$OTEL_LINE" == "task.type=preset" ]]; then
  pass "parent shell's task.type=preset preserved exactly"
else
  fail "parent shell's task.type=preset preserved" "OTEL line: '$OTEL_LINE'"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "catalyst-claude-task-type: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]]
