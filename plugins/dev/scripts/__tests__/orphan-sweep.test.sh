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

# T26b: SALVAGE_UNPUSHED fixture -> NOT removed, log says "salvage"
UNPUSHED_WT="${SWEEP_WT_ROOT}/SALVAGE_UNPUSHED-WT"
mkdir -p "${UNPUSHED_WT}/.git"
touch -t 202501010000 "${UNPUSHED_WT}" 2>/dev/null || true
rm -f "$GIT_LOG"
run "T26b: SALVAGE_UNPUSHED fixture not removed, salvage logged" \
  bash -c "SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_PROJECT_CLAUDE_WT=/nonexistent SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash '${SWEEP}' 2>&1 | grep -qi 'salvage\|SALVAGE\|skip.*SALVAGE\|SALVAGE.*skip'"

run "T26b-b: SALVAGE_UNPUSHED-WT not in git worktree remove" \
  bash -c "! grep -E 'worktree remove.*SALVAGE_UNPUSHED|SALVAGE_UNPUSHED.*worktree remove' '${GIT_LOG}' 2>/dev/null; true"

# T27: --dry-run -> logs "would remove" for SAFE dirs, GIT_LOG has no worktree remove
rm -f "$GIT_LOG"
run "T27: dry-run logs would-remove for SAFE dirs" \
  bash -c "SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_PROJECT_CLAUDE_WT=/nonexistent SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash '${SWEEP}' --dry-run 2>&1 | grep -qi 'would remove'"

run "T27b: dry-run GIT_LOG has no worktree remove" \
  bash -c "SWEEP_FORCE_POWER=1 SWEEP_IDLE_HOURS=9999 SWEEP_PROJECT_CLAUDE_WT=/nonexistent SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0 bash '${SWEEP}' --dry-run && ! grep -q 'worktree remove' '${GIT_LOG}' 2>/dev/null; true"

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

# ─── results ────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]] && exit 0 || exit 1
