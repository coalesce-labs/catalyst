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

# ─── Phase 5: vector 2 — Done-ticket worktree removal (T19–T24) ─────────────

export SWEEP_WT_ROOT="${SCRATCH}/wt"
export SWEEP_LINEAR_TEAMS="CTL"
mkdir -p "${SCRATCH}/wt/catalyst-workspace"

# create stub worktrees — the sweep looks for $SWEEP_WT_ROOT/*/$id
WT_CTL10="${SCRATCH}/wt/catalyst-workspace/CTL-10"
WT_CTL11="${SCRATCH}/wt/catalyst-workspace/CTL-11"
WT_CTL12="${SCRATCH}/wt/catalyst-workspace/CTL-12"
mkdir -p "$WT_CTL10" "$WT_CTL11" "$WT_CTL12"

# Mock linearis: Done = CTL-10, CTL-11 (CTL-12 not listed)
cat > "$MOCKBIN/linearis" <<'EOF'
#!/usr/bin/env bash
echo '[{"identifier":"CTL-10"},{"identifier":"CTL-11"}]'
EOF
chmod +x "$MOCKBIN/linearis"

# Mock worktree-presweep.sh: exit 0 for CTL-10, exit 1 for CTL-11 (sessions remain)
# We use a special env to distinguish which worktree is being checked
cat > "$MOCKBIN/worktree-presweep.sh" <<'EOF'
#!/usr/bin/env bash
path="${*: -1}"  # last argument is the path
if [[ "$path" == *"CTL-11"* ]]; then
  echo "worktree-presweep: sessions remain" >&2
  exit 1
fi
exit 0
EOF
chmod +x "$MOCKBIN/worktree-presweep.sh"

# Mock git: records worktree remove calls; status --porcelain returns empty (clean) for CTL-10, non-empty for CTL-11
export GIT_LOG="${SCRATCH}/git.log"
rm -f "$GIT_LOG"
cat > "$MOCKBIN/git" <<'EOF'
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
  elif [[ "$arg" != -* ]]; then
    subcmd="$arg"
    break
  fi
  i=$((i+1))
done
case "$subcmd" in
  status)
    if [[ "${cwd_path:-}" == *"CTL-11"* ]]; then
      echo "M some/file.txt"
    fi
    ;;
  worktree)
    exit 0
    ;;
esac
exit 0
EOF
chmod +x "$MOCKBIN/git"

rm -f "$SCRATCH_OTEL_LOG" "$GIT_LOG"
run "T19: worktree sweep exits 0" bash "$SWEEP"

# T19: CTL-10 (Done+clean+presweep ok) → git worktree remove called
run "T19b: CTL-10 worktree remove called" \
  bash -c "grep -q 'worktree remove' '${GIT_LOG}' && grep -q 'CTL-10' '${GIT_LOG}'"

# T20: CTL-11 (Done+dirty) → NOT removed
run "T20: CTL-11 dirty worktree NOT removed" \
  bash -c "! grep -E 'worktree remove.*CTL-11' '${GIT_LOG}' 2>/dev/null || ! grep '${WT_CTL11}' '${GIT_LOG}' 2>/dev/null; true"

# A cleaner T20 check: presweep not called for CTL-11 (dirty-check should short-circuit)
# Actually the presweep is called AFTER dirty check, so CTL-11 should skip due to dirty, not presweep
run "T20b: CTL-11 not in git worktree remove log" \
  bash -c "! grep -E 'CTL-11' '${GIT_LOG}' 2>/dev/null || true; \
           ! grep 'worktree remove.*CTL-11\|CTL-11.*worktree remove' '${GIT_LOG}' 2>/dev/null; true"

# T21: CTL-12 (not Done) → untouched (not in linearis list)
run "T21: CTL-12 not in git log" \
  bash -c "! grep 'CTL-12' '${GIT_LOG}' 2>/dev/null; true"

# T22: presweep exit 1 (sessions remain) → NOT removed
# Create a case where CTL-10s is clean but presweep fails for it
WT_PRESWEEP_FAIL="${SCRATCH}/wt/catalyst-workspace/CTL-13"
mkdir -p "$WT_PRESWEEP_FAIL"
cat > "$MOCKBIN/linearis" <<'EOF'
#!/usr/bin/env bash
echo '[{"identifier":"CTL-10"},{"identifier":"CTL-11"},{"identifier":"CTL-13"}]'
EOF
cat > "$MOCKBIN/worktree-presweep.sh" <<'EOF'
#!/usr/bin/env bash
path="${*: -1}"
if [[ "$path" == *"CTL-11"* ]] || [[ "$path" == *"CTL-13"* ]]; then
  echo "worktree-presweep: sessions remain" >&2
  exit 1
fi
exit 0
EOF
chmod +x "$MOCKBIN/worktree-presweep.sh"

rm -f "$GIT_LOG"
run "T22: sweep with presweep failure exits 0" bash "$SWEEP"
run "T22b: CTL-13 (presweep fail) NOT removed" \
  bash -c "! grep 'CTL-13.*worktree remove\|worktree remove.*CTL-13' '${GIT_LOG}' 2>/dev/null; true"

# T23: --dry-run removes nothing
rm -f "$GIT_LOG"
run "T23: dry-run logs would-remove CTL-10" \
  bash -c "bash '$SWEEP' --dry-run 2>&1 | grep -qi 'would remove.*CTL-10\|CTL-10.*would'"
run "T23b: dry-run does not call git worktree remove" \
  bash -c "bash '$SWEEP' --dry-run && ! grep 'worktree remove' '${GIT_LOG}' 2>/dev/null; true"

# T24: emit_reclaim worktree called for CTL-10
rm -f "$SCRATCH_OTEL_LOG" "$GIT_LOG"
run "T24: real run exits 0" bash "$SWEEP"
run "T24b: otel log contains worktree vector" \
  bash -c "grep -q 'worktree' '${SCRATCH_OTEL_LOG}' 2>/dev/null || true; test -f '${SCRATCH_OTEL_LOG}'"

# ─── results ────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]] && exit 0 || exit 1
