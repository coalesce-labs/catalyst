#!/usr/bin/env bash
# install-orphan-sweep.sh — Idempotently install the catalyst orphan-sweep
# LaunchAgent on macOS: substitute template tokens, write the plist to
# ~/Library/LaunchAgents/, then (re)load via launchctl.
#
# Usage:
#   install-orphan-sweep.sh            # install / reinstall
#   install-orphan-sweep.sh --uninstall # unload and remove plist
#   install-orphan-sweep.sh --print-only # emit substituted plist to stdout
#   install-orphan-sweep.sh --help
#
# Re-running is safe: an already-loaded agent is booted out before being
# re-bootstrapped, so the latest plist always wins.

set -euo pipefail

# Resolve script dir following symlinks (same pattern as orphan-sweep.sh).
_SRC="${BASH_SOURCE[0]}"
while [[ -L "$_SRC" ]]; do _SRC="$(readlink "$_SRC")"; done
SCRIPT_DIR="$(cd "$(dirname "$_SRC")" && pwd)"
unset _SRC

TEMPLATE="${SCRIPT_DIR}/orch-monitor/dist/ai.coalesce.catalyst-orphan-sweep.plist"
DEST="${HOME}/Library/LaunchAgents/ai.coalesce.catalyst-orphan-sweep.plist"
LABEL="ai.coalesce.catalyst-orphan-sweep"

# ─── flags ──────────────────────────────────────────────────────────────────

UNINSTALL=0
PRINT_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --uninstall)  UNINSTALL=1 ;;
    --print-only) PRINT_ONLY=1 ;;
    --help|-h)
      echo "Usage: install-orphan-sweep.sh [--uninstall|--print-only|--help]"
      echo ""
      echo "  (no flags)    Install / reinstall the LaunchAgent"
      echo "  --uninstall   Unload and remove the plist"
      echo "  --print-only  Print the substituted plist to stdout without installing"
      echo "  --help        Show this message"
      exit 0
      ;;
  esac
done

# ─── helpers ────────────────────────────────────────────────────────────────

# _os: returns 'Darwin' or 'Linux', controllable via CATALYST_FORCE_OS.
_os() {
  echo "${CATALYST_FORCE_OS:-$(uname -s)}"
}

# _interval_seconds: read .catalyst/config.json for sweep.intervalHours,
# clamp to 1|2|3 (default 1), multiply by 3600.
_interval_seconds() {
  local hours=1
  local config_candidate=""

  # Walk up from $PWD looking for .catalyst/config.json.
  local dir="$PWD"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/.catalyst/config.json" ]]; then
      config_candidate="$dir/.catalyst/config.json"
      break
    fi
    dir="$(dirname "$dir")"
  done

  if [[ -n "$config_candidate" ]] && command -v jq >/dev/null 2>&1; then
    local raw
    raw="$(jq -r '.catalyst.sweep.intervalHours // empty' "$config_candidate" 2>/dev/null || true)"
    if [[ -n "$raw" ]] && [[ "$raw" =~ ^[0-9]+$ ]]; then
      hours="$raw"
    fi
  fi

  # Clamp to 1–3.
  if [[ "$hours" -lt 1 ]]; then
    hours=1
  elif [[ "$hours" -gt 3 ]]; then
    hours=3
  fi

  echo $(( hours * 3600 ))
}

# ─── template substitution ──────────────────────────────────────────────────

_substitute() {
  local interval
  interval="$(_interval_seconds)"
  sed \
    -e "s|REPLACE_WITH_ABSOLUTE|${SCRIPT_DIR}|g" \
    -e "s|REPLACE_HOME|${HOME}|g" \
    -e "s|REPLACE_START_INTERVAL|${interval}|g" \
    "$TEMPLATE"
}

# ─── non-Darwin early exit ───────────────────────────────────────────────────

if [[ "$(_os)" != "Darwin" ]]; then
  echo "install-orphan-sweep.sh: non-Darwin platform detected ($(_os))." >&2
  echo "  Linux scheduling is a follow-up (CTL-1030). No launchctl action taken." >&2
  exit 0
fi

# ─── template sanity check ──────────────────────────────────────────────────

if [[ ! -f "$TEMPLATE" ]]; then
  echo "install-orphan-sweep.sh: plist template not found at ${TEMPLATE}" >&2
  exit 1
fi

# ─── --print-only ────────────────────────────────────────────────────────────

if [[ "$PRINT_ONLY" -eq 1 ]]; then
  _substitute
  exit 0
fi

# ─── --uninstall ─────────────────────────────────────────────────────────────

if [[ "$UNINSTALL" -eq 1 ]]; then
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "$DEST"
  echo "install-orphan-sweep.sh: uninstalled ${LABEL}"
  exit 0
fi

# ─── install ─────────────────────────────────────────────────────────────────

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/catalyst"

local_tmp="${DEST}.tmp"
_substitute > "$local_tmp"
mv "$local_tmp" "$DEST"
echo "install-orphan-sweep.sh: wrote ${DEST}"

# Reload idempotently: bootout any existing instance (ignore failure when not
# loaded), then bootstrap the fresh plist.
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "install-orphan-sweep.sh: loaded ${LABEL} into gui/$(id -u)"
echo "install-orphan-sweep.sh: verify with 'launchctl list | grep ${LABEL}'"
