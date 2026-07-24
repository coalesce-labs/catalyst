#!/usr/bin/env bash
# install-health-responder.sh — Idempotently install the catalyst cloud-sync
# health-responder LaunchAgent on macOS: substitute template tokens, write the
# plist to ~/Library/LaunchAgents/, then (re)load via launchctl.
#
# Usage:
#   install-health-responder.sh            # install / reinstall
#   install-health-responder.sh --uninstall # unload and remove plist
#   install-health-responder.sh --print-only # emit substituted plist to stdout
#   install-health-responder.sh --help
#
# Re-running is safe: an already-loaded agent is booted out before being
# re-bootstrapped, so the latest plist always wins.
#
# Structure mirrors install-orphan-sweep.sh (CTL-1306) verbatim — same
# pristine-clone path resolution, same ephemeral-path hard-refusal, same
# flags-before-guard ordering — because the failure mode is identical: the
# plist's baked program path is permanent, and baking a worktree/temp path
# means a silently exit-127ing responder after that checkout is deleted.

set -euo pipefail

# Resolve script dir following symlinks (same pattern as health-responder.sh).
_SRC="${BASH_SOURCE[0]}"
while [[ -L "$_SRC" ]]; do _SRC="$(readlink "$_SRC")"; done
SCRIPT_DIR="$(cd "$(dirname "$_SRC")" && pwd)"
unset _SRC

# DEST + LABEL do NOT depend on BAKE_DIR — define them up front so --uninstall
# can run without ever resolving (or guarding) a bake dir.
DEST="${HOME}/Library/LaunchAgents/ai.coalesce.catalyst-health-responder.plist"
LABEL="ai.coalesce.catalyst-health-responder"

# ─── flags ──────────────────────────────────────────────────────────────────
#
# Parse flags BEFORE resolving BAKE_DIR or running the ephemeral guard. The guard
# can `exit 1`; running it ahead of flag parsing would mean `--uninstall` and
# `--help` from a /tmp checkout or linked worktree exit 1 WITHOUT uninstalling
# (the CTL-1306 lesson from install-orphan-sweep.sh). The guard only gates the
# install / print paths.

UNINSTALL=0
PRINT_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --uninstall)  UNINSTALL=1 ;;
    --print-only) PRINT_ONLY=1 ;;
    --help|-h)
      echo "Usage: install-health-responder.sh [--uninstall|--print-only|--help]"
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
#
# CTL-1306 (inherited): the plist's program path is permanent. Installing from a
# throwaway worktree (e.g. /private/tmp/... or ~/catalyst/wt/<TICKET>) would
# bake a path that later gets deleted — the responder then exit-127s silently
# every interval, which for THIS agent means the fleet loses its cloud-sync
# self-healer exactly when nobody is watching. So:
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
  # pluginDirs points at <clone>/plugins/dev; health-responder.sh lives under scripts/.
  [[ -n "$pd" && -f "${pd}/scripts/health-responder.sh" ]] && echo "${pd}/scripts"
  # FAIL OPEN (CTL-1306): a false [[ ... ]] test would otherwise make this
  # function return 1, and under `set -euo pipefail` the caller's
  # BAKE_DIR="$(_pristine_scripts_dir)" would abort the whole installer BEFORE
  # the SCRIPT_DIR fallback — stranding a host whose config exists but has
  # stale/absent pluginDirs with NO responder. Always exit 0.
  return 0
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

# _os: returns 'Darwin' or 'Linux', controllable via CATALYST_FORCE_OS.
_os() {
  echo "${CATALYST_FORCE_OS:-$(uname -s)}"
}

# _interval_seconds: read .catalyst/config.json for responder.intervalSeconds,
# clamp to 60–900 (default 180).
_interval_seconds() {
  local secs=180
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
    raw="$(jq -r '.catalyst.responder.intervalSeconds // empty' "$config_candidate" 2>/dev/null || true)"
    if [[ -n "$raw" ]] && [[ "$raw" =~ ^[0-9]+$ ]]; then
      secs="$raw"
    fi
  fi

  # Clamp to 60–900: below 60 the responder churns launchctl/pgrep for nothing;
  # above 900 a dead writer outlives the read tier's 300s serve gate too long.
  if [[ "$secs" -lt 60 ]]; then
    secs=60
  elif [[ "$secs" -gt 900 ]]; then
    secs=900
  fi

  echo "$secs"
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

# ─── --uninstall ─────────────────────────────────────────────────────────────
#
# Runs BEFORE any BAKE_DIR resolution / ephemeral guard / TEMPLATE — uninstall
# only needs DEST + LABEL, so it must work even from a /tmp checkout or linked
# worktree (CTL-1306). The guard never gates uninstall.

if [[ "$UNINSTALL" -eq 1 ]]; then
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "$DEST"
  echo "install-health-responder.sh: uninstalled ${LABEL}"
  exit 0
fi

# ─── non-Darwin early exit ───────────────────────────────────────────────────

if [[ "$(_os)" != "Darwin" ]]; then
  echo "install-health-responder.sh: non-Darwin platform detected ($(_os))." >&2
  echo "  Linux scheduling (systemd timer) is a follow-up. No launchctl action taken." >&2
  exit 0
fi

# ─── resolve BAKE_DIR + ephemeral guard + TEMPLATE (install / print only) ─────
#
# Only reached for the install and --print-only paths; uninstall + help have
# already exited. BAKE_DIR: prefer the pristine clone; else SCRIPT_DIR. The guard
# STILL fires for a plain install and for --print-only.

BAKE_DIR="${CATALYST_FORCE_BAKE_DIR:-$(_pristine_scripts_dir)}"
[[ -z "$BAKE_DIR" ]] && BAKE_DIR="$SCRIPT_DIR"
if _is_ephemeral_dir "$BAKE_DIR"; then
  echo "install-health-responder.sh: refusing to install from an ephemeral path (CTL-1306):" >&2
  echo "  $BAKE_DIR" >&2
  echo "  A linked worktree / temp dir can be deleted, which silently kills the responder." >&2
  echo "  Run from the pristine clone (e.g. ~/catalyst/plugin-source/plugins/dev/scripts)," >&2
  echo "  or register catalyst.orchestration.pluginDirs in ~/.config/catalyst/config.json." >&2
  exit 1
fi

TEMPLATE="${BAKE_DIR}/orch-monitor/dist/ai.coalesce.catalyst-health-responder.plist"

# ─── template sanity check ──────────────────────────────────────────────────

if [[ ! -f "$TEMPLATE" ]]; then
  echo "install-health-responder.sh: plist template not found at ${TEMPLATE}" >&2
  exit 1
fi

# ─── --print-only ────────────────────────────────────────────────────────────

if [[ "$PRINT_ONLY" -eq 1 ]]; then
  _substitute
  exit 0
fi

# ─── install ─────────────────────────────────────────────────────────────────

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/catalyst"

local_tmp="${DEST}.tmp"
_substitute > "$local_tmp"
mv "$local_tmp" "$DEST"
echo "install-health-responder.sh: wrote ${DEST}"

# Reload idempotently: bootout any existing instance (ignore failure when not
# loaded), then bootstrap the fresh plist.
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "install-health-responder.sh: loaded ${LABEL} into gui/$(id -u)"
echo "install-health-responder.sh: verify with 'launchctl list | grep ${LABEL}'"
