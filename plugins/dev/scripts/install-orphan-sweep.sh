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

# ─── CTL-1306: bake the CANONICAL pristine-clone path, never an ephemeral one ──
#
# The plist's program path is permanent. The original bug baked ${SCRIPT_DIR}
# verbatim, so installing from a throwaway worktree (e.g. /private/tmp/pr1827-wt
# or ~/catalyst/wt/<TICKET>) wrote a path that later got deleted — the reaper
# then exit-127'd silently every interval, fleet-wide. Fix:
#   1. Prefer the registered pristine clone (catalyst.orchestration.pluginDirs →
#      the main-only ~/catalyst/plugin-source that wrappers + daemons resolve to).
#   2. HARD-REFUSE to bake a path inside a *linked git worktree* or a temp dir —
#      those are exactly the paths that vanish. A real clone (plugin-source, a
#      main checkout) has git-dir == git-common-dir; a linked worktree does not.
#
# CATALYST_LAYER2_CONFIG_FILE overridable for tests; CATALYST_FORCE_BAKE_DIR lets
# tests inject a resolved dir without a real config/clone.

# _pristine_scripts_dir: the scripts dir of the registered pristine clone, or "".
_pristine_scripts_dir() {
  local cfg="${CATALYST_LAYER2_CONFIG_FILE:-${HOME}/.config/catalyst/config.json}"
  [[ -f "$cfg" ]] && command -v jq >/dev/null 2>&1 || return 0
  local pd
  # pluginDirs is polymorphic (join-bundle.mjs:61): a string, or an array whose
  # first element is the active dir. Normalize both to a single path.
  pd="$(jq -r '.catalyst.orchestration.pluginDirs | if type=="array" then .[0] elif type=="string" then . else empty end' "$cfg" 2>/dev/null || true)"
  # pluginDirs points at <clone>/plugins/dev; orphan-sweep.sh lives under scripts/.
  [[ -n "$pd" && -f "${pd}/scripts/orphan-sweep.sh" ]] && echo "${pd}/scripts"
}

# _is_ephemeral_dir <dir>: true if the dir is a linked git worktree or under a
# temp root — i.e. a path that can be deleted out from under the LaunchAgent.
# A linked worktree's git dir is always <main>/.git/worktrees/<name>; a real
# clone's is <clone>/.git — so the /worktrees/ segment cleanly distinguishes them.
_is_ephemeral_dir() {
  local d="$1"
  case "$d" in
    /private/tmp/*|/tmp/*|/var/tmp/*|/var/folders/*|*/.Trash/*) return 0 ;;
  esac
  command -v git >/dev/null 2>&1 || return 1
  local gd
  gd="$(git -C "$d" rev-parse --absolute-git-dir 2>/dev/null)" || return 1
  case "$gd" in
    */worktrees/*) return 0 ;;
  esac
  return 1
}

# BAKE_DIR: prefer the pristine clone; else SCRIPT_DIR. Refuse ephemeral targets.
BAKE_DIR="${CATALYST_FORCE_BAKE_DIR:-$(_pristine_scripts_dir)}"
[[ -z "$BAKE_DIR" ]] && BAKE_DIR="$SCRIPT_DIR"
if _is_ephemeral_dir "$BAKE_DIR"; then
  echo "install-orphan-sweep.sh: refusing to install from an ephemeral path (CTL-1306):" >&2
  echo "  $BAKE_DIR" >&2
  echo "  A linked worktree / temp dir can be deleted, which silently kills the reaper." >&2
  echo "  Run from the pristine clone (e.g. ~/catalyst/plugin-source/plugins/dev/scripts)," >&2
  echo "  or register catalyst.orchestration.pluginDirs in ~/.config/catalyst/config.json." >&2
  exit 1
fi

TEMPLATE="${BAKE_DIR}/orch-monitor/dist/ai.coalesce.catalyst-orphan-sweep.plist"
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
    -e "s|REPLACE_WITH_ABSOLUTE|${BAKE_DIR}|g" \
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
