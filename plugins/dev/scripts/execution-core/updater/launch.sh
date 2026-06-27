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
# Pin CATALYST_HOST_NAME only from an AUTHORITATIVE source — the env var, or the Layer-2
# catalyst.host.name (which host-identity.sh can read ONLY when jq is present). Without jq
# (and no env), catalyst_host_name() silently falls back to the OS hostname; pinning that
# would OVERRIDE the Layer-2 name, because updater.mjs getHostName() gives the env var
# precedence (Codex P2). So when we can't resolve authoritatively, leave it UNSET and let
# updater.mjs resolve host.name from Layer-2 itself (JS JSON.parse — no jq) + short-reduce,
# which is strictly better than pinning a fallback.
# shellcheck source=../../lib/host-identity.sh
if [[ -n "${CATALYST_HOST_NAME:-}" ]]; then
  : # already pinned authoritatively by the caller/plist
elif [[ -f "${SCRIPT_DIR}/../../lib/host-identity.sh" ]] && command -v jq >/dev/null 2>&1; then
  . "${SCRIPT_DIR}/../../lib/host-identity.sh"
  export CATALYST_HOST_NAME="$(catalyst_host_name)"
else
  warn "host.name not authoritatively resolvable here (no jq / no env) — leaving CATALYST_HOST_NAME unset; updater.mjs getHostName() resolves it from Layer-2/OS in JS"
fi

log "starting updater (node=${CATALYST_HOST_NAME:-<os-hostname>}, poll=${CATALYST_UPDATER_POLL_INTERVAL_MS:-90000}ms)"
exec bun "$UPDATER_MJS"
