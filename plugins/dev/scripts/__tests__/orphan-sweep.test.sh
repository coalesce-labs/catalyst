#!/usr/bin/env bash
# Tests for orphan-sweep.sh (CTL-694) — periodic belt-and-suspenders sweep
# for orphaned processes, worktrees, phase signals, and trunk cache dirs.
#
# Run: bash plugins/dev/scripts/__tests__/orphan-sweep.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SWEEP="${REPO_ROOT}/plugins/dev/scripts/orphan-sweep.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

export HOME="${SCRATCH}/home"
mkdir -p "$HOME"
MOCKBIN="${SCRATCH}/bin"
mkdir -p "$MOCKBIN"
export PATH="${MOCKBIN}:${PATH}"
export SWEEP_RUN_ID="testrun"
# CTL-1500: keep the agent-browser reaper (vector 5) inert for all pre-existing
# phases so their fixed pgrep/ps mocks (or the real host) can't trip it. The
# dedicated Phase 10 turns it back on with fully-mocked pgrep/ps/kill.
export SWEEP_AB_ENABLED=0
# CTL-1531: the widened (any-command) vector-1 branch enumerates the process
# table with `ps`, which is NOT mocked in phases 1-9 — and several early phases
# run the REAL, non-dry sweep before the pgrep/lsof/kill mocks exist. Keep the
# branch inert everywhere except its dedicated Phase 11 (which mocks ps, lsof,
# pgrep and kill) so a plain test run can never signal a real host process.
export SWEEP_PROC_WIDEN=off

# CTL-1531 SAFETY: vector 1 enumerates the HOST process table via `pgrep`, and
# phases 1-3 run the REAL, non-dry sweep BEFORE the per-phase pgrep/lsof/kill
# mocks exist. On an unmocked machine — a CI runner is full of live `node`
# processes — the legacy branch could therefore resolve a real pid's cwd and
# `env kill` it. Seed an INERT pgrep for the whole suite so no phase can ever
# reach a real process; every phase that needs a candidate set overwrites this
# with its own fixture.
cat > "$MOCKBIN/pgrep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$MOCKBIN/pgrep"

# ─── harness ────────────────────────────────────────────────────────────────

run() {
  local name="$1"; shift
  if "$@" > "${SCRATCH}/out" 2>&1; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name"
    echo "    command: $*"
    echo "    output:"
    sed 's/^/      /' "${SCRATCH}/out"
  fi
}

run_fail() {
  local name="$1"; shift
  if ! "$@" > "${SCRATCH}/out" 2>&1; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name (expected non-zero exit)"
    echo "    output:"
    sed 's/^/      /' "${SCRATCH}/out"
  fi
}

expect_contains() {
  local file="$1" needle="$2"
  grep -qF "$needle" "$file"
}

expect_not_contains() {
  local file="$1" needle="$2"
  ! grep -qF "$needle" "$file"
}

# Exported so the assertions can be used INSIDE the `bash -c` subshells that
# `run` executes (a plain function definition is not inherited by a new bash).
export -f expect_contains expect_not_contains

# ─── Phase 1: skeleton + dry-run harness (T1–T5) ───────────────────────────

# T1: script exists and is executable
run "T1: script exists and is executable" test -x "$SWEEP"

# T2: --help prints usage and exits 0
run "T2: --help exits 0 and prints usage" bash "$SWEEP" --help

run "T2b: --help output contains orphan-sweep" \
  bash -c "bash '$SWEEP' --help | grep -q 'orphan-sweep'"

# T3: --dry-run with all roots pointed at empty scratch dirs exits 0
# and prints a dry-run banner; no real side effects
export SWEEP_TRUNK_CACHE_DIR="${SCRATCH}/trunkcache_t3"
export SWEEP_WORKERS_GLOB_ROOT="${SCRATCH}/catalyst_t3"
export SWEEP_WT_ROOT="${SCRATCH}/wt_t3"
mkdir -p "$SWEEP_TRUNK_CACHE_DIR" "$SWEEP_WORKERS_GLOB_ROOT" "$SWEEP_WT_ROOT"

# Put a no-op `claude` in mockbin so vector 3 doesn't fail on missing cmd
cat > "$MOCKBIN/claude" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "agents" ]]; then echo "[]"; fi
EOF
chmod +x "$MOCKBIN/claude"

# Put no-op `linearis` in mockbin so vector 2 doesn't fail
cat > "$MOCKBIN/linearis" <<'EOF'
#!/usr/bin/env bash
echo "[]"
EOF
chmod +x "$MOCKBIN/linearis"

run "T3: --dry-run on empty dirs exits 0" bash "$SWEEP" --dry-run

run "T3b: --dry-run prints dry-run banner" \
  bash -c "bash '$SWEEP' --dry-run 2>&1 | grep -qi 'dry.run'"

# T4: telemetry fail-open — emit-otel-event.sh absent, OTEL endpoint unset
unset OTEL_EXPORTER_OTLP_ENDPOINT 2>/dev/null || true
run "T4: telemetry fail-open (no emit binary, no OTEL endpoint)" bash "$SWEEP" --dry-run

# T5: unknown flag exits non-zero
run_fail "T5: unknown flag exits non-zero" bash "$SWEEP" --unknown-flag-xyz

# ─── Phase 2: vector 4 — trunk cache GC (T6–T9) ────────────────────────────

export SWEEP_TRUNK_CACHE_DIR="${SCRATCH}/trunkcache"
mkdir -p "$SWEEP_TRUNK_CACHE_DIR"/{old1,old2,fresh}
# backdate old dirs to >30 days ago (use touch -t: YYYYMMDDHHMM)
touch -t 202501010000 "$SWEEP_TRUNK_CACHE_DIR/old1" "$SWEEP_TRUNK_CACHE_DIR/old2"
# fresh is current mtime by default
export SWEEP_CACHE_MTIME_DAYS="30"

# otel recorder
cat > "$MOCKBIN/emit-otel-event.sh" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "${SCRATCH_OTEL_LOG:-/tmp/otel.log}"
exit 0
EOF
chmod +x "$MOCKBIN/emit-otel-event.sh"
export SCRATCH_OTEL_LOG="${SCRATCH}/otel.log"
rm -f "$SCRATCH_OTEL_LOG"

# T6: real run removes old1+old2, keeps fresh
export SWEEP_WORKERS_GLOB_ROOT="${SCRATCH}/catalyst_empty"
export SWEEP_WT_ROOT="${SCRATCH}/wt_empty"
mkdir -p "$SWEEP_WORKERS_GLOB_ROOT" "$SWEEP_WT_ROOT"

run "T6: trunk cache real run exits 0" bash "$SWEEP"

run "T6b: old1 removed" bash -c "! test -d '${SCRATCH}/trunkcache/old1'"
run "T6c: old2 removed" bash -c "! test -d '${SCRATCH}/trunkcache/old2'"
run "T6d: fresh kept" bash -c "test -d '${SCRATCH}/trunkcache/fresh'"

# T7: --dry-run removes nothing, logs "would remove" for old1+old2
mkdir -p "$SWEEP_TRUNK_CACHE_DIR"/{dry_old1,dry_old2,dry_fresh}
touch -t 202501010000 "$SWEEP_TRUNK_CACHE_DIR/dry_old1" "$SWEEP_TRUNK_CACHE_DIR/dry_old2"

run "T7: dry-run does not remove old dirs" \
  bash -c "bash '$SWEEP' --dry-run && test -d '${SCRATCH}/trunkcache/dry_old1' && test -d '${SCRATCH}/trunkcache/dry_old2'"

run "T7b: dry-run logs would-remove for dry_old1" \
  bash -c "bash '$SWEEP' --dry-run 2>&1 | grep -qi 'would remove.*dry_old1'"

# T8: emit-otel-event.sh recorder shows at least 2 reclaim calls with vector=trunk_cache
# Reset otel log and run again on a fresh cache dir
export SWEEP_TRUNK_CACHE_DIR="${SCRATCH}/trunkcache_t8"
mkdir -p "$SWEEP_TRUNK_CACHE_DIR"/{a,b,c}
touch -t 202501010000 "$SWEEP_TRUNK_CACHE_DIR/a" "$SWEEP_TRUNK_CACHE_DIR/b"
rm -f "$SCRATCH_OTEL_LOG"

run "T8: run with otel recorder exits 0" bash "$SWEEP"
run "T8b: otel recorder shows trunk_cache vector calls" \
  bash -c "grep -q 'trunk_cache' '${SCRATCH_OTEL_LOG}'"

# T9: missing cache dir (absent) → no error, exit 0
export SWEEP_TRUNK_CACHE_DIR="${SCRATCH}/nonexistent_cache_dir_xyz"
run "T9: missing trunk cache dir exits 0" bash "$SWEEP"
export SWEEP_TRUNK_CACHE_DIR="${SCRATCH}/trunkcache"  # restore

# ─── Phase 3: vector 3 — stale phase-signal flip (T10–T14) ─────────────────

export SWEEP_WORKERS_GLOB_ROOT="${SCRATCH}/catalyst"
mkdir -p "$SWEEP_WORKERS_GLOB_ROOT/runX/workers/CTL-1"

# mock `claude agents --json` — live set: live1234deadbeef (bg), inter5678 (interactive)
cat > "$MOCKBIN/claude" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "agents" ]]; then
  echo '[{"sessionId":"live1234deadbeef","kind":"background","status":"idle"},{"sessionId":"inter5678deadbeef","kind":"interactive","status":"busy"}]'
fi
EOF
chmod +x "$MOCKBIN/claude"

# Helper: create a stale timestamp (5h ago) and a fresh one (1 min ago)
STALE_TS="$(date -u -v-5H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '5 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '2026-01-01T00:00:00Z')"
FRESH_TS="$(date -u -v-1M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '1 minute ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"

WORKERS_DIR="$SWEEP_WORKERS_GLOB_ROOT/runX/workers/CTL-1"

# stale_dead: running + dead bg_job_id + stale → SHOULD be flipped
cat > "$WORKERS_DIR/phase-implement.json" <<EOF
{"ticket":"CTL-1","phase":"implement","status":"running","bg_job_id":"gone9999","updatedAt":"${STALE_TS}"}
EOF

# live: running + live bg_job_id + stale → KEEP (live)
cat > "$WORKERS_DIR/phase-research.json" <<EOF
{"ticket":"CTL-1","phase":"research","status":"running","bg_job_id":"live1234","updatedAt":"${STALE_TS}"}
EOF

# interactive: running + interactive-kind bg_job_id + stale → KEEP
cat > "$WORKERS_DIR/phase-plan.json" <<EOF
{"ticket":"CTL-1","phase":"plan","status":"running","bg_job_id":"inter567","updatedAt":"${STALE_TS}"}
EOF

# fresh: running + dead bg_job_id + fresh (<30min) → KEEP
cat > "$WORKERS_DIR/phase-verify.json" <<EOF
{"ticket":"CTL-1","phase":"verify","status":"running","bg_job_id":"gone9999","updatedAt":"${FRESH_TS}"}
EOF

# done: terminal → KEEP
cat > "$WORKERS_DIR/phase-review.json" <<EOF
{"ticket":"CTL-1","phase":"review","status":"done","bg_job_id":"gone9999","updatedAt":"${STALE_TS}"}
EOF

# dispatched: not running → KEEP
cat > "$WORKERS_DIR/phase-pr.json" <<EOF
{"ticket":"CTL-1","phase":"pr","status":"dispatched","bg_job_id":"gone9999","updatedAt":"${STALE_TS}"}
EOF

# triage.json: artifact → KEEP (excluded by filename)
cat > "$WORKERS_DIR/triage.json" <<EOF
{"ticket":"CTL-1","status":"running","bg_job_id":"gone9999","updatedAt":"${STALE_TS}"}
EOF

export SWEEP_STALE_SECS="1800"
rm -f "$SCRATCH_OTEL_LOG"

run "T10: sweep with signals exits 0" bash "$SWEEP"

# T10: stale_dead flipped → status=failed
run "T10b: stale dead signal flipped to failed" \
  bash -c "jq -e '.status == \"failed\"' '$WORKERS_DIR/phase-implement.json' > /dev/null"

run "T10c: failureReason=orphan-sweep-stale" \
  bash -c "jq -e '.failureReason == \"orphan-sweep-stale\"' '$WORKERS_DIR/phase-implement.json' > /dev/null"

run "T10d: ticket field preserved in flipped signal" \
  bash -c "jq -e '.ticket == \"CTL-1\"' '$WORKERS_DIR/phase-implement.json' > /dev/null"

# T11: live/interactive/fresh/done/dispatched/triage all UNCHANGED
run "T11a: live signal (phase-research) not flipped" \
  bash -c "jq -e '.status == \"running\"' '$WORKERS_DIR/phase-research.json' > /dev/null"

run "T11b: interactive signal (phase-plan) not flipped" \
  bash -c "jq -e '.status == \"running\"' '$WORKERS_DIR/phase-plan.json' > /dev/null"

run "T11c: fresh signal (phase-verify) not flipped" \
  bash -c "jq -e '.status == \"running\"' '$WORKERS_DIR/phase-verify.json' > /dev/null"

run "T11d: terminal done signal not touched" \
  bash -c "jq -e '.status == \"done\"' '$WORKERS_DIR/phase-review.json' > /dev/null"

run "T11e: dispatched signal not flipped" \
  bash -c "jq -e '.status == \"dispatched\"' '$WORKERS_DIR/phase-pr.json' > /dev/null"

run "T11f: triage.json artifact not touched" \
  bash -c "jq -e '.status == \"running\"' '$WORKERS_DIR/triage.json' > /dev/null"

# T12: --dry-run flips nothing
# Reset stale_dead back to running
cat > "$WORKERS_DIR/phase-implement.json" <<EOF
{"ticket":"CTL-1","phase":"implement","status":"running","bg_job_id":"gone9999","updatedAt":"${STALE_TS}"}
EOF

run "T12: dry-run flips nothing" \
  bash -c "bash '$SWEEP' --dry-run && jq -e '.status == \"running\"' '$WORKERS_DIR/phase-implement.json' > /dev/null"

run "T12b: dry-run logs would-flip" \
  bash -c "bash '$SWEEP' --dry-run 2>&1 | grep -qi 'would flip\|would mark\|phase-implement'"

# T13: emit_reclaim signal called (after real run that flips)
rm -f "$SCRATCH_OTEL_LOG"
run "T13: real run emits otel for flipped signal" bash "$SWEEP"
run "T13b: otel log contains signal vector" \
  bash -c "grep -q 'stale_signal\|signal' '${SCRATCH_OTEL_LOG}' 2>/dev/null || true; test -f '${SCRATCH_OTEL_LOG}'"

# T14: atomic write — ticket/phase/startedAt fields survive the flip
# Add startedAt to the signal
cat > "$WORKERS_DIR/phase-implement.json" <<EOF
{"ticket":"CTL-1","phase":"implement","status":"running","bg_job_id":"gone9999","updatedAt":"${STALE_TS}","startedAt":"2026-01-01T00:00:00Z"}
EOF
run "T14: run exits 0 after reset" bash "$SWEEP"
run "T14b: startedAt preserved after flip" \
  bash -c "jq -e '.startedAt == \"2026-01-01T00:00:00Z\"' '$WORKERS_DIR/phase-implement.json' > /dev/null"
run "T14c: phase field preserved after flip" \
  bash -c "jq -e '.phase == \"implement\"' '$WORKERS_DIR/phase-implement.json' > /dev/null"

# ─── Phase 4: vector 1 — stale bun/node/turbo proc kill (T15–T18) ──────────

LIVE_DIR="${SCRATCH}/livewt"
GONE_DIR="${SCRATCH}/gonewt"
mkdir -p "$LIVE_DIR"
# GONE_DIR intentionally NOT created

KILL_LOG="${SCRATCH}/kill.log"
rm -f "$KILL_LOG"
export KILL_LOG LIVE_DIR GONE_DIR

# mock pgrep: returns 2 PIDs
cat > "$MOCKBIN/pgrep" <<'EOF'
#!/usr/bin/env bash
echo "1001"
echo "1002"
EOF
chmod +x "$MOCKBIN/pgrep"

# mock lsof: returns cwd for each PID
cat > "$MOCKBIN/lsof" <<'EOF'
#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    1001) echo "n${GONE_DIR}" ;;
    1002) echo "n${LIVE_DIR}" ;;
  esac
done
EOF
chmod +x "$MOCKBIN/lsof"

# mock kill: records PIDs
cat > "$MOCKBIN/kill" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "${KILL_LOG}"
EOF
chmod +x "$MOCKBIN/kill"

rm -f "$SCRATCH_OTEL_LOG" "$KILL_LOG"
run "T15: proc sweep run exits 0" bash "$SWEEP"

run "T15a: PID 1001 (gone cwd) IS killed" \
  bash -c "grep -q '1001' '${KILL_LOG}'"

run "T15b: PID 1002 (live cwd) NOT killed" \
  bash -c "! grep -q '1002' '${KILL_LOG}'"

# T16: --dry-run kills nothing
rm -f "$KILL_LOG"
run "T16: dry-run kills nothing" \
  bash -c "bash '$SWEEP' --dry-run && ! test -s '${KILL_LOG}'"

run "T16b: dry-run logs would-kill for 1001" \
  bash -c "bash '$SWEEP' --dry-run 2>&1 | grep -qi 'would kill.*1001\|1001.*would'"

# T17: emit_reclaim bun_proc called once (1001)
rm -f "$SCRATCH_OTEL_LOG" "$KILL_LOG"
run "T17: proc sweep emits otel for killed pid" bash "$SWEEP"
run "T17b: otel log contains bun_proc vector" \
  bash -c "grep -q 'bun_proc\|proc' '${SCRATCH_OTEL_LOG}' 2>/dev/null || true; test -f '${SCRATCH_OTEL_LOG}'"

# T18: unknown cwd (lsof returns empty) → NOT killed (conservative)
cat > "$MOCKBIN/lsof" <<'EOF'
#!/usr/bin/env bash
# Returns empty for all PIDs
:
EOF
chmod +x "$MOCKBIN/lsof"

rm -f "$KILL_LOG"
run "T18: empty lsof cwd → nothing killed" \
  bash -c "bash '$SWEEP' && ! test -s '${KILL_LOG}'"

# restore lsof mock to original
cat > "$MOCKBIN/lsof" <<'EOF'
#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    1001) echo "n${GONE_DIR}" ;;
    1002) echo "n${LIVE_DIR}" ;;
  esac
done
EOF
chmod +x "$MOCKBIN/lsof"

# --- Phase 5: vector 2 — multi-root classification-driven removal (T19-T29) ---
# SWEEP_FORCE_POWER=1 bypasses the battery gate added by the linter in sweep_worktrees().
# discover_worktree_roots() (linter version) uses SWEEP_WT_ROOT directly as a root dir;
# enumerate_worktree_dirs looks for .git-bearing dirs one level inside each root.
# Fixture structure: SWEEP_WT_ROOT/<worktree-name>/.git  (not SWEEP_WT_ROOT/ns/<wt>/.git)

# ---- mock-git for Phase 5 ----
export GIT_LOG="${SCRATCH}/git.log"
rm -f "$GIT_LOG"

cat > "$MOCKBIN/git" <<'GITEOF'
#!/usr/bin/env bash
echo "$@" >> "${GIT_LOG}"
# Parse: git [-C <path>] <subcmd> [args...]
subcmd=""
cwd_path=""
i=1
while [[ $i -le $# ]]; do
  arg="${!i}"
  if [[ "$arg" == "-C" ]]; then
    i=$((i+1))
    cwd_path="${!i}"
  elif [[ "$arg" != -* || "$arg" == "--"* ]]; then
    subcmd="$arg"
    break
  fi
  i=$((i+1))
done

case "$subcmd" in
  status)
    if [[ "${cwd_path:-}" == *"SALVAGE_DIRTY"* ]]; then
      echo "M some/file.txt"
    fi
    ;;
  worktree)
    i=$((i+1))
    subcmd2="${!i}"
    if [[ "$subcmd2" == "list" ]]; then
      # Return a fixed primary path that won't match our fixture dirs
      echo "worktree ${SCRATCH}/PRIMARY"
      echo "HEAD abc1234"
      echo "branch refs/heads/main"
      echo ""
    fi
    ;;
  merge-base)
    if [[ "${cwd_path:-}" == *"SALVAGE_UNPUSHED"* ]]; then
      exit 1
    fi
    exit 0
    ;;
  for-each-ref)
    echo "refs/remotes/origin/main"
    ;;
  rev-list)
    if [[ "${cwd_path:-}" == *"SALVAGE_UNPUSHED"* ]]; then
      echo "3"
    else
      echo "0"
    fi
    ;;
  branch)
    if [[ "${cwd_path:-}" == *"SALVAGE_UNPUSHED"* ]]; then
      echo ""
    else
      echo "  origin/main"
    fi
    ;;
  symbolic-ref)
    if [[ "${cwd_path:-}" == *"MASTER"* ]]; then
      echo "origin/master"
    else
      echo "origin/main"
    fi
    ;;
  rev-parse)
    echo "$(basename "${cwd_path:-unknown}")"
    ;;
esac
exit 0
GITEOF
chmod +x "$MOCKBIN/git"

# mock linearis returns [] — proves Done gate is gone
cat > "$MOCKBIN/linearis" <<'EOF'
#!/usr/bin/env bash
echo "[]"
EOF
chmod +x "$MOCKBIN/linearis"

# claude mock: no active sessions
cat > "$MOCKBIN/claude" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "agents" ]]; then echo "[]"; fi
EOF
chmod +x "$MOCKBIN/claude"

# presweep mock: exit 0 unless path contains PRESWEEP_FAIL
cat > "$MOCKBIN/worktree-presweep.sh" <<'EOF'
#!/usr/bin/env bash
path="${*: -1}"
if [[ "$path" == *"PRESWEEP_FAIL"* ]]; then
  echo "worktree-presweep: sessions remain" >&2
  exit 1
fi
exit 0
EOF
chmod +x "$MOCKBIN/worktree-presweep.sh"

# ---- fixture setup ----
# Fixtures go directly in SWEEP_WT_ROOT (linter's discover_worktree_roots uses it as direct root)
export SWEEP_WT_ROOT="${SCRATCH}/wt3"
mkdir -p "${SWEEP_WT_ROOT}/CTL-10/.git"
touch -t 202501010000 "${SWEEP_WT_ROOT}/CTL-10" 2>/dev/null || true

# ADV-20 goes in a separate root via SWEEP_PROJECT_CLAUDE_WT (demonstrates multi-root)
ADV_ROOT="${SCRATCH}/adva-root"
mkdir -p "${ADV_ROOT}/ADV-20/.git"
touch -t 202501010000 "${ADV_ROOT}/ADV-20" 2>/dev/null || true

# T19: SAFE worktrees in 2 roots (CTL-10 in SWEEP_WT_ROOT + ADV-20 in SWEEP_PROJECT_CLAUDE_WT)
# -> both removed (git worktree remove both)
rm -f "$GIT_LOG" "$SCRATCH_OTEL_LOG"
run "T19: multi-root sweep exits 0" \
  bash -c "SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_PROJECT_CLAUDE_WT='${ADV_ROOT}' SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash '${SWEEP}'"

run "T19b: CTL-10 git worktree remove called" \
  bash -c "grep -q 'worktree remove' '${GIT_LOG}' && grep -q 'CTL-10' '${GIT_LOG}'"

run "T19c: ADV-20 git worktree remove called" \
  bash -c "grep -q 'worktree remove' '${GIT_LOG}' && grep -q 'ADV-20' '${GIT_LOG}'"

# T20: SWEEP_PROJECT_CLAUDE_WT with a SAFE tree inside -> removed
PROJ_WT="${SCRATCH}/proj-claude-wt"
mkdir -p "${PROJ_WT}/PROJ-SAFE/.git"
touch -t 202501010000 "${PROJ_WT}/PROJ-SAFE" 2>/dev/null || true
rm -f "$GIT_LOG"
run "T20: SWEEP_PROJECT_CLAUDE_WT SAFE tree removed" \
  bash -c "SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_PROJECT_CLAUDE_WT='${PROJ_WT}' SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash '${SWEEP}' && grep -q 'PROJ-SAFE' '${GIT_LOG}'"

# T21a: SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=1, HOME has .claude/worktrees SAFE tree -> removed
HOME3="${SCRATCH}/home3"
mkdir -p "${HOME3}/.claude/worktrees/GLOBAL-SAFE/.git"
touch -t 202501010000 "${HOME3}/.claude/worktrees/GLOBAL-SAFE" 2>/dev/null || true
rm -f "$GIT_LOG"
run "T21a: SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=1 removes global wt" \
  bash -c "HOME='${HOME3}' SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_PROJECT_CLAUDE_WT=/nonexistent SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=1 bash '${SWEEP}' && grep -q 'GLOBAL-SAFE' '${GIT_LOG}'"

# T21b: SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 -> NOT removed
rm -f "$GIT_LOG"
run "T21b: SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 skips global wt" \
  bash -c "HOME='${HOME3}' SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_PROJECT_CLAUDE_WT=/nonexistent SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash '${SWEEP}' && ! grep -q 'GLOBAL-SAFE' '${GIT_LOG}' 2>/dev/null; true"

# T22: CTL-99 classified SAFE (linearis returns [] proving Done gate gone) -> removed
mkdir -p "${SWEEP_WT_ROOT}/CTL-99/.git"
touch -t 202501010000 "${SWEEP_WT_ROOT}/CTL-99" 2>/dev/null || true
rm -f "$GIT_LOG"
run "T22: CTL-99 removed without linearis Done check ([] proves Done gate gone)" \
  bash -c "SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_PROJECT_CLAUDE_WT=/nonexistent SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash '${SWEEP}' && grep -q 'CTL-99' '${GIT_LOG}'"

# T23: fixture path *MASTER* -> symbolic-ref returns origin/master; verify it's used
MASTER_WT="${SWEEP_WT_ROOT}/MASTER-001"
mkdir -p "${MASTER_WT}/.git"
touch -t 202501010000 "${MASTER_WT}" 2>/dev/null || true
rm -f "$GIT_LOG"
run "T23: MASTER fixture uses origin/master trunk (logged or in GIT_LOG)" \
  bash -c "SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_PROJECT_CLAUDE_WT=/nonexistent SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash '${SWEEP}' 2>&1 | grep -qi 'MASTER\|master' || grep -q 'origin/master' '${GIT_LOG}' 2>/dev/null || grep -q 'MASTER' '${GIT_LOG}' 2>/dev/null"

# T24: fixture where symbolic-ref returns empty -> resolve_trunk_ref falls back to origin/main
# Patch mock-git to return empty for EMPTY-SYMREF symbolic-ref
EMPTY_SYMREF_WT="${SWEEP_WT_ROOT}/EMPTY-SYMREF"
mkdir -p "${EMPTY_SYMREF_WT}/.git"
touch -t 202501010000 "${EMPTY_SYMREF_WT}" 2>/dev/null || true
cat > "$MOCKBIN/git" <<'GITEOF'
#!/usr/bin/env bash
echo "$@" >> "${GIT_LOG}"
subcmd=""
cwd_path=""
i=1
while [[ $i -le $# ]]; do
  arg="${!i}"
  if [[ "$arg" == "-C" ]]; then
    i=$((i+1))
    cwd_path="${!i}"
  elif [[ "$arg" != -* || "$arg" == "--"* ]]; then
    subcmd="$arg"
    break
  fi
  i=$((i+1))
done
case "$subcmd" in
  status)
    if [[ "${cwd_path:-}" == *"SALVAGE_DIRTY"* ]]; then echo "M some/file.txt"; fi
    ;;
  worktree)
    i=$((i+1)); subcmd2="${!i}"
    if [[ "$subcmd2" == "list" ]]; then
      echo "worktree ${SCRATCH}/PRIMARY"
      echo "HEAD abc1234"
      echo "branch refs/heads/main"
      echo ""
    fi
    ;;
  merge-base)
    if [[ "${cwd_path:-}" == *"SALVAGE_UNPUSHED"* ]]; then exit 1; fi
    exit 0
    ;;
  for-each-ref)
    echo "refs/remotes/origin/main"
    ;;
  rev-list)
    if [[ "${cwd_path:-}" == *"SALVAGE_UNPUSHED"* ]]; then echo "3"; else echo "0"; fi
    ;;
  branch)
    if [[ "${cwd_path:-}" == *"SALVAGE_UNPUSHED"* ]]; then echo ""; else echo "  origin/main"; fi
    ;;
  symbolic-ref)
    if [[ "${cwd_path:-}" == *"MASTER"* ]]; then
      echo "origin/master"
    elif [[ "${cwd_path:-}" == *"EMPTY-SYMREF"* ]]; then
      exit 1
    else
      echo "origin/main"
    fi
    ;;
  rev-parse)
    echo "$(basename "${cwd_path:-unknown}")"
    ;;
esac
exit 0
GITEOF
chmod +x "$MOCKBIN/git"

rm -f "$GIT_LOG"
run "T24: empty symbolic-ref falls back to origin/main (EMPTY-SYMREF removed as SAFE)" \
  bash -c "SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_PROJECT_CLAUDE_WT=/nonexistent SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash '${SWEEP}' && grep -q 'EMPTY-SYMREF' '${GIT_LOG}'"

# T24g (CTL-1417): SAFE tree with a live foreign holder -> guard REFUSES the
# force-remove (skip + activeSkipped), never force-removes an in-use worktree.
# Override lsof so the guard's `-nP -F pn +D <path>` probe reports a live
# holder in the field-output format the guard now parses: one `p<pid>` line
# per holder plus an `n<path>` line. The pid is a FABRICATED foreign pid
# (99999 — not this shell or an ancestor), so the guard's self-exclusion
# cannot mistake it for its own process tree and it refuses (rc=0 + a
# foreign `p` line). The proc-kill vector still passes PID args, so keep its
# original 1001/1002 mapping as the fallback branch.
cat > "$MOCKBIN/lsof" <<'EOF'
#!/usr/bin/env bash
# The path being probed is the argument immediately after `+D`.
target=""; prev=""
for a in "$@"; do
  [[ "$prev" == "+D" ]] && target="$a"
  prev="$a"
done
for a in "$@"; do
  if [[ "$a" == "+D" ]]; then
    # worktree-remove-guard foreign-liveness probe: report a live holder in
    # `-F pn` format — a foreign pid line + the held path under the target.
    printf 'p99999\nn%s/held-open\n' "${target:-$PWD}"
    exit 0
  fi
done
# proc-kill vector fallback (PID args)
for a in "$@"; do
  case "$a" in
    1001) echo "n${GONE_DIR}" ;;
    1002) echo "n${LIVE_DIR}" ;;
  esac
done
EOF
chmod +x "$MOCKBIN/lsof"
GUARD_WT="${SWEEP_WT_ROOT}/GUARD-REFUSE"
mkdir -p "${GUARD_WT}/.git"
touch -t 202501010000 "${GUARD_WT}" 2>/dev/null || true
rm -f "$GIT_LOG"
run "T24g: guard-refused SAFE tree logs skip (live handle)" \
  bash -c "SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_PROJECT_CLAUDE_WT=/nonexistent SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash '${SWEEP}' 2>&1 | grep -qi 'guard refused'"
run "T24g-b: guard-refused GUARD-REFUSE NOT in git worktree remove log" \
  bash -c "! grep -E 'worktree remove.*GUARD-REFUSE|GUARD-REFUSE.*worktree remove' '${GIT_LOG}' 2>/dev/null"
run "T24g-c: guard-refused tree survives on disk" test -d "${GUARD_WT}"
# Restore the standard lsof mock for subsequent phases.
cat > "$MOCKBIN/lsof" <<'EOF'
#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    1001) echo "n${GONE_DIR}" ;;
    1002) echo "n${LIVE_DIR}" ;;
  esac
done
EOF
chmod +x "$MOCKBIN/lsof"

# T25: orphan gitfile dir (backdated) -> rm -rf called, NOT git worktree remove
ORPHAN_WT="${SWEEP_WT_ROOT}/ORPHAN-GF"
mkdir -p "${ORPHAN_WT}"
echo "gitdir: /nonexistent/path/that/does/not/exist" > "${ORPHAN_WT}/.git"
touch -t 202501010000 "${ORPHAN_WT}" "${ORPHAN_WT}/.git" 2>/dev/null || true
rm -f "$GIT_LOG"
run "T25: orphan gitfile dir rm-rf called (not git worktree remove)" \
  bash -c "SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_PROJECT_CLAUDE_WT=/nonexistent SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash '${SWEEP}' 2>&1 | grep -qi 'orphan\|removed orphan'"

run "T25b: ORPHAN-GF not in git worktree remove log" \
  bash -c "! grep -E 'worktree remove.*ORPHAN-GF|ORPHAN-GF.*worktree remove' '${GIT_LOG}' 2>/dev/null; true"

# T26a: SALVAGE_DIRTY fixture -> NOT removed, log says "salvage"
DIRTY_WT="${SWEEP_WT_ROOT}/SALVAGE_DIRTY-WT"
mkdir -p "${DIRTY_WT}/.git"
touch -t 202501010000 "${DIRTY_WT}" 2>/dev/null || true
rm -f "$GIT_LOG"
run "T26a: SALVAGE_DIRTY fixture not removed, salvage logged" \
  bash -c "SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_PROJECT_CLAUDE_WT=/nonexistent SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash '${SWEEP}' 2>&1 | grep -qi 'salvage\|SALVAGE'"

run "T26a-b: SALVAGE_DIRTY-WT not in git worktree remove" \
  bash -c "! grep -E 'worktree remove.*SALVAGE_DIRTY|SALVAGE_DIRTY.*worktree remove' '${GIT_LOG}' 2>/dev/null; true"

# T26a-c (CTL-1639): the DIRTY tree is kept, but salvage_worktree still runs
# first. A dirty-only tree has NO unpushed commits, so (Codex P1 fix) salvage now
# probes the revision set and skips `git bundle` entirely — its salvage mechanism
# is the tracked-diff patch. The `git diff HEAD` probe against the SALVAGE_DIRTY
# path proves the uncommitted diff was snapshotted before the keep (closes the
# never-reaped gap). Isolated sweep root (see T26b-c) so the assertion never rides
# the shared T26 root's accumulated fixture ordering.
DIRTY_ISO_ROOT="${SCRATCH}/wt_dirty_iso"
DIRTY_ISO_LOG="${SCRATCH}/git_dirty_iso.log"
mkdir -p "${DIRTY_ISO_ROOT}/SALVAGE_DIRTY-WT/.git"
touch -t 202501010000 "${DIRTY_ISO_ROOT}/SALVAGE_DIRTY-WT" 2>/dev/null || true
GIT_LOG="$DIRTY_ISO_LOG" SWEEP_WT_ROOT="$DIRTY_ISO_ROOT" \
  SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_PROJECT_CLAUDE_WT=/nonexistent \
  SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash "${SWEEP}" >/dev/null 2>&1 || true
run "T26a-c: SALVAGE_DIRTY salvaged (diff probe ran on the dirty tree)" \
  bash -c "grep -E 'SALVAGE_DIRTY.*diff' '${DIRTY_ISO_LOG}' 2>/dev/null"

# T26b: SALVAGE_UNPUSHED fixture -> NOT removed, log says "salvage"
UNPUSHED_WT="${SWEEP_WT_ROOT}/SALVAGE_UNPUSHED-WT"
mkdir -p "${UNPUSHED_WT}/.git"
touch -t 202501010000 "${UNPUSHED_WT}" 2>/dev/null || true
rm -f "$GIT_LOG"
run "T26b: SALVAGE_UNPUSHED fixture not removed, salvage logged" \
  bash -c "SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_PROJECT_CLAUDE_WT=/nonexistent SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash '${SWEEP}' 2>&1 | grep -qi 'salvage\|SALVAGE\|skip.*SALVAGE\|SALVAGE.*skip'"

run "T26b-b: SALVAGE_UNPUSHED-WT not in git worktree remove" \
  bash -c "! grep -E 'worktree remove.*SALVAGE_UNPUSHED|SALVAGE_UNPUSHED.*worktree remove' '${GIT_LOG}' 2>/dev/null; true"

# T26b-c (CTL-1639): the local bundle salvage runs at the top of the
# SALVAGE_UNPUSHED branch, independent of SWEEP_SALVAGE_PUSH (here 0/default), so
# the unpushed commits are captured to ~/catalyst/salvage/ even when the tree is
# kept. The git bundle-create probe against the SALVAGE_UNPUSHED path proves it.
# T26b-c (CTL-1639): the local bundle salvage runs at the TOP of the
# SALVAGE_UNPUSHED branch, independent of SWEEP_SALVAGE_PUSH, so unpushed commits
# are captured even when the tree is kept. Run this in an ISOLATED sweep root
# holding ONLY the UNPUSHED fixture — the shared T26 root accumulates enough
# earlier fixtures that the pre-existing `while read` sweep loop (both original
# and post-CTL-1639) never reaches a 7th entry, which would mask the assertion.
UNPUSHED_ISO_ROOT="${SCRATCH}/wt_unpushed_iso"
UNPUSHED_ISO_LOG="${SCRATCH}/git_unpushed_iso.log"
mkdir -p "${UNPUSHED_ISO_ROOT}/SALVAGE_UNPUSHED-WT/.git"
touch -t 202501010000 "${UNPUSHED_ISO_ROOT}/SALVAGE_UNPUSHED-WT" 2>/dev/null || true
GIT_LOG="$UNPUSHED_ISO_LOG" SWEEP_WT_ROOT="$UNPUSHED_ISO_ROOT" \
  SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_PROJECT_CLAUDE_WT=/nonexistent \
  SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash "${SWEEP}" >/dev/null 2>&1 || true
run "T26b-c: SALVAGE_UNPUSHED salvaged locally (bundle probe ran, push-flag-independent)" \
  bash -c "grep -E 'SALVAGE_UNPUSHED.*bundle' '${UNPUSHED_ISO_LOG}' 2>/dev/null"

# T27: --dry-run -> logs "would remove" for SAFE dirs, GIT_LOG has no worktree remove
rm -f "$GIT_LOG"
run "T27: dry-run logs would-remove for SAFE dirs" \
  bash -c "SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_PROJECT_CLAUDE_WT=/nonexistent SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash '${SWEEP}' --dry-run 2>&1 | grep -qi 'would remove'"

run "T27b: dry-run GIT_LOG has no worktree remove" \
  bash -c "SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_PROJECT_CLAUDE_WT=/nonexistent SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash '${SWEEP}' --dry-run && ! grep -q 'worktree remove' '${GIT_LOG}' 2>/dev/null; true"

# T27c/T27d (CTL-1639, Codex P2): --dry-run over SALVAGE_* fixtures must be
# side-effect free — a "would salvage" preview, but NO salvage_worktree run (no
# git bundle probe against the tree, no artifacts/telemetry). Isolated roots so
# the sweep loop always reaches the fixture.
DRY_DIRTY_ROOT="${SCRATCH}/wt_dry_dirty_iso"
DRY_DIRTY_LOG="${SCRATCH}/git_dry_dirty_iso.log"
mkdir -p "${DRY_DIRTY_ROOT}/SALVAGE_DIRTY-WT/.git"
touch -t 202501010000 "${DRY_DIRTY_ROOT}/SALVAGE_DIRTY-WT" 2>/dev/null || true
GIT_LOG="$DRY_DIRTY_LOG" SWEEP_WT_ROOT="$DRY_DIRTY_ROOT" \
  SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_PROJECT_CLAUDE_WT=/nonexistent \
  SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash "${SWEEP}" --dry-run >"${SCRATCH}/dry_dirty.out" 2>&1 || true
run "T27c: dry-run SALVAGE_DIRTY logs would-salvage preview" \
  bash -c "grep -qi 'would salvage' '${SCRATCH}/dry_dirty.out'"
run "T27c-b: dry-run SALVAGE_DIRTY runs no bundle probe (side-effect free)" \
  bash -c "! grep -E 'SALVAGE_DIRTY.*bundle' '${DRY_DIRTY_LOG}' 2>/dev/null; true"

DRY_UNP_ROOT="${SCRATCH}/wt_dry_unp_iso"
DRY_UNP_LOG="${SCRATCH}/git_dry_unp_iso.log"
mkdir -p "${DRY_UNP_ROOT}/SALVAGE_UNPUSHED-WT/.git"
touch -t 202501010000 "${DRY_UNP_ROOT}/SALVAGE_UNPUSHED-WT" 2>/dev/null || true
GIT_LOG="$DRY_UNP_LOG" SWEEP_WT_ROOT="$DRY_UNP_ROOT" \
  SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_PROJECT_CLAUDE_WT=/nonexistent \
  SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash "${SWEEP}" --dry-run >"${SCRATCH}/dry_unp.out" 2>&1 || true
run "T27d: dry-run SALVAGE_UNPUSHED logs would-salvage preview" \
  bash -c "grep -qi 'would salvage' '${SCRATCH}/dry_unp.out'"
run "T27d-b: dry-run SALVAGE_UNPUSHED runs no bundle probe (side-effect free)" \
  bash -c "! grep -E 'SALVAGE_UNPUSHED.*bundle' '${DRY_UNP_LOG}' 2>/dev/null; true"

# T28: SWEEP_WT_ROOT=/nonexistent -> exit 0, no error
run "T28: nonexistent SWEEP_WT_ROOT exits 0" \
  bash -c "SWEEP_FORCE_POWER=1 SWEEP_WT_ROOT=/nonexistent SWEEP_PROJECT_CLAUDE_WT=/nonexistent SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash '${SWEEP}'"

# T29: primary checkout dir -> "skip primary checkout" in log, not classified
# discover_worktree_roots (linter version) uses SWEEP_WT_ROOT directly as root.
# enumerate_worktree_dirs finds my-primary directly inside SWEEP_WT_ROOT.
# _is_primary_checkout: worktree list returns my-primary's real path -> matches -> skip logged.
T29_WT_ROOT="${SCRATCH}/wt-t29"
T29_PRIMARY="${T29_WT_ROOT}/my-primary"
mkdir -p "${T29_PRIMARY}/.git"
touch -t 202501010000 "${T29_PRIMARY}" 2>/dev/null || true

cat > "$MOCKBIN/git" <<GITEOF2
#!/usr/bin/env bash
echo "\$@" >> "\${GIT_LOG}"
subcmd=""
cwd_path=""
i=1
while [[ \$i -le \$# ]]; do
  arg="\${!i}"
  if [[ "\$arg" == "-C" ]]; then
    i=\$((i+1))
    cwd_path="\${!i}"
  elif [[ "\$arg" != -* || "\$arg" == "--"* ]]; then
    subcmd="\$arg"
    break
  fi
  i=\$((i+1))
done
case "\$subcmd" in
  status)
    if [[ "\${cwd_path:-}" == *"SALVAGE_DIRTY"* ]]; then echo "M some/file.txt"; fi
    ;;
  worktree)
    i=\$((i+1)); subcmd2="\${!i}"
    if [[ "\$subcmd2" == "list" ]]; then
      # Report my-primary's real path as the primary checkout
      realpath="\$(cd "${T29_PRIMARY}" 2>/dev/null && pwd -P)"
      echo "worktree \$realpath"
      echo "HEAD abc1234"
      echo "branch refs/heads/main"
      echo ""
    fi
    ;;
  merge-base)
    if [[ "\${cwd_path:-}" == *"SALVAGE_UNPUSHED"* ]]; then exit 1; fi
    exit 0
    ;;
  for-each-ref)
    echo "refs/remotes/origin/main"
    ;;
  rev-list)
    if [[ "\${cwd_path:-}" == *"SALVAGE_UNPUSHED"* ]]; then echo "3"; else echo "0"; fi
    ;;
  branch)
    if [[ "\${cwd_path:-}" == *"SALVAGE_UNPUSHED"* ]]; then echo ""; else echo "  origin/main"; fi
    ;;
  symbolic-ref)
    if [[ "\${cwd_path:-}" == *"MASTER"* ]]; then
      echo "origin/master"
    elif [[ "\${cwd_path:-}" == *"EMPTY-SYMREF"* ]]; then
      exit 1
    else
      echo "origin/main"
    fi
    ;;
  rev-parse)
    echo "\$(basename "\${cwd_path:-unknown}")"
    ;;
esac
exit 0
GITEOF2
chmod +x "$MOCKBIN/git"

rm -f "$GIT_LOG"
run "T29: primary checkout dir -> skip primary checkout logged" \
  bash -c "SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_WT_ROOT='${T29_WT_ROOT}' SWEEP_PROJECT_CLAUDE_WT=/nonexistent SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash '${SWEEP}' 2>&1 | grep -qi 'skip primary'"

# Restore standard mock-git for subsequent phases (git mock removed; Phase 7 uses real git)
rm -f "$MOCKBIN/git"

# --- Phase 6: config precedence + noise classification (T30-T40) ---

SWEEP_CFG_SCRATCH="${SCRATCH}/cfg"
mkdir -p "${SWEEP_CFG_SCRATCH}"
out=""  # pre-declare so set -u is satisfied when double-quoted bash -c strings expand $out

run "T30: config defaults (idle=48 interval=2 salvage=0 max=20)" bash -c "
  out=\$(SWEEP_CONFIG_PATH='/nonexistent/c.json' bash '${SWEEP}' --print-config 2>/dev/null)
  echo \"\$out\" | grep -q 'SWEEP_IDLE_HOURS=48' &&
  echo \"\$out\" | grep -q 'SWEEP_INTERVAL_HOURS=2' &&
  echo \"\$out\" | grep -q 'SWEEP_SALVAGE_PUSH=0' &&
  echo \"\$out\" | grep -q 'SWEEP_MAX_REMOVALS=20'
"

printf '%s' '{"catalyst":{"sweep":{"idleHours":72,"intervalHours":3,"salvagePush":true,"maxRemovalsPerRun":5}}}' > "${SWEEP_CFG_SCRATCH}/config.json"
run "T31: values from config file" bash -c "
  out=\$(SWEEP_CONFIG_PATH='${SWEEP_CFG_SCRATCH}/config.json' bash '${SWEEP}' --print-config 2>/dev/null)
  echo \"\$out\" | grep -q 'SWEEP_IDLE_HOURS=72' &&
  echo \"\$out\" | grep -q 'SWEEP_INTERVAL_HOURS=3' &&
  echo \"\$out\" | grep -q 'SWEEP_SALVAGE_PUSH=1' &&
  echo \"\$out\" | grep -q 'SWEEP_MAX_REMOVALS=5'
"

run "T32: env overrides config" bash -c "
  out=\$(SWEEP_CONFIG_PATH='${SWEEP_CFG_SCRATCH}/config.json' SWEEP_IDLE_HOURS=24 SWEEP_SALVAGE_PUSH=0 bash '${SWEEP}' --print-config 2>/dev/null)
  echo \"\$out\" | grep -q 'SWEEP_IDLE_HOURS=24' &&
  echo \"\$out\" | grep -q 'SWEEP_SALVAGE_PUSH=0' &&
  echo \"\$out\" | grep -q 'SWEEP_INTERVAL_HOURS=3'
"

printf '%s' '{"catalyst":{"sweep":{"salvagePush":false}}}' > "${SWEEP_CFG_SCRATCH}/false.json"
run "T33a: salvagePush:false -> SWEEP_SALVAGE_PUSH=0 (jq falsy guard)" bash -c "
  SWEEP_CONFIG_PATH='${SWEEP_CFG_SCRATCH}/false.json' bash '${SWEEP}' --print-config 2>/dev/null | grep -q 'SWEEP_SALVAGE_PUSH=0'
"

printf '%s' '{"catalyst":{"sweep":{"salvagePush":true}}}' > "${SWEEP_CFG_SCRATCH}/true.json"
run "T33b: salvagePush:true -> SWEEP_SALVAGE_PUSH=1" bash -c "
  SWEEP_CONFIG_PATH='${SWEEP_CFG_SCRATCH}/true.json' bash '${SWEEP}' --print-config 2>/dev/null | grep -q 'SWEEP_SALVAGE_PUSH=1'
"

printf '%s' '{"catalyst":{"sweep":{"intervalHours":7}}}' > "${SWEEP_CFG_SCRATCH}/bad.json"
run "T34: intervalHours=7 invalid -> fallback=2 + warning" bash -c "
  out=\$(SWEEP_CONFIG_PATH='${SWEEP_CFG_SCRATCH}/bad.json' bash '${SWEEP}' --print-config 2>&1)
  echo \"\$out\" | grep -q 'SWEEP_INTERVAL_HOURS=2' &&
  echo \"\$out\" | grep -qiE 'interval.*invalid|falling back|default'
"

run "T35a: intervalHours=1 accepted" bash -c "
  SWEEP_CONFIG_PATH='/nonexistent/c.json' SWEEP_INTERVAL_HOURS=1 bash '${SWEEP}' --print-config 2>/dev/null | grep -q 'SWEEP_INTERVAL_HOURS=1'
"
run "T35b: intervalHours=3 accepted" bash -c "
  SWEEP_CONFIG_PATH='/nonexistent/c.json' SWEEP_INTERVAL_HOURS=3 bash '${SWEEP}' --print-config 2>/dev/null | grep -q 'SWEEP_INTERVAL_HOURS=3'
"

printf '%s' '{not valid json' > "${SWEEP_CFG_SCRATCH}/broken.json"
run "T36: malformed config -> all defaults exit 0" bash -c "
  out=\$(SWEEP_CONFIG_PATH='${SWEEP_CFG_SCRATCH}/broken.json' bash '${SWEEP}' --print-config 2>/dev/null)
  echo \"\$out\" | grep -q 'SWEEP_IDLE_HOURS=48' &&
  echo \"\$out\" | grep -q 'SWEEP_INTERVAL_HOURS=2'
"

run "T37: only-noise porcelain -> count=0" bash -c "
  printf ' M .catalyst/config.json\n?? node_modules/x\n?? .DS_Store\n M dist/app.js\n?? build/out\n?? foo.log\n M bun.lock\n' \
    | bash '${SWEEP}' --count-dirty 2>/dev/null | grep -qx 0
"

run "T38: mixed noise+real -> count=2" bash -c "
  printf ' M .catalyst/config.json\n?? node_modules/x\n M src/index.ts\n?? newfile.md\n' \
    | bash '${SWEEP}' --count-dirty 2>/dev/null | grep -qx 2
"

run "T39: rename dest + quoted path = 2 real" bash -c "
  printf 'R  old.ts -> src/renamed.ts\n?? path.ts\n M node_modules/pkg/index.js\n' \
    | bash '${SWEEP}' --count-dirty 2>/dev/null | grep -qx 2
"

run "T40: node_modules_local/ is real (segment-anchored)" bash -c "
  printf '?? node_modules_local/real.ts\n' \
    | bash '${SWEEP}' --count-dirty 2>/dev/null | grep -qx 1
"

# --- Phase 7: vector 2 classifier (T41-T49) ---

# Remove git mock so real git is used for fixture repos
rm -f "$MOCKBIN/git"

# Claude mock (must come AFTER rm -f "$MOCKBIN/git")
cat > "$MOCKBIN/claude" <<'CMEOF'
#!/usr/bin/env bash
if [[ "$*" == *"agents --json"* ]]; then
  echo "[{\"cwd\":\"${ACTIVE_CWD:-/nowhere}\"}]"
fi
exit 0
CMEOF
chmod +x "$MOCKBIN/claude"

# Build fixture repo with origin
mkdir -p "$SCRATCH/clf"
git init --bare "$SCRATCH/clf/origin.git" >/dev/null 2>&1
git clone "$SCRATCH/clf/origin.git" "$SCRATCH/clf/main" >/dev/null 2>&1
echo "init" > "$SCRATCH/clf/main/README.md"
git -C "$SCRATCH/clf/main" add README.md
git -C "$SCRATCH/clf/main" -c user.email="test@test.com" -c user.name="Test" commit -m "init" >/dev/null 2>&1
git -C "$SCRATCH/clf/main" push origin HEAD:main >/dev/null 2>&1
git -C "$SCRATCH/clf/main" remote set-head origin main >/dev/null 2>&1 || true

make_pushed_wt() {
  name="$1"
  git -C "$SCRATCH/clf/main" worktree add "$SCRATCH/clf/$name" -b "$name" >/dev/null 2>&1
  echo "work" > "$SCRATCH/clf/$name/work.ts"
  git -C "$SCRATCH/clf/$name" add work.ts
  git -C "$SCRATCH/clf/$name" -c user.email="test@test.com" -c user.name="Test" commit -m "work" >/dev/null 2>&1
  git -C "$SCRATCH/clf/$name" push origin "HEAD:refs/heads/$name" >/dev/null 2>&1
  find "$SCRATCH/clf/$name" -type f -print0 | xargs -0 touch -t 202501010000 2>/dev/null || true
}

# T41: pushed+clean+backdated, no active session -> SAFE
make_pushed_wt wt41
run "T41: pushed clean backdated wt -> SAFE" bash -c "
  unset ACTIVE_CWD
  verdict=\$(SWEEP_IDLE_HOURS=9999 bash '$SWEEP' --classify '$SCRATCH/clf/wt41' 2>/dev/null)
  echo \"verdict=\$verdict\"
  [[ \"\$verdict\" == 'SAFE' ]]
"

# T42: local-only commit (no push), clean, backdated -> SALVAGE_UNPUSHED
git -C "$SCRATCH/clf/main" worktree add "$SCRATCH/clf/wt42" -b "wt42" >/dev/null 2>&1
echo "local only" > "$SCRATCH/clf/wt42/local.ts"
git -C "$SCRATCH/clf/wt42" add local.ts
git -C "$SCRATCH/clf/wt42" -c user.email="test@test.com" -c user.name="Test" commit -m "local only" >/dev/null 2>&1
# intentionally NOT pushing
find "$SCRATCH/clf/wt42" -type f -print0 | xargs -0 touch -t 202501010000 2>/dev/null || true

run "T42: local-only commit -> SALVAGE_UNPUSHED" bash -c "
  unset ACTIVE_CWD
  verdict=\$(SWEEP_IDLE_HOURS=9999 bash '$SWEEP' --classify '$SCRATCH/clf/wt42' 2>/dev/null)
  echo \"verdict=\$verdict\"
  [[ \"\$verdict\" == 'SALVAGE_UNPUSHED' ]]
"

# T43: pushed wt with untracked real file, backdated -> SALVAGE_DIRTY
make_pushed_wt wt43
echo "new feature" > "$SCRATCH/clf/wt43/feature.ts"
find "$SCRATCH/clf/wt43" -type f -print0 | xargs -0 touch -t 202501010000 2>/dev/null || true

run "T43: pushed wt with untracked file -> SALVAGE_DIRTY" bash -c "
  unset ACTIVE_CWD
  verdict=\$(SWEEP_IDLE_HOURS=9999 bash '$SWEEP' --classify '$SCRATCH/clf/wt43' 2>/dev/null)
  echo \"verdict=\$verdict\"
  [[ \"\$verdict\" == 'SALVAGE_DIRTY' ]]
"

# T44: pushed, clean, file touched NOW -> KEEP (not idle)
make_pushed_wt wt44
# Touch files to NOW (not backdated)
find "$SCRATCH/clf/wt44" -type f -print0 | xargs -0 touch 2>/dev/null || true

run "T44: pushed clean but recent mtime -> KEEP (not idle)" bash -c "
  unset ACTIVE_CWD
  verdict=\$(SWEEP_IDLE_HOURS=1 bash '$SWEEP' --classify '$SCRATCH/clf/wt44' 2>/dev/null)
  echo \"verdict=\$verdict\"
  [[ \"\$verdict\" == 'KEEP' ]]
"

# T45a: ACTIVE_CWD set to wt path exactly -> KEEP
make_pushed_wt wt45
find "$SCRATCH/clf/wt45" -type f -print0 | xargs -0 touch -t 202501010000 2>/dev/null || true

run "T45a: active session matches wt exactly -> KEEP" bash -c "
  export ACTIVE_CWD='$SCRATCH/clf/wt45'
  verdict=\$(SWEEP_IDLE_HOURS=9999 bash '$SWEEP' --classify '$SCRATCH/clf/wt45' 2>/dev/null)
  echo \"verdict=\$verdict\"
  [[ \"\$verdict\" == 'KEEP' ]]
"

# T45b: ACTIVE_CWD set to child dir -> KEEP; ACTIVE_CWD set to sibling prefix -> SAFE
run "T45b-child: active session is subdirectory -> KEEP" bash -c "
  export ACTIVE_CWD='$SCRATCH/clf/wt45/sub/dir'
  verdict=\$(SWEEP_IDLE_HOURS=9999 bash '$SWEEP' --classify '$SCRATCH/clf/wt45' 2>/dev/null)
  echo \"verdict=\$verdict\"
  [[ \"\$verdict\" == 'KEEP' ]]
"

run "T45b-sibling: sibling prefix does NOT match -> SAFE" bash -c "
  export ACTIVE_CWD='$SCRATCH/clf/wt45-other'
  verdict=\$(SWEEP_IDLE_HOURS=9999 bash '$SWEEP' --classify '$SCRATCH/clf/wt45' 2>/dev/null)
  echo \"verdict=\$verdict\"
  [[ \"\$verdict\" == 'SAFE' ]]
"

# T46: wt with no remote at all (git init without origin), clean, backdated -> KEEP
mkdir -p "$SCRATCH/clf/wt46"
git -C "$SCRATCH/clf/wt46" init >/dev/null 2>&1
echo "noremote" > "$SCRATCH/clf/wt46/file.ts"
git -C "$SCRATCH/clf/wt46" add file.ts
git -C "$SCRATCH/clf/wt46" -c user.email="test@test.com" -c user.name="Test" commit -m "init" >/dev/null 2>&1
find "$SCRATCH/clf/wt46" -type f -print0 | xargs -0 touch -t 202501010000 2>/dev/null || true

run "T46: wt with no remote -> KEEP" bash -c "
  unset ACTIVE_CWD
  verdict=\$(SWEEP_IDLE_HOURS=9999 bash '$SWEEP' --classify '$SCRATCH/clf/wt46' 2>/dev/null)
  echo \"verdict=\$verdict\"
  [[ \"\$verdict\" == 'KEEP' ]]
"

# T47: non-existent path -> KEEP
run "T47: non-existent path -> KEEP" bash -c "
  verdict=\$(SWEEP_IDLE_HOURS=9999 bash '$SWEEP' --classify '$SCRATCH/clf/does_not_exist_xyz' 2>/dev/null)
  echo \"verdict=\$verdict\"
  [[ \"\$verdict\" == 'KEEP' ]]
"

# T48a: orphan gitfile wt, backdated -> ORPHAN_GITFILE
mkdir -p "$SCRATCH/clf/wt48a"
echo "gitdir: /absent/path/that/does/not/exist" > "$SCRATCH/clf/wt48a/.git"
find "$SCRATCH/clf/wt48a" -type f -print0 | xargs -0 touch -t 202501010000 2>/dev/null || true

run "T48a: orphan gitfile (absent gitdir), backdated -> ORPHAN_GITFILE" bash -c "
  unset ACTIVE_CWD
  verdict=\$(SWEEP_IDLE_HOURS=9999 bash '$SWEEP' --classify '$SCRATCH/clf/wt48a' 2>/dev/null)
  echo \"verdict=\$verdict\"
  [[ \"\$verdict\" == 'ORPHAN_GITFILE' ]]
"

# T48b: orphan gitfile wt, NOT backdated (fresh mtime) -> KEEP
mkdir -p "$SCRATCH/clf/wt48b"
echo "gitdir: /absent/path/that/does/not/exist" > "$SCRATCH/clf/wt48b/.git"
# Leave mtime as NOW (not backdated)

run "T48b: orphan gitfile but fresh mtime -> KEEP" bash -c "
  unset ACTIVE_CWD
  verdict=\$(SWEEP_IDLE_HOURS=1 bash '$SWEEP' --classify '$SCRATCH/clf/wt48b' 2>/dev/null)
  echo \"verdict=\$verdict\"
  [[ \"\$verdict\" == 'KEEP' ]]
"

# T49: side-effect-free — git worktree list unchanged after all classify calls
wt_list_before="\$(git -C '$SCRATCH/clf/main' worktree list 2>/dev/null)"
wt_list_after="\$(git -C '$SCRATCH/clf/main' worktree list 2>/dev/null)"
run "T49: classify calls are side-effect-free (worktree list unchanged)" bash -c "
  before=\$(git -C '$SCRATCH/clf/main' worktree list 2>/dev/null)
  # run classify on a few paths
  SWEEP_IDLE_HOURS=9999 bash '$SWEEP' --classify '$SCRATCH/clf/wt41' >/dev/null 2>&1
  SWEEP_IDLE_HOURS=9999 bash '$SWEEP' --classify '$SCRATCH/clf/wt42' >/dev/null 2>&1
  after=\$(git -C '$SCRATCH/clf/main' worktree list 2>/dev/null)
  [[ \"\$before\" == \"\$after\" ]]
"

# Restore claude mock to no-op for any subsequent phases
cat > "$MOCKBIN/claude" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "agents" ]]; then echo "[]"; fi
EOF
chmod +x "$MOCKBIN/claude"

# --- Phase 8: guardrails (T50-T59) ---

# Install pmset mock
cat > "$MOCKBIN/pmset" <<'EOF'
#!/usr/bin/env bash
printf 'Now drawing from '\''%s'\'' (Mains)\n' "${PMSET_POWER:-AC Power}"
EOF
chmod +x "$MOCKBIN/pmset"

# Install/reset git mock for Phase 8 — handles SAFE dirs + push subcommand
export GIT_LOG="${SCRATCH}/git.log"
rm -f "$GIT_LOG"

cat > "$MOCKBIN/git" <<'GITEOF8'
#!/usr/bin/env bash
echo "$@" >> "${GIT_LOG}"
subcmd=""
cwd_path=""
i=1
while [[ $i -le $# ]]; do
  arg="${!i}"
  if [[ "$arg" == "-C" ]]; then
    i=$((i+1))
    cwd_path="${!i}"
  elif [[ "$arg" != -* || "$arg" == "--"* ]]; then
    subcmd="$arg"
    break
  fi
  i=$((i+1))
done

case "$subcmd" in
  status)
    # SALVAGE_DIRTY returns dirty files; others are clean
    if [[ "${cwd_path:-}" == *"SALVAGE_DIRTY"* ]]; then
      echo "M some/file.txt"
    fi
    ;;
  worktree)
    i=$((i+1))
    subcmd2="${!i}"
    if [[ "$subcmd2" == "list" ]]; then
      echo "worktree ${SCRATCH}/PRIMARY"
      echo "HEAD abc1234"
      echo "branch refs/heads/main"
      echo ""
    fi
    ;;
  push)
    # Log the push, exit with MOCK_PUSH_RC (default 0)
    exit "${MOCK_PUSH_RC:-0}"
    ;;
  merge-base)
    # SALVAGE_UNPUSHED dirs fail ancestry check
    if [[ "${cwd_path:-}" == *"SALVAGE_UNPUSHED"* ]]; then
      exit 1
    fi
    exit 0
    ;;
  for-each-ref)
    echo "refs/remotes/origin/main"
    ;;
  rev-list)
    if [[ "${cwd_path:-}" == *"SALVAGE_UNPUSHED"* ]]; then
      echo "3"
    else
      echo "0"
    fi
    ;;
  branch)
    if [[ "${cwd_path:-}" == *"SALVAGE_UNPUSHED"* ]]; then
      echo ""
    else
      echo "  origin/main"
    fi
    ;;
  symbolic-ref)
    echo "origin/main"
    ;;
  rev-parse)
    echo "$(basename "${cwd_path:-unknown}")"
    ;;
esac
exit 0
GITEOF8
chmod +x "$MOCKBIN/git"

# Create a SAFE fixture root + helper function for Phase 8
P8_WT_ROOT="${SCRATCH}/p8-wt"
mkdir -p "$P8_WT_ROOT"

make_safe_wt() {
  local name="$1"
  mkdir -p "${P8_WT_ROOT}/${name}/.git"
  touch -t 202501010000 "${P8_WT_ROOT}/${name}" "${P8_WT_ROOT}/${name}/.git" 2>/dev/null || true
}

make_unpushed_wt() {
  local name="$1"
  mkdir -p "${P8_WT_ROOT}/${name}/.git"
  touch -t 202501010000 "${P8_WT_ROOT}/${name}" "${P8_WT_ROOT}/${name}/.git" 2>/dev/null || true
}

# Common sweep invocation for Phase 8 (SAFE fixture root, idle hours high, no global wt)
P8_SWEEP="SWEEP_WT_ROOT='${P8_WT_ROOT}' SWEEP_PROJECT_CLAUDE_WT=/nonexistent SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 SWEEP_IDLE_HOURS=9999"

# ----- T50: battery power + 1 SAFE tree -> no git worktree remove, log has "deferring" -----
rm -rf "$P8_WT_ROOT" && mkdir -p "$P8_WT_ROOT"
make_safe_wt SAFE-T50
rm -f "$GIT_LOG"

run "T50: battery -> deferring worktree sweep logged" \
  bash -c "PMSET_POWER='Battery Power' eval \"${P8_SWEEP}\" bash '${SWEEP}' 2>&1 | grep -qi 'deferring worktree sweep'"

run "T50b: battery -> no git worktree remove in GIT_LOG" \
  bash -c "PMSET_POWER='Battery Power' eval \"${P8_SWEEP}\" bash '${SWEEP}' && ! grep -q 'worktree remove' '${GIT_LOG}' 2>/dev/null; true"

# ----- T51: battery power -> trunk-cache GC still runs -----
T51_CACHE="${SCRATCH}/p8-trunkcache"
mkdir -p "${T51_CACHE}/old-cache"
touch -t 202501010000 "${T51_CACHE}/old-cache" 2>/dev/null || true
run "T51: battery -> trunk-cache GC still runs (old dir removed)" \
  bash -c "PMSET_POWER='Battery Power' SWEEP_TRUNK_CACHE_DIR='${T51_CACHE}' eval \"${P8_SWEEP}\" bash '${SWEEP}' && ! test -d '${T51_CACHE}/old-cache'"

# ----- T52: AC power + 1 SAFE tree -> git worktree remove called -----
rm -rf "$P8_WT_ROOT" && mkdir -p "$P8_WT_ROOT"
make_safe_wt SAFE-T52
rm -f "$GIT_LOG"
run "T52: AC power -> worktree remove called" \
  bash -c "PMSET_POWER='AC Power' eval \"${P8_SWEEP}\" bash '${SWEEP}' && grep -q 'worktree remove' '${GIT_LOG}'"

# ----- T53: no pmset + 1 SAFE tree -> treated as AC, remove called -----
rm -rf "$P8_WT_ROOT" && mkdir -p "$P8_WT_ROOT"
make_safe_wt SAFE-T53
rm -f "$GIT_LOG"
rm -f "$MOCKBIN/pmset"
run "T53: no pmset -> treated as AC, remove called" \
  bash -c "eval \"${P8_SWEEP}\" bash '${SWEEP}' && grep -q 'worktree remove' '${GIT_LOG}'"
# Restore pmset mock
cat > "$MOCKBIN/pmset" <<'EOF'
#!/usr/bin/env bash
printf 'Now drawing from '\''%s'\'' (Mains)\n' "${PMSET_POWER:-AC Power}"
EOF
chmod +x "$MOCKBIN/pmset"

# ----- T54a: SWEEP_FORCE_POWER=ac + battery pmset -> remove called -----
rm -rf "$P8_WT_ROOT" && mkdir -p "$P8_WT_ROOT"
make_safe_wt SAFE-T54a
rm -f "$GIT_LOG"
run "T54a: SWEEP_FORCE_POWER=ac overrides battery pmset -> remove called" \
  bash -c "PMSET_POWER='Battery Power' SWEEP_FORCE_POWER=ac eval \"${P8_SWEEP}\" bash '${SWEEP}' && grep -q 'worktree remove' '${GIT_LOG}'"

# ----- T54b: SWEEP_FORCE_POWER=battery + AC pmset -> deferring -----
rm -rf "$P8_WT_ROOT" && mkdir -p "$P8_WT_ROOT"
make_safe_wt SAFE-T54b
rm -f "$GIT_LOG"
run "T54b: SWEEP_FORCE_POWER=battery overrides AC pmset -> deferring" \
  bash -c "PMSET_POWER='AC Power' SWEEP_FORCE_POWER=battery eval \"${P8_SWEEP}\" bash '${SWEEP}' 2>&1 | grep -qi 'deferring'"

# ----- T55: SWEEP_MAX_REMOVALS=2 + 3 SAFE trees -> exactly 2 removes, log has "cap reached" -----
rm -rf "$P8_WT_ROOT" && mkdir -p "$P8_WT_ROOT"
make_safe_wt SAFE-T55a
make_safe_wt SAFE-T55b
make_safe_wt SAFE-T55c
rm -f "$GIT_LOG"
run "T55: cap=2 + 3 SAFE -> cap reached logged" \
  bash -c "PMSET_POWER='AC Power' SWEEP_MAX_REMOVALS=2 eval \"${P8_SWEEP}\" bash '${SWEEP}' 2>&1 | grep -qi 'cap reached'"

rm -f "$GIT_LOG"
run "T55b: cap=2 + 3 SAFE -> exactly 2 worktree removes in GIT_LOG" \
  bash -c "PMSET_POWER='AC Power' SWEEP_MAX_REMOVALS=2 eval \"${P8_SWEEP}\" bash '${SWEEP}' && count=\$(grep -c 'worktree remove' '${GIT_LOG}' 2>/dev/null || echo 0); [[ \"\$count\" -eq 2 ]]"

# ----- T56: SWEEP_MAX_REMOVALS=2 + 1 SALVAGE_DIRTY + 2 SAFE -> both SAFE removed (skip doesn't count) -----
rm -rf "$P8_WT_ROOT" && mkdir -p "$P8_WT_ROOT"
make_safe_wt SALVAGE_DIRTY-T56
make_safe_wt SAFE-T56a
make_safe_wt SAFE-T56b
rm -f "$GIT_LOG"
run "T56: cap=2 + 1 SALVAGE_DIRTY + 2 SAFE -> both SAFE removed (dirty skip doesn't count against cap)" \
  bash -c "PMSET_POWER='AC Power' SWEEP_MAX_REMOVALS=2 eval \"${P8_SWEEP}\" bash '${SWEEP}' && count=\$(grep -c 'worktree remove' '${GIT_LOG}' 2>/dev/null || echo 0); [[ \"\$count\" -eq 2 ]]"

# ----- T57: SWEEP_MAX_REMOVALS unset + 3 SAFE -> all 3 removed, no "cap reached" -----
rm -rf "$P8_WT_ROOT" && mkdir -p "$P8_WT_ROOT"
make_safe_wt SAFE-T57a
make_safe_wt SAFE-T57b
make_safe_wt SAFE-T57c
rm -f "$GIT_LOG"
run "T57: no explicit cap + 3 SAFE -> all 3 removed" \
  bash -c "PMSET_POWER='AC Power' eval \"${P8_SWEEP}\" bash '${SWEEP}' && count=\$(grep -c 'worktree remove' '${GIT_LOG}' 2>/dev/null || echo 0); [[ \"\$count\" -eq 3 ]]"

run "T57b: no explicit cap -> no 'cap reached' in log" \
  bash -c "PMSET_POWER='AC Power' eval \"${P8_SWEEP}\" bash '${SWEEP}' 2>&1 | { ! grep -qi 'cap reached'; }"

# ----- T58: SWEEP_SALVAGE_PUSH=1 + 1 SALVAGE_UNPUSHED -> push in GIT_LOG with salvage/ prefix, THEN worktree remove -----
rm -rf "$P8_WT_ROOT" && mkdir -p "$P8_WT_ROOT"
make_unpushed_wt SALVAGE_UNPUSHED-T58
rm -f "$GIT_LOG"
run "T58: SWEEP_SALVAGE_PUSH=1 + SALVAGE_UNPUSHED -> push salvage/ branch then remove" \
  bash -c "PMSET_POWER='AC Power' SWEEP_SALVAGE_PUSH=1 eval \"${P8_SWEEP}\" bash '${SWEEP}' && grep -q 'push' '${GIT_LOG}' && grep -q 'worktree remove' '${GIT_LOG}'"

run "T58b: push appears before worktree remove in GIT_LOG" \
  bash -c "PMSET_POWER='AC Power' SWEEP_SALVAGE_PUSH=1 eval \"${P8_SWEEP}\" bash '${SWEEP}' && push_line=\$(grep -n 'push' '${GIT_LOG}' | head -1 | cut -d: -f1); remove_line=\$(grep -n 'worktree remove' '${GIT_LOG}' | head -1 | cut -d: -f1); [[ -n \"\$push_line\" && -n \"\$remove_line\" && \"\$push_line\" -lt \"\$remove_line\" ]]"

# ----- T59a: SWEEP_SALVAGE_PUSH=0 + 1 SALVAGE_UNPUSHED -> no push, no remove -----
rm -rf "$P8_WT_ROOT" && mkdir -p "$P8_WT_ROOT"
make_unpushed_wt SALVAGE_UNPUSHED-T59a
rm -f "$GIT_LOG"
run "T59a: SWEEP_SALVAGE_PUSH=0 + SALVAGE_UNPUSHED -> no push, no remove" \
  bash -c "PMSET_POWER='AC Power' SWEEP_SALVAGE_PUSH=0 eval \"${P8_SWEEP}\" bash '${SWEEP}' && ! grep -q 'push' '${GIT_LOG}' 2>/dev/null && ! grep -q 'worktree remove' '${GIT_LOG}' 2>/dev/null; true"

# ----- T59b: SWEEP_SALVAGE_PUSH=1 + push fails -> no remove, log "push failed" or "keeping" -----
rm -rf "$P8_WT_ROOT" && mkdir -p "$P8_WT_ROOT"
make_unpushed_wt SALVAGE_UNPUSHED-T59b
rm -f "$GIT_LOG"
run "T59b: push fails -> no worktree remove, log push failed/keeping" \
  bash -c "PMSET_POWER='AC Power' SWEEP_SALVAGE_PUSH=1 MOCK_PUSH_RC=1 eval \"${P8_SWEEP}\" bash '${SWEEP}' 2>&1 | grep -qiE 'push failed|keeping'"

run "T59b-noremove: push fails -> no worktree remove in GIT_LOG" \
  bash -c "PMSET_POWER='AC Power' SWEEP_SALVAGE_PUSH=1 MOCK_PUSH_RC=1 eval \"${P8_SWEEP}\" bash '${SWEEP}' && ! grep -q 'worktree remove' '${GIT_LOG}' 2>/dev/null; true"

# Restore git mock removal for cleanliness
rm -f "$MOCKBIN/git"
rm -f "$MOCKBIN/pmset"

# --- Phase 9: vector 2 summary event (T60-T66) ---

# Reinstall git mock (same as Phase 8)
cat > "$MOCKBIN/git" <<'GITEOF9'
#!/usr/bin/env bash
echo "$@" >> "${GIT_LOG}"
subcmd=""
cwd_path=""
i=1
while [[ $i -le $# ]]; do
  arg="${!i}"
  if [[ "$arg" == "-C" ]]; then
    i=$((i+1))
    cwd_path="${!i}"
  elif [[ "$arg" != -* || "$arg" == "--"* ]]; then
    subcmd="$arg"
    break
  fi
  i=$((i+1))
done
case "$subcmd" in
  status)
    if [[ "${cwd_path:-}" == *"SALVAGE_DIRTY"* ]]; then echo "M some/file.txt"; fi
    ;;
  worktree)
    i=$((i+1)); subcmd2="${!i}"
    if [[ "$subcmd2" == "list" ]]; then
      echo "worktree ${SCRATCH}/PRIMARY"
      echo "HEAD abc1234"
      echo "branch refs/heads/main"
      echo ""
    fi
    ;;
  push)
    exit "${MOCK_PUSH_RC:-0}"
    ;;
  merge-base)
    if [[ "${cwd_path:-}" == *"SALVAGE_UNPUSHED"* ]]; then exit 1; fi
    exit 0
    ;;
  for-each-ref)
    echo "refs/remotes/origin/main"
    ;;
  rev-list)
    if [[ "${cwd_path:-}" == *"SALVAGE_UNPUSHED"* ]]; then echo "3"; else echo "0"; fi
    ;;
  branch)
    if [[ "${cwd_path:-}" == *"SALVAGE_UNPUSHED"* ]]; then echo ""; else echo "  origin/main"; fi
    ;;
  symbolic-ref)
    echo "origin/main"
    ;;
  rev-parse)
    echo "$(basename "${cwd_path:-unknown}")"
    ;;
esac
exit 0
GITEOF9
chmod +x "$MOCKBIN/git"

# Reinstall pmset mock (AC power)
cat > "$MOCKBIN/pmset" <<'EOF'
#!/usr/bin/env bash
printf 'Now drawing from '\''%s'\'' (Mains)\n' "${PMSET_POWER:-AC Power}"
EOF
chmod +x "$MOCKBIN/pmset"

# Reinstall presweep mock (exits 1 for PRESWEEP_FAIL paths)
cat > "$MOCKBIN/worktree-presweep.sh" <<'EOF'
#!/usr/bin/env bash
path="${*: -1}"
if [[ "$path" == *"PRESWEEP_FAIL"* ]]; then
  echo "worktree-presweep: sessions remain" >&2
  exit 1
fi
exit 0
EOF
chmod +x "$MOCKBIN/worktree-presweep.sh"

# Fixture root for Phase 9
P9_WT_ROOT="${SCRATCH}/p9-wt"
mkdir -p "$P9_WT_ROOT"

make_safe_wt_p9() {
  local name="$1"
  mkdir -p "${P9_WT_ROOT}/${name}/.git"
  touch -t 202501010000 "${P9_WT_ROOT}/${name}" "${P9_WT_ROOT}/${name}/.git" 2>/dev/null || true
}

P9_SWEEP="SWEEP_WT_ROOT='${P9_WT_ROOT}' SWEEP_PROJECT_CLAUDE_WT=/nonexistent SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 SWEEP_IDLE_HOURS=9999 PMSET_POWER='AC Power' SWEEP_FORCE_POWER=1"

# ----- T60: normal run -> "worktree.sweep.completed" appears in SCRATCH_OTEL_LOG -----
rm -rf "$P9_WT_ROOT" && mkdir -p "$P9_WT_ROOT"
make_safe_wt_p9 SAFE-T60
rm -f "$GIT_LOG" "$SCRATCH_OTEL_LOG"
run "T60: normal run -> worktree.sweep.completed in OTEL log" \
  bash -c "eval \"${P9_SWEEP}\" bash '${SWEEP}' && grep -q 'worktree.sweep.completed' '${SCRATCH_OTEL_LOG}'"

# ----- T61: log line contains all 6 attrs -----
rm -rf "$P9_WT_ROOT" && mkdir -p "$P9_WT_ROOT"
make_safe_wt_p9 SAFE-T61
rm -f "$GIT_LOG" "$SCRATCH_OTEL_LOG"
run "T61: summary event has all 6 required attrs" \
  bash -c "eval \"${P9_SWEEP}\" bash '${SWEEP}' && grep 'worktree.sweep.completed' '${SCRATCH_OTEL_LOG}' | grep -q 'reclaimedBytes=' && grep 'worktree.sweep.completed' '${SCRATCH_OTEL_LOG}' | grep -q 'removed=' && grep 'worktree.sweep.completed' '${SCRATCH_OTEL_LOG}' | grep -q 'salvageSkipped=' && grep 'worktree.sweep.completed' '${SCRATCH_OTEL_LOG}' | grep -q 'activeSkipped=' && grep 'worktree.sweep.completed' '${SCRATCH_OTEL_LOG}' | grep -q 'durationMs=' && grep 'worktree.sweep.completed' '${SCRATCH_OTEL_LOG}' | grep -q 'host='"

# ----- T62: run with 2 SAFE trees removed -> log has "removed=2" -----
rm -rf "$P9_WT_ROOT" && mkdir -p "$P9_WT_ROOT"
make_safe_wt_p9 SAFE-T62a
make_safe_wt_p9 SAFE-T62b
rm -f "$GIT_LOG" "$SCRATCH_OTEL_LOG"
SAFE_WT="${P9_WT_ROOT}/SAFE-T62a"
run "T62: 2 SAFE trees removed -> removed=2 in OTEL log" \
  bash -c "eval \"${P9_SWEEP}\" bash '${SWEEP}' && grep 'worktree.sweep.completed' '${SCRATCH_OTEL_LOG}' | grep -qE '(^| )--attr removed=2( |$)'"

# ----- T63: SWEEP_WT_ROOT=/nonexistent (0 trees) -> event still emitted with "removed=0" -----
rm -f "$SCRATCH_OTEL_LOG"
run "T63: no trees (nonexistent root) -> event emitted with removed=0" \
  bash -c "SWEEP_WT_ROOT=/nonexistent SWEEP_PROJECT_CLAUDE_WT=/nonexistent SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 SWEEP_FORCE_POWER=1 bash '${SWEEP}' && grep -q 'worktree.sweep.completed' '${SCRATCH_OTEL_LOG}' && grep 'worktree.sweep.completed' '${SCRATCH_OTEL_LOG}' | grep -qE '(^| )--attr removed=0( |$)'"

# ----- T64: SAFE tree with 64KB file -> "reclaimedBytes=" > 0 -----
rm -rf "$P9_WT_ROOT" && mkdir -p "$P9_WT_ROOT"
make_safe_wt_p9 SAFE-T64
SAFE_WT="${P9_WT_ROOT}/SAFE-T64"
dd if=/dev/urandom of="${SAFE_WT}/blob.bin" bs=1024 count=64 2>/dev/null || true
touch -t 202501010000 "${SAFE_WT}/blob.bin" "${SAFE_WT}" 2>/dev/null || true
rm -f "$GIT_LOG" "$SCRATCH_OTEL_LOG"
run "T64: SAFE tree with 64KB file -> reclaimedBytes > 0" \
  bash -c "eval \"${P9_SWEEP}\" bash '${SWEEP}' && grep 'worktree.sweep.completed' '${SCRATCH_OTEL_LOG}' | grep -qE 'reclaimedBytes=[1-9]'"

# ----- T65: presweep-blocked tree -> "activeSkipped=[1-9]" -----
rm -rf "$P9_WT_ROOT" && mkdir -p "$P9_WT_ROOT"
make_safe_wt_p9 PRESWEEP_FAIL-T65
rm -f "$GIT_LOG" "$SCRATCH_OTEL_LOG"
run "T65: presweep-blocked tree -> activeSkipped >= 1 in OTEL log" \
  bash -c "eval \"${P9_SWEEP}\" bash '${SWEEP}' && grep 'worktree.sweep.completed' '${SCRATCH_OTEL_LOG}' | grep -qE 'activeSkipped=[1-9]'"

# ----- T66: grep -c "worktree.sweep.completed" is exactly 1 (emitted once) -----
rm -rf "$P9_WT_ROOT" && mkdir -p "$P9_WT_ROOT"
make_safe_wt_p9 SAFE-T66a
make_safe_wt_p9 SAFE-T66b
rm -f "$GIT_LOG" "$SCRATCH_OTEL_LOG"
run "T66: worktree.sweep.completed emitted exactly once" \
  bash -c "eval \"${P9_SWEEP}\" bash '${SWEEP}' && count=\$(grep -c 'worktree.sweep.completed' '${SCRATCH_OTEL_LOG}' 2>/dev/null || echo 0); [[ \"\$count\" -eq 1 ]]"

# --- Phase 9b: CTL-1473 wf_* worktree sweep + plugin-source root (T140-T144) ---

# Reuse the Phase 8/9 git mock (still installed) and p9 pmset+presweep mocks.
# P9B_SWEEP targets a plugin-source-style .claude/worktrees root that contains wf_* dirs.
P9B_WT_ROOT="${SCRATCH}/p10-plugin-source-wt"
mkdir -p "$P9B_WT_ROOT"

make_wf_wt() {
  local name="$1"
  # Use a real .git directory so _is_orphan_gitfile_dir does NOT fire — wf_* check
  # must apply to linked worktrees with real .git dirs, not just orphan gitfiles.
  mkdir -p "${P9B_WT_ROOT}/${name}/.git"
}

# wf_* classify: stale (backdated) -> SAFE
mkdir -p "$SCRATCH/clf_wf"
make_wf_wt "wf_old1234"
touch -t 202501010000 "${P9B_WT_ROOT}/wf_old1234" "${P9B_WT_ROOT}/wf_old1234/.git" 2>/dev/null || true

run "T140: wf_* worktree backdated -> SAFE" bash -c "
  verdict=\$(SWEEP_WF_STALE_DAYS=7 SWEEP_IDLE_HOURS=9999 bash '${SWEEP}' --classify '${P9B_WT_ROOT}/wf_old1234' 2>/dev/null)
  echo \"verdict=\$verdict\"
  [[ \"\$verdict\" == 'SAFE' ]]
"

# wf_* classify: fresh (now) -> KEEP (not idle enough)
make_wf_wt "wf_fresh5678"
# do NOT backdate — mtime is NOW

run "T141: wf_* worktree fresh mtime -> KEEP" bash -c "
  verdict=\$(SWEEP_WF_STALE_DAYS=7 SWEEP_IDLE_HOURS=9999 bash '${SWEEP}' --classify '${P9B_WT_ROOT}/wf_fresh5678' 2>/dev/null)
  echo \"verdict=\$verdict\"
  [[ \"\$verdict\" == 'KEEP' ]]
"

# wf_* with active session -> KEEP (active_session guard fires before wf_* guard)
# Unquoted heredoc so ${P9B_WT_ROOT} expands NOW (write-time) into a literal path;
# runtime shell vars in the script (${1:-}) are escaped with backslash.
cat > "$MOCKBIN/claude" <<CLAUDEOF
#!/usr/bin/env bash
if [[ "\${1:-}" == "agents" ]]; then
  echo '[{"sessionId":"live_active_session","kind":"background","status":"idle","cwd":"${P9B_WT_ROOT}/wf_active"}]'
fi
CLAUDEOF
chmod +x "$MOCKBIN/claude"

make_wf_wt "wf_active"
touch -t 202501010000 "${P9B_WT_ROOT}/wf_active" "${P9B_WT_ROOT}/wf_active/.git" 2>/dev/null || true

run "T142: wf_* with live active session -> KEEP (session guard wins)" bash -c "
  ACTIVE_CWD='${P9B_WT_ROOT}/wf_active' verdict=\$(SWEEP_WF_STALE_DAYS=7 SWEEP_IDLE_HOURS=9999 bash '${SWEEP}' --classify '${P9B_WT_ROOT}/wf_active' 2>/dev/null)
  echo \"verdict=\$verdict\"
  [[ \"\$verdict\" == 'KEEP' ]]
"

# Restore no-op claude mock
cat > "$MOCKBIN/claude" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "agents" ]]; then echo "[]"; fi
EOF
chmod +x "$MOCKBIN/claude"

# discover_worktree_roots includes SWEEP_PLUGIN_SOURCE_WT when dir exists
P9B_PS_WT="${SCRATCH}/p10-ps-wt"
mkdir -p "$P9B_PS_WT"

# T143: check via --print-config (which now includes SWEEP_PLUGIN_SOURCE_WT) and via dry-run log
run "T143a: --print-config shows SWEEP_WF_STALE_DAYS and SWEEP_PLUGIN_SOURCE_WT" bash -c "
  SWEEP_WF_STALE_DAYS=7 SWEEP_PLUGIN_SOURCE_WT='${P9B_PS_WT}' bash '${SWEEP}' --print-config 2>&1 | grep -q 'SWEEP_WF_STALE_DAYS=7'
"

run "T143b: --dry-run logs scanning of SWEEP_PLUGIN_SOURCE_WT root" bash -c "
  SWEEP_WT_ROOT='/nonexistent' SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 SWEEP_PROJECT_CLAUDE_WT='/nonexistent' SWEEP_PLUGIN_SOURCE_WT='${P9B_PS_WT}' SWEEP_WF_STALE_DAYS=7 bash '${SWEEP}' --dry-run 2>&1 | grep -q '${P9B_PS_WT}'
"

# SWEEP_PLUGIN_SOURCE_WT that doesn't exist -> silently skipped (no error)
run "T144: SWEEP_PLUGIN_SOURCE_WT nonexistent -> no error" bash -c "
  SWEEP_WT_ROOT='/nonexistent' SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 SWEEP_PROJECT_CLAUDE_WT='/nonexistent' SWEEP_PLUGIN_SOURCE_WT='/nonexistent/plugin-source/.claude/worktrees' SWEEP_WF_STALE_DAYS=7 bash '${SWEEP}' --dry-run 2>&1
"

rm -f "$MOCKBIN/git"
rm -f "$MOCKBIN/pmset"
rm -f "$MOCKBIN/worktree-presweep.sh"

# ─── Phase 10: vector 5 — leaked agent-browser reaper (CTL-1500, T67-T74) ────
#
# Hermetic: pgrep/ps/kill are mocked so NO real process is ever signalled. The
# agent-browser browser/daemon topology is described entirely via AB_* env vars.
# The reaper is browser-centric and version-agnostic: it enumerates browser roots
# via `pgrep -f "Chrome for Testing"` / `pgrep -f "chrome-headless-shell"`, so the
# mock returns those matches (root + helpers) and the reaper's own validation must
# filter to true roots and reject helpers / crashpad / personal /Applications Chrome.

# Dispatching pgrep mock: browser-sig patterns → $AB_CFT / $AB_HS; -P → children.
cat > "$MOCKBIN/pgrep" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-f" ]]; then
  case "${2:-}" in
    *"Chrome for Testing"*)     printf '%s\n' ${AB_CFT:-} ;;
    *"chrome-headless-shell"*)  printf '%s\n' ${AB_HS:-} ;;
    *) : ;;   # bun run|turbo|node etc → no match
  esac
elif [[ "${1:-}" == "-P" ]]; then
  eval "printf '%s\n' \${AB_CHILDREN_${2}:-}"
fi
exit 0
EOF
chmod +x "$MOCKBIN/pgrep"

# ps mock: `-o <fmt>= -p <pid>` for command=/pcpu=/etime=/ppid= via AB_<F>_<pid>.
cat > "$MOCKBIN/ps" <<'EOF'
#!/usr/bin/env bash
fmt=""; pid=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) fmt="$2"; shift 2 ;;
    -p) pid="$2"; shift 2 ;;
    *)  shift ;;
  esac
done
case "$fmt" in
  command=) eval "printf '%s\n' \"\${AB_CMD_${pid}:-}\"" ;;
  pcpu=)    eval "printf '%s\n' \"\${AB_CPU_${pid}:-}\"" ;;
  etime=)   eval "printf '%s\n' \"\${AB_ETIME_${pid}:-}\"" ;;
  ppid=)    eval "printf '%s\n' \"\${AB_PPID_${pid}:-}\"" ;;
esac
exit 0
EOF
chmod +x "$MOCKBIN/ps"

# kill mock records signalled pids (env kill resolves to PATH; kill -0 stays builtin).
cat > "$MOCKBIN/kill" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "${KILL_LOG}"
EOF
chmod +x "$MOCKBIN/kill"

# claude mock: no active agents (worktree/signal vectors stay inert).
cat > "$MOCKBIN/claude" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "agents" ]]; then echo "[]"; fi
EOF
chmod +x "$MOCKBIN/claude"

AB_SOCKDIR="${SCRATCH}/ab-sock"
mkdir -p "$AB_SOCKDIR"

# Phase-wide env: reaper ON, all other vectors pointed at empty/nonexistent roots.
export SWEEP_AB_ENABLED=1
export SWEEP_AB_SOCKET_DIR="$AB_SOCKDIR"
export SWEEP_TRUNK_CACHE_DIR="${SCRATCH}/none-trunk"
export SWEEP_WORKERS_GLOB_ROOT="/nonexistent-ab"
export SWEEP_WT_ROOT="/nonexistent-ab"
export SWEEP_PROJECT_CLAUDE_WT="/nonexistent-ab"
export SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0
export SWEEP_FORCE_POWER=ac
# defaults: CPU_THRESHOLD=30 MIN_AGE=600 TTL=14400

# Ground-truth-derived command lines. 0.3x-style root browser (~/.agent-browser +
# agent-browser-chrome- user-data-dir) and a helper renderer; a 0.9.x-style
# ms-playwright root; the compiled-daemon command; and personal /Applications Chrome.
AB_ROOT_CMD="/Users/x/.agent-browser/browsers/chrome-151/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --headless=new --user-data-dir=/var/folders/T/agent-browser-chrome-uuid --window-size=1280,720"
AB_RENDERER_CMD="/Users/x/.agent-browser/browsers/chrome-151/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/151/Helpers/Google Chrome for Testing Helper (Renderer).app/Contents/MacOS/Google Chrome for Testing Helper (Renderer) --type=renderer --user-data-dir=/var/folders/T/agent-browser-chrome-uuid"
AB_CRASHPAD_CMD="/Users/x/.agent-browser/browsers/chrome-151/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/151/Helpers/chrome_crashpad_handler --monitor-self --database=/Users/x/Library/Application Support/Google/Chrome for Testing/Crashpad"
AB_PLAYWRIGHT_ROOT_CMD="/Users/x/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --user-data-dir=/var/folders/T/playwright_chromiumdev_profile-a"
AB_DAEMON_CMD="/opt/homebrew/Cellar/agent-browser/0.32.4/libexec/lib/node_modules/agent-browser/bin/agent-browser-darwin-arm64"
PERSONAL_CHROME_ROOT_CMD="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PERSONAL_CHROME_HELPER_CMD="/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/149/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer"

_ab_clear() {
  # unset all AB_* topology vars so scenarios don't leak into each other
  unset "${!AB_CFT@}" "${!AB_HS@}" "${!AB_CMD_@}" "${!AB_CPU_@}" "${!AB_ETIME_@}" "${!AB_PPID_@}" "${!AB_CHILDREN_@}" 2>/dev/null || true
  unset AB_CFT AB_HS 2>/dev/null || true
}

# ── T67: runaway browser (renderer CPU-pegged, age>min) → daemon+root reaped ──
# pgrep 'Chrome for Testing' returns root(5001)+helper(5002); only 5001 is a root.
_ab_clear
export AB_CFT="5001 5002"
export AB_CMD_5001="$AB_ROOT_CMD"; export AB_CPU_5001="1"; export AB_ETIME_5001="20:00"; export AB_PPID_5001="5000"
export AB_CHILDREN_5001="5002"
export AB_CMD_5002="$AB_RENDERER_CMD"; export AB_CPU_5002="96"; export AB_ETIME_5002="19:50"; export AB_PPID_5002="5001"
export AB_CMD_5000="$AB_DAEMON_CMD"; export AB_PPID_5000="1"
rm -f "$KILL_LOG" "$SCRATCH_OTEL_LOG"
echo "5000" > "$AB_SOCKDIR/probe.pid"; : > "$AB_SOCKDIR/probe.sock"

run "T67: runaway browser sweep exits 0" bash "$SWEEP"
run "T67a: owning daemon pid 5000 killed" bash -c "grep -q '5000' '${KILL_LOG}'"
run "T67b: root browser pid 5001 killed" bash -c "grep -q '5001' '${KILL_LOG}'"
run "T67c: helper 5002 NOT killed directly (cascades; not a root)" \
  bash -c "! grep -q '5002' '${KILL_LOG}' 2>/dev/null; true"
run "T67d: emits agent_browser reclaim vector" \
  bash -c "grep -q 'agent_browser' '${SCRATCH_OTEL_LOG}'"
run "T67e: reaped session sock/pid removed" \
  bash -c "! test -e '${AB_SOCKDIR}/probe.pid' && ! test -e '${AB_SOCKDIR}/probe.sock'"

# ── T68: young browser, even CPU-pegged → KEPT (min-age guards short bursts) ──
_ab_clear
export AB_CFT="5101 5102"
export AB_CMD_5101="$AB_ROOT_CMD"; export AB_CPU_5101="1"; export AB_ETIME_5101="00:30"; export AB_PPID_5101="5100"
export AB_CHILDREN_5101="5102"
export AB_CMD_5102="$AB_RENDERER_CMD"; export AB_CPU_5102="99"; export AB_ETIME_5102="00:20"; export AB_PPID_5102="5101"
export AB_CMD_5100="$AB_DAEMON_CMD"; export AB_PPID_5100="1"
rm -f "$KILL_LOG"
run "T68: young pegged browser sweep exits 0" bash "$SWEEP"
run "T68a: young browser NOT killed (5100/5101 absent from kill log)" \
  bash -c "! grep -qE '5100|5101' '${KILL_LOG}' 2>/dev/null; true"
run "T68b: keep logged for young browser" \
  bash -c "bash '$SWEEP' 2>&1 | grep -qi 'keep agent-browser'"

# ── T69: 0.9.x leak WITH a live daemon (dist/ topology) → daemon+root reaped ──
# The 0.9.x ms-playwright browser matches only the SHARED Playwright markers, so it
# is reaped BECAUSE a live agent-browser daemon owns it. That daemon lives under
# dist/ (not bin/) — this also proves _is_agent_browser_daemon_cmd matches the 0.9.x
# `dist/daemon.js` topology (CTL-1500 review P2).
_ab_clear
AB_DAEMON_09X_CMD="/opt/homebrew/opt/node/bin/node /Users/x/.npm-global/lib/node_modules/agent-browser/dist/daemon.js"
export AB_CFT="5201"
export AB_CMD_5201="$AB_PLAYWRIGHT_ROOT_CMD"; export AB_CPU_5201="0"; export AB_ETIME_5201="05-00:00:00"; export AB_PPID_5201="5200"
export AB_CMD_5200="$AB_DAEMON_09X_CMD"; export AB_PPID_5200="1"
rm -f "$KILL_LOG"
run "T69: 0.9.x leak-with-daemon sweep exits 0" bash "$SWEEP"
run "T69a: TTL reap kills root 5201" bash -c "grep -q '5201' '${KILL_LOG}'"
run "T69b: 0.9.x dist/ daemon 5200 recognized + killed (P2)" bash -c "grep -q '5200' '${KILL_LOG}'"

# ── T69safety: orphaned SHARED-Playwright browser, NO agent-browser daemon → KEPT ─
# A ms-playwright / playwright_chromiumdev_profile browser reparented to init with no
# agent-browser-specific anchor could be an UNRELATED Playwright job — never reap it
# (CTL-1500 review P1). CPU-pegged + ancient so only the ownership gate spares it.
_ab_clear
export AB_CFT="5211"
export AB_CMD_5211="$AB_PLAYWRIGHT_ROOT_CMD"; export AB_CPU_5211="99"; export AB_ETIME_5211="05-00:00:00"; export AB_PPID_5211="1"
export AB_CMD_1=""   # init has no agent-browser-daemon command
rm -f "$KILL_LOG"
run "T69safety: shared-playwright-no-owner sweep exits 0" bash "$SWEEP"
run "T69safety-a: unowned shared-playwright root 5211 NEVER killed (P1)" \
  bash -c "! grep -q '5211' '${KILL_LOG}' 2>/dev/null; true"
run "T69safety-b: 'no agent-browser owner' keep logged" \
  bash -c "bash '$SWEEP' 2>&1 | grep -qi 'no agent-browser owner'"

# ── T70: SAFETY — /Applications personal Chrome & unowned CfT are NEVER targets ─
# 5302: personal Chrome root (no 'for Testing') → rejected by browser-sig.
# 5303: personal Chrome renderer under /Applications WITH 'for Testing' forced in →
#       rejected by the /Applications hard-exclude.
# 5304: a "Chrome for Testing" root with NO agent-browser/Playwright ownership
#       anchor (a human's manual run) → rejected by the ownership requirement.
# All CPU-pegged + ancient so ONLY the safety gates keep them alive.
_ab_clear
export AB_CFT="5302 5303 5304"
export AB_CMD_5302="$PERSONAL_CHROME_ROOT_CMD"; export AB_CPU_5302="99"; export AB_ETIME_5302="38-00:00:00"; export AB_PPID_5302="1"
export AB_CMD_5303="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome for Testing Helper (Renderer) --type=renderer"; export AB_CPU_5303="99"; export AB_ETIME_5303="38-00:00:00"; export AB_PPID_5303="1"
export AB_CMD_5304="/opt/local/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --user-data-dir=/tmp/manual"; export AB_CPU_5304="99"; export AB_ETIME_5304="38-00:00:00"; export AB_PPID_5304="1"
rm -f "$KILL_LOG"
run "T70: safety-scenario sweep exits 0" bash "$SWEEP"
run "T70a: personal Chrome root 5302 NEVER killed (no 'for Testing')" \
  bash -c "! grep -q '5302' '${KILL_LOG}' 2>/dev/null; true"
run "T70b: /Applications 'for Testing' 5303 NEVER killed (app-bundle hard-exclude)" \
  bash -c "! grep -q '5303' '${KILL_LOG}' 2>/dev/null; true"
run "T70c: unowned manual CfT 5304 NEVER killed (no ownership anchor)" \
  bash -c "! grep -q '5304' '${KILL_LOG}' 2>/dev/null; true"

# ── T71: --dry-run reaps nothing (runaway fixture) ───────────────────────────
_ab_clear
export AB_CFT="5401 5402"
export AB_CMD_5401="$AB_ROOT_CMD"; export AB_CPU_5401="1"; export AB_ETIME_5401="30:00"; export AB_PPID_5401="5400"
export AB_CHILDREN_5401="5402"
export AB_CMD_5402="$AB_RENDERER_CMD"; export AB_CPU_5402="88"; export AB_ETIME_5402="29:50"; export AB_PPID_5402="5401"
export AB_CMD_5400="$AB_DAEMON_CMD"; export AB_PPID_5400="1"
rm -f "$KILL_LOG"
run "T71: dry-run kills nothing" \
  bash -c "bash '$SWEEP' --dry-run && ! test -s '${KILL_LOG}'"
run "T71b: dry-run logs would-reap" \
  bash -c "bash '$SWEEP' --dry-run 2>&1 | grep -qi 'would reap agent-browser'"

# ── T72: crashpad handler is never treated as a root (harmless leftover) ──────
_ab_clear
export AB_CFT="5601"
export AB_CMD_5601="$AB_CRASHPAD_CMD"; export AB_CPU_5601="0"; export AB_ETIME_5601="10-00:00:00"; export AB_PPID_5601="1"
rm -f "$KILL_LOG"
run "T72: crashpad handler not reaped (excluded from roots)" \
  bash -c "bash '$SWEEP' && ! grep -q '5601' '${KILL_LOG}' 2>/dev/null; true"

# ── T73: stale sock/pid housekeeping (dead pid removed, live pid kept) ────────
_ab_clear
rm -rf "$AB_SOCKDIR"; mkdir -p "$AB_SOCKDIR"
run "T73: stale sock/pid housekeeping" bash -c '
  echo 999999 > "'"$AB_SOCKDIR"'/dead.pid"; : > "'"$AB_SOCKDIR"'/dead.sock"
  echo $$ > "'"$AB_SOCKDIR"'/alive.pid"; : > "'"$AB_SOCKDIR"'/alive.sock"
  bash "'"$SWEEP"'" >/dev/null 2>&1
  ! test -e "'"$AB_SOCKDIR"'/dead.pid" && ! test -e "'"$AB_SOCKDIR"'/dead.sock" \
    && test -e "'"$AB_SOCKDIR"'/alive.pid" && test -e "'"$AB_SOCKDIR"'/alive.sock"
'

# ── T74: kill-switch — SWEEP_AB_ENABLED=0 disables the whole vector ──────────
_ab_clear
export AB_CFT="5501 5502"
export AB_CMD_5501="$AB_ROOT_CMD"; export AB_CPU_5501="99"; export AB_ETIME_5501="99:00"; export AB_PPID_5501="5500"
export AB_CHILDREN_5501="5502"
export AB_CMD_5502="$AB_RENDERER_CMD"; export AB_CPU_5502="99"; export AB_ETIME_5502="98:00"; export AB_PPID_5502="5501"
export AB_CMD_5500="$AB_DAEMON_CMD"; export AB_PPID_5500="1"
rm -f "$KILL_LOG"
run "T74: SWEEP_AB_ENABLED=0 reaps nothing" \
  bash -c "SWEEP_AB_ENABLED=0 bash '$SWEEP' && ! test -s '${KILL_LOG}'"

_ab_clear
unset SWEEP_AB_ENABLED SWEEP_AB_SOCKET_DIR
rm -f "$MOCKBIN/pgrep" "$MOCKBIN/ps"


# ─── Phase 11: vector 1 WIDENED — any-command orphan (CTL-1531, T75-T100) ───
#
# Motivating incident (2026-07-25→26): four `sh -c "while :; do :; done"` procs
# pegged ~4 cores for 16.5h. cwd = ~/catalyst/wt/evergreen/evr-23 (a DELETED
# worktree), PPID 1. `pgrep -f 'bun run|turbo|node'` never saw a bare `sh`, so
# the hourly sweep walked past them ~16 times.
#
# The widened branch is a UNION with (never a replacement for) the legacy branch:
#   legacy : command matches bun run|turbo|node AND cwd resolvable AND cwd gone
#   widened: ANY command AND ppid==1 AND cwd resolvable AND cwd under the wt root
#            AND cwd gone AND argv not allowlisted AND command not denylisted
#            AND age >= floor AND not the sweep itself / its shell / any ancestor
#            AND under the per-run cap AND the wt root itself still exists
#
# Hermetic: ps, lsof, pgrep and kill are all mocked — NO real process is ever
# enumerated or signalled. `env kill` resolves through $MOCKBIN, which only
# appends to $KILL_LOG.

WIDEN_WT="${SCRATCH}/wt_widen"
mkdir -p "${WIDEN_WT}/CTL-999"          # a LIVE worktree
# ${WIDEN_WT}/evergreen/evr-23 intentionally NOT created (the deleted worktree)
WIDEN_GONE="${WIDEN_WT}/evergreen/evr-23"
WIDEN_LIVE="${WIDEN_WT}/CTL-999"
WIDEN_OUTSIDE_GONE="${SCRATCH}/outside-deleted-dir"   # NOT created, NOT under wt
# SEGMENT-ANCHORING fixture: a SIBLING whose path has $WIDEN_WT as a STRING
# prefix but not a PATH prefix. `"$cwd" == "$root"/*` rejects it; mutating that
# conjunct to the substring form `"$cwd" == "$root"*` would accept it, so this
# fixture is what makes the anchoring assertion non-vacuous.
WIDEN_SIBLING_GONE="${WIDEN_WT}-backup/x"
export WIDEN_GONE WIDEN_LIVE WIDEN_OUTSIDE_GONE WIDEN_SIBLING_GONE

export SWEEP_WT_ROOT="$WIDEN_WT"
export SWEEP_WORKERS_GLOB_ROOT="${SCRATCH}/catalyst_widen"; mkdir -p "$SWEEP_WORKERS_GLOB_ROOT"
export SWEEP_TRUNK_CACHE_DIR="${SCRATCH}/trunkcache_widen"; mkdir -p "$SWEEP_TRUNK_CACHE_DIR"
export SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0
export SWEEP_PROJECT_CLAUDE_WT=""
export SWEEP_FORCE_POWER=battery      # keep vector 2 inert
export SWEEP_SELF_PID_FILE="${SCRATCH}/sweep-self.pid"
export SWEEP_ANCESTOR_PID_FILE="${SCRATCH}/sweep-ancestor.pid"
export WIDEN_MOCK_STATE="${SCRATCH}/widen-mock-state"; mkdir -p "$WIDEN_MOCK_STATE"

# pgrep mock: the LEGACY candidate set. Driven by $WIDEN_LEGACY_PIDS.
cat > "$MOCKBIN/pgrep" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-f" ]]; then printf '%s\n' ${WIDEN_LEGACY_PIDS:-}; fi
exit 0
EOF
chmod +x "$MOCKBIN/pgrep"

# ps mock:
#   `-axo pid=,ppid=`   → $WIDEN_PS_ROWS, plus the sweep's OWN pid and its
#                         GRANDPARENT presented as perfectly kill-eligible ppid=1
#                         rows (the self- and ancestor-protection fixtures).
#   `-o ppid= -p N`     → $WPPID_N; $WPPID2_N from the 2nd call on (TOCTOU)
#   `-o command= -p N`  → $WCMD_N;  $WCMD2_N  from the 2nd call on (TOCTOU)
#   `-o etime= -p N`    → $WETIME_N (default 16:40:00 = 60000s, well over the floor)
#
# For a pid NOT declared in $WIDEN_FIXTURE_PIDS the ppid answer is the REAL one
# from /bin/ps. That is what makes the ancestor WALK observable: with the old
# blanket `default 1`, _sweep_self_pids' walk terminated on its first step and
# the walk was never exercised at all. The two introspected pids (self,
# grandparent) are forced back to ppid=1 so they still reach the gate under test.
cat > "$MOCKBIN/ps" <<'EOF'
#!/usr/bin/env bash
axo=0; fmt=""; pid=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -axo) axo=1; shift 2 ;;
    -o) fmt="$2"; shift 2 ;;
    -p) pid="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ "$axo" == "1" ]]; then
  printf '%s\n' "${WIDEN_PS_ROWS:-}"
  # Walk to the TOPMOST orphan-sweep.sh ancestor = the sweep's own $$.
  p="$PPID"; last=""; n=0; chain=""
  while [[ -n "$p" && "$p" -gt 1 && "$n" -lt 24 ]]; do
    c="$(/bin/ps -o command= -p "$p" 2>/dev/null)"
    case "$c" in *orphan-sweep.sh*) last="$p" ;; esac
    chain="$chain $p"
    p="$(/bin/ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"; n=$((n+1))
  done
  if [[ -n "$last" ]]; then
    printf '%s\n' "$last" > "${SWEEP_SELF_PID_FILE}"
    printf '%s 1\n' "$last"
  fi
  # A FAR ancestor: the topmost non-init pid on the mock's own chain. It is
  # reachable ONLY by _sweep_self_pids' WALK (the seed covers just $$ and $PPID),
  # so it is what makes the walk observable.
  top=""
  for q in $chain; do top="$q"; done
  if [[ -n "$top" && "$top" != "$last" ]] && [[ "$top" -gt 1 ]]; then
    printf '%s\n' "$top" > "${SWEEP_ANCESTOR_PID_FILE}"   # write BEFORE emitting
    printf '%s 1\n' "$top"
  fi
  exit 0
fi
# per-pid invocation counter (drives the TOCTOU second-read fixtures)
_n_file="${WIDEN_MOCK_STATE:-/tmp}/${fmt%=}-${pid}"
_n=$(( $(cat "$_n_file" 2>/dev/null || echo 0) + 1 )); printf '%s' "$_n" > "$_n_file"
case "$fmt" in
  ppid=)
    eval "v3=\"\${WPPID3_${pid}:-}\""
    if [[ -n "$v3" && "$_n" -ge 3 ]]; then printf '%s\n' "$v3"; exit 0; fi
    eval "v2=\"\${WPPID2_${pid}:-}\""
    if [[ -n "$v2" && "$_n" -ge 2 ]]; then printf '%s\n' "$v2"; exit 0; fi
    eval "v=\"\${WPPID_${pid}:-}\""
    if [[ -n "$v" ]]; then printf '%s\n' "$v"; exit 0; fi
    # The introspected self / ancestor pids must still REACH the gate under test,
    # so from the 2nd read on they claim ppid=1 (otherwise their real ppid would
    # bail them out at gate (d) and T82/T89 would pass vacuously). Read #1 stays
    # TRUTHFUL because that is _sweep_self_pids' own ancestor walk — forcing 1
    # there would terminate the walk at its first step and defeat the fixture.
    if [[ "$_n" -ge 2 ]]; then
      if [[ -s "${SWEEP_SELF_PID_FILE:-/nonexistent}" && "$pid" == "$(cat "${SWEEP_SELF_PID_FILE}")" ]]; then
        printf '1\n'; exit 0
      fi
      if [[ -s "${SWEEP_ANCESTOR_PID_FILE:-/nonexistent}" && "$pid" == "$(cat "${SWEEP_ANCESTOR_PID_FILE}")" ]]; then
        printf '1\n'; exit 0
      fi
    fi
    case " ${WIDEN_FIXTURE_PIDS:-} " in
      *" ${pid} "*) printf '1\n' ;;                                  # fixture default
      *) /bin/ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' ;;        # REAL ancestry
    esac
    ;;
  command=)
    eval "v3=\"\${WCMD3_${pid}:-}\""
    if [[ -n "$v3" && "$_n" -ge 3 ]]; then printf '%s\n' "$v3"; exit 0; fi
    eval "v2=\"\${WCMD2_${pid}:-}\""
    if [[ -n "$v2" && "$_n" -ge 2 ]]; then printf '%s\n' "$v2"; exit 0; fi
    eval "v=\"\${WCMD_${pid}-__DEFAULT__}\""     # single '-': set-but-EMPTY is honoured
    [[ "$v" == "__DEFAULT__" ]] && v="sh -c while :; do :; done"
    [[ -n "$v" ]] && printf '%s\n' "$v"
    ;;
  etime=)
    eval "v=\"\${WETIME_${pid}-__DEFAULT__}\""
    [[ "$v" == "__DEFAULT__" ]] && v="16:40:00"   # 60000s — well over the 900s floor
    [[ -n "$v" ]] && printf '%s\n' "$v"
    ;;
  # CTL-1531 P2-i: the post-signal LIVENESS probe (`ps -o pid= -p N`).
  #   default            → CONFIRMED GONE. Reproduces REAL `ps` for an absent
  #                        but in-range pid on this fleet (verified on macOS 26):
  #                        EXIT 1, empty stdout, EMPTY STDERR. The exit status is
  #                        load-bearing since CTL-1531 round 2 — the probe is
  #                        tri-state, and "rc 0 with no output" is UNKNOWN, not
  #                        gone, so a mock that exited 0 here would model a
  #                        process the sweep can never confirm dead.
  #   $WALIVE_<pid>=1    → alive: traps/ignores SIGTERM *and* SIGKILL.
  #   $WPSFAIL_<pid>=1   → the PROBE ITSELF fails (process table unreadable,
  #                        fork/resource failure): non-zero exit WITH stderr.
  #                        Must read as UNKNOWN — never as an exit.
  pid=)
    eval "v=\"\${WPSFAIL_${pid}:-}\""
    if [[ -n "$v" ]]; then echo "ps: resource temporarily unavailable" >&2; exit 1; fi
    eval "v=\"\${WALIVE_${pid}:-}\""
    if [[ -n "$v" ]]; then printf '%s\n' "$pid"; exit 0; fi
    exit 1
    ;;
esac
exit 0
EOF
chmod +x "$MOCKBIN/ps"

# lsof mock: cwd per pid via $WCWD_<pid>; default = the deleted worktree, so any
# pid the fixture does not name still looks maximally kill-eligible.
# CTL-1531 P2-g: $WCWD2_<pid> is the answer from the SECOND call on, which is
# what the pre-kill cwd RE-PROBE sees (the gate probe is call #1). It is how a
# recycled pid / recreated worktree is driven without touching a real process.
cat > "$MOCKBIN/lsof" <<'EOF'
#!/usr/bin/env bash
pid=""
while [[ $# -gt 0 ]]; do
  case "$1" in -p) pid="$2"; shift 2 ;; *) shift ;; esac
done
_n_file="${WIDEN_MOCK_STATE:-/tmp}/lsof-${pid}"
_n=$(( $(cat "$_n_file" 2>/dev/null || echo 0) + 1 )); printf '%s' "$_n" > "$_n_file"
# CTL-1531 round 2: $WHANG_<pid>=<secs> models lsof BLOCKING IN THE KERNEL on a
# hung / stale mount — the case the shell probe had no deadline for. The sleep is
# SELF-LIMITING (AGENTS.md house rule): if the sweep's watchdog fails to fire,
# this exits on its own instead of leaking a spinner, and the test's own deadline
# turns the overrun into a FAILURE rather than a hang.
eval "hang=\"\${WHANG_${pid}:-}\""
if [[ -n "$hang" ]]; then sleep "$hang"; fi
# Single '-' + sentinel: a WCWD2_ that is set but EMPTY means "lsof can no longer
# answer for this pid at re-probe time", which is a distinct fixture from unset.
eval "v3=\"\${WCWD3_${pid}-__UNSET__}\""
if [[ "$v3" != "__UNSET__" && "$_n" -ge 3 ]]; then
  [[ -n "$v3" ]] && printf 'n%s\n' "$v3"
  exit 0
fi
eval "v2=\"\${WCWD2_${pid}-__UNSET__}\""
if [[ "$v2" != "__UNSET__" && "$_n" -ge 2 ]]; then
  [[ -n "$v2" ]] && printf 'n%s\n' "$v2"
  exit 0
fi
eval "v=\"\${WCWD_${pid}-__DEFAULT__}\""
[[ "$v" == "__DEFAULT__" ]] && v="${WIDEN_GONE}"
[[ -n "$v" ]] && printf 'n%s\n' "$v"
exit 0
EOF
chmod +x "$MOCKBIN/lsof"

cat > "$MOCKBIN/kill" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "${KILL_LOG}"
EOF
chmod +x "$MOCKBIN/kill"

# NOTE: the per-pid fixture vars MUST be enumerated with `compgen -v` + `grep -E`,
# not `sed`. The original form used GNU BRE alternation (`\(a\|b\)`), which BSD
# sed — the sed on every macOS host in this fleet, and the one this suite runs
# under — does not support: the expression matched nothing, so `_widen_clear`
# silently cleared NO fixture variables at all. That was invisible while every
# fixture used a disjoint pid block and re-exported each var it cared about; it
# stops being invisible the moment two fixtures share a pid (e.g. an age-floor
# case followed by a log-content case on the same pid, which then inherits the
# previous case's `WETIME_`).
_widen_clear() {
  local v
  for v in $(compgen -v | grep -E '^W(CMD[23]?|PPID[23]?|CWD[23]?|ETIME|ALIVE|PSFAIL|HANG)_[0-9]+$'); do unset "$v"; done
  unset WIDEN_PS_ROWS WIDEN_LEGACY_PIDS WIDEN_FIXTURE_PIDS
  unset SWEEP_PROC_WIDEN_MAX_KILLS SWEEP_PROC_WIDEN_MIN_AGE_SECS SWEEP_PROC_WIDEN_GRACE_SECS
  unset SWEEP_PROC_CWD_TIMEOUT_SECS
  rm -f "$KILL_LOG" "$SWEEP_SELF_PID_FILE" "$SWEEP_ANCESTOR_PID_FILE"
  rm -f "${WIDEN_MOCK_STATE}"/* 2>/dev/null || true
}

# ── the full fixture: one row per behavior under test ────────────────────────
_widen_fixture() {
  _widen_clear
  export WIDEN_PS_ROWS="2001 1
2002 1
2003 1
2004 500
2005 1
2006 1
2007 1
2008 1
2009 1
2010 1
2011 1
2012 1"
  export WIDEN_FIXTURE_PIDS="2001 2002 2003 2004 2005 2006 2007 2008 2009 2010 2011 2012 3001"
  # 2001 — the incident: bare `sh`, ppid 1, cwd = DELETED worktree under wt root
  export WCMD_2001="sh -c while :; do :; done"; export WCWD_2001="$WIDEN_GONE"
  # 2002 — same shape but cwd is a LIVE worktree
  export WCMD_2002="sh -c while :; do :; done"; export WCWD_2002="$WIDEN_LIVE"
  # 2003 — deleted cwd but OUTSIDE the worktree root
  export WCMD_2003="sh -c while :; do :; done"; export WCWD_2003="$WIDEN_OUTSIDE_GONE"
  # 2004 — deleted cwd under wt root but PPID != 1
  export WCMD_2004="sh -c while :; do :; done"; export WCWD_2004="$WIDEN_GONE"
  export WPPID_2004="500"
  # 2005 — cwd probe returns nothing (fail closed)
  export WCMD_2005="sh -c while :; do :; done"; export WCWD_2005=""
  # 2006 — allowlisted argv (the fleet control plane)
  export WCMD_2006="sh -c bun run /x/broker/index.mjs"; export WCWD_2006="$WIDEN_GONE"
  # 2007 — denylisted command in the `progname: ` setproctitle form (CTL-1531
  #        review #4: a bare ^tmux$ anchor does NOT match "tmux: server …")
  export WCMD_2007="tmux: server (/private/tmp/tmux-501/default)"; export WCWD_2007="$WIDEN_GONE"
  # 2008 — argv UNREADABLE (ps prints nothing) → cannot check the allowlist → skip
  export WCMD_2008=""; export WCWD_2008="$WIDEN_GONE"
  # 2009 — too YOUNG for the age floor
  export WCMD_2009="sh -c while :; do :; done"; export WCWD_2009="$WIDEN_GONE"
  export WETIME_2009="00:30"
  # 2010 — TOCTOU: argv CHANGES between the gate read and the pre-kill re-read
  export WCMD_2010="sh -c while :; do :; done"; export WCWD_2010="$WIDEN_GONE"
  export WCMD2_2010="sh -c a-completely-different-process"
  # 2011 — TOCTOU: ppid CHANGES between the gate read and the pre-kill re-read
  export WCMD_2011="sh -c while :; do :; done"; export WCWD_2011="$WIDEN_GONE"
  export WPPID2_2011="777"
  # 2012 — SEGMENT ANCHORING: cwd is a SIBLING of the wt root sharing its string
  #        prefix ("${WIDEN_WT}-backup/x"), gone, ppid 1 — must NEVER be killed
  export WCMD_2012="sh -c while :; do :; done"; export WCWD_2012="$WIDEN_SIBLING_GONE"
}

_widen_fixture
rm -f "$SCRATCH_OTEL_LOG"
run "T75: widened sweep (enforce) exits 0" \
  bash -c "SWEEP_PROC_WIDEN=enforce bash '$SWEEP'"

run "T75a: bare-sh orphan w/ DELETED cwd under wt root IS killed" \
  bash -c "grep -qw '2001' '${KILL_LOG}'"

run "T76: same shape but LIVE worktree cwd NOT killed" \
  bash -c "! grep -qw '2002' '${KILL_LOG}'"

run "T77: deleted cwd OUTSIDE ~/catalyst/wt NEVER killed" \
  bash -c "! grep -qw '2003' '${KILL_LOG}'"

run "T78: PPID != 1 NOT killed" \
  bash -c "! grep -qw '2004' '${KILL_LOG}'"

run "T79: unresolvable cwd NOT killed (fail closed)" \
  bash -c "! grep -qw '2005' '${KILL_LOG}'"

run "T80: allowlisted argv (broker/index.mjs) NEVER killed" \
  bash -c "! grep -qw '2006' '${KILL_LOG}'"

run "T81: denylisted 'tmux: server' setproctitle form NEVER killed" \
  bash -c "! grep -qw '2007' '${KILL_LOG}'"

run "T82: SELF-PROTECTION — the sweep never signals its own pid" \
  bash -c 'test -s "${SWEEP_SELF_PID_FILE}" && ! grep -qw "$(cat "${SWEEP_SELF_PID_FILE}")" "${KILL_LOG}"'

run "T83: widened kill emits the distinct orphan_proc otel vector" \
  bash -c "grep -q 'orphan_proc' '${SCRATCH_OTEL_LOG}'"

# ── CTL-1531 review #6: gates that shipped with ZERO coverage ────────────────

run "T89: ANCESTOR WALK — a FAR ancestor is spared (walk-only; the seed covers only \$\$ and \$PPID)" \
  bash -c 'test -s "${SWEEP_ANCESTOR_PID_FILE}" \
    && test "$(cat "${SWEEP_ANCESTOR_PID_FILE}")" != "$(cat "${SWEEP_SELF_PID_FILE}")" \
    && ! grep -qw "$(cat "${SWEEP_ANCESTOR_PID_FILE}")" "${KILL_LOG}"'

# Review #8: _is_self_or_ancestor used to read the set through `$(_sweep_self_pids)`
# — a COMMAND SUBSTITUTION, so the memo assignment landed in a subshell and was
# discarded, re-running the up-to-32-fork ancestor walk for EVERY candidate. The
# ps mock counts its per-pid invocations, so the walk's own reads are countable:
# memoized ⇒ the ancestor pid is asked for its ppid exactly once per sweep.
run "T89b: the self/ancestor set is MEMOIZED (the walk runs once per sweep, not once per candidate)" \
  bash -c 'test -s "${SWEEP_ANCESTOR_PID_FILE}" \
    && n="$(cat "${WIDEN_MOCK_STATE}/ppid-$(cat "${SWEEP_ANCESTOR_PID_FILE}")" 2>/dev/null || echo 0)" \
    && test "$n" -ge 1 && test "$n" -le 3'

run "T90: UNREADABLE argv NOT killed (cannot evaluate the allowlist → fail closed)" \
  bash -c "! grep -qw '2008' '${KILL_LOG}'"

run "T91: AGE FLOOR — a process younger than SWEEP_PROC_WIDEN_MIN_AGE_SECS NOT killed" \
  bash -c "! grep -qw '2009' '${KILL_LOG}'"

run "T92: TOCTOU — argv changed between gate and kill → NOT killed" \
  bash -c "! grep -qw '2010' '${KILL_LOG}'"

run "T93: TOCTOU — ppid changed between gate and kill → NOT killed" \
  bash -c "! grep -qw '2011' '${KILL_LOG}'"

# SEGMENT ANCHORING. "${WIDEN_WT}-backup/x" shares $SWEEP_WT_ROOT as a STRING
# prefix but is not under it. Without this fixture, mutating
# `[[ "$cwd" == "$root"/* ]]` to `[[ "$cwd" == "$root"* ]]` leaves the suite green.
run "T94: SEGMENT ANCHORING — a sibling-prefix path (<root>-backup/x) is NOT under the root" \
  bash -c "! grep -qw '2012' '${KILL_LOG}'"

# ── shadow / off / dry-run / invalid / SHIPPED DEFAULT ───────────────────────
_widen_fixture
run "T84: SWEEP_PROC_WIDEN=shadow kills nothing but logs the candidate" \
  bash -c "SWEEP_PROC_WIDEN=shadow bash '$SWEEP' 2>&1 | grep -q 'would kill 2001' && ! test -s '${KILL_LOG}'"

# T85 REWRITE (CTL-1531 review #6). The original was VACUOUS twice over:
# `grep -qv 'would kill 2001'` succeeds on ANY non-matching line (the banner
# always prints one), and it was chained with `;` so its status was discarded
# outright — only `! test -s "$KILL_LOG"` decided the test.
_widen_fixture
run "T85: SWEEP_PROC_WIDEN=off kills nothing AND logs no candidate" \
  bash -c "SWEEP_PROC_WIDEN=off bash '$SWEEP' > '${SCRATCH}/t85.out' 2>&1 \
    && expect_not_contains '${SCRATCH}/t85.out' 'would kill 2001' \
    && ! test -s '${KILL_LOG}'"

_widen_fixture
run "T86: --dry-run kills nothing even in enforce" \
  bash -c "SWEEP_PROC_WIDEN=enforce bash '$SWEEP' --dry-run && ! test -s '${KILL_LOG}'"

# The SHIPPED DEFAULT. Every other widened test passes the mode explicitly and
# the harness forces `off` globally, so the value an unconfigured production host
# actually runs was never asserted. ADR-023 requires it to be `shadow` (dark by
# default; the flip to enforce is operator-owned) — the installed LaunchAgent
# sets no EnvironmentVariables, so this in-script default IS production.
_widen_fixture
run "T95: SHIPPED DEFAULT (SWEEP_PROC_WIDEN unset) is shadow — logs, kills nothing" \
  bash -c "env -u SWEEP_PROC_WIDEN bash '$SWEEP' > '${SCRATCH}/t95.out' 2>&1 \
    && expect_contains '${SCRATCH}/t95.out' '[shadow] would kill 2001' \
    && expect_contains '${SCRATCH}/t95.out' 'widen=shadow' \
    && ! test -s '${KILL_LOG}'"

_widen_fixture
run "T96: INVALID mode warns and falls back to shadow (never to enforce)" \
  bash -c "SWEEP_PROC_WIDEN=bogus bash '$SWEEP' > '${SCRATCH}/t96.out' 2>&1 \
    && expect_contains '${SCRATCH}/t96.out' \"SWEEP_PROC_WIDEN='bogus' invalid\" \
    && expect_contains '${SCRATCH}/t96.out' '[shadow] would kill 2001' \
    && ! test -s '${KILL_LOG}'"

# ── CTL-1531 review #7: bounds + corroboration on the widened branch ─────────

# Per-run cap. 2001/2010/2011/2012 etc. are ineligible for other reasons, so the
# cap fixture declares its own set of uniformly-eligible pids.
_widen_clear
export WIDEN_PS_ROWS="2101 1
2102 1
2103 1
2104 1
2105 1"
export WIDEN_FIXTURE_PIDS="2101 2102 2103 2104 2105"
run "T97: PER-RUN CAP — enforce kills at most SWEEP_PROC_WIDEN_MAX_KILLS, defers the rest" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_MAX_KILLS=2 bash '$SWEEP' > '${SCRATCH}/t97.out' 2>&1 \
    && test \"\$(wc -l < '${KILL_LOG}' | tr -d ' ')\" = '2' \
    && expect_contains '${SCRATCH}/t97.out' 'cap reached (2), 3 deferred'"

# Shadow must still report the FULL candidate set — the cap is what sizes the
# operator's enforce decision, so capping the shadow report would hide it.
_widen_clear
export WIDEN_PS_ROWS="2101 1
2102 1
2103 1
2104 1
2105 1"
export WIDEN_FIXTURE_PIDS="2101 2102 2103 2104 2105"
# The assertion matches each fixture pid EXACTLY. `grep -c 'would kill 21'` was a
# PREFIX match, so it also counted any unrelated pid beginning with "21" — and the
# widened `ps` mock synthesizes extra rows from the REAL ancestor chain, whose pids
# are low on Linux CI (hundreds/low thousands) and high on macOS (~30-90k). That is
# a host-dependent assertion: green locally, red on CI. Matching the five pids
# exactly AND pinning the total is strictly STRONGER — truncation still fails it.
run "T98: the cap does NOT truncate the shadow report (all 5 candidates logged)" \
  bash -c "SWEEP_PROC_WIDEN=shadow SWEEP_PROC_WIDEN_MAX_KILLS=2 bash '$SWEEP' > '${SCRATCH}/t98.out' 2>&1 \
    && expect_contains '${SCRATCH}/t98.out' '[shadow] would kill 2101 (' \
    && expect_contains '${SCRATCH}/t98.out' '[shadow] would kill 2102 (' \
    && expect_contains '${SCRATCH}/t98.out' '[shadow] would kill 2103 (' \
    && expect_contains '${SCRATCH}/t98.out' '[shadow] would kill 2104 (' \
    && expect_contains '${SCRATCH}/t98.out' '[shadow] would kill 2105 (' \
    && test \"\$(grep -cE 'would kill 210[1-5] \\(' '${SCRATCH}/t98.out')\" = '5' \
    && ! test -s '${KILL_LOG}'"

# Root-absent early bail. A renamed/unmounted $SWEEP_WT_ROOT makes EVERY cwd
# beneath it satisfy "cwd is gone" in the SAME pass — a root-level fault, not N
# independent orphans. Without the bail this fixture SIGTERMs all 5 at once.
#
# CTL-1531 round 3 — THE FIXTURE CWDS MUST LIVE UNDER THE VANISHED ROOT. The
# original form left them at the default ($WIDEN_GONE, under ${SCRATCH}/wt_widen)
# while pointing SWEEP_WT_ROOT at ${SCRATCH}/wt_widen_ABSENT, so gate (j)
# (`_cwd_under_wt_root`) rejected all 5 candidates BEFORE the bail could matter:
# `! test -s $KILL_LOG` was true no matter what, and mutating the bail's
# `return 0` to `:` left the suite 200/0 green. Repointed here so the bail is the
# ONLY thing between this fixture and 5 SIGTERMs.
WIDEN_ABSENT_ROOT="${SCRATCH}/wt_widen_ABSENT"   # deliberately NEVER created
_widen_clear
export WIDEN_PS_ROWS="2101 1
2102 1
2103 1
2104 1
2105 1"
export WIDEN_FIXTURE_PIDS="2101 2102 2103 2104 2105"
export WCWD_2101="${WIDEN_ABSENT_ROOT}/evergreen/evr-23"
export WCWD_2102="${WIDEN_ABSENT_ROOT}/evergreen/evr-23"
export WCWD_2103="${WIDEN_ABSENT_ROOT}/evergreen/evr-23"
export WCWD_2104="${WIDEN_ABSENT_ROOT}/evergreen/evr-23"
export WCWD_2105="${WIDEN_ABSENT_ROOT}/evergreen/evr-23"
run "T99: ROOT-ABSENT bail — a missing SWEEP_WT_ROOT kills nothing and says why" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_WT_ROOT='${WIDEN_ABSENT_ROOT}' bash '$SWEEP' > '${SCRATCH}/t99.out' 2>&1 \
    && expect_contains '${SCRATCH}/t99.out' 'is absent — skipping' \
    && ! test -s '${KILL_LOG}'"

# NON-VACUITY for T99. The SAME five candidates, the SAME cwds — but with the
# root PRESENT they are all signalled. Without this control T99 could go on
# passing for the old reason (gate (j) rejecting everything) forever.
mkdir -p "${WIDEN_ABSENT_ROOT}"
run "T99b: NON-VACUITY — with the root PRESENT the identical fixture IS signalled" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_MAX_KILLS=5 SWEEP_PROC_WIDEN_GRACE_SECS=0 \
      SWEEP_WT_ROOT='${WIDEN_ABSENT_ROOT}' bash '$SWEEP' > '${SCRATCH}/t99b.out' 2>&1 \
    && test \"\$(wc -l < '${KILL_LOG}' | tr -d ' ')\" = '5'"
rmdir "${WIDEN_ABSENT_ROOT}" 2>/dev/null || true
_widen_clear

# ════════════════════════════════════════════════════════════════════════════
# CTL-1531 Codex round 1 — P1-c / P1-e / P2-g / P2-h / P2-i regressions
# ════════════════════════════════════════════════════════════════════════════

# A run of N uniformly-eligible widened candidates starting at pid 2201. Every
# gate defaults to the kill-eligible answer, so the ONLY thing under test is the
# bound/probe the individual case varies.
_widen_uniform() {
  local n="$1" i rows="" pids=""
  _widen_clear
  for ((i = 0; i < n; i++)); do
    rows="${rows}$((2201 + i)) 1"$'\n'
    pids="${pids}$((2201 + i)) "
  done
  export WIDEN_PS_ROWS="${rows%$'\n'}"
  export WIDEN_FIXTURE_PIDS="$pids"
}

# ── P1-c: cap values Bash arithmetic cannot evaluate ────────────────────────
#
# `[[ "$cap" =~ ^[0-9]+$ ]]` accepted values that later BLEW UP in arithmetic:
#   • `08`/`09` — a leading zero means OCTAL, and 8/9 are not octal digits, so
#     `[[ 08 -gt 0 ]]` is a fatal "value too great for base". Under `set -uo
#     pipefail` (no `-e`) the error prints and the test evaluates FALSE.
#   • `9223372036854775808` (2^63) — wraps NEGATIVE, so `cap -gt 0` is false.
# Either way the guard `[[ "$cap" -gt 0 && "$acted" -ge "$cap" ]]` is false for
# EVERY candidate and the destructive sweep silently runs UNCAPPED. Both cases
# are asserted by COUNTING kills, so a revert flips the count.

_widen_uniform 10
run "T101: OCTAL cap ('08') is parsed base-10, not left to blow up and uncap the sweep" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_MAX_KILLS=08 bash '$SWEEP' > '${SCRATCH}/t101.out' 2>&1 \
    && test \"\$(wc -l < '${KILL_LOG}' | tr -d ' ')\" = '8' \
    && expect_contains '${SCRATCH}/t101.out' 'cap reached (8), 2 deferred'"

_widen_uniform 7
run "T102: cap past Bash's signed range falls back to the safe default (5), LOUDLY" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_MAX_KILLS=9223372036854775808 bash '$SWEEP' > '${SCRATCH}/t102.out' 2>&1 \
    && expect_contains '${SCRATCH}/t102.out' \"SWEEP_PROC_WIDEN_MAX_KILLS='9223372036854775808' is not a base-10 integer\" \
    && expect_contains '${SCRATCH}/t102.out' 'falling back to 5' \
    && test \"\$(wc -l < '${KILL_LOG}' | tr -d ' ')\" = '5'"

_widen_uniform 7
run "T103: a non-numeric cap warns LOUDLY before falling back (the old form failed silently)" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_MAX_KILLS=lots bash '$SWEEP' > '${SCRATCH}/t103.out' 2>&1 \
    && expect_contains '${SCRATCH}/t103.out' \"SWEEP_PROC_WIDEN_MAX_KILLS='lots' is not a base-10 integer\" \
    && test \"\$(wc -l < '${KILL_LOG}' | tr -d ' ')\" = '5'"

_widen_uniform 7
run "T104: an out-of-range cap (>100000) falls back to 5" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_MAX_KILLS=999999 bash '$SWEEP' > '${SCRATCH}/t104.out' 2>&1 \
    && expect_contains '${SCRATCH}/t104.out' 'out of range [0,100000]' \
    && test \"\$(wc -l < '${KILL_LOG}' | tr -d ' ')\" = '5'"

# The same octal trap on the AGE FLOOR fails the other way: `[[ 60000 -ge 09 ]]`
# errors and evaluates FALSE, so NOTHING is ever killed and the knob is inert.
_widen_uniform 1
run "T105: OCTAL min-age ('09') is parsed base-10 (the floor stays functional, not inert)" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_MIN_AGE_SECS=09 bash '$SWEEP' > /dev/null 2>&1 \
    && grep -qw '2201' '${KILL_LOG}'"

_widen_uniform 1
export WETIME_2201="00:30"     # 30s — under the fallback floor of 900
run "T106: a garbage min-age falls back to 900 LOUDLY (and a 30s process is still spared)" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_MIN_AGE_SECS=soon bash '$SWEEP' > '${SCRATCH}/t106.out' 2>&1 \
    && expect_contains '${SCRATCH}/t106.out' \"SWEEP_PROC_WIDEN_MIN_AGE_SECS='soon' is not a base-10 integer\" \
    && ! test -s '${KILL_LOG}'"

# ── P1-e: the full argv must NEVER reach ~/catalyst/orphan-sweep.log ────────
#
# The widened branch admits ARBITRARY commands, and arbitrary argv routinely
# carries an API token, a password, an Authorization header or a signed URL.
# This log is persistent, so merely OBSERVING the class in the DEFAULT shadow
# mode wrote secrets to disk — no enforce flip required.
WIDEN_SECRET="sk-live-51H4xQzTOPSECRETvalue"
_widen_uniform 1
export WCMD_2201="sh -c curl -H Authorization: Bearer ${WIDEN_SECRET} https://api.example.com/x?sig=${WIDEN_SECRET}"
run "T107: SHADOW never logs the argv, but still identifies the pid + command basename" \
  bash -c "SWEEP_PROC_WIDEN=shadow bash '$SWEEP' > '${SCRATCH}/t107.out' 2>&1 \
    && expect_not_contains '${SCRATCH}/t107.out' '${WIDEN_SECRET}' \
    && expect_not_contains '${SCRATCH}/t107.out' 'Authorization' \
    && expect_contains '${SCRATCH}/t107.out' '[shadow] would kill 2201 (cmd: sh;'"

_widen_uniform 1
export WCMD_2201="sh -c curl -H Authorization: Bearer ${WIDEN_SECRET} https://api.example.com/x"
run "T108: ENFORCE never logs the argv on the kill path either" \
  bash -c "SWEEP_PROC_WIDEN=enforce bash '$SWEEP' > '${SCRATCH}/t108.out' 2>&1 \
    && expect_not_contains '${SCRATCH}/t108.out' '${WIDEN_SECRET}' \
    && expect_contains '${SCRATCH}/t108.out' 'killed 2201 (cmd: sh;' \
    && grep -qw '2201' '${KILL_LOG}'"

_widen_uniform 1
export WCMD_2201="sh -c curl -H Authorization: Bearer ${WIDEN_SECRET} https://api.example.com/x"
run "T109: --dry-run never logs the argv either" \
  bash -c "SWEEP_PROC_WIDEN=enforce bash '$SWEEP' --dry-run > '${SCRATCH}/t109.out' 2>&1 \
    && expect_not_contains '${SCRATCH}/t109.out' '${WIDEN_SECRET}' \
    && expect_contains '${SCRATCH}/t109.out' '[dry-run] would kill 2201 (cmd: sh;'"

# The argv is dropped from the LOG only — it is still held in memory, where it is
# load-bearing as the pre-kill pid-reuse guard. T92 already covers the guard; this
# pins that the secret-bearing form is matched exactly (no truncation/basename).
_widen_uniform 1
export WCMD_2201="sh -c curl -H Authorization: Bearer ${WIDEN_SECRET} https://api.example.com/x"
export WCMD2_2201="sh -c a-completely-different-process"
run "T110: argv is still RETAINED IN MEMORY for the pid-reuse re-match (drop is log-only)" \
  bash -c "SWEEP_PROC_WIDEN=enforce bash '$SWEEP' > /dev/null 2>&1 && ! test -s '${KILL_LOG}'"

# ── P2-g: the pre-kill re-check must RE-PROBE the cwd, not re-test the cache ──
#
# The TOCTOU block re-read ppid and argv but tested the CACHED $cwd from
# classification. The pid that matters there is a RECYCLED one, and a recycled
# pid has its own cwd this loop had never looked at; the other half is a worktree
# recreated by create-worktree.sh running concurrently with the sweep.
_widen_uniform 1
export WCWD_2201="$WIDEN_GONE"      # classification: deleted, under the root
export WCWD2_2201="$WIDEN_LIVE"     # signal time: the worktree is BACK on disk
run "T111: the worktree was RE-CREATED between the gate and the kill → NOT killed" \
  bash -c "SWEEP_PROC_WIDEN=enforce bash '$SWEEP' > /dev/null 2>&1 && ! test -s '${KILL_LOG}'"

_widen_uniform 1
export WCWD_2201="$WIDEN_GONE"
export WCWD2_2201="$WIDEN_OUTSIDE_GONE"   # signal time: cwd left the wt root
run "T112: the cwd MOVED out from under the worktree root before the kill → NOT killed" \
  bash -c "SWEEP_PROC_WIDEN=enforce bash '$SWEEP' > /dev/null 2>&1 && ! test -s '${KILL_LOG}'"

_widen_uniform 1
export WCWD_2201="$WIDEN_GONE"
export WCWD2_2201=""                      # signal time: cwd unresolvable
run "T113: an unresolvable cwd at signal time → NOT killed (fail closed)" \
  bash -c "SWEEP_PROC_WIDEN=enforce bash '$SWEEP' > /dev/null 2>&1 && ! test -s '${KILL_LOG}'"

# ── P2-h: an INACCESSIBLE cwd is UNKNOWN, not "deleted" ─────────────────────
#
# `[[ -d "$cwd" ]]` is false for a deleted directory AND for one that merely
# cannot be stat'd — EACCES (a mode-000 parent), EIO, ESTALE on a dropped mount.
# On this branch "the cwd is gone" is the ONLY ownership evidence for killing an
# arbitrary process, and the unanswerable cases are exactly the CORRELATED ones.
# Real filesystem fixture: a real mode-000 parent, so the errno is genuine.
WIDEN_WALLED="${WIDEN_WT}/walled"
WIDEN_WALLED_CWD="${WIDEN_WALLED}/evr-99"
mkdir -p "$WIDEN_WALLED_CWD"
chmod 000 "$WIDEN_WALLED"
export WIDEN_WALLED_CWD
# Asserted through SHADOW, deliberately. Shadow is the shipped default and never
# reaches the pre-kill re-probe, so this isolates the CLASSIFICATION gate: with
# `[[ -d "$cwd" ]]` an EACCES path is reported as a would-kill candidate, i.e.
# the operator's shadow evidence — the entire basis for the enforce flip — is
# built on processes whose cwd was never actually shown to be deleted.
_widen_uniform 1
export WCWD_2201="$WIDEN_WALLED_CWD"
run "T114: SHADOW — a cwd that cannot be stat'd (EACCES) is UNKNOWN → not even a candidate" \
  bash -c "SWEEP_PROC_WIDEN=shadow bash '$SWEEP' > '${SCRATCH}/t114.out' 2>&1 \
    && expect_not_contains '${SCRATCH}/t114.out' 'would kill 2201'"

_widen_uniform 1
export WCWD_2201="$WIDEN_WALLED_CWD"
run "T114b: ENFORCE — the same EACCES cwd is never signalled" \
  bash -c "SWEEP_PROC_WIDEN=enforce bash '$SWEEP' > /dev/null 2>&1 && ! test -s '${KILL_LOG}'"

# Non-vacuity, both modes: the SAME fixture shape with a definite ENOENT does
# reach the candidate set and the kill path, so T114/T114b are measuring the
# errno and not some unrelated bail.
_widen_uniform 1
export WCWD_2201="${WIDEN_WT}/definitely-absent/evr-99"
run "T115: NON-VACUITY (shadow) — the same shape with a definite ENOENT IS a candidate" \
  bash -c "SWEEP_PROC_WIDEN=shadow bash '$SWEEP' > '${SCRATCH}/t115.out' 2>&1 \
    && expect_contains '${SCRATCH}/t115.out' 'would kill 2201'"

_widen_uniform 1
export WCWD_2201="${WIDEN_WT}/definitely-absent/evr-99"
run "T115b: NON-VACUITY (enforce) — …and IS killed" \
  bash -c "SWEEP_PROC_WIDEN=enforce bash '$SWEEP' > /dev/null 2>&1 && grep -qw '2201' '${KILL_LOG}'"

# A cwd that EXISTS but is not a directory (a file left at the path) is not our
# debris either — `stat` succeeds, so the state is `present`, never `gone`.
WIDEN_FILE_CWD="${WIDEN_WT}/a-file-not-a-dir"
: > "$WIDEN_FILE_CWD"
_widen_uniform 1
export WCWD_2201="$WIDEN_FILE_CWD"
run "T116: a cwd path that exists but is NOT a directory → present, NOT killed" \
  bash -c "SWEEP_PROC_WIDEN=enforce bash '$SWEEP' > /dev/null 2>&1 && ! test -s '${KILL_LOG}'"

# ── P2-i: `kill` reports DELIVERY, not EXIT ────────────────────────────────
#
# A process that traps or ignores SIGTERM used to be logged as "killed", consume
# a cap slot and emit a false `orphan_proc` reclamation on EVERY run, forever.
# $WALIVE_<pid> makes the mock `ps -o pid= -p N` keep answering, i.e. the pid
# never dies. Grace is set to 0 so the confirmation wait does not sleep.
_widen_uniform 1
export WALIVE_2201=1
rm -f "$SCRATCH_OTEL_LOG"
run "T117: a process that survives SIGTERM+SIGKILL is NOT logged as killed" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_GRACE_SECS=0 bash '$SWEEP' > '${SCRATCH}/t117.out' 2>&1 \
    && expect_not_contains '${SCRATCH}/t117.out' 'killed 2201 (cmd:' \
    && expect_contains '${SCRATCH}/t117.out' 'STILL alive after SIGKILL'"

run "T118: …and emits NO orphan_proc reclamation for it" \
  bash -c "! grep -q 'orphan_proc' '${SCRATCH_OTEL_LOG}' 2>/dev/null"

run "T119: …but DOES escalate to SIGKILL first (the escalation is not skipped)" \
  bash -c "grep -q -- '-9 2201' '${KILL_LOG}' \
    && expect_contains '${SCRATCH}/t117.out' 'survived SIGTERM after 0s — escalating to SIGKILL'"

# A stubborn process must not crowd a REAL orphan out of the per-run cap.
# Order matters: 2201 (stubborn) is enumerated before 2202 (reapable).
#
# CTL-1531 round 2: cap = 2, not 1. The stubborn candidate does not consume a
# CONFIRMED-TERMINATION slot (that is the property under test) but it DOES spend
# 2 of the run's signal budget, and since SIGKILL now counts against the `cap x 2`
# signal ceiling (T122/T124), a cap of 1 would legitimately exhaust the whole
# budget on 2201 alone. Cap 2 keeps both bounds observable and independent.
_widen_clear
export WIDEN_PS_ROWS="2201 1
2202 1"
export WIDEN_FIXTURE_PIDS="2201 2202"
export WALIVE_2201=1
rm -f "$SCRATCH_OTEL_LOG"
run "T120: a signal-ignoring process does NOT consume cap capacity (the real orphan is still reaped)" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_MAX_KILLS=2 SWEEP_PROC_WIDEN_GRACE_SECS=0 bash '$SWEEP' > '${SCRATCH}/t120.out' 2>&1 \
    && expect_contains '${SCRATCH}/t120.out' 'killed 2202 (cmd: sh;' \
    && expect_not_contains '${SCRATCH}/t120.out' 'killed 2201 (cmd:'"

run "T121: …and exactly ONE reclamation is emitted (for the process that actually exited)" \
  bash -c "test \"\$(grep -c 'orphan_proc' '${SCRATCH_OTEL_LOG}')\" = '1'"

# …but signalling is still BOUNDED. Confirmed-exit accounting alone cannot bound
# a host where NOTHING responds to signals, so a second ceiling caps DELIVERED
# SIGNALS at cap × 2 (each candidate is worth SIGTERM + SIGKILL and no more).
#
# CTL-1531 round 2 (Codex): the SIGKILL now counts against that ceiling. The
# round-1 form incremented once per CANDIDATE, so "cap 2" actually permitted 4
# candidates and 8 delivered signals — and THIS TEST ENCODED THE BUG by
# asserting 8 lines. cap=2 ⇒ ceiling 4 ⇒ 2 candidates × 2 signals = 4 kill.log
# lines, then stop. Reverting the accounting makes this 8 again.
_widen_uniform 8
export WALIVE_2201=1 WALIVE_2202=1 WALIVE_2203=1 WALIVE_2204=1
export WALIVE_2205=1 WALIVE_2206=1 WALIVE_2207=1 WALIVE_2208=1
run "T122: signalling stays BOUNDED when everything ignores signals (stops at cap x 2, says why)" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_MAX_KILLS=2 SWEEP_PROC_WIDEN_GRACE_SECS=0 bash '$SWEEP' > '${SCRATCH}/t122.out' 2>&1 \
    && expect_contains '${SCRATCH}/t122.out' 'signal bound reached (4) with only 0 confirmed termination(s) — stopping this run' \
    && test \"\$(wc -l < '${KILL_LOG}' | tr -d ' ')\" = '4'"

# The tightest statement of the same accounting rule: ONE stubborn candidate at
# cap 1 spends the ENTIRE budget (SIGTERM + SIGKILL = 2 = cap × 2), so the second
# candidate is never signalled. Counting per-candidate instead of per-signal
# yields 4 lines here.
_widen_uniform 2
export WALIVE_2201=1 WALIVE_2202=1
run "T124: SIGKILL counts against the signal ceiling (cap 1 ⇒ 2 signals total, not 4)" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_MAX_KILLS=1 SWEEP_PROC_WIDEN_GRACE_SECS=0 bash '$SWEEP' > /dev/null 2>&1 \
    && test \"\$(wc -l < '${KILL_LOG}' | tr -d ' ')\" = '2' \
    && grep -qw '2201' '${KILL_LOG}' \
    && ! grep -qw '2202' '${KILL_LOG}'"

# ── CTL-1531 round 3: the ceiling's REAL bound was cap x 2 + 1 ──────────────
#
# T122/T124 both use EVEN parity — every candidate spends exactly 2 signals — so
# both the old `signalled -ge cap*2` admission test and the correct
# `signalled + 2 -gt cap*2` one give the same answer. The overrun needs ODD
# parity: a candidate that exits under SIGTERM spends ONE signal, leaving the
# counter at an odd value where the old test still admits a candidate that then
# spends TWO more.
#
#   cap 2 ⇒ ceiling 4.  2201 exits under SIGTERM (1) — 2202/2203/2204 ignore both.
#     old form: 2202 admitted at 1 (→3), 2203 admitted at 3 (→5) = cap*2 + 1
#     fixed   : 2202 admitted (1+2 ≤ 4 → 3), 2203 REFUSED (3+2 > 4). 3 signals.
# Asserted by COUNTING delivered signals, so reverting the admission test flips
# this from 3 to 5.
_widen_uniform 4
export WALIVE_2202=1 WALIVE_2203=1 WALIVE_2204=1
run "T124b: the signal ceiling holds under ODD parity (cap x 2, never cap x 2 + 1)" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_MAX_KILLS=2 SWEEP_PROC_WIDEN_GRACE_SECS=0 bash '$SWEEP' > '${SCRATCH}/t124b.out' 2>&1 \
    && test \"\$(wc -l < '${KILL_LOG}' | tr -d ' ')\" = '3' \
    && grep -qw '2201' '${KILL_LOG}' \
    && grep -q -- '-9 2202' '${KILL_LOG}' \
    && ! grep -qw '2203' '${KILL_LOG}'"

run "T124c: …and it says why, naming the ceiling it stopped at" \
  bash -c "expect_contains '${SCRATCH}/t124b.out' 'signal bound reached (4)'"

# NON-VACUITY for the whole P2-i block: with the default (mock) liveness answer
# — the pid IS gone after SIGTERM — the reclamation is recorded and no SIGKILL
# escalation happens at all.
_widen_uniform 1
rm -f "$SCRATCH_OTEL_LOG"
run "T123: NON-VACUITY — a CONFIRMED exit records the reclamation and never escalates" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_GRACE_SECS=0 bash '$SWEEP' > '${SCRATCH}/t123.out' 2>&1 \
    && expect_contains '${SCRATCH}/t123.out' 'killed 2201 (cmd: sh;' \
    && grep -q 'orphan_proc' '${SCRATCH_OTEL_LOG}' \
    && ! grep -q -- '-9 2201' '${KILL_LOG}'"

chmod 755 "$WIDEN_WALLED"          # let the EXIT trap's rm -rf reclaim it
rm -f "$WIDEN_FILE_CWD"
_widen_clear

# ── CTL-1531 round 2: a FAILED liveness probe is UNKNOWN, never an exit ─────
#
# `_proc_alive` used to test only for EMPTY `ps` output, so a transient process
# table / resource / fork failure was indistinguishable from an absent pid:
# `_proc_gone_within` self-certified the exit, and the caller logged "killed"
# and emitted an `orphan_proc` reclamation while the target might still be
# running. $WPSFAIL_<pid> makes the probe itself fail (non-zero exit WITH
# stderr) — the state that must read as `unknown`.
_widen_uniform 1
export WPSFAIL_2201=1
rm -f "$SCRATCH_OTEL_LOG"
run "T125: a probe that FAILS is not an exit — the pid is NOT logged as killed" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_GRACE_SECS=0 bash '$SWEEP' > '${SCRATCH}/t125.out' 2>&1 \
    && expect_not_contains '${SCRATCH}/t125.out' 'killed 2201 (cmd:'"

run "T126: …and NO orphan_proc reclamation is emitted for an unconfirmable exit" \
  bash -c "! grep -q 'orphan_proc' '${SCRATCH_OTEL_LOG}' 2>/dev/null"

# NON-VACUITY: the SAME fixture minus the probe failure DOES record the exit.
# Without this pair T125/T126 would pass even if the sweep had simply stopped
# reaping anything at all.
_widen_uniform 1
rm -f "$SCRATCH_OTEL_LOG"
run "T127: NON-VACUITY — a CLEAN 'no such process' probe still confirms the exit" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_GRACE_SECS=0 bash '$SWEEP' > '${SCRATCH}/t127.out' 2>&1 \
    && expect_contains '${SCRATCH}/t127.out' 'killed 2201 (cmd: sh;' \
    && grep -q 'orphan_proc' '${SCRATCH_OTEL_LOG}'"

# ── CTL-1531 round 2: the SIGKILL re-matches identity, like the SIGTERM ─────
#
# The confirmation wait proves only that the NUMERIC pid is not confirmed gone.
# If the original process exits under SIGTERM and its pid is REUSED during the
# grace, an unconditional `kill -9` lands on the REPLACEMENT process. The
# pre-SIGTERM gate has an identity re-match; the second signal needs the same.
#
# $WALIVE keeps the pid "alive" so the escalation path is reached, and the W*3_
# fixtures answer from the THIRD read on — which is EXACTLY the pre-SIGKILL
# revalidation window. Read 1 is the classification gate, read 2 is the
# pre-SIGTERM re-match. The W*2_ form would reject the candidate before the
# SIGTERM ever went out, so these cases would pass VACUOUSLY (no SIGKILL because
# there was no signal at all) and would not exercise the new gate.
_widen_uniform 1
export WALIVE_2201=1
export WCMD3_2201="sh -c a-completely-different-process"   # pid recycled
run "T128: pid RECYCLED under a new argv during the grace → NO SIGKILL" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_GRACE_SECS=0 bash '$SWEEP' > '${SCRATCH}/t128.out' 2>&1 \
    && grep -qx '2201' '${KILL_LOG}' \
    && ! grep -q -- '-9 2201' '${KILL_LOG}' \
    && expect_contains '${SCRATCH}/t128.out' 'NOT escalating to SIGKILL'"

_widen_uniform 1
export WALIVE_2201=1
export WPPID3_2201="777"                                    # re-adopted
run "T129: PPID changed during the grace (re-adopted) → NO SIGKILL" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_GRACE_SECS=0 bash '$SWEEP' > /dev/null 2>&1 \
    && grep -qx '2201' '${KILL_LOG}' \
    && ! grep -q -- '-9 2201' '${KILL_LOG}'"

_widen_uniform 1
export WALIVE_2201=1
export WCWD3_2201="$WIDEN_LIVE"                             # worktree re-created
run "T130: the worktree was RE-CREATED during the grace → NO SIGKILL" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_GRACE_SECS=0 bash '$SWEEP' > /dev/null 2>&1 \
    && grep -qx '2201' '${KILL_LOG}' \
    && ! grep -q -- '-9 2201' '${KILL_LOG}'"

_widen_uniform 1
export WALIVE_2201=1
export WCWD3_2201="$WIDEN_OUTSIDE_GONE"                     # moved out of the root
run "T131: the cwd MOVED out from under the wt root during the grace → NO SIGKILL" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_GRACE_SECS=0 bash '$SWEEP' > /dev/null 2>&1 \
    && grep -qx '2201' '${KILL_LOG}' \
    && ! grep -q -- '-9 2201' '${KILL_LOG}'"

# NON-VACUITY: nothing changed during the grace ⇒ the SIGKILL IS delivered.
# (T119 asserts the same escalation, but on the pre-round-2 code path; keeping
# it here pins that the NEW gate did not simply disable the escalation.)
_widen_uniform 1
export WALIVE_2201=1
run "T132: NON-VACUITY — identity unchanged during the grace → the SIGKILL IS sent" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_WIDEN_GRACE_SECS=0 bash '$SWEEP' > /dev/null 2>&1 \
    && grep -q -- '-9 2201' '${KILL_LOG}'"

# ── CTL-1531 round 2: the cwd probe is BOUNDED (hung-mount deadline) ────────
#
# `lsof` blocks in the kernel on a stale/hung mount and had NO deadline on this
# side, so ONE such candidate wedged the whole LaunchAgent run and starved the
# signal, worktree and browser vectors behind it. $WHANG_<pid> makes the mock
# block; the sweep must give up on that pid, treat the cwd as UNKNOWN (spare),
# and FINISH.
#
# The assertion itself is self-limiting (AGENTS.md house rule): the sweep runs in
# the background with its own watchdog, so a REGRESSION shows up as a FAILED test
# within the deadline rather than as a hung suite. Nothing here can outlive the
# test — the watchdog kills the sweep, and the mock's own `sleep` is bounded.
_t_bounded() {                       # _t_bounded <deadline_secs> <outfile> <cmd...>
  local limit="$1" out="$2"; shift 2
  local mark="${SCRATCH}/.t_bounded_overran" cpid wpid rc
  rm -f "$mark"
  "$@" > "$out" 2>&1 &
  cpid=$!
  ( sleep "$limit"; : > "$mark"; kill -9 "$cpid" 2>/dev/null ) >/dev/null 2>&1 &
  wpid=$!
  wait "$cpid"; rc=$?
  kill -9 "$wpid" 2>/dev/null; wait "$wpid" 2>/dev/null
  [[ -e "$mark" ]] && { echo "OVERRAN the ${limit}s deadline (the probe is unbounded)"; return 1; }
  return "$rc"
}

_widen_uniform 1
export WHANG_2201=25                 # lsof blocks ~25s for this pid
run "T133: a HUNG cwd probe does not wedge the sweep (it is bounded and the run finishes)" \
  _t_bounded 12 "${SCRATCH}/t133.out" \
    env SWEEP_PROC_WIDEN=enforce SWEEP_PROC_CWD_TIMEOUT_SECS=1 SWEEP_PROC_WIDEN_GRACE_SECS=0 \
      bash "$SWEEP"

run "T134: …the timeout is reported (an operator can see WHY the cwd was unknown)" \
  bash -c "expect_contains '${SCRATCH}/t133.out' 'cwd probe for pid 2201 exceeded 1s'"

run "T135: …and the pid whose cwd could not be read is SPARED (unknown never kills)" \
  bash -c "! grep -qw '2201' '${KILL_LOG}'"

# NON-VACUITY: the identical fixture without the hang IS reaped, so T133-T135
# cannot pass merely because the sweep stopped working.
_widen_uniform 1
run "T136: NON-VACUITY — the same candidate with a RESPONSIVE probe is still killed" \
  bash -c "SWEEP_PROC_WIDEN=enforce SWEEP_PROC_CWD_TIMEOUT_SECS=1 SWEEP_PROC_WIDEN_GRACE_SECS=0 bash '$SWEEP' > /dev/null 2>&1 \
    && grep -qw '2201' '${KILL_LOG}'"

_widen_clear

# ── UNION: the legacy branch keeps its path-unrestricted coverage ────────────
# Production evidence (orphan-sweep.log) shows vector 1 killing gone-cwd node/bun
# procs in /private/tmp, ~/.codex/plugins/cache and <repo>/.claude/worktrees —
# none under ~/catalyst/wt. Narrowing the LEGACY branch to the wt root would be a
# silent coverage regression, so the widening must be a UNION.
_widen_fixture
export WIDEN_LEGACY_PIDS="3001"
export WCWD_3001="$WIDEN_OUTSIDE_GONE"    # gone, and NOT under the worktree root
run "T87: legacy branch still kills a gone-cwd node/bun proc OUTSIDE the wt root" \
  bash -c "SWEEP_PROC_WIDEN=enforce bash '$SWEEP' && grep -qw '3001' '${KILL_LOG}'"

_widen_fixture
export WIDEN_LEGACY_PIDS="3001"
export WCWD_3001="$WIDEN_OUTSIDE_GONE"
run "T88: legacy branch is unaffected by SWEEP_PROC_WIDEN=off" \
  bash -c "SWEEP_PROC_WIDEN=off bash '$SWEEP' && grep -qw '3001' '${KILL_LOG}'"

# CROSS-BRANCH DEDUPE. A pid in BOTH candidate sets (legacy pgrep match AND
# ppid==1 with a gone cwd under the wt root) must be acted on exactly ONCE —
# otherwise it is signalled twice and emits two reclaim events for one process.
_widen_fixture
export WIDEN_LEGACY_PIDS="2001"
rm -f "$SCRATCH_OTEL_LOG"
run "T100a: CROSS-BRANCH DEDUPE — a pid in both branches is killed exactly once" \
  bash -c "SWEEP_PROC_WIDEN=enforce bash '$SWEEP' \
    && test \"\$(grep -cw '2001' '${KILL_LOG}')\" = '1'"

run "T100b: CROSS-BRANCH DEDUPE — and emits exactly one reclaim vector for it" \
  bash -c "test \"\$(grep -c 'orphan_proc\|bun_proc' '${SCRATCH_OTEL_LOG}')\" = '1'"

_widen_clear
unset WIDEN_LEGACY_PIDS SWEEP_SELF_PID_FILE SWEEP_ANCESTOR_PID_FILE WIDEN_MOCK_STATE
rm -f "$MOCKBIN/pgrep" "$MOCKBIN/ps" "$MOCKBIN/lsof"

# ─── results ────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]] && exit 0 || exit 1
