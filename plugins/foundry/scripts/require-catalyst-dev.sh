#!/usr/bin/env bash
# require-catalyst-dev.sh — resolve the shared catalyst-dev scripts dir, or fail fast.
#
# catalyst-foundry skills are thin: their SKILL.md lives here, but the backing shell
# scripts they call live in the catalyst-dev plugin (the shared framework core). The
# plugin manifest declares `"dependencies": ["catalyst-dev"]` so the install layer
# guarantees dev is present — but the installer does NOT wire physical paths, so this
# helper finds dev's scripts at runtime and exports CATALYST_DEV_SCRIPTS. It also
# fail-fasts with a clear message on older Claude Code versions (no dependency support),
# source checkouts, or when catalyst-dev is disabled.
#
# Usage (from a skill bash block):
#   source "${CLAUDE_PLUGIN_ROOT:-plugins/foundry}/scripts/require-catalyst-dev.sh" \
#       "${CLAUDE_PLUGIN_ROOT:-plugins/foundry}" || exit 1
#   "$CATALYST_DEV_SCRIPTS/check-setup.sh"   # scripts now resolvable
#
# THIN SHIM (CTL-1628 Phase A2): the resolution order, sentinel, sort -V newest-wins
# semantics, and the LOUD miss message all now live once in
# lib/catalyst-runtime-root.sh's catalyst_dev_scripts function — this file only
# bootstraps far enough to SOURCE that lib, then delegates. The bootstrap below
# necessarily duplicates the candidate-path SKELETON (not the decision logic): this
# file cannot call catalyst_dev_scripts before it has sourced the file that defines
# it, a chicken-and-egg install-cli.sh's own "inlined git-only health probe" comment
# documents solving the identical way for the identical reason. Whatever directory the
# bootstrap lands on is used ONLY to locate lib/catalyst-runtime-root.sh — the
# authoritative CATALYST_DEV_SCRIPTS value (including honoring an explicit env
# override) is decided by catalyst_dev_scripts itself, not by this bootstrap.
#
# CTL-1628 Phase A2 verify-round-1 fix: a versioned-cache install can update
# this plugin (foundry) before its cached catalyst-dev copy refreshes — the
# cross-plugin sidecar/mutating-pair version-skew window CTL-1536 documents.
# In that window the sentinel (check-project-setup.sh) is present in the
# cached catalyst-dev dir but lib/catalyst-runtime-root.sh is not, and the
# pre-fold resolver used to succeed there. Two compensations restore that:
# (1) a sentinel-valid CATALYST_DEV_SCRIPTS override is honored immediately,
# before the lib is even required — so the error message's own suggested
# remedy ("export CATALYST_DEV_SCRIPTS=...") keeps working against an
# unfolded target; (2) if no candidate anywhere has the lib, the bootstrap
# falls back to the exact pre-fold inline sentinel-based resolution instead
# of hard-failing, so this shim degrades to precisely the old contract.
#
# zsh/bash-safe: no ${BASH_SOURCE}, no `local`, globs guarded via `ls -d ... 2>/dev/null`.

__rcd_requesting_plugin="${1:-${CLAUDE_PLUGIN_ROOT:-}}"
__rcd_lib_rel="lib/catalyst-runtime-root.sh"
__rcd_sentinel="check-project-setup.sh"

__rcd_has_lib() { [ -n "$1" ] && [ -f "$1/$__rcd_lib_rel" ]; }
__rcd_has_sentinel() { [ -n "$1" ] && [ -d "$1" ] && [ -f "$1/$__rcd_sentinel" ]; }

if __rcd_has_sentinel "${CATALYST_DEV_SCRIPTS:-}"; then
  export CATALYST_DEV_SCRIPTS
  unset -f __rcd_has_lib __rcd_has_sentinel 2>/dev/null
  unset __rcd_requesting_plugin __rcd_lib_rel __rcd_sentinel 2>/dev/null
  return 0 2>/dev/null || exit 0
fi

__rcd_bootstrap_find() {
  if [ -n "$__rcd_requesting_plugin" ]; then
    __rcd_sib="$( cd "$__rcd_requesting_plugin/../dev/scripts" 2>/dev/null && pwd )"
    __rcd_has_lib "$__rcd_sib" && { printf '%s\n' "$__rcd_sib"; return 0; }
  fi
  __rcd_root="$( cd "./plugins/dev/scripts" 2>/dev/null && pwd )"
  __rcd_has_lib "$__rcd_root" && { printf '%s\n' "$__rcd_root"; return 0; }
  __rcd_mkt="$( ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/dev/scripts 2>/dev/null | sort -V | tail -1 )"
  __rcd_has_lib "$__rcd_mkt" && { printf '%s\n' "$__rcd_mkt"; return 0; }
  __rcd_cache="$( ls -d "$HOME"/.claude/plugins/cache/*/catalyst-dev/*/scripts 2>/dev/null | sort -V | tail -1 )"
  __rcd_has_lib "$__rcd_cache" && { printf '%s\n' "$__rcd_cache"; return 0; }
  return 1
}

__rcd_bootstrap_dir="$( __rcd_bootstrap_find || true )"   # || true: survive caller's set -e on miss
unset -f __rcd_bootstrap_find __rcd_has_lib 2>/dev/null

if [ -n "$__rcd_bootstrap_dir" ]; then
  # shellcheck source=../../dev/scripts/lib/catalyst-runtime-root.sh
  . "$__rcd_bootstrap_dir/$__rcd_lib_rel"
  catalyst_dev_scripts "$__rcd_requesting_plugin"
  __rcd_status=$?
  unset -f __rcd_has_sentinel 2>/dev/null
  unset __rcd_requesting_plugin __rcd_lib_rel __rcd_sentinel __rcd_bootstrap_dir __rcd_sib __rcd_root __rcd_mkt __rcd_cache 2>/dev/null
  if [ "$__rcd_status" = "0" ]; then
    unset __rcd_status 2>/dev/null
    return 0 2>/dev/null || exit 0
  fi
  unset __rcd_status 2>/dev/null
  return 1 2>/dev/null || exit 1
fi

# Pre-fold fallback: no candidate anywhere has the lib yet (see CTL-1536
# skew note above). Re-run the exact resolution the pre-fold resolver used
# (same order, same sentinel), so this shim still succeeds wherever the
# original inline resolver did.
__rcd_resolve() {
  if [ -n "$__rcd_requesting_plugin" ]; then
    __rcd_sib="$( cd "$__rcd_requesting_plugin/../dev/scripts" 2>/dev/null && pwd )"
    __rcd_has_sentinel "$__rcd_sib" && { printf '%s\n' "$__rcd_sib"; return 0; }
  fi
  __rcd_root="$( cd "./plugins/dev/scripts" 2>/dev/null && pwd )"
  __rcd_has_sentinel "$__rcd_root" && { printf '%s\n' "$__rcd_root"; return 0; }
  __rcd_mkt="$( ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/dev/scripts 2>/dev/null | sort -V | tail -1 )"
  __rcd_has_sentinel "$__rcd_mkt" && { printf '%s\n' "$__rcd_mkt"; return 0; }
  __rcd_cache="$( ls -d "$HOME"/.claude/plugins/cache/*/catalyst-dev/*/scripts 2>/dev/null | sort -V | tail -1 )"
  __rcd_has_sentinel "$__rcd_cache" && { printf '%s\n' "$__rcd_cache"; return 0; }
  return 1
}

CATALYST_DEV_SCRIPTS="$( __rcd_resolve || true )"   # || true: survive caller's set -e on miss
unset -f __rcd_resolve __rcd_has_sentinel 2>/dev/null
unset __rcd_requesting_plugin __rcd_lib_rel __rcd_sentinel __rcd_bootstrap_dir __rcd_sib __rcd_root __rcd_mkt __rcd_cache 2>/dev/null

if [ -z "$CATALYST_DEV_SCRIPTS" ]; then
  echo "ERROR: this skill requires the 'catalyst-dev' plugin (the shared framework core)." >&2
  echo "       catalyst-dev provides the backing scripts this skill calls; it was not found." >&2
  echo "       Fix: install/enable catalyst-dev —  claude plugin install catalyst-dev@catalyst" >&2
  echo "       (or export CATALYST_DEV_SCRIPTS=/path/to/catalyst-dev/scripts)" >&2
  unset CATALYST_DEV_SCRIPTS 2>/dev/null
  return 1 2>/dev/null || exit 1
fi
export CATALYST_DEV_SCRIPTS
return 0 2>/dev/null || exit 0
