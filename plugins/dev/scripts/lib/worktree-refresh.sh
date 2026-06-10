#!/usr/bin/env bash
# lib/worktree-refresh.sh — CTL-707 Layer 1. Refresh a worktree onto
# origin/<base>. Called by the daemon's periodic refresh timer.
# Clean rebase → 0; conflict (aborted) → 2; fetch failure → 1.
# Can be sourced (provides refresh_worktree function) or executed directly.
#
# CTL-990: shares the noise-stash helpers with the dispatch-time rebase
# (lib/worktree-rebase.sh) so a dirty machine-local config — the same class
# that looped the dispatch path — cannot fail the periodic refresh either.

set -uo pipefail

_WRF_SELF="${BASH_SOURCE[0]:-${(%):-%x}}"
_WRF_DIR="$(cd "$(dirname "$_WRF_SELF")" && pwd)"
# shellcheck source=./worktree-rebase.sh
source "${_WRF_DIR}/worktree-rebase.sh"

# refresh_worktree DIR BASE → fetch origin/<base>, stash noise, try rebase;
# abort on conflict. Subshell-cd so the noise helpers (which operate on the
# cwd) target DIR without leaking a directory change to the caller.
refresh_worktree() {
  local dir="$1" base="$2"
  (
    cd "$dir" 2>/dev/null || exit 1
    git fetch --quiet origin "$base" 2>/dev/null || exit 1
    local marker
    marker="$(noise_stash_push)"
    if git rebase --quiet "origin/${base}" 2>/dev/null; then
      noise_stash_pop "$marker"
      exit 0
    fi
    git rebase --abort 2>/dev/null || true
    noise_stash_pop "$marker"
    exit 2
  )
}

# Direct invocation: bash worktree-refresh.sh <dir> <base>
if [[ "${BASH_SOURCE[0]:-}" == "$0" ]]; then
  refresh_worktree "${1:?dir required}" "${2:?base required}"
fi
