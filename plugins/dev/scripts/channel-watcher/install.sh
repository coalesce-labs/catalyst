#!/usr/bin/env bash
# channel-watcher/install.sh — CTL-1423. Installs (or uninstalls) the
# ai.coalesce.catalyst-channel-watcher launchd agent.
#
# Usage:
#   install.sh              # install: resolve tokens, copy plist, bootstrap
#   install.sh --dry-run    # print resolved plist without writing
#   install.sh --uninstall  # bootout + remove plist
set -uo pipefail

# ─── SCRIPT_DIR (symlink-walking) ────────────────────────────────────────────
_SRC="${BASH_SOURCE[0]}"
while [[ -L "$_SRC" ]]; do _SRC="$(readlink "$_SRC")"; done
SCRIPT_DIR="$(cd "$(dirname "$_SRC")" && pwd)"
unset _SRC

LABEL="ai.coalesce.catalyst-channel-watcher"
PLIST_TEMPLATE="${SCRIPT_DIR}/${LABEL}.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LAUNCH_SH="${SCRIPT_DIR}/launch.sh"

fail() { printf '[install-channel-watcher] ERROR: %s\n' "$*" >&2; exit 1; }
log()  { printf '[install-channel-watcher] %s\n' "$*"; }

# ─── Resolve tokens ──────────────────────────────────────────────────────────
_resolve_plist() {
  [[ -f "$PLIST_TEMPLATE" ]] || fail "plist template not found: $PLIST_TEMPLATE"
  local launch_abs
  launch_abs="$(cd "${SCRIPT_DIR}" && pwd)/launch.sh"
  local bun_path
  bun_path="$(command -v bun 2>/dev/null || echo bun)"

  # Build a safe PATH string: current PATH + bun's bin dir prepended.
  local bun_bin=""
  if [[ "$bun_path" != "bun" ]]; then
    bun_bin="$(dirname "$bun_path"):"
  fi
  local full_path="${bun_bin}${HOME}/.local/bin:${HOME}/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

  sed \
    -e "s|REPLACE_WITH_LAUNCH_SH_ABS_PATH|${launch_abs}|g" \
    -e "s|REPLACE_WITH_HOME|${HOME}|g" \
    -e "s|REPLACE_WITH_PATH|${full_path}|g" \
    "$PLIST_TEMPLATE"
}

# ─── Dispatch ────────────────────────────────────────────────────────────────
case "${1:-}" in
  --dry-run)
    _resolve_plist
    ;;

  --uninstall)
    if launchctl list "$LABEL" >/dev/null 2>&1; then
      launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || \
        launchctl unload "$PLIST_DST" 2>/dev/null || true
      log "unloaded $LABEL"
    fi
    if [[ -f "$PLIST_DST" ]]; then
      rm -f "$PLIST_DST"
      log "removed $PLIST_DST"
    else
      log "plist not found at $PLIST_DST (already removed?)"
    fi
    ;;

  "")
    mkdir -p "$(dirname "$PLIST_DST")"
    _resolve_plist > "$PLIST_DST"
    log "wrote $PLIST_DST"
    # Load — best-effort; macOS version differences
    launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || \
      launchctl load -w "$PLIST_DST" 2>/dev/null || true
    log "loaded $LABEL (check: launchctl list $LABEL)"
    ;;

  *)
    fail "unknown argument: ${1:-}. Usage: install.sh [--dry-run|--uninstall]"
    ;;
esac
