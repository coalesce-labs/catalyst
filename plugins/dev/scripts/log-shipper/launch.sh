#!/usr/bin/env bash
# log-shipper/launch.sh — resolve the per-host environment and exec Grafana Alloy
# against config.alloy (CTL-1263, launcher for the CTL-1261 shipper config).
#
# WHY A LAUNCHER
#   config.alloy (CTL-1261) is a stock Alloy config that tails the four Catalyst
#   daemon .log files and ships them OTLP/HTTP to the shared collector. It reads
#   its node identity + per-file paths from environment variables because River
#   cannot read the Layer-2 JSON config or compute the first-DNS-label reduction
#   itself. This launcher is the one place that resolves them — using the EXACT
#   getHostName() precedence — and then exec's Alloy.
#
#   catalyst-stack's start_shipper step calls this launcher (it owns the pid file,
#   log redirection, and idempotency). You can also run it by hand for a smoke
#   test; it exec's Alloy in the foreground.
#
# NODE NAME (load-bearing — see config.alloy "HOST TAGGING")
#   CATALYST_HOST_NAME is resolved via lib/host-identity.sh's catalyst_host_name():
#       CATALYST_HOST_NAME env
#         -> catalyst.host.name in Layer-2 ~/.config/catalyst/config.json
#         -> os.hostname() reduced to its first DNS label
#   This is getHostName() semantics exactly and is NEVER the Tailscale device
#   name (RyansMini250233 != mini). config.alloy reads CATALYST_HOST_NAME for its
#   catalyst.host.name resource attribute.
#
# Usage:
#   log-shipper/launch.sh [--storage <dir>] [--config <path>] [-- <extra alloy args>]
#
# Env (all optional; sensible defaults):
#   CATALYST_DIR              catalyst home (default ~/catalyst)
#   CATALYST_HOST_NAME        stable node name (else resolved as above)
#   CATALYST_OTLP_ENDPOINT    collector OTLP/HTTP base (config.alloy default applies)
#   CATALYST_ALLOY_STORAGE    Alloy storage.path (default $CATALYST_DIR/alloy-data)
#   CATALYST_ALLOY_CONFIG     config path (default this dir's config.alloy)

set -uo pipefail

# ─── SCRIPT_DIR (symlink-walking) ────────────────────────────────────────────
_SRC="${BASH_SOURCE[0]}"
while [[ -L "$_SRC" ]]; do _SRC="$(readlink "$_SRC")"; done
SCRIPT_DIR="$(cd "$(dirname "$_SRC")" && pwd)"
unset _SRC

log()  { printf '[log-shipper] %s\n' "$*"; }
warn() { printf '[log-shipper] WARN: %s\n' "$*" >&2; }
fail() { printf '[log-shipper] ERROR: %s\n' "$*" >&2; exit 1; }

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"

# ─── Arg parsing ─────────────────────────────────────────────────────────────
STORAGE="${CATALYST_ALLOY_STORAGE:-${CATALYST_DIR}/alloy-data}"
CONFIG="${CATALYST_ALLOY_CONFIG:-${SCRIPT_DIR}/config.alloy}"
EXTRA_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --storage) STORAGE="${2:?--storage needs a value}"; shift 2 ;;
    --config)  CONFIG="${2:?--config needs a value}"; shift 2 ;;
    --)        shift; EXTRA_ARGS=("$@"); break ;;
    -h | --help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) fail "unknown arg: $1 (try: --storage <dir> | --config <path> | -- <extra alloy args>)" ;;
  esac
done

# ─── Preflight ───────────────────────────────────────────────────────────────
command -v alloy >/dev/null 2>&1 \
  || fail "alloy not found on PATH — install it: bash \"${SCRIPT_DIR}/../install-cli.sh\" (installs Grafana Alloy), or 'brew install grafana-alloy'"
[[ -f "$CONFIG" ]] || fail "config not found at $CONFIG"

# ─── Resolve the stable node name (getHostName() semantics) ──────────────────
# shellcheck source=../lib/host-identity.sh
if [[ -f "${SCRIPT_DIR}/../lib/host-identity.sh" ]]; then
  . "${SCRIPT_DIR}/../lib/host-identity.sh"
  _hn="$(catalyst_host_name)"
  export CATALYST_HOST_NAME="$_hn"
else
  warn "lib/host-identity.sh missing — config.alloy will fall back to the OS hostname for catalyst.host.name"
fi

# ─── Export the absolute, $HOME-resolved daemon log paths (config defaults are a
#     last-resort fallback; the launcher is the authoritative source). ─────────
export CATALYST_BROKER_LOG="${CATALYST_BROKER_LOG:-${CATALYST_DIR}/broker.log}"
export CATALYST_DAEMON_LOG="${CATALYST_DAEMON_LOG:-${CATALYST_DIR}/execution-core/daemon.log}"
export CATALYST_OTEL_FORWARD_LOG="${CATALYST_OTEL_FORWARD_LOG:-${CATALYST_DIR}/otel-forward.log}"
export CATALYST_MONITOR_LOG="${CATALYST_MONITOR_LOG:-${CATALYST_DIR}/monitor.log}"
# CTL-1348: the standalone catalyst-updater daemon's log (5th Alloy stream). Exported
# even when no updater agent is installed — Alloy's loki.source.file just tails nothing.
export CATALYST_UPDATER_LOG="${CATALYST_UPDATER_LOG:-${CATALYST_DIR}/updater.log}"

# CTL-1395: the catalyst-cloud-sync writer's log (6th Alloy stream). Exported even when no
# cloud-sync agent is installed — Alloy's loki.source.file just tails nothing.
export CATALYST_CLOUD_SYNC_LOG="${CATALYST_CLOUD_SYNC_LOG:-${CATALYST_DIR}/cloud-sync.log}"

mkdir -p "$STORAGE"

log "starting alloy (node=${CATALYST_HOST_NAME:-<os-hostname>}, config=$CONFIG, storage=$STORAGE)"
exec alloy run "$CONFIG" --storage.path "$STORAGE" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
