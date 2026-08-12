#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"; CLI="$ROOT/plugins/dev/scripts/catalyst-execution-core"
failures=0; children=""; ok(){ echo "  PASS: $1"; }; bad(){ echo "  FAIL: $1 ($2)"; failures=$((failures+1)); }
tmp="$(mktemp -d)"; export CATALYST_DIR="$tmp" CATALYST_SKIP_DEP_PREFLIGHT=1
marker="cat163-execution-core-$PPID-$$"; marker_script="$tmp/$marker-daemon.mjs"
printf '#!/usr/bin/env bash\nsleep 30 & wait\n' > "$marker_script"; chmod +x "$marker_script"; export EXECUTION_CORE_PROC_PATTERN="$marker"
cleanup(){ local p; for p in $children; do kill -9 "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; done; rm -rf "$tmp"; }; trap cleanup EXIT
spawn(){ bash "$marker_script" & SPAWNED=$!; children="$children $SPAWNED"; sleep 0.1; }

sleep 30 & imposter=$!; children="$children $imposter"; mkdir -p "$tmp/execution-core"; echo "$imposter" > "$tmp/execution-core/daemon.pid"
out="$($CLI stop 2>&1)"; rc=$?
if [[ $rc -eq 0 && "$out" == *"not running"* ]] && kill -0 "$imposter" 2>/dev/null && [[ "$(cat "$tmp/execution-core/daemon.pid")" == "$imposter" ]]; then ok "recycled pid is not signalled and its pid file is preserved"; else bad "recycled pid is not signalled and its pid file is preserved" "$out rc=$rc"; fi
rm -f "$tmp/execution-core/daemon.pid"
spawn; orphan=$SPAWNED; rm -f "$tmp/execution-core/daemon.pid"; out="$($CLI stop 2>&1)"; rc=$?
if [[ $rc -eq 0 && "$out" == *"orphan"* ]] && ! kill -0 "$orphan" 2>/dev/null; then ok "orphan is found and stopped"; else bad "orphan is found and stopped" "$out rc=$rc"; fi
out="$($CLI stop 2>&1)"; rc=$?; [[ $rc -eq 0 && "$out" == *"not running"* ]] && ok "absent daemon is a clean no-op" || bad "absent daemon is a clean no-op" "$out rc=$rc"
spawn; first=$SPAWNED; spawn; second=$SPAWNED; out="$($CLI stop 2>&1)"; rc=$?
if [[ $rc -eq 1 && "$out" == *"ambiguous"* ]] && kill -0 "$first" 2>/dev/null && kill -0 "$second" 2>/dev/null; then ok "ambiguous matches are not signalled"; else bad "ambiguous matches are not signalled" "$out rc=$rc"; fi
kill "$first" "$second" 2>/dev/null || true; wait "$first" "$second" 2>/dev/null || true
spawn; orphan=$SPAWNED; out="$($CLI status 2>&1)"; [[ "$out" == *"running"* && "$out" == *"orphan"* ]] && ok "status reports orphan as running" || bad "status reports orphan as running" "$out"
stub="$tmp/process-identity-stub.sh"; sed '$a\
cpi_pid_gone() { return 1; }' "$ROOT/plugins/dev/scripts/lib/process-identity.sh" > "$stub"
echo "$orphan" > "$tmp/execution-core/daemon.pid"; out="$(CATALYST_PROCESS_IDENTITY_LIB="$stub" $CLI stop 2>&1)"; rc=$?
[[ $rc -eq 1 && "$out" == *"not confirmed"* ]] && ok "unconfirmable stop fails distinctly" || bad "unconfirmable stop fails distinctly" "$out rc=$rc"
stale_stub="$tmp/process-identity-stale-stub.sh"; cp "$ROOT/plugins/dev/scripts/lib/process-identity.sh" "$stale_stub"
printf '\ncpi_find_orphans() { echo 5999998; }\n' >> "$stale_stub"
rm -f "$tmp/execution-core/daemon.pid"; out="$(CATALYST_PROCESS_IDENTITY_LIB="$stale_stub" $CLI stop 2>&1)"; rc=$?
[[ $rc -ne 0 && "$out" == *"refusing to signal"* ]] && ok "orphan stop refuses a pid that no longer matches the pattern" || bad "orphan stop refuses a pid that no longer matches the pattern" "$out rc=$rc"
exit "$failures"
