#!/usr/bin/env bash
# event-mirror/launch.sh — CTL-1654: launch the event-mirror daemon under launchd.
# Models on execution-core/cloud-sync/launch.sh — symlink-walking SCRIPT_DIR,
# canonicalized writer path, exec bun in the foreground so launchd KeepAlive
# supervises the REAL daemon (death → restart without a nohup & disown).
#
# WHY A LAUNCHER
#   launchd does NOT source ~/.zshenv and does NOT run direnv, so env-specific
#   config (CATALYST_EVENT_MIRROR_HOSTS, etc.) must arrive via plist
#   EnvironmentVariables or this launcher. The launcher resolves and exec-s the
#   writer so pgrep-by-path liveness checks (catalyst-stack, verify-node) see
#   the canonical `event-mirror/index.ts` path.
set -uo pipefail

# ─── SCRIPT_DIR (symlink-walking) ─────────────────────────────────────────────
_SRC="${BASH_SOURCE[0]}"
while [[ -L "$_SRC" ]]; do _SRC="$(readlink "$_SRC")"; done
SCRIPT_DIR="$(cd "$(dirname "$_SRC")" && pwd)"
unset _SRC

log()  { printf '[catalyst-event-mirror] %s\n' "$*"; }
fail() { printf '[catalyst-event-mirror] ERROR: %s\n' "$*" >&2; exit 1; }

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
export CATALYST_DIR

# ─── Preflight ────────────────────────────────────────────────────────────────
command -v bun >/dev/null 2>&1 || fail "bun not found on PATH — install it (https://bun.sh)"

# CANONICALIZE the writer path (collapse any `..`) so the launched argv is a
# clean `.../event-mirror/index.ts` — otherwise pgrep-by-path liveness checks
# (catalyst-stack _vn_event_mirror_running) see `event-mirror/../index.ts` and miss it.
WRITER_TS="${SCRIPT_DIR}/index.ts"
[[ -f "$WRITER_TS" ]] || fail "index.ts not found at $WRITER_TS"

log "launching event-mirror (hosts=${CATALYST_EVENT_MIRROR_HOSTS:-<from cluster.json>})"
exec bun "$WRITER_TS"
