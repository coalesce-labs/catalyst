#!/usr/bin/env bash
# require-catalyst-dev.sh — resolve the shared catalyst-dev scripts dir, or fail fast.
#
# catalyst-legacy skills are thin: their SKILL.md lives here, but the backing shell
# scripts they call live in the catalyst-dev plugin (the shared framework core). The
# plugin manifest declares `"dependencies": ["catalyst-dev"]` so the install layer
# guarantees dev is present — but the installer does NOT wire physical paths, so this
# helper finds dev's scripts at runtime and exports CATALYST_DEV_SCRIPTS. It also
# fail-fasts with a clear message on older Claude Code versions (no dependency support),
# source checkouts, or when catalyst-dev is disabled.
#
# Usage (from a skill bash block):
#   source "${CLAUDE_PLUGIN_ROOT:-plugins/legacy}/scripts/require-catalyst-dev.sh" \
#       "${CLAUDE_PLUGIN_ROOT:-plugins/legacy}" || exit 1
#   "$CATALYST_DEV_SCRIPTS/check-project-setup.sh"   # scripts now resolvable
#
# Resolution order (first dir containing the sentinel wins):
#   1. $CATALYST_DEV_SCRIPTS if already valid
#   2. sibling in a source checkout:  <this-plugin>/../dev/scripts
#   3. repo-root cwd:                 ./plugins/dev/scripts
#   4. installed marketplace clone:   ~/.claude/plugins/marketplaces/*/plugins/dev/scripts
#   5. installed versioned cache:     ~/.claude/plugins/cache/*/catalyst-dev/*/scripts
#
# zsh/bash-safe: no ${BASH_SOURCE}, no `local`, globs guarded via `ls -d ... 2>/dev/null`.

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
  __cd_mkt="$( ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/dev/scripts 2>/dev/null | sort -V | tail -1 )"
  __cd_valid "$__cd_mkt" && { printf '%s\n' "$__cd_mkt"; return 0; }
  __cd_cache="$( ls -d "$HOME"/.claude/plugins/cache/*/catalyst-dev/*/scripts 2>/dev/null | sort -V | tail -1 )"
  __cd_valid "$__cd_cache" && { printf '%s\n' "$__cd_cache"; return 0; }
  return 1
}

CATALYST_DEV_SCRIPTS="$( __cd_resolve )"
if [ -z "$CATALYST_DEV_SCRIPTS" ]; then
  echo "ERROR: this skill requires the 'catalyst-dev' plugin (the shared framework core)." >&2
  echo "       catalyst-dev provides the backing scripts this skill calls; it was not found." >&2
  echo "       Fix: install/enable catalyst-dev —  claude plugin install catalyst-dev@catalyst" >&2
  echo "       (or export CATALYST_DEV_SCRIPTS=/path/to/catalyst-dev/scripts)" >&2
  unset -f __cd_valid __cd_resolve 2>/dev/null
  return 1 2>/dev/null || exit 1
fi
export CATALYST_DEV_SCRIPTS
unset -f __cd_valid __cd_resolve 2>/dev/null
unset __cd_requesting_plugin __cd_sentinel __cd_sib __cd_root __cd_mkt __cd_cache 2>/dev/null
