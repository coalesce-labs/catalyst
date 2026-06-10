#!/usr/bin/env bash
# lib/plugin-dirs.sh — single source of truth for resolving the per-host
# plugin checkout (CTL-940).
#
# Mirrors the resolution order phase-agent-dispatch uses when it builds
# `--plugin-dir` flags for worker sessions (PR #1614):
#
#   1. CATALYST_PLUGIN_DIRS env (colon-separated)
#   2. repo .catalyst/config.json  → .catalyst.orchestration.pluginDirs
#   3. machine config ${CATALYST_MACHINE_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/catalyst/config.json}
#      → .catalyst.orchestration.pluginDirs
#
# pluginDirs may be a string or an array in either config file; arrays are
# joined with ":". Consumers that update the checkout (catalyst-stack
# --hotpatch, node-freshness.sh) MUST resolve through this lib so the dir
# they update is exactly the dir the dispatcher hands to workers.
#
# Idempotent-source guard — safe to source multiple times.
[[ -n "${_CATALYST_PLUGIN_DIRS_SH_LOADED:-}" ]] && return 0
_CATALYST_PLUGIN_DIRS_SH_LOADED=1

# plugin_dirs_machine_config_path — echoes the machine-config path
# (CTL-689 convention; CATALYST_MACHINE_CONFIG overrides for tests).
plugin_dirs_machine_config_path() {
  printf '%s' "${CATALYST_MACHINE_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/catalyst/config.json}"
}

# plugin_dirs_repo_config_path [START_DIR] — walk up from START_DIR (default
# $PWD) looking for .catalyst/config.json; echoes its path or "".
plugin_dirs_repo_config_path() {
  local dir="${1:-$PWD}"
  while [[ "$dir" != "/" && -n "$dir" ]]; do
    if [[ -f "${dir}/.catalyst/config.json" ]]; then
      printf '%s' "${dir}/.catalyst/config.json"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  printf ''
}

# __plugin_dirs_from_file FILE — extract pluginDirs from one config file.
# Same jq program as phase-agent-dispatch:891 (string-or-array tolerant).
__plugin_dirs_from_file() {
  local file="$1"
  [[ -n "$file" && -f "$file" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  jq -r '.catalyst.orchestration.pluginDirs
         | if type=="array" then join(":") else . end // empty' \
    "$file" 2>/dev/null || true
}

# resolve_plugin_dirs — resolves pluginDirs into globals (no subshell needed):
#   RESOLVED_PLUGIN_DIRS        colon-separated dirs, "" when unset anywhere
#   RESOLVED_PLUGIN_DIRS_SOURCE env | repo-config | machine-config | none
resolve_plugin_dirs() {
  RESOLVED_PLUGIN_DIRS=""
  RESOLVED_PLUGIN_DIRS_SOURCE="none"

  if [[ -n "${CATALYST_PLUGIN_DIRS:-}" ]]; then
    RESOLVED_PLUGIN_DIRS="$CATALYST_PLUGIN_DIRS"
    RESOLVED_PLUGIN_DIRS_SOURCE="env"
    return 0
  fi

  local v
  v="$(__plugin_dirs_from_file "$(plugin_dirs_repo_config_path)")"
  if [[ -n "$v" ]]; then
    RESOLVED_PLUGIN_DIRS="$v"
    RESOLVED_PLUGIN_DIRS_SOURCE="repo-config"
    return 0
  fi

  v="$(__plugin_dirs_from_file "$(plugin_dirs_machine_config_path)")"
  if [[ -n "$v" ]]; then
    RESOLVED_PLUGIN_DIRS="$v"
    RESOLVED_PLUGIN_DIRS_SOURCE="machine-config"
    return 0
  fi
  return 0
}

# plugin_checkout_root PLUGIN_DIR — echoes the git toplevel containing the
# plugin dir (pluginDirs entries point at <checkout>/plugins/dev). Returns
# non-zero (and echoes nothing) when the dir is not inside a git checkout.
plugin_checkout_root() {
  local pd="$1"
  [[ -d "$pd" ]] || return 1
  git -C "$pd" rev-parse --show-toplevel 2>/dev/null
}
