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
  # Optional <anchor> dir for the repo-config walk (default $PWD). CTL-1349: verify-updater
  # passes SCRIPT_DIR so it resolves the SAME checkout the updater daemon does (the daemon
  # anchors repo-config at updater.mjs, not the operator's cwd) — otherwise running verify
  # from another directory could check a different checkout's pluginDirs.
  local anchor="${1:-$PWD}"
  RESOLVED_PLUGIN_DIRS=""
  RESOLVED_PLUGIN_DIRS_SOURCE="none"

  if [[ -n "${CATALYST_PLUGIN_DIRS:-}" ]]; then
    RESOLVED_PLUGIN_DIRS="$CATALYST_PLUGIN_DIRS"
    RESOLVED_PLUGIN_DIRS_SOURCE="env"
    return 0
  fi

  local v
  v="$(__plugin_dirs_from_file "$(plugin_dirs_repo_config_path "$anchor")")"
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

# plugin_source_health PLUGIN_DIR — offline, read-only structural health check
# of a pluginDirs checkout (CTL-992). Emits zero or more TYPED warning lines to
# stdout (stable prefix tokens so callers can switch on them, mirroring the
# catalyst-stack drift() taxonomy) and returns the line count as the exit code
# (0 = healthy). Dependency-light (only git); never fetches (freshness vs
# origin stays in `catalyst-stack parity`, which fetches) and never exits.
#
# Typed lines (one per detected problem, first match wins per checkout):
#   MISSING <pd>                  the pluginDirs entry does not exist
#   NOT_A_CHECKOUT <pd>           exists but is not inside a git checkout
#   LINKED_WORKTREE <root>        resolves to a git linked worktree, not a
#                                 standalone pristine checkout
#   OFF_MAIN <root> <branch>      checkout HEAD is not on main
#   DIRTY <root>                  working tree has uncommitted changes
plugin_source_health() {
  local pd="$1"
  local n=0

  if [[ ! -d "$pd" ]]; then
    printf 'MISSING %s\n' "$pd"
    return 1
  fi

  local root
  root="$(git -C "$pd" rev-parse --show-toplevel 2>/dev/null)"
  if [[ -z "$root" ]]; then
    printf 'NOT_A_CHECKOUT %s\n' "$pd"
    return 1
  fi

  # Linked worktree: its per-worktree git dir differs from the shared common
  # dir. A pristine plugin source must be a standalone checkout, never a
  # worktree linked to some other primary repo. Resolve both to absolute paths
  # ourselves (--git-common-dir can be relative on older git) before comparing.
  local git_dir common_dir
  git_dir="$(git -C "$root" rev-parse --absolute-git-dir 2>/dev/null)"
  common_dir="$(git -C "$root" rev-parse --git-common-dir 2>/dev/null)"
  if [[ -n "$common_dir" && "$common_dir" != /* ]]; then
    common_dir="$(cd "$root" && cd "$common_dir" 2>/dev/null && pwd -P)"
  fi
  if [[ -n "$git_dir" && -n "$common_dir" && "$git_dir" != "$common_dir" ]]; then
    printf 'LINKED_WORKTREE %s\n' "$root"
    n=$((n + 1))
  fi

  # Off main: workers must run from a pristine main-only checkout.
  local branch
  branch="$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [[ -n "$branch" && "$branch" != "main" ]]; then
    printf 'OFF_MAIN %s %s\n' "$root" "$branch"
    n=$((n + 1))
  fi

  # Dirty: a dirty tree blocks the ff-only auto-pull.
  if [[ -n "$(git -C "$root" status --porcelain 2>/dev/null)" ]]; then
    printf 'DIRTY %s\n' "$root"
    n=$((n + 1))
  fi

  return "$n"
}
