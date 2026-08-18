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

# CTL-1968: `gui/$(id -u)` is a PER-USER launchd domain, so a scratch HOME does
# NOT sandbox it — it renders the plist somewhere temporary and then re-binds the
# REAL label to that path. Refuse rather than damage the live domain.
[[ -f "${SCRIPT_DIR}/lib/launchd-domain-guard.sh" ]] || {
  echo "install-orphan-sweep.sh: missing lib/launchd-domain-guard.sh next to this script" >&2; exit 1; }
# shellcheck source=lib/launchd-domain-guard.sh
. "${SCRIPT_DIR}/lib/launchd-domain-guard.sh"
launchd_agent_guard() {
  launchd_guard_ok "the orphan-sweep agent" && return 0
  launchd_guard_message "the orphan-sweep agent" >&2
  echo "install-orphan-sweep.sh: REFUSED (${CATALYST_LAUNCHD_GUARD_REASON})" >&2
  exit 1
}
unset _SRC

# DEST + LABEL do NOT depend on BAKE_DIR — define them up front so --uninstall
# can run without ever resolving (or guarding) a bake dir.
DEST="${HOME}/Library/LaunchAgents/ai.coalesce.catalyst-orphan-sweep.plist"
LABEL="ai.coalesce.catalyst-orphan-sweep"

# ─── flags ──────────────────────────────────────────────────────────────────
#
# Parse flags BEFORE resolving BAKE_DIR or running the ephemeral guard. The guard
# can `exit 1`; running it ahead of flag parsing meant `--uninstall` and `--help`
# from a /tmp checkout or linked worktree exited 1 WITHOUT uninstalling, so
# `catalyst-stack uninstall-services` from such a checkout could not remove the
# agent (CTL-1306). The guard now only gates the install / print paths.

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
#
# CTL-1306: the plist's program path is permanent. The original bug baked
# ${SCRIPT_DIR} verbatim, so installing from a throwaway worktree (e.g.
# /private/tmp/pr1827-wt or ~/catalyst/wt/<TICKET>) wrote a path that later got
# deleted — the reaper then exit-127'd silently every interval, fleet-wide. Fix:
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
  # FAIL OPEN (CTL-1306): a false [[ ... ]] test would otherwise make this
  # function return 1, and under `set -euo pipefail` the caller's
  # BAKE_DIR="$(_pristine_scripts_dir)" would abort the whole installer BEFORE
  # the SCRIPT_DIR fallback — stranding a host whose config exists but has
  # stale/absent pluginDirs with NO reaper. Always exit 0.
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

# _escape_repl VALUE — make VALUE safe to inject into the plist via sed
# (CTL-1510 item 3, kept in lockstep with install-health-responder.sh): a path
# like "/Volumes/Catalyst & Data" otherwise breaks TWICE — `&` is sed's
# whole-match metacharacter (mangled program path → silent exit-127 loop) and
# a raw `&`/`<`/`>` is invalid inside an XML <string>. A sed pipeline, NOT
# bash parameter expansion (Codex P1: /bin/bash 3.2 drops the backslash from
# `${v//&/\\&}`). Backslash-double first, XML-entity-escape second,
# sed-metacharacter-escape last.
_escape_repl() {
  printf '%s' "$1" | sed \
    -e 's/\\/\\\\/g' \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/[&|]/\\&/g'
}

# ── CTL-1531: the widened-branch rollout knob must SURVIVE reinstallation ───
#
# This installer unconditionally regenerates and replaces the LaunchAgent plist,
# and it runs on every routine `catalyst-stack install-services`. Before CTL-1531
# the documented way to flip vector 1's widened branch to `enforce` was to
# hand-edit the installed plist — which the very next install silently reverted.
# A rollout knob a routine reinstall resets is worse than none, so the value is
# now part of the shipped template and is RESOLVED here.
#
# Precedence (each step only applies when it yields off|shadow|enforce):
#   1. an explicit SWEEP_PROC_WIDEN in the installing environment — an operator
#      saying "flip it now": `SWEEP_PROC_WIDEN=enforce bash install-orphan-sweep.sh`
#   2. .catalyst/config.json → catalyst.sweep.procWiden — a declared, committed
#      intent, which should win over a stale value baked into an older plist
#   3. the value ALREADY IN the installed plist — this is the clause that makes a
#      hand-flip survive a routine reinstall
#   4. "shadow" — ADR-023 dark-by-default
# Anything unrecognized falls back to `shadow` LOUDLY (never to `enforce`: a typo
# must not arm a process killer).

_installed_widen_mode() {
  [[ -f "$DEST" ]] || { printf ''; return 0; }
  grep -A2 '<key>SWEEP_PROC_WIDEN</key>' "$DEST" 2>/dev/null \
    | sed -n 's|.*<string>\(.*\)</string>.*|\1|p' \
    | head -1
}

_config_widen_mode() {
  local dir="$PWD" cfg=""
  while [[ "$dir" != "/" && -n "$dir" ]]; do
    if [[ -f "$dir/.catalyst/config.json" ]]; then cfg="$dir/.catalyst/config.json"; break; fi
    dir="$(dirname "$dir")"
  done
  [[ -n "$cfg" ]] && command -v jq >/dev/null 2>&1 || { printf ''; return 0; }
  jq -r '.catalyst.sweep.procWiden // empty' "$cfg" 2>/dev/null || printf ''
}

_resolve_widen_mode() {
  local candidate
  for candidate in "${SWEEP_PROC_WIDEN:-}" "$(_config_widen_mode)" "$(_installed_widen_mode)"; do
    case "$candidate" in
      off|shadow|enforce) printf '%s' "$candidate"; return 0 ;;
      "") ;;
      # SET-BUT-INVALID SHORT-CIRCUITS TO shadow — it must NOT fall through to a
      # lower-precedence source. Continuing the loop meant a mistyped rollback
      # (`SWEEP_PROC_WIDEN=shdow`) was warned about and then IGNORED in favour of
      # an `enforce` already sitting in the config or the installed plist — so the
      # operator's attempt to DISARM the killer re-armed it, contradicting the
      # contract three lines above ("never to enforce: a typo must not arm a
      # process killer"). An explicit-but-unrecognized value is a clear intent to
      # change the mode, and the only safe reading of an unparseable intent is the
      # dark default.
      *)
        echo "install-orphan-sweep.sh: SWEEP_PROC_WIDEN='${candidate}' is not one of off|shadow|enforce — falling back to 'shadow' (NOT to any lower-precedence value)" >&2
        printf 'shadow'
        return 0
        ;;
    esac
  done
  printf 'shadow'
}

_substitute() {
  local interval widen
  interval="$(_interval_seconds)"
  # No _escape_repl needed: _resolve_widen_mode only ever returns one of the
  # three literals off|shadow|enforce, so the substitution can carry no sed
  # metacharacter and no XML-unsafe byte. (Anything else was already rejected.)
  widen="$(_resolve_widen_mode)"
  sed \
    -e "s|REPLACE_WITH_ABSOLUTE|$(_escape_repl "$BAKE_DIR")|g" \
    -e "s|REPLACE_HOME|$(_escape_repl "$HOME")|g" \
    -e "s|REPLACE_START_INTERVAL|${interval}|g" \
    -e "s|REPLACE_SWEEP_PROC_WIDEN|${widen}|g" \
    "$TEMPLATE"
}

# ─── --uninstall ─────────────────────────────────────────────────────────────
#
# Runs BEFORE any BAKE_DIR resolution / ephemeral guard / TEMPLATE — uninstall
# only needs DEST + LABEL, so it must work even from a /tmp checkout or linked
# worktree (CTL-1306). The guard never gates uninstall.

if [[ "$UNINSTALL" -eq 1 ]]; then
  launchd_agent_guard
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "$DEST"
  echo "install-orphan-sweep.sh: uninstalled ${LABEL}"
  exit 0
fi

# ─── non-Darwin early exit ───────────────────────────────────────────────────

if [[ "$(_os)" != "Darwin" ]]; then
  echo "install-orphan-sweep.sh: non-Darwin platform detected ($(_os))." >&2
  echo "  Linux scheduling is a follow-up (CTL-1030). No launchctl action taken." >&2
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
  echo "install-orphan-sweep.sh: refusing to install from an ephemeral path (CTL-1306):" >&2
  echo "  $BAKE_DIR" >&2
  echo "  A linked worktree / temp dir can be deleted, which silently kills the reaper." >&2
  echo "  Run from the pristine clone (e.g. ~/catalyst/plugin-source/plugins/dev/scripts)," >&2
  echo "  or register catalyst.orchestration.pluginDirs in ~/.config/catalyst/config.json." >&2
  exit 1
fi

TEMPLATE="${BAKE_DIR}/orch-monitor/dist/ai.coalesce.catalyst-orphan-sweep.plist"

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

# ─── install ─────────────────────────────────────────────────────────────────

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/catalyst"

local_tmp="${DEST}.tmp"
_substitute > "$local_tmp"
mv "$local_tmp" "$DEST"
echo "install-orphan-sweep.sh: wrote ${DEST}"

# Reload idempotently: bootout any existing instance (ignore failure when not
# loaded), then bootstrap the fresh plist.
launchd_agent_guard
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "install-orphan-sweep.sh: loaded ${LABEL} into gui/$(id -u)"
echo "install-orphan-sweep.sh: verify with 'launchctl list | grep ${LABEL}'"
