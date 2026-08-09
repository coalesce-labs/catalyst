#!/usr/bin/env bash
# CAT-53: a stack start banner and exit status must be derived from the health
# of every component the node class actually attempted to start.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
STACK="${REPO_ROOT}/plugins/dev/scripts/catalyst-stack"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
PASSES=0
FAILURES=0

check() {
  local name="$1"; shift
  if "$@" >"${SCRATCH}/check.out" 2>&1; then
    PASSES=$((PASSES + 1)); echo "  PASS: ${name}"
  else
    FAILURES=$((FAILURES + 1)); echo "  FAIL: ${name}"
    sed 's/^/      /' "${SCRATCH}/check.out"
  fi
}

run_start() {
  local node_class="${1:-worker}" failures="${2:-}" broken="${3:-no}"
  local run_dir="${SCRATCH}/run-${RANDOM}-${RANDOM}"
  mkdir -p "${run_dir}/bin" "${run_dir}/scripts" "${run_dir}/catalyst"
  : >"${run_dir}/events"
  : >"${run_dir}/findings"
  cat >"${run_dir}/bin/catalyst-state.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$EVENTS_FILE"
[[ "${BREAK_EMITTERS:-no}" != yes ]]
STUB
  cat >"${run_dir}/scripts/add-finding.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FINDINGS_FILE"
[[ "${BREAK_EMITTERS:-no}" != yes ]]
STUB
  chmod +x "${run_dir}/bin/catalyst-state.sh" "${run_dir}/scripts/add-finding.sh"

  RUN_DIR="$run_dir" EVENTS_FILE="${run_dir}/events" FINDINGS_FILE="${run_dir}/findings" \
  BREAK_EMITTERS="$broken" PATH="${run_dir}/bin:${PATH}" \
  bash --noprofile --norc <<EOF >"${run_dir}/out" 2>&1
set -uo pipefail
source "${STACK}" 2>/dev/null || true
SCRIPT_DIR="${run_dir}/scripts"
CATALYST_DIR="${run_dir}/catalyst"
STACK_ALERT_FILE="\${CATALYST_DIR}/stack/start.alert.json"
_resolve_node_class() { printf '%s' "${node_class}"; }
_component() {
  local name="\$1"
  case " ${failures} " in *" \${name} "*) return 23;; esac
  return 0
}
start_monitor() { _component monitor; }
start_broker() { _component broker; }
start_daemon() { _component execution-core; }
start_forward() { _component otel-forward; }
start_daemon_watchdog() { _component daemon-watchdog; }
start_coordination() { _component coordination; }
start_shipper() { _component log-shipper; }
start_event_mirror() { _component event-mirror; }
_cloud_token_env_run() { :; }
cmd_status() { echo '  execution-core   stopped'; }
ASSUME_YES=yes cmd_start
EOF
  printf '%s' "$?" >"${run_dir}/rc"
  printf '%s\n' "$run_dir"
}

out_has() { local d="$1" s="$2"; grep -q "$s" "$d/out"; }
out_lacks() { local d="$1" s="$2"; ! grep -q "$s" "$d/out"; }
rc_is() { local d="$1" want="$2"; [[ "$(cat "$d/rc")" == "$want" ]]; }
rc_nonzero() { local d="$1"; [[ "$(cat "$d/rc")" -ne 0 ]]; }
json_expr() { local d="$1" expr="$2"; jq -e "$expr" "$d/catalyst/stack/start.alert.json" >/dev/null; }

echo "=== catalyst-stack start health (CAT-53) ==="

ok="$(run_start worker "")"
check "all components ok prints stack up" out_has "$ok" "stack up"
check "all components ok omits DEGRADED" out_lacks "$ok" "DEGRADED"
check "all components ok exits zero" rc_is "$ok" 0
check "all components ok clears durable marker" test ! -e "$ok/catalyst/stack/start.alert.json"

monitor_fail="$(run_start worker monitor)"
check "monitor failure prints DEGRADED" out_has "$monitor_fail" "stack DEGRADED"
check "monitor failure never prints stack up" out_lacks "$monitor_fail" "stack up"
check "monitor failure names monitor" out_has "$monitor_fail" "monitor"
check "monitor failure exits nonzero" rc_nonzero "$monitor_fail"
check "status still prints on failure" out_has "$monitor_fail" "execution-core"
check "failure writes durable marker" json_expr "$monitor_fail" '.status == "degraded"'
check "marker names failed component" json_expr "$monitor_fail" '.failed | index("monitor") != null'
check "failure emits alert event" grep -q 'catalyst.alert.raised' "$monitor_fail/events"
check "failure files operator finding" grep -q -- '--severity high' "$monitor_fail/findings"

two_fail="$(run_start worker 'monitor broker')"
check "banner counts two failed components" out_has "$two_fail" "2 of"

developer="$(run_start developer "")"
check "unattempted developer components are not failures" rc_is "$developer" 0

coordination="$(run_start worker coordination)"
check "formerly warn-guarded component degrades" out_has "$coordination" "stack DEGRADED"

broken="$(run_start worker monitor yes)"
check "broken alarm emitters do not replace component result" rc_nonzero "$broken"
check "broken alarm emitters do not crash banner" out_has "$broken" "stack DEGRADED"

echo "=== Results: ${PASSES} pass, ${FAILURES} fail ==="
[[ "$FAILURES" -eq 0 ]]
