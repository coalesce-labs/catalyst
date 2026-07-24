#!/usr/bin/env bash
# channel-watcher/launch.sh — CTL-1423. Sources ~/.config/catalyst/channel-watcher.env
# and execs channel-watcher.mjs under bun in the FOREGROUND so launchd KeepAlive
# supervises the real process (death → restart via SuccessfulExit:false).
#
# CATALYST_WATCHER_CHANNEL must be set in the environment or in
# ~/.config/catalyst/channel-watcher.env (0600). The VALUE is never written into
# the world-readable plist — only the launcher knows it.
set -uo pipefail

# ─── SCRIPT_DIR (symlink-walking) ────────────────────────────────────────────
_SRC="${BASH_SOURCE[0]}"
while [[ -L "$_SRC" ]]; do _SRC="$(readlink "$_SRC")"; done
SCRIPT_DIR="$(cd "$(dirname "$_SRC")" && pwd)"
unset _SRC

log()  { printf '[catalyst-channel-watcher] %s\n' "$*"; }
fail() { printf '[catalyst-channel-watcher] ERROR: %s\n' "$*" >&2; exit 1; }

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
export CATALYST_DIR

# ─── Secret hygiene: warn if config env is group/other-readable ─────────────
_warn_if_readable() {
  local f="$1"
  [[ -r "$f" ]] || return 0
  local mode
  mode="$(stat -f '%Lp' "$f" 2>/dev/null || stat -c '%a' "$f" 2>/dev/null || echo '')"
  [[ "$mode" =~ ^[0-7]+$ ]] || return 0
  local grp=$(( ${mode: -2:1} )) oth=$(( ${mode: -1:1} ))
  if (( (grp & 4) != 0 || (oth & 4) != 0 )); then
    printf '[catalyst-channel-watcher] WARN: %s is group/other-readable (mode %s) — chmod 600 it\n' "$f" "$mode" >&2
  fi
}

# ─── Source per-node config (launchd can't see ~/.zshenv/direnv) ─────────────
set +u
_warn_if_readable "$HOME/.config/catalyst/channel-watcher.env"
[[ -r "$HOME/.config/catalyst/channel-watcher.env" ]] && . "$HOME/.config/catalyst/channel-watcher.env"
set -u

# ─── Preflight ───────────────────────────────────────────────────────────────
[[ -n "${CATALYST_WATCHER_CHANNEL:-}" ]] || \
  fail "CATALYST_WATCHER_CHANNEL is required — set it in ~/.config/catalyst/channel-watcher.env"

command -v bun >/dev/null 2>&1 || fail "bun not found on PATH — install it (https://bun.sh)"

DAEMON_MJS="${SCRIPT_DIR}/channel-watcher.mjs"
[[ -f "$DAEMON_MJS" ]] || fail "channel-watcher.mjs not found at $DAEMON_MJS"

log "launching channel-watcher (channel=${CATALYST_WATCHER_CHANNEL})"
exec bun "$DAEMON_MJS"
