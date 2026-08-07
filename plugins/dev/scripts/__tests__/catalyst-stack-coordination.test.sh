#!/usr/bin/env bash
# CTL-1494: focused tests for catalyst-stack's coordination-publish lifecycle
# primitives — the off-inert no-op path and the bun-missing fail-closed path.
#
#   - node-class gating (worker/monitor start it, developer doesn't) is covered by
#     catalyst-stack-start-node-class.test.sh
#   - the status-line inventory is covered by catalyst-stack.test.sh
#   - LIVE shadow/enforce launch (the mirror is actually written) is a MANUAL step:
#     it needs a real bun runtime and a coordination-stamped event on the log, which
#     a hermetic shell test can't provide. Out of scope here (plan Testing Strategy).
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-stack-coordination.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
STACK="${REPO_ROOT}/plugins/dev/scripts/catalyst-stack"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
# Cleanup also reaps any straggler fake-publisher process (self-bounded to 60s as a
# backstop, but kill it eagerly so the suite never leaks a background process —
# AGENTS.md "make the LOOP ITSELF self-limiting; never let cleanup be load-bearing").
trap 'pkill -f "${SCRATCH}/coordination-publish" 2>/dev/null || true; rm -rf "$SCRATCH"' EXIT

# A fake "live publisher": a bash script whose PATH contains the token
# "coordination-publish" (so the coordination_pid command-grep guard + the
# COORDINATION_SCRIPT-override pgrep fallback both recognize it) and which
# self-bounds to 60s so a broken kill path can never strand it. IGNORE_TERM=1
# makes it ignore SIGTERM, to exercise the SIGKILL-after-grace fallback.
FAKE_PUB="${SCRATCH}/coordination-publish/index.ts"
mkdir -p "$(dirname "$FAKE_PUB")"
cat > "$FAKE_PUB" <<'PROC'
#!/usr/bin/env bash
[[ "${IGNORE_TERM:-0}" == "1" ]] && trap '' TERM
end=$((SECONDS + 60)); while [ "$SECONDS" -lt "$end" ]; do sleep 1; done
PROC
chmod +x "$FAKE_PUB"

pass()  { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
failx() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [[ -n "${2:-}" ]] && sed 's/^/      /' <<<"$2"; }

echo ""
echo "=== catalyst-stack coordination-publish lifecycle (CTL-1494) ==="
echo ""

# --- off-skip: a fake bun that resolves mode=off ⇒ clean no-op, no PID file, rc 0 ---
STUB_OFF="${SCRATCH}/stub-off"
mkdir -p "$STUB_OFF"
cat > "${STUB_OFF}/bun" <<'BUN'
#!/usr/bin/env bash
# Fake bun: the coordination_mode probe expects the resolved mode on stdout.
printf 'off'
BUN
chmod +x "${STUB_OFF}/bun"

CATALYST_DIR_OFF="${SCRATCH}/catalyst-off"
mkdir -p "$CATALYST_DIR_OFF"
OUT_OFF="$(PATH="${STUB_OFF}:${PATH}" CATALYST_DIR="$CATALYST_DIR_OFF" \
  bash --noprofile --norc -c '
    source "'"${STACK}"'" 2>/dev/null || true
    start_coordination
    echo "RC=$?"
  ' 2>&1)"

if grep -q 'RC=0' <<<"$OUT_OFF"; then pass "off-skip: start_coordination returns 0"; else failx "off-skip: start_coordination returns 0" "$OUT_OFF"; fi
if grep -qi 'inert' <<<"$OUT_OFF"; then pass "off-skip: prints an inert/skip breadcrumb"; else failx "off-skip: prints an inert/skip breadcrumb" "$OUT_OFF"; fi
if [[ ! -f "${CATALYST_DIR_OFF}/coordination-publish.pid" ]]; then pass "off-skip: writes NO PID file"; else failx "off-skip: writes NO PID file"; fi

# --- bun-missing: coordination_mode fails closed to off ⇒ clean skip, rc 0, no PID file ---
# Even with CATALYST_COORDINATION_MODE=shadow forced, a bun-less host cannot run the
# bun daemon, so coordination_mode returns off and start_coordination is a clean skip.
# This is the intended fail-closed collapse (plan Note under Tests First test 3).
MINIMAL_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
CATALYST_DIR_NOBUN="${SCRATCH}/catalyst-nobun"
mkdir -p "$CATALYST_DIR_NOBUN"
OUT_NOBUN="$(PATH="$MINIMAL_PATH" CATALYST_DIR="$CATALYST_DIR_NOBUN" CATALYST_COORDINATION_MODE=shadow \
  bash --noprofile --norc -c '
    source "'"${STACK}"'" 2>/dev/null || true
    start_coordination
    echo "RC=$?"
  ' 2>&1)"

if grep -q 'RC=0' <<<"$OUT_NOBUN"; then pass "bun-missing: non-fatal (clean skip, returns 0 via off-fallback)"; else failx "bun-missing: non-fatal (clean skip, returns 0 via off-fallback)" "$OUT_NOBUN"; fi
if [[ ! -f "${CATALYST_DIR_NOBUN}/coordination-publish.pid" ]]; then pass "bun-missing: writes NO PID file"; else failx "bun-missing: writes NO PID file"; fi

# --- reconcile-on-off: mode=off while a publisher is live ⇒ stop it, no PID file ---
# Codex P1: the daemon reads config only at startup, so a prior shadow/enforce process
# must be STOPPED when the resolved mode flips to off — not left mirroring/egressing.
CDIR_R="${SCRATCH}/catalyst-reconcile"; mkdir -p "$CDIR_R"
OUT_R="$(PATH="${STUB_OFF}:${PATH}" CATALYST_DIR="$CDIR_R" COORD_FAKE="$FAKE_PUB" \
  bash --noprofile --norc -c '
    source "'"${STACK}"'" 2>/dev/null || true
    COORDINATION_SCRIPT="$COORD_FAKE"
    bash "$COORDINATION_SCRIPT" & echo $! > "$COORDINATION_PID"
    sleep 1
    livepid="$(cat "$COORDINATION_PID")"
    start_coordination; echo "RC=$?"
    sleep 1
    # Fail CLOSED (AGENTS.md): PROC_DEAD only on a POSITIVE confirmation the pid is
    # gone — an empty/uncapturable pid must NOT read as "dead" (that would let a
    # shutdown regression pass silently).
    if [[ -z "$livepid" ]]; then echo "NO_PID"; elif ps -p "$livepid" >/dev/null 2>&1; then echo "PROC_ALIVE"; kill -9 "$livepid" 2>/dev/null; else echo "PROC_DEAD"; fi
    [[ -f "$COORDINATION_PID" ]] && echo "PIDFILE_PRESENT" || echo "PIDFILE_GONE"
  ' 2>&1)"
if grep -q 'RC=0' <<<"$OUT_R"; then pass "reconcile-off: returns 0"; else failx "reconcile-off: returns 0" "$OUT_R"; fi
if grep -qi 'stale config' <<<"$OUT_R"; then pass "reconcile-off: logs the stale-config stop"; else failx "reconcile-off: logs the stale-config stop" "$OUT_R"; fi
if grep -q 'PROC_DEAD' <<<"$OUT_R"; then pass "reconcile-off: stops the live publisher"; else failx "reconcile-off: stops the live publisher" "$OUT_R"; fi
if grep -q 'PIDFILE_GONE' <<<"$OUT_R"; then pass "reconcile-off: removes the PID file"; else failx "reconcile-off: removes the PID file" "$OUT_R"; fi

# --- bounded shutdown: a SIGTERM-ignoring publisher survives the grace window, then
#     is SIGKILLed — proves stop_coordination waits for the flush instead of a hard 1s.
CDIR_S="${SCRATCH}/catalyst-stopgrace"; mkdir -p "$CDIR_S"
OUT_S="$(CATALYST_DIR="$CDIR_S" COORD_FAKE="$FAKE_PUB" COORDINATION_STOP_GRACE_SECONDS=2 \
  bash --noprofile --norc -c '
    source "'"${STACK}"'" 2>/dev/null || true
    COORDINATION_SCRIPT="$COORD_FAKE"
    IGNORE_TERM=1 bash "$COORDINATION_SCRIPT" & echo $! > "$COORDINATION_PID"
    sleep 1
    livepid="$(cat "$COORDINATION_PID")"
    t0="$SECONDS"; stop_coordination; t1="$SECONDS"
    # Fail CLOSED (AGENTS.md): KILLED only when we POSITIVELY confirm the pid is
    # gone. An empty/uncapturable pid → NO_PID (asserts fail), never a false KILLED.
    if [[ -z "$livepid" ]]; then echo "NO_PID"; elif ps -p "$livepid" >/dev/null 2>&1; then echo "STILL_ALIVE"; kill -9 "$livepid" 2>/dev/null; else echo "KILLED"; fi
    echo "ELAPSED=$((t1 - t0))"
  ' 2>&1)"
if grep -q 'KILLED' <<<"$OUT_S"; then pass "stop-grace: SIGKILLs a SIGTERM-ignoring publisher"; else failx "stop-grace: SIGKILLs a SIGTERM-ignoring publisher" "$OUT_S"; fi
if grep -qi 'forcing SIGKILL' <<<"$OUT_S"; then pass "stop-grace: warns before forcing"; else failx "stop-grace: warns before forcing" "$OUT_S"; fi
ELAPSED_S="$(grep -o 'ELAPSED=[0-9]*' <<<"$OUT_S" | cut -d= -f2)"
if [[ -n "$ELAPSED_S" && "$ELAPSED_S" -ge 2 ]]; then pass "stop-grace: honors the ${ELAPSED_S}s graceful window (≥2s)"; else failx "stop-grace: honors the graceful window (≥2s)" "$OUT_S"; fi

# --- PID-discovery fallback: PID file deleted, but a publisher is still live ⇒
#     coordination_pid rediscovers it by command line (Codex P1: no orphan/dup).
CDIR_D="${SCRATCH}/catalyst-discover"; mkdir -p "$CDIR_D"
OUT_D="$(CATALYST_DIR="$CDIR_D" COORD_FAKE="$FAKE_PUB" \
  bash --noprofile --norc -c '
    source "'"${STACK}"'" 2>/dev/null || true
    COORDINATION_SCRIPT="$COORD_FAKE"
    bash "$COORDINATION_SCRIPT" & realpid=$!
    sleep 1
    rm -f "$COORDINATION_PID"      # simulate a lost/corrupt PID file
    found="$(coordination_pid)"
    echo "FOUND=[$found] REAL=[$realpid]"
    kill -9 "$realpid" 2>/dev/null
  ' 2>&1)"
REAL_D="$(grep -o 'REAL=\[[0-9]*\]' <<<"$OUT_D" | grep -o '[0-9]*')"
if [[ -n "$REAL_D" ]] && grep -q "FOUND=\[${REAL_D}\]" <<<"$OUT_D"; then pass "pid-discovery: rediscovers the publisher after PID-file loss"; else failx "pid-discovery: rediscovers the publisher after PID-file loss" "$OUT_D"; fi

# --- start serialization: a held (fresh) start lock ⇒ this invocation SKIPS the
#     tick without spawning (Codex P1: overlapping starts must not both spawn). ---
CDIR_L="${SCRATCH}/catalyst-lockheld"; mkdir -p "$CDIR_L"
OUT_L="$(PATH="${STUB_OFF}:${PATH}" CATALYST_DIR="$CDIR_L" \
  bash --noprofile --norc -c '
    source "'"${STACK}"'" 2>/dev/null || true
    mkdir -p "$COORDINATION_LOCK"      # simulate a concurrent start holding the lock
    start_coordination; echo "RC=$?"
    [[ -d "$COORDINATION_LOCK" ]] && echo "LOCK_KEPT" || echo "LOCK_REMOVED"
    [[ -f "$COORDINATION_PID" ]] && echo "PIDFILE_PRESENT" || echo "PIDFILE_GONE"
  ' 2>&1)"
if grep -q 'RC=0' <<<"$OUT_L"; then pass "start-lock: held lock ⇒ returns 0 (skips tick)"; else failx "start-lock: held lock ⇒ returns 0" "$OUT_L"; fi
if grep -qi 'already in progress' <<<"$OUT_L"; then pass "start-lock: logs the skip breadcrumb"; else failx "start-lock: logs the skip breadcrumb" "$OUT_L"; fi
if grep -q 'LOCK_KEPT' <<<"$OUT_L"; then pass "start-lock: does NOT steal a live peer's lock"; else failx "start-lock: does NOT steal a live peer's lock" "$OUT_L"; fi
if grep -q 'PIDFILE_GONE' <<<"$OUT_L"; then pass "start-lock: spawns nothing while lock is held"; else failx "start-lock: spawns nothing while lock is held" "$OUT_L"; fi

# --- stale-lock reclaim: a lock older than the threshold (a crashed start) is
#     reclaimed so startup can't wedge forever; the off-stub then no-ops cleanly. ---
CDIR_ST="${SCRATCH}/catalyst-lockstale"; mkdir -p "$CDIR_ST"
OUT_ST="$(PATH="${STUB_OFF}:${PATH}" CATALYST_DIR="$CDIR_ST" \
  bash --noprofile --norc -c '
    source "'"${STACK}"'" 2>/dev/null || true
    mkdir -p "$COORDINATION_LOCK"
    touch -t 202001010000 "$COORDINATION_LOCK"   # back-date well past the stale threshold
    start_coordination; echo "RC=$?"
    [[ -d "$COORDINATION_LOCK" ]] && echo "LOCK_KEPT" || echo "LOCK_REMOVED"
  ' 2>&1)"
if grep -qi 'reclaimed an abandoned (empty) start lock' <<<"$OUT_ST"; then pass "stale-lock: reclaims an empty crashed start lock"; else failx "stale-lock: reclaims an empty crashed start lock" "$OUT_ST"; fi
if grep -q 'RC=0' <<<"$OUT_ST"; then pass "stale-lock: proceeds after reclaim (rc 0)"; else failx "stale-lock: proceeds after reclaim (rc 0)" "$OUT_ST"; fi
if grep -q 'LOCK_REMOVED' <<<"$OUT_ST"; then pass "stale-lock: releases the lock it acquired"; else failx "stale-lock: releases the lock it acquired" "$OUT_ST"; fi

# --- live-owner lock: an OLD lock whose sentinel owner is still ALIVE is a live
#     peer (never force-removed) ⇒ skip. Guards mkdir as the sole ownership arbiter
#     so a reclaimer can't delete a live peer's lock and let both spawn (Codex P1). ---
CDIR_LO="${SCRATCH}/catalyst-liveowner"; mkdir -p "$CDIR_LO"
OUT_LO="$(PATH="${STUB_OFF}:${PATH}" CATALYST_DIR="$CDIR_LO" \
  bash --noprofile --norc -c '
    source "'"${STACK}"'" 2>/dev/null || true
    mkdir -p "$COORDINATION_LOCK"
    printf "%s" "$$" > "$COORDINATION_LOCK/owner"   # owner = THIS shell (alive)
    touch -t 202001010000 "$COORDINATION_LOCK"      # OLD (age gate passes)
    start_coordination; echo "RC=$?"
    [[ -d "$COORDINATION_LOCK" ]] && echo "LOCK_KEPT" || echo "LOCK_REMOVED"
    [[ -f "$COORDINATION_PID" ]] && echo "PIDFILE_PRESENT" || echo "PIDFILE_GONE"
  ' 2>&1)"
if grep -q 'RC=0' <<<"$OUT_LO"; then pass "live-owner: returns 0 (skips)"; else failx "live-owner: returns 0" "$OUT_LO"; fi
if grep -q 'LOCK_KEPT' <<<"$OUT_LO"; then pass "live-owner: never force-removes a live peer's lock"; else failx "live-owner: never force-removes a live peer's lock" "$OUT_LO"; fi
if grep -q 'PIDFILE_GONE' <<<"$OUT_LO"; then pass "live-owner: spawns nothing"; else failx "live-owner: spawns nothing" "$OUT_LO"; fi

# --- dead-owner lock: an OLD sentinel-bearing lock whose recorded owner is DEAD is a
#     crash-after-sentinel carcass ⇒ reclaimed (atomic-rename takeover), not left
#     wedged after reboot until manual deletion (Codex P1). ---
CDIR_DO="${SCRATCH}/catalyst-deadowner"; mkdir -p "$CDIR_DO"
OUT_DO="$(PATH="${STUB_OFF}:${PATH}" CATALYST_DIR="$CDIR_DO" \
  bash --noprofile --norc -c '
    source "'"${STACK}"'" 2>/dev/null || true
    mkdir -p "$COORDINATION_LOCK"
    printf "%s" "2147480000" > "$COORDINATION_LOCK/owner"   # a PID that is not alive
    touch -t 202001010000 "$COORDINATION_LOCK"              # OLD
    start_coordination; echo "RC=$?"
    [[ -d "$COORDINATION_LOCK" ]] && echo "LOCK_KEPT" || echo "LOCK_REMOVED"
  ' 2>&1)"
if grep -qi 'reclaimed a dead-owner start lock' <<<"$OUT_DO"; then pass "dead-owner: reclaims a crash-after-sentinel carcass"; else failx "dead-owner: reclaims a crash-after-sentinel carcass" "$OUT_DO"; fi
if grep -q 'RC=0' <<<"$OUT_DO"; then pass "dead-owner: proceeds after reclaim (rc 0)"; else failx "dead-owner: proceeds after reclaim (rc 0)" "$OUT_DO"; fi
if grep -q 'LOCK_REMOVED' <<<"$OUT_DO"; then pass "dead-owner: releases the reclaimed lock"; else failx "dead-owner: releases the reclaimed lock" "$OUT_DO"; fi

# --- plist Layer-2 pinning (Codex P2): the stack LaunchAgent must carry the
#     operator's CATALYST_LAYER2_CONFIG_FILE so the keep-alive resolves coordination
#     from the SAME config the operator used — else a shadow/enforce publisher is
#     seen as `off` on the tick and reconcile-stopped. render_stack_plist is pure. ---
OUT_P2="$(CATALYST_LAYER2_CONFIG_FILE="/custom/layer2.json" \
  bash --noprofile --norc -c 'source "'"${STACK}"'" 2>/dev/null || true; render_stack_plist catalyst-stack 600' 2>&1)"
if grep -q '<key>CATALYST_LAYER2_CONFIG_FILE</key>' <<<"$OUT_P2" && grep -q '<string>/custom/layer2.json</string>' <<<"$OUT_P2"; then
  pass "plist-layer2: pins CATALYST_LAYER2_CONFIG_FILE when set"
else failx "plist-layer2: pins CATALYST_LAYER2_CONFIG_FILE when set" "$OUT_P2"; fi
OUT_P2U="$(bash --noprofile --norc -c 'unset CATALYST_LAYER2_CONFIG_FILE; source "'"${STACK}"'" 2>/dev/null || true; render_stack_plist catalyst-stack 600' 2>&1)"
if grep -q 'CATALYST_LAYER2_CONFIG_FILE' <<<"$OUT_P2U"; then
  failx "plist-layer2: omits the key when unset" "$OUT_P2U"
else pass "plist-layer2: omits the key when unset (default path)"; fi

# --- plist coordination-override pinning (Codex P1): install-time
#     CATALYST_COORDINATION_MODE / _HUB_URL overrides must ride into the agent env,
#     else the scheduled job drops the operator's kill-switch/override. ---
OUT_CO="$(CATALYST_COORDINATION_MODE="0" CATALYST_COORDINATION_HUB_URL="https://hub.example/x" \
  bash --noprofile --norc -c 'source "'"${STACK}"'" 2>/dev/null || true; render_stack_plist catalyst-stack 600' 2>&1)"
if grep -q '<key>CATALYST_COORDINATION_MODE</key>' <<<"$OUT_CO" && grep -q '<string>0</string>' <<<"$OUT_CO"; then
  pass "plist-coord: pins CATALYST_COORDINATION_MODE kill-switch when set"
else failx "plist-coord: pins CATALYST_COORDINATION_MODE when set" "$OUT_CO"; fi
if grep -q '<key>CATALYST_COORDINATION_HUB_URL</key>' <<<"$OUT_CO" && grep -q '<string>https://hub.example/x</string>' <<<"$OUT_CO"; then
  pass "plist-coord: pins CATALYST_COORDINATION_HUB_URL when set"
else failx "plist-coord: pins CATALYST_COORDINATION_HUB_URL when set" "$OUT_CO"; fi
OUT_COU="$(bash --noprofile --norc -c 'unset CATALYST_COORDINATION_MODE CATALYST_COORDINATION_HUB_URL; source "'"${STACK}"'" 2>/dev/null || true; render_stack_plist catalyst-stack 600' 2>&1)"
if grep -q 'CATALYST_COORDINATION_MODE\|CATALYST_COORDINATION_HUB_URL' <<<"$OUT_COU"; then
  failx "plist-coord: omits coordination keys when unset" "$OUT_COU"
else pass "plist-coord: omits coordination keys when unset"; fi

echo ""
echo "  ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]]
