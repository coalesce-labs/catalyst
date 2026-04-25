#!/usr/bin/env bash
# Shell tests for catalyst-state.sh
#
# Covers the new runs-dir helpers added for CTL-59:
# - `run-dir <orch-id>` prints the resolved path to ~/catalyst/runs/<id>/
# - `ensure-run-dir <orch-id>` creates runs/<id>/workers/output/ layout
# - RUNS_DIR honors CATALYST_DIR env override (for tests)
# - `ensure-run-dir` is idempotent

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
STATE_SCRIPT="${REPO_ROOT}/plugins/dev/scripts/catalyst-state.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t catalyst-state-test-XXXXXX)"
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

assert_dir_exists() {
  local path="$1" label="$2"
  if [[ -d "$path" ]]; then
    pass "$label"
  else
    fail "$label — directory not found: $path"
  fi
}

if [[ ! -x "$STATE_SCRIPT" ]]; then
  echo "FATAL: catalyst-state.sh not found or not executable at $STATE_SCRIPT" >&2
  exit 1
fi

# ─── Test 1: run-dir prints correct path ────────────────────────────────────
echo ""
echo "--- Test 1: run-dir prints resolved path ---"
export CATALYST_DIR="$SCRATCH/cat1"
RUN_DIR=$("$STATE_SCRIPT" run-dir orch-2026-04-16)
assert_eq "$SCRATCH/cat1/runs/orch-2026-04-16" "$RUN_DIR" "run-dir output matches \$CATALYST_DIR/runs/<id>"

# ─── Test 2: ensure-run-dir creates full layout ─────────────────────────────
echo ""
echo "--- Test 2: ensure-run-dir creates workers/output/ layout ---"
export CATALYST_DIR="$SCRATCH/cat2"
"$STATE_SCRIPT" ensure-run-dir orch-test-42 >/dev/null
assert_dir_exists "$SCRATCH/cat2/runs/orch-test-42" "run dir exists"
assert_dir_exists "$SCRATCH/cat2/runs/orch-test-42/workers" "workers/ exists"
assert_dir_exists "$SCRATCH/cat2/runs/orch-test-42/workers/output" "workers/output/ exists"

# ─── Test 3: ensure-run-dir is idempotent ───────────────────────────────────
echo ""
echo "--- Test 3: ensure-run-dir runs twice without error ---"
export CATALYST_DIR="$SCRATCH/cat3"
"$STATE_SCRIPT" ensure-run-dir orch-idempotent >/dev/null
touch "$SCRATCH/cat3/runs/orch-idempotent/workers/CTL-1.json"
"$STATE_SCRIPT" ensure-run-dir orch-idempotent >/dev/null
if [[ -f "$SCRATCH/cat3/runs/orch-idempotent/workers/CTL-1.json" ]]; then
  pass "second ensure-run-dir preserved existing signal file"
else
  fail "second ensure-run-dir wiped existing signal file"
fi

# ─── Test 4: ensure-run-dir rejects missing arg ─────────────────────────────
echo ""
echo "--- Test 4: ensure-run-dir requires orch-id ---"
export CATALYST_DIR="$SCRATCH/cat4"
set +e
"$STATE_SCRIPT" ensure-run-dir 2>/dev/null
RC=$?
set -e
if [[ "$RC" != "0" ]]; then
  pass "ensure-run-dir without arg exits non-zero"
else
  fail "ensure-run-dir without arg should have failed"
fi

# ─── Test 5: run-dir rejects missing arg ────────────────────────────────────
echo ""
echo "--- Test 5: run-dir requires orch-id ---"
set +e
"$STATE_SCRIPT" run-dir 2>/dev/null
RC=$?
set -e
if [[ "$RC" != "0" ]]; then
  pass "run-dir without arg exits non-zero"
else
  fail "run-dir without arg should have failed"
fi

# ─── Test 6: init creates runs/ alongside events/ and history/ ──────────────
echo ""
echo "--- Test 6: init creates the top-level runs/ directory ---"
export CATALYST_DIR="$SCRATCH/cat6"
"$STATE_SCRIPT" init >/dev/null
assert_dir_exists "$SCRATCH/cat6/runs" "runs/ created by init"
assert_dir_exists "$SCRATCH/cat6/events" "events/ created by init"
assert_dir_exists "$SCRATCH/cat6/history" "history/ created by init"

# ─── Test 7: gc emits claude_code.session.outcome for abandoned orch (CTL-157) ──
echo ""
echo "--- Test 7: gc emits session.outcome with outcome=abandoned ---"
export CATALYST_DIR="$SCRATCH/cat7"
"$STATE_SCRIPT" init >/dev/null

CAP="$SCRATCH/cat7/emit.args"
STUB="$SCRATCH/cat7/emit-stub.sh"
cat > "$STUB" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$@" >> "$CAP"
exit 0
STUB
chmod +x "$STUB"

STALE_TS=$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -d "30 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
"$STATE_SCRIPT" register "orch-stale-test" "$(jq -nc \
  --arg ts "$STALE_TS" \
  '{id:"orch-stale-test",projectKey:"k",repository:"r",baseBranch:"main",
    status:"active",startedAt:$ts,lastHeartbeat:$ts,
    worktreeDir:"/tmp",stateFile:"/tmp/x.json",progress:{},usage:{},
    workers:{},attention:[]}')" >/dev/null
# cmd_register force-overwrites lastHeartbeat to now — rewrite it to the stale
# value directly so gc's filter picks this orch up.
TMP_STATE="$SCRATCH/cat7/state.json"
jq --arg ts "$STALE_TS" '.orchestrators["orch-stale-test"].lastHeartbeat = $ts' \
  "$TMP_STATE" > "$TMP_STATE.tmp" && mv "$TMP_STATE.tmp" "$TMP_STATE"

CATALYST_EMIT_OTEL_BIN="$STUB" "$STATE_SCRIPT" gc --stale-after 10 >/dev/null 2>&1

[[ -f "$CAP" ]] && pass "emitter invoked during gc" || fail "emitter not invoked for stale orch"
ARGS=$(cat "$CAP" 2>/dev/null || echo "")
if echo "$ARGS" | grep -qx "abandoned"; then
  pass "outcome=abandoned forwarded"
else
  fail "outcome=abandoned not forwarded: $ARGS"
fi
if echo "$ARGS" | grep -qx "orch-stale-test"; then
  pass "orch id forwarded as session-id"
else
  fail "orch id not forwarded: $ARGS"
fi
if echo "$ARGS" | grep -q "heartbeat expired"; then
  pass "reason forwarded"
else
  fail "reason not forwarded: $ARGS"
fi

# ─── Test 8: gc still emits orchestrator-failed event (regression) ──────────
echo ""
echo "--- Test 8: existing orchestrator-failed event still emitted ---"
EVENT_FILE=$(ls "$SCRATCH/cat7/events"/*.jsonl 2>/dev/null | head -1)
if [[ -n "$EVENT_FILE" ]] && grep -q "orchestrator-failed" "$EVENT_FILE"; then
  pass "orchestrator-failed event still written to JSONL"
else
  fail "orchestrator-failed event missing from JSONL"
fi

# ─── Test 9: gc silent no-op when emitter binary missing ────────────────────
echo ""
echo "--- Test 9: gc still succeeds when emitter binary missing ---"
export CATALYST_DIR="$SCRATCH/cat9"
"$STATE_SCRIPT" init >/dev/null
STALE_TS=$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -d "30 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
"$STATE_SCRIPT" register "orch-stale-2" "$(jq -nc \
  --arg ts "$STALE_TS" \
  '{id:"orch-stale-2",projectKey:"k",repository:"r",baseBranch:"main",
    status:"active",startedAt:$ts,lastHeartbeat:$ts,
    worktreeDir:"/tmp",stateFile:"/tmp/x.json",progress:{},usage:{},
    workers:{},attention:[]}')" >/dev/null
TMP_STATE9="$SCRATCH/cat9/state.json"
jq --arg ts "$STALE_TS" '.orchestrators["orch-stale-2"].lastHeartbeat = $ts' \
  "$TMP_STATE9" > "$TMP_STATE9.tmp" && mv "$TMP_STATE9.tmp" "$TMP_STATE9"

set +e
CATALYST_EMIT_OTEL_BIN="/nonexistent/path" "$STATE_SCRIPT" gc --stale-after 10 >/dev/null 2>&1
GC_RC=$?
set -e
assert_eq "0" "$GC_RC" "gc exits 0 even when emitter missing"
HIST_ENTRIES=$(ls "$SCRATCH/cat9/history/"*.json 2>/dev/null | wc -l | tr -d ' ')
if [[ "$HIST_ENTRIES" -ge 1 ]]; then
  pass "orchestrator archived despite emitter missing"
else
  fail "orchestrator not archived: $HIST_ENTRIES entries in history"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════"
echo " $PASSES passed, $FAILURES failed"
echo "══════════════════════════════════════════════"

if [[ "$FAILURES" -gt 0 ]]; then
  exit 1
fi
