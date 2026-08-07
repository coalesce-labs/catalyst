#!/usr/bin/env bash
# install-dependabot-escalate.sh — Idempotently install the dependabot-escalate
# LaunchAgent on macOS: substitute template tokens, write the plist to
# ~/Library/LaunchAgents/, then (re)load via launchctl.
#
# Usage:
#   install-dependabot-escalate.sh             # install / reinstall
#   install-dependabot-escalate.sh --uninstall # unload and remove plist
#   install-dependabot-escalate.sh --print-only # emit substituted plist to stdout
#   install-dependabot-escalate.sh --help
#
# Re-running is safe: an already-loaded agent is booted out before being
# re-bootstrapped, so the latest plist always wins.
#
# Deliberately a LIGHTER-WEIGHT installer than install-health-responder.sh's
# (no dual launchd+cron scheduling backstop): that hardening protects the
# CRITICAL cloud-sync replica writer, where a wedged scheduler silently kills
# Linear read caching fleet-wide. This sweep is a convenience notification
# bridge — a missed hour just means a ticket files an hour late, not a
# correctness incident — so a single launchd StartInterval is proportional.
# The ephemeral-path refusal below IS kept: baking a path that gets deleted
# would silently exit-127 every interval forever, same failure class either
# script has.

set -euo pipefail

_SRC="${BASH_SOURCE[0]}"
while [[ -L "$_SRC" ]]; do _SRC="$(readlink "$_SRC")"; done
SCRIPT_DIR="$(cd "$(dirname "$_SRC")" && pwd)"
unset _SRC

DEST="${HOME}/Library/LaunchAgents/ai.coalesce.catalyst-dependabot-escalate.plist"
LABEL="ai.coalesce.catalyst-dependabot-escalate"

# The config path the sweep will read at run time — same override/default
# resolution as dependabot-escalate.sh itself, resolved HERE (at install
# time) and baked into the plist's EnvironmentVariables (Codex P2): launchd
# does not inherit the installer's shell environment, so an operator who set
# DEPENDABOT_ESCALATE_CONFIG only for this install invocation would otherwise
# have every scheduled run silently fall back to the default path.
DEPENDABOT_ESCALATE_CONFIG_RESOLVED="${DEPENDABOT_ESCALATE_CONFIG:-${HOME}/.config/catalyst/dependabot-escalate-repos.json}"

UNINSTALL=0
PRINT_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --uninstall)  UNINSTALL=1 ;;
    --print-only) PRINT_ONLY=1 ;;
    --help|-h)
      echo "Usage: install-dependabot-escalate.sh [--uninstall|--print-only|--help]"
      echo ""
      echo "  (no flags)    Install / reinstall the LaunchAgent"
      echo "  --uninstall   Unload and remove the plist"
      echo "  --print-only  Print the substituted plist to stdout without installing"
      echo "  --help        Show this message"
      exit 0
      ;;
    *)
      printf 'install-dependabot-escalate.sh: unknown argument: %s (see --help)\n' "$arg" >&2
      exit 2
      ;;
  esac
done

# _pristine_scripts_dir: the scripts dir of the registered pristine clone, or
# "". Same resolution as install-health-responder.sh's helper of the same
# name (Codex P1) — a cache/marketplace checkout is neither a temp dir nor a
# linked worktree, so the ephemeral guard below alone accepts it; baking that
# path means the installed plist points at a location that disappears on the
# next plugin upgrade, silently exit-127ing the sweep every interval. Prefer
# the canonical pluginDirs-registered pristine clone; SCRIPT_DIR is only the
# fallback.
_pristine_scripts_dir() {
  local pd=""
  if [[ -r "${SCRIPT_DIR}/lib/plugin-dirs.sh" ]]; then
    # shellcheck source=/dev/null
    . "${SCRIPT_DIR}/lib/plugin-dirs.sh" 2>/dev/null || true
    if command -v resolve_plugin_dirs >/dev/null 2>&1; then
      # resolve_plugin_dirs POPULATES RESOLVED_PLUGIN_DIRS (no stdout) — call
      # it in THIS shell, not a $(subshell), or the precedence walk is lost.
      resolve_plugin_dirs "$SCRIPT_DIR" 2>/dev/null || true
      pd="${RESOLVED_PLUGIN_DIRS%%:*}"
    fi
  fi
  if [[ -z "$pd" ]]; then
    local cfg="${CATALYST_LAYER2_CONFIG_FILE:-${HOME}/.config/catalyst/config.json}"
    [[ -f "$cfg" ]] && command -v jq >/dev/null 2>&1 || return 0
    pd="$(jq -r '.catalyst.orchestration.pluginDirs | if type=="array" then .[0] elif type=="string" then . else empty end' "$cfg" 2>/dev/null || true)"
  fi
  # pluginDirs points at <clone>/plugins/dev; dependabot-escalate.sh lives
  # under scripts/.
  [[ -n "$pd" && -f "${pd}/scripts/dependabot-escalate.sh" ]] && echo "${pd}/scripts"
  # Fail open, same as install-health-responder.sh: under `set -e`, a false
  # `[[ ... ]]` test would make this function return 1 and abort the caller's
  # BAKE_DIR="$(_pristine_scripts_dir)" before the SCRIPT_DIR fallback runs.
  return 0
}

# Same ephemeral-path refusal as install-health-responder.sh (CTL-1306
# lesson): a linked git worktree or temp dir can be deleted out from under
# the LaunchAgent's baked program path.
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

_os() {
  echo "${CATALYST_FORCE_OS:-$(uname -s)}"
}

# Interval in seconds — hourly by default (dependency-update failures are not
# time-critical the way cloud-sync liveness is; hourly keeps gh/linearis API
# usage light across a growing repo list). Overridable via
# DEPENDABOT_ESCALATE_INTERVAL_SECS for testing.
_interval_seconds() {
  echo "${DEPENDABOT_ESCALATE_INTERVAL_SECS:-3600}"
}

_agent_path() {
  echo "${HOME}/.catalyst/bin:${HOME}/.local/node/bin:${HOME}/.local/bin:${HOME}/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

# Same escaping discipline as install-health-responder.sh's _escape_repl —
# a path containing &, <, or > would otherwise corrupt both the sed
# substitution and the plist XML.
_escape_repl() {
  printf '%s' "$1" | sed \
    -e 's/\\/\\\\/g' \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/[&|]/\\&/g'
}

_substitute() {
  local interval
  interval="$(_interval_seconds)"
  sed \
    -e "s|REPLACE_WITH_ABSOLUTE|$(_escape_repl "$BAKE_DIR")|g" \
    -e "s|REPLACE_HOME|$(_escape_repl "$HOME")|g" \
    -e "s|REPLACE_START_INTERVAL|${interval}|g" \
    -e "s|REPLACE_PATH|$(_escape_repl "$(_agent_path)")|g" \
    -e "s|REPLACE_CONFIG|$(_escape_repl "$DEPENDABOT_ESCALATE_CONFIG_RESOLVED")|g" \
    "$TEMPLATE"
}

if [[ "$UNINSTALL" -eq 1 ]]; then
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "$DEST"
  echo "install-dependabot-escalate.sh: uninstalled ${LABEL}"
  exit 0
fi

if [[ "$(_os)" != "Darwin" && "$PRINT_ONLY" -ne 1 ]]; then
  echo "install-dependabot-escalate.sh: non-Darwin platform detected ($(_os))." >&2
  echo "  Linux scheduling (systemd timer) is a follow-up. No launchctl action taken." >&2
  exit 0
fi

BAKE_DIR="${CATALYST_FORCE_BAKE_DIR:-$(_pristine_scripts_dir)}"
[[ -z "$BAKE_DIR" ]] && BAKE_DIR="$SCRIPT_DIR"
if _is_ephemeral_dir "$BAKE_DIR"; then
  echo "install-dependabot-escalate.sh: refusing to install from an ephemeral path:" >&2
  echo "  $BAKE_DIR" >&2
  echo "  A linked worktree / temp dir can be deleted, which silently kills the sweep." >&2
  echo "  Run from the pristine clone (e.g. ~/catalyst/plugin-source/plugins/dev/scripts)," >&2
  echo "  or register catalyst.orchestration.pluginDirs in ~/.config/catalyst/config.json." >&2
  exit 1
fi

TEMPLATE="${BAKE_DIR}/orch-monitor/dist/ai.coalesce.catalyst-dependabot-escalate.plist"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "install-dependabot-escalate.sh: plist template not found at ${TEMPLATE}" >&2
  exit 1
fi

if [[ "$PRINT_ONLY" -eq 1 ]]; then
  _substitute
  exit 0
fi

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/catalyst"

local_tmp="${DEST}.tmp"
_substitute > "$local_tmp"
mv "$local_tmp" "$DEST"
echo "install-dependabot-escalate.sh: wrote ${DEST}"

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "install-dependabot-escalate.sh: loaded ${LABEL} into gui/$(id -u)"
echo "install-dependabot-escalate.sh: verify with 'launchctl list | grep ${LABEL}'"
