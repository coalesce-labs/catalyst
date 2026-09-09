#!/usr/bin/env bash
# lib/catalyst-runtime-root.sh — single source of truth for three resolver
# questions that were previously answered by N hand-rolled, independently
# drifting copies scattered across the plugin tree (CTL-1628 Phase A2):
#
#   Q1. Where is the catalyst-dev `scripts/` dir?  → catalyst_dev_scripts
#   Q3. What is the enclosing plugin's root dir?    → catalyst_plugin_root
#   —   What kind of install is this process in?    → catalyst_runtime_layout
#
# zsh/bash-safe (this file is sourced directly by zsh AND bash, from a
# skill's bash block or interactively): no bash-only array subscripting
# outside functions, no `${(%)...}` zsh-only expansion, globs guarded via
# `ls -d ... 2>/dev/null`, self-location branches on $ZSH_VERSION instead of
# relying on ${BASH_SOURCE} directly (empty-but-legal in zsh, populated in
# bash) — see the self-location block below.
#
# Idempotent-source guard — safe to source multiple times (mirrors
# lib/plugin-dirs.sh's own guard).
[ -n "${_CATALYST_RUNTIME_ROOT_SH_LOADED:-}" ] && return 0
_CATALYST_RUNTIME_ROOT_SH_LOADED=1

# ─── Self-location (to source the sibling lib/plugin-dirs.sh) ───────────────
#
# Plain zsh: $0 is the sourced file's path. Plain bash: $0 stays the parent
# shell/script's own name on `source`, but $BASH_SOURCE (no index — bash
# implicitly reads element 0) is the sourced file's path. Referencing
# $BASH_SOURCE under zsh is legal (evaluates empty, not a syntax error), so
# branching on $ZSH_VERSION — never on `${(%)...}`, which bash cannot even
# parse — keeps this file source-able verbatim by both shells, including
# under `set -euo pipefail` callers.
if [ -n "${ZSH_VERSION:-}" ]; then
  __crr_self="$0"
elif [ -n "${BASH_SOURCE:-}" ]; then
  __crr_self="${BASH_SOURCE}"
else
  __crr_self="$0"
fi
__crr_lib_dir="$(cd "$(dirname "$__crr_self")" 2>/dev/null && pwd)"
unset __crr_self

# plugin-dirs.sh lives next to this file (both in scripts/lib/). Sourced
# for plugin_checkout_root, reused by catalyst_runtime_layout below to tell
# a source checkout apart from an installed (marketplace/cache) layout.
# Best-effort: if the sibling is somehow absent (a hermetic test fixture
# that copies this file alone), catalyst_runtime_layout degrades to
# path-pattern-only classification rather than failing to source.
if [ -n "$__crr_lib_dir" ] && [ -f "${__crr_lib_dir}/plugin-dirs.sh" ]; then
  # shellcheck source=lib/plugin-dirs.sh
  . "${__crr_lib_dir}/plugin-dirs.sh"
fi
unset __crr_lib_dir

# ─── Q1: catalyst_dev_scripts [requesting_plugin] ────────────────────────────
#
# Resolves the shared catalyst-dev `scripts/` dir into CATALYST_DEV_SCRIPTS
# (exported) and returns 0, or prints a LOUD actionable error to stderr and
# returns 1. This is the exact probe order, sentinel, and `sort -V` newest-
# wins semantics proven in plugins/foundry/scripts/require-catalyst-dev.sh —
# lifted verbatim (CTL-1628 Phase A2) so that file can fold onto this single
# implementation instead of hand-maintaining a second copy. (Its former
# plugins/legacy twin was removed with the catalyst-legacy plugin, CTL-2241.)
#
# Resolution order (first dir containing the sentinel wins):
#   1. $CATALYST_DEV_SCRIPTS if already valid
#   2. sibling in a source checkout:  <requesting_plugin>/../dev/scripts
#   3. repo-root cwd:                 ./plugins/dev/scripts
#   4. installed marketplace clone:   ~/.claude/plugins/marketplaces/*/plugins/dev/scripts
#   5. installed versioned cache:     ~/.claude/plugins/cache/*/catalyst-dev/*/scripts
#
# Usage:
#   source ".../lib/catalyst-runtime-root.sh"
#   catalyst_dev_scripts "${CLAUDE_PLUGIN_ROOT:-plugins/foundry}" || exit 1
#   "$CATALYST_DEV_SCRIPTS/check-setup.sh"   # scripts now resolvable
catalyst_dev_scripts() {
  __cd_requesting_plugin="${1:-${CLAUDE_PLUGIN_ROOT:-}}"
  __cd_sentinel="check-project-setup.sh"

  __cd_valid() { [ -n "$1" ] && [ -d "$1" ] && [ -f "$1/$__cd_sentinel" ]; }

  __cd_resolve() {
    if __cd_valid "${CATALYST_DEV_SCRIPTS:-}"; then printf '%s\n' "$CATALYST_DEV_SCRIPTS"; return 0; fi
    if [ -n "$__cd_requesting_plugin" ]; then
      __cd_sib="$( cd "$__cd_requesting_plugin/../dev/scripts" 2>/dev/null && pwd )"
      __cd_valid "$__cd_sib" && { printf '%s\n' "$__cd_sib"; return 0; }
    fi
    __cd_root="$( cd "./plugins/dev/scripts" 2>/dev/null && pwd )"
    __cd_valid "$__cd_root" && { printf '%s\n' "$__cd_root"; return 0; }
    # CTL-1628 A2 post-merge fix: these two rungs used to pick the SINGLE
    # newest candidate (`sort -V | tail -1`) and validate only that one — if
    # the newest install was partial/broken (sentinel missing), the WHOLE
    # rung failed even when an older, fully-valid install sat right next to
    # it. Concretely, register-thought.sh delegates here to find
    # workflow-context.sh: catalyst_dev_scripts validates a DIFFERENT
    # sentinel (check-project-setup.sh), so a newest cache dir that passes
    # THIS sentinel but happens to be missing workflow-context.sh specifically
    # would shadow an older cache dir that has it. Walk candidates
    # newest-to-oldest (`sort -rV`) and take the first one that validates,
    # via a heredoc-fed loop (not a pipe) so `return` propagates out of
    # __cd_resolve rather than exiting an unwanted subshell.
    __cd_mkt_list="$( ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/dev/scripts 2>/dev/null | sort -rV )"
    if [ -n "$__cd_mkt_list" ]; then
      while IFS= read -r __cd_mkt; do
        __cd_valid "$__cd_mkt" && { printf '%s\n' "$__cd_mkt"; return 0; }
      done <<__CD_MKT_EOF__
$__cd_mkt_list
__CD_MKT_EOF__
    fi
    __cd_cache_list="$( ls -d "$HOME"/.claude/plugins/cache/*/catalyst-dev/*/scripts 2>/dev/null | sort -rV )"
    if [ -n "$__cd_cache_list" ]; then
      while IFS= read -r __cd_cache; do
        __cd_valid "$__cd_cache" && { printf '%s\n' "$__cd_cache"; return 0; }
      done <<__CD_CACHE_EOF__
$__cd_cache_list
__CD_CACHE_EOF__
    fi
    return 1
  }

  CATALYST_DEV_SCRIPTS="$( __cd_resolve || true )"   # || true: survive caller's set -e on miss
  if [ -z "$CATALYST_DEV_SCRIPTS" ]; then
    echo "ERROR: this skill requires the 'catalyst-dev' plugin (the shared framework core)." >&2
    echo "       catalyst-dev provides the backing scripts this skill calls; it was not found." >&2
    echo "       Fix: install/enable catalyst-dev —  claude plugin install catalyst-dev@catalyst" >&2
    echo "       (or export CATALYST_DEV_SCRIPTS=/path/to/catalyst-dev/scripts)" >&2
    unset -f __cd_valid __cd_resolve 2>/dev/null
    unset __cd_requesting_plugin __cd_sentinel __cd_sib __cd_root __cd_mkt __cd_cache __cd_mkt_list __cd_cache_list 2>/dev/null
    return 1
  fi
  export CATALYST_DEV_SCRIPTS
  unset -f __cd_valid __cd_resolve 2>/dev/null
  unset __cd_requesting_plugin __cd_sentinel __cd_sib __cd_root __cd_mkt __cd_cache 2>/dev/null
  return 0
}

# ─── Q3: catalyst_plugin_root [start_dir] ────────────────────────────────────
#
# Walks up from start_dir (default $PWD) looking for the first ancestor that
# contains BOTH `version.txt` AND `.claude-plugin/plugin.json` — the same
# plugin-root test lib/catalyst-version.sh's catalyst_print_version already
# proved out (CTL-390). Echoes the resolved absolute path and returns 0, or
# echoes nothing and returns 1 when no ancestor (up to and including `/`)
# qualifies.
#
# Usage:
#   root="$(catalyst_plugin_root "$SCRIPT_DIR")" || { echo "no plugin root" >&2; exit 1; }
catalyst_plugin_root() {
  __cpr_dir="${1:-$PWD}"
  __cpr_dir="$( cd "$__cpr_dir" 2>/dev/null && pwd )"
  if [ -z "$__cpr_dir" ]; then
    unset __cpr_dir
    return 1
  fi
  while [ -n "$__cpr_dir" ]; do
    if [ -f "$__cpr_dir/version.txt" ] && [ -f "$__cpr_dir/.claude-plugin/plugin.json" ]; then
      printf '%s\n' "$__cpr_dir"
      unset __cpr_dir
      return 0
    fi
    [ "$__cpr_dir" = "/" ] && break
    __cpr_dir="$(dirname "$__cpr_dir")"
  done
  unset __cpr_dir
  return 1
}

# ─── catalyst_runtime_layout [dir] ───────────────────────────────────────────
#
# Classifies the kind of install a resolved catalyst-dev scripts dir (or any
# dir passed explicitly) lives in — echoes one of:
#
#   source-checkout   inside a git checkout (worktree or pristine clone)
#   marketplace       under ~/.claude/plugins/marketplaces/*/plugins/dev/scripts
#   cache             under ~/.claude/plugins/cache/*/catalyst-dev/*/scripts
#   unknown           none of the above (or dir absent/unreadable)
#
# Always returns 0 — this is advisory classification, never a failure mode.
# Defaults to $CATALYST_DEV_SCRIPTS (set by catalyst_dev_scripts above) when
# no explicit dir is given, so the common call is just
# `catalyst_runtime_layout` after a `catalyst_dev_scripts` call.
catalyst_runtime_layout() {
  __crl_dir="${1:-${CATALYST_DEV_SCRIPTS:-}}"
  if [ -z "$__crl_dir" ] || [ ! -d "$__crl_dir" ]; then
    echo "unknown"
    unset __crl_dir
    return 0
  fi
  __crl_dir="$( cd "$__crl_dir" 2>/dev/null && pwd )"

  case "$__crl_dir" in
    "$HOME"/.claude/plugins/marketplaces/*/plugins/dev/scripts)
      echo "marketplace"
      unset __crl_dir
      return 0
      ;;
    "$HOME"/.claude/plugins/cache/*/catalyst-dev/*/scripts)
      echo "cache"
      unset __crl_dir
      return 0
      ;;
  esac

  # Not a recognized installed-layout path — a git checkout (source or
  # linked worktree) counts as source-checkout. plugin_checkout_root comes
  # from the sibling lib/plugin-dirs.sh sourced above; guarded by
  # command -v so a fixture that copies this file alone degrades to
  # "unknown" instead of erroring on a missing function.
  if command -v plugin_checkout_root >/dev/null 2>&1; then
    if plugin_checkout_root "$__crl_dir" >/dev/null 2>&1; then
      echo "source-checkout"
      unset __crl_dir
      return 0
    fi
  elif git -C "$__crl_dir" rev-parse --show-toplevel >/dev/null 2>&1; then
    echo "source-checkout"
    unset __crl_dir
    return 0
  fi

  echo "unknown"
  unset __crl_dir
  return 0
}
