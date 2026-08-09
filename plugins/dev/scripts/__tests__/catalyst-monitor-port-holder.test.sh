#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SCRIPT="$ROOT/plugins/dev/scripts/catalyst-monitor.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/state"
cat > "$TMP/bin/lsof" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${LSOF_PIDS:-}"
EOF
cat > "$TMP/bin/ps" <<'EOF'
#!/usr/bin/env bash
pid="${@: -1}"
IFS=';' read -ra rows <<< "${PS_ROWS:-}"
for row in "${rows[@]}"; do [[ "${row%%=*}" == "$pid" ]] && { printf '%s\n' "${row#*=}"; exit 0; }; done
exit 1
EOF
chmod +x "$TMP/bin/"*

pass=0 fail=0
expect() { local name="$1" want="$2" pids="$3" file="$4" rows="$5"; rm -f "$TMP/state/monitor.pid"; [[ -n "$file" ]] && printf '%s\n' "$file" > "$TMP/state/monitor.pid"; got="$(CATALYST_DIR="$TMP/state" MONITOR_PID_FILE="$TMP/state/monitor.pid" MONITOR_SKIP_BOOTSTRAP=1 LSOF_PIDS="$pids" PS_ROWS="$rows" PATH="$TMP/bin:/usr/bin:/bin" bash --noprofile --norc -c 'source "'$SCRIPT'" url >/dev/null; classify_port_holder')"; if [[ "$got" == "$want" ]]; then pass=$((pass+1)); else echo "FAIL $name: wanted $want got $got"; fail=$((fail+1)); fi; }
expect free free "" "" ""
expect ours ours 111 111 '111=bun run /x/orch-monitor/server.ts --pid-file /y/monitor.pid'
expect orphan orphan 222 "" '222=bun run /x/orch-monitor/server.ts'
expect stale orphan 222 999 '222=bun run /x/orch-monitor/server.ts'
expect foreign foreign 333 "" '333=/usr/bin/python3 -m http.server 7400'
expect unreadable unknown 444 "" ''
expect mixed foreign $'222\n333' "" '222=bun run /x/orch-monitor/server.ts;333=/usr/bin/nc -l 7400'

fn="$(MONITOR_SKIP_BOOTSTRAP=1 bash -c 'source "'$SCRIPT'" url >/dev/null; declare -f classify_port_holder')"
[[ "$fn" != *'kill '* ]] && pass=$((pass+1)) || { echo 'FAIL classifier signals'; fail=$((fail+1)); }
printf 'catalyst-monitor-port-holder: %d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
