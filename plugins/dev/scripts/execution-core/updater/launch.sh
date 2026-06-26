#!/usr/bin/env bash
# execution-core/updater/launch.sh — CTL-1348. Resolve the per-host environment and
# exec the standalone catalyst-updater daemon (updater.mjs) in the FOREGROUND, mirroring
# log-shipper/launch.sh's `exec alloy run`.
#
# WHY A LAUNCHER
#   The updater plist (render_updater_plist in catalyst-stack) runs this under launchd
#   KeepAlive. updater.mjs needs the SAME stable node identity every other signal uses
#   (getHostName() semantics) so its telemetry joins on host.name; River/launchd can't
#   compute that, so this launcher resolves CATALYST_HOST_NAME via lib/host-identity.sh
#   and then exec's bun on updater.mjs. exec (not a child) keeps launchd's KeepAlive
#   supervising the actual daemon — death → instant restart (the CTL-1285 template).
#
# Env (all optional; sensible defaults):
#   CATALYST_DIR                catalyst home (default ~/catalyst)
#   CATALYST_HOST_NAME          stable node name (else resolved as above)
#   CATALYST_UPDATER_POLL_INTERVAL_MS   refresh poll cadence (updater.mjs default 90s)
#   CATALYST_TRACING            "on" to enable OTLP spans (off by default)

set -uo pipefail

# ─── SCRIPT_DIR (symlink-walking) ────────────────────────────────────────────
_SRC="${BASH_SOURCE[0]}"
while [[ -L "$_SRC" ]]; do _SRC="$(readlink "$_SRC")"; done
SCRIPT_DIR="$(cd "$(dirname "$_SRC")" && pwd)"
unset _SRC

log()  { printf '[updater] %s\n' "$*"; }
warn() { printf '[updater] WARN: %s\n' "$*" >&2; }
fail() { printf '[updater] ERROR: %s\n' "$*" >&2; exit 1; }

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
export CATALYST_DIR

# ─── Preflight ───────────────────────────────────────────────────────────────
command -v bun >/dev/null 2>&1 || fail "bun not found on PATH — install it (https://bun.sh) or run install-cli.sh"
UPDATER_MJS="${SCRIPT_DIR}/updater.mjs"
[[ -f "$UPDATER_MJS" ]] || fail "updater.mjs not found at $UPDATER_MJS"

# ─── Resolve the stable node name (getHostName() semantics) ──────────────────
# shellcheck source=../../lib/host-identity.sh
if [[ -f "${SCRIPT_DIR}/../../lib/host-identity.sh" ]]; then
  . "${SCRIPT_DIR}/../../lib/host-identity.sh"
  _hn="$(catalyst_host_name)"
  export CATALYST_HOST_NAME="$_hn"
else
  warn "lib/host-identity.sh missing — updater telemetry will fall back to the OS hostname for host.name"
fi

log "starting updater (node=${CATALYST_HOST_NAME:-<os-hostname>}, poll=${CATALYST_UPDATER_POLL_INTERVAL_MS:-90000}ms)"
exec bun "$UPDATER_MJS"
