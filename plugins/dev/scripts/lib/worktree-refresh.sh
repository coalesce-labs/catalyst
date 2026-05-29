#!/usr/bin/env bash
# lib/worktree-refresh.sh — CTL-707 Layer 1. Refresh a worktree onto
# origin/<base>. Called by the daemon's periodic refresh timer.
# Clean rebase → 0; conflict (aborted) → 2; fetch failure → 1.
# Can be sourced (provides refresh_worktree function) or executed directly.

set -uo pipefail

# refresh_worktree DIR BASE → fetch origin/<base>, try rebase; abort on conflict.
refresh_worktree() {
  local dir="$1" base="$2"
  git -C "$dir" fetch --quiet origin "$base" 2>/dev/null || return 1
  if git -C "$dir" rebase --quiet "origin/${base}" 2>/dev/null; then
    return 0
  fi
  git -C "$dir" rebase --abort 2>/dev/null || true
  return 2
}

# Direct invocation: bash worktree-refresh.sh <dir> <base>
if [[ "${BASH_SOURCE[0]:-}" == "$0" ]]; then
  refresh_worktree "${1:?dir required}" "${2:?base required}"
fi
