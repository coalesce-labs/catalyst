#!/usr/bin/env bash
# Shell tests for catalyst-execution-core — the daemon-lifecycle script (CTL-554).
# Run: bash plugins/dev/scripts/__tests__/catalyst-execution-core.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SCRIPT="${REPO_ROOT}/plugins/dev/scripts/catalyst-execution-core"

FAILURES=0
PASSES=0
pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	[ $# -ge 2 ] && echo "    $2"
}

setup() {
	SCRATCH=$(mktemp -d)
	export CATALYST_DIR="$SCRATCH"
	export DAEMON_ENV_DUMP="$SCRATCH/daemon-env.dump"
	# fake daemon: dump env for proxy-gating assertions, write PID file, then sleep.
	FAKE="$SCRATCH/fake-daemon.sh"
	cat >"$FAKE" <<'EOF'
#!/usr/bin/env bash
env > "${DAEMON_ENV_DUMP:?}"
while [ $# -gt 0 ]; do [ "$1" = "--pid-file" ] && echo $$ > "$2"; shift; done
sleep 30
EOF
	chmod +x "$FAKE"
	export EXECUTION_CORE_DAEMON_SCRIPT="$FAKE"
	export EXECUTION_CORE_RUNTIME="bash" # run the fake under bash, not bun
}

teardown() {
	"$SCRIPT" stop >/dev/null 2>&1 || true
	pkill -f "fake-daemon.sh" 2>/dev/null || true
	rm -rf "$SCRATCH"
	unset CATALYST_DIR EXECUTION_CORE_DAEMON_SCRIPT EXECUTION_CORE_RUNTIME \
	      DAEMON_ENV_DUMP CATALYST_EXECUTION_CORE_ENV
}

# Return a localhost TCP port with no current listener (best-effort).
_free_port() {
	local p
	for p in 49231 49233 49237 49241 49243; do
		if ! (echo >"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then echo "$p"; return; fi
	done
	echo 49251
}

# ─── Test cases ───────────────────────────────────────────────────────────────

echo "test 1 (CTL-554): start is idempotent"
setup
"$SCRIPT" start >/dev/null 2>&1
PID1=$(cat "$SCRATCH/execution-core/daemon.pid" 2>/dev/null)
"$SCRIPT" start >/dev/null 2>&1
PID2=$(cat "$SCRATCH/execution-core/daemon.pid" 2>/dev/null)
if [ -n "$PID1" ] && [ "$PID1" = "$PID2" ]; then
	pass "start is idempotent"
else
	fail "start idempotent" "pid1=$PID1 pid2=$PID2"
fi

echo "test 2 (CTL-554): status + probe report running"
if "$SCRIPT" probe; then pass "probe exits 0 while running"; else fail "probe exits 0 while running"; fi
if "$SCRIPT" status | grep -q running; then pass "status says running"; else fail "status says running"; fi

echo "test 3 (CTL-554): stop removes the PID file and probe then fails"
"$SCRIPT" stop >/dev/null 2>&1
if [ ! -f "$SCRATCH/execution-core/daemon.pid" ]; then
	pass "stop removes pidfile"
else
	fail "stop removes pidfile"
fi
"$SCRIPT" probe || pass "probe exits non-zero after stop"
teardown

echo "test 4 (CTL-554): start fails loudly when the daemon never writes its PID file"
setup
# A daemon that stays alive but never writes a PID file — simulates a hang
# mid-init. cmd_start must NOT fabricate a PID file or report success.
NOPID="$SCRATCH/nopid-daemon.sh"
cat >"$NOPID" <<'EOF'
#!/usr/bin/env bash
sleep 30
EOF
chmod +x "$NOPID"
export EXECUTION_CORE_DAEMON_SCRIPT="$NOPID"
OUT=$("$SCRIPT" start 2>&1)
RC=$?
if [ "$RC" != "0" ]; then
	pass "start exits non-zero on a hung daemon"
else
	fail "start exits non-zero on a hung daemon" "rc=$RC"
fi
if [ ! -f "$SCRATCH/execution-core/daemon.pid" ]; then
	pass "start does not fabricate a PID file"
else
	fail "start does not fabricate a PID file" "pidfile present"
fi
if echo "$OUT" | grep -qi "wedged"; then
	pass "start reports the degraded state"
else
	fail "start reports the degraded state" "out=$OUT"
fi
pkill -f "nopid-daemon.sh" 2>/dev/null || true
teardown

echo "test 5 (CTL-635): _neutralize_otel_attrs transform"
# shellcheck source=/dev/null
source "$SCRIPT" # source-safe: dispatch guarded, helpers defined
POISONED="project=adva,hostname=mac-1,branch=CTL-635-x,linear.key=ADV-1039,catalyst.orchestration=CTL-635,task.type=phase-plan"
OUT="$(_neutralize_otel_attrs "$POISONED")"
# poisoning keys gone
if ! echo "$OUT" | grep -q 'linear.key='; then pass "drops linear.key"; else fail "drops linear.key" "out=$OUT"; fi
if ! echo "$OUT" | grep -q 'catalyst.orchestration='; then pass "drops catalyst.orchestration"; else fail "drops catalyst.orchestration" "out=$OUT"; fi
if ! echo "$OUT" | grep -q 'branch='; then pass "drops branch"; else fail "drops branch" "out=$OUT"; fi
if ! echo "$OUT" | grep -q 'task.type='; then pass "drops task.type"; else fail "drops task.type" "out=$OUT"; fi
if ! echo "$OUT" | grep -q 'project=adva'; then pass "drops borrowed project"; else fail "drops borrowed project" "out=$OUT"; fi
# neutral identity + honest attrs preserved
if echo "$OUT" | grep -q 'project=catalyst'; then pass "stamps project=catalyst"; else fail "stamps project=catalyst" "out=$OUT"; fi
if echo "$OUT" | grep -q 'catalyst.role=execution-core-daemon'; then pass "stamps daemon role"; else fail "stamps daemon role" "out=$OUT"; fi
if echo "$OUT" | grep -q 'hostname=mac-1'; then pass "preserves hostname"; else fail "preserves hostname" "out=$OUT"; fi
# empty input still yields the neutral identity
OUT_EMPTY="$(_neutralize_otel_attrs "")"
if echo "$OUT_EMPTY" | grep -q 'catalyst.role=execution-core-daemon'; then pass "empty input → neutral identity"; else fail "empty input → neutral identity" "out=$OUT_EMPTY"; fi

echo "test 6 (CTL-635): start neutralizes the daemon's OTEL_RESOURCE_ATTRIBUTES"
setup
# fake daemon that records the OTEL env it was launched with, then behaves normally
ENVDUMP="$SCRATCH/otel-env.txt"
REC="$SCRATCH/rec-daemon.sh"
cat >"$REC" <<EOF
#!/usr/bin/env bash
printf '%s' "\${OTEL_RESOURCE_ATTRIBUTES-}" > "$ENVDUMP"
while [ \$# -gt 0 ]; do [ "\$1" = "--pid-file" ] && echo \$\$ > "\$2"; shift; done
sleep 30
EOF
chmod +x "$REC"
export EXECUTION_CORE_DAEMON_SCRIPT="$REC"
export EXECUTION_CORE_RUNTIME="bash"
# simulate a poisoned launch environment
export OTEL_RESOURCE_ATTRIBUTES="project=adva,hostname=mac-1,linear.key=ADV-1039,catalyst.orchestration=CTL-635"
"$SCRIPT" start >/dev/null 2>&1
sleep 0.3
GOT="$(cat "$ENVDUMP" 2>/dev/null)"
if ! echo "$GOT" | grep -q 'linear.key='; then pass "daemon env has no linear.key"; else fail "daemon env has no linear.key" "got=$GOT"; fi
if echo "$GOT" | grep -q 'catalyst.role=execution-core-daemon'; then pass "daemon env carries neutral identity"; else fail "daemon env carries neutral identity" "got=$GOT"; fi
unset OTEL_RESOURCE_ATTRIBUTES
teardown

echo "test 7 (CTL-846): dead proxy in execution-core.env is stripped before daemon launch"
setup
DEAD_PORT=$(_free_port)
ENVF="$SCRATCH/execution-core.env"
printf 'export HTTPS_PROXY=http://127.0.0.1:%s\n' "$DEAD_PORT" >  "$ENVF"
printf 'export HTTP_PROXY=http://127.0.0.1:%s\n'  "$DEAD_PORT" >> "$ENVF"
printf 'export NODE_USE_ENV_PROXY=1\n'                          >> "$ENVF"
export CATALYST_EXECUTION_CORE_ENV="$ENVF"
WARN=$("$SCRIPT" start 2>&1 >/dev/null)
if ! grep -q 'HTTPS_PROXY=' "$DAEMON_ENV_DUMP" \
   && ! grep -q 'NODE_USE_ENV_PROXY=' "$DAEMON_ENV_DUMP"; then
	pass "dead proxy vars stripped from daemon env"
else
	fail "dead proxy vars stripped from daemon env" "$(grep -E 'PROXY' "$DAEMON_ENV_DUMP" || true)"
fi
if printf '%s' "$WARN" | grep -qi 'proxy.*not listening\|degrad'; then
	pass "warns when proxy is down"
else
	fail "warns when proxy is down" "stderr: $WARN"
fi
teardown

echo "test 8 (CTL-846): live proxy is preserved into daemon env"
if ! command -v nc >/dev/null 2>&1; then
	echo "SKIP: test 8 requires nc (not found on PATH)"
else
	setup
	LIVE_PORT=$(_free_port)
	( nc -l 127.0.0.1 "$LIVE_PORT" >/dev/null 2>&1 & echo $! > "$SCRATCH/listener.pid" )
	sleep 0.3
	ENVF="$SCRATCH/execution-core.env"
	printf 'export HTTPS_PROXY=http://127.0.0.1:%s\n' "$LIVE_PORT" > "$ENVF"
	printf 'export NODE_USE_ENV_PROXY=1\n'                        >> "$ENVF"
	export CATALYST_EXECUTION_CORE_ENV="$ENVF"
	"$SCRIPT" start >/dev/null 2>&1
	if grep -q "HTTPS_PROXY=http://127.0.0.1:$LIVE_PORT" "$DAEMON_ENV_DUMP"; then
		pass "live proxy preserved into daemon env"
	else
		fail "live proxy preserved into daemon env" "$(grep -E 'PROXY' "$DAEMON_ENV_DUMP" || true)"
	fi
	kill "$(cat "$SCRATCH/listener.pid" 2>/dev/null)" 2>/dev/null || true
	teardown
fi

echo "test 9 (CTL-846): no proxy vars set → launch unaffected, no warning"
setup
ENVF="$SCRATCH/execution-core.env"
printf 'export LINEAR_STATE_CACHE_TTL_MS=180000\n' > "$ENVF"
export CATALYST_EXECUTION_CORE_ENV="$ENVF"
WARN=$("$SCRIPT" start 2>&1 >/dev/null)
if printf '%s' "$WARN" | grep -qi 'proxy.*not listening'; then
	fail "no spurious proxy warning when no proxy configured" "$WARN"
else
	pass "no spurious proxy warning when no proxy configured"
fi
teardown

echo "test 10 (CTL-1404): _default_otel_from_user_settings fills unset OTLP keys from settings.json"
# helper already sourced in test 5. Needs jq (the function no-ops without it).
if ! command -v jq >/dev/null 2>&1; then
	echo "  SKIP: jq not installed"
else
	SETTINGS_DIR="$(mktemp -d)"
	cat >"$SETTINGS_DIR/settings.json" <<'JSON'
{ "env": {
  "OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector.example:4318",
  "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
  "OTEL_METRICS_EXPORTER": "otlp",
  "OTEL_LOGS_EXPORTER": "otlp",
  "CLAUDE_CODE_ENABLE_TELEMETRY": "1"
} }
JSON
	export CLAUDE_SETTINGS_JSON="$SETTINGS_DIR/settings.json"
	# (a) unset → filled from settings.json
	unset OTEL_EXPORTER_OTLP_ENDPOINT OTEL_EXPORTER_OTLP_PROTOCOL OTEL_METRICS_EXPORTER OTEL_LOGS_EXPORTER CLAUDE_CODE_ENABLE_TELEMETRY
	_default_otel_from_user_settings
	if [ "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" = "http://collector.example:4318" ]; then pass "fills endpoint from settings.json"; else fail "fills endpoint from settings.json" "got=${OTEL_EXPORTER_OTLP_ENDPOINT:-<unset>}"; fi
	if [ "${OTEL_EXPORTER_OTLP_PROTOCOL:-}" = "http/protobuf" ]; then pass "fills protocol from settings.json"; else fail "fills protocol from settings.json" "got=${OTEL_EXPORTER_OTLP_PROTOCOL:-<unset>}"; fi
	if [ "${CLAUDE_CODE_ENABLE_TELEMETRY:-}" = "1" ]; then pass "fills enable-telemetry"; else fail "fills enable-telemetry" "got=${CLAUDE_CODE_ENABLE_TELEMETRY:-<unset>}"; fi
	# (b) already set → NOT overridden (execution-core.env wins)
	export OTEL_EXPORTER_OTLP_ENDPOINT="http://daemon-env-wins:4318"
	_default_otel_from_user_settings
	if [ "${OTEL_EXPORTER_OTLP_ENDPOINT}" = "http://daemon-env-wins:4318" ]; then pass "does not override an already-set endpoint"; else fail "does not override an already-set endpoint" "got=${OTEL_EXPORTER_OTLP_ENDPOINT}"; fi
	# (d) Codex P1: a BARE (non-exported) value sourced from execution-core.env — e.g.
	# catalyst-join.sh's `OTEL_EXPORTER_OTLP_ENDPOINT=...` without export — must be PROMOTED to
	# exported so the nohup'd daemon child inherits it (else SDK workers start endpoint-less).
	unset OTEL_EXPORTER_OTLP_ENDPOINT
	OTEL_EXPORTER_OTLP_ENDPOINT="http://bare-sourced:4318" # bare assignment, NOT exported
	_default_otel_from_user_settings
	CHILD_SEES="$(bash -c 'printf %s "${OTEL_EXPORTER_OTLP_ENDPOINT-}"')"
	if [ "$CHILD_SEES" = "http://bare-sourced:4318" ]; then pass "promotes a bare daemon-env value to exported (child inherits)"; else fail "promotes a bare daemon-env value to exported" "child_sees=$CHILD_SEES"; fi
	# (c) settings file absent → no-op success, env untouched
	unset OTEL_EXPORTER_OTLP_ENDPOINT
	export CLAUDE_SETTINGS_JSON="$SETTINGS_DIR/does-not-exist.json"
	if _default_otel_from_user_settings; then pass "absent settings.json → no-op success"; else fail "absent settings.json → no-op success"; fi
	if [ -z "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then pass "absent settings.json leaves env unset"; else fail "absent settings.json leaves env unset" "got=${OTEL_EXPORTER_OTLP_ENDPOINT}"; fi
	unset CLAUDE_SETTINGS_JSON OTEL_EXPORTER_OTLP_ENDPOINT OTEL_EXPORTER_OTLP_PROTOCOL OTEL_METRICS_EXPORTER OTEL_LOGS_EXPORTER CLAUDE_CODE_ENABLE_TELEMETRY
	rm -rf "$SETTINGS_DIR"
fi

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
