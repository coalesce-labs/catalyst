#!/usr/bin/env bash
# lib/worktree-rebase.sh — CTL-667: front-load merge-conflict surfacing.
# Mechanically rebase a build-phase worktree onto origin/<base> at dispatch
# time, stashing machine-local noise (.catalyst/config.json, .trunk/* symlink
# dirs) across the rebase. Clean → 0; conflict → abort + restore + 2.
# Pure git/bash; NO claude, NO force-push, NO PR interaction.

set -uo pipefail

# Single source of truth for the machine-local noise paths (mirrors the
# operator pattern in memory/project_worktree_noise_before_pr.md).
# shellcheck disable=SC2034
WORKTREE_NOISE_PATHS=(
  .catalyst/config.json
  .trunk/actions .trunk/logs .trunk/notifications .trunk/out .trunk/tools
)

# resolve_base_branch → echoes the rebase target branch name (no origin/ prefix).
resolve_base_branch() {
  if [[ -n ${CATALYST_BASE_BRANCH:-} ]]; then printf '%s' "$CATALYST_BASE_BRANCH"; return 0; fi
  local head
  head="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)" \
    && { printf '%s' "${head#origin/}"; return 0; }
  printf 'main'
}

# noise_stash_push → stash only the noise paths that are actually present/dirty.
# Echoes a marker ("1" = something stashed, "" = nothing) on stdout so the
# caller knows whether to pop. Returns 0 on success.
noise_stash_push() {
  local present=()
  local p
  for p in "${WORKTREE_NOISE_PATHS[@]}"; do
    [[ -e $p ]] && present+=("$p")
  done
  [[ ${#present[@]} -eq 0 ]] && { printf ''; return 0; }
  # Only stash if at least one present noise path is actually dirty/untracked.
  # On modern git a pathspec `git stash push` over CLEAN paths is a silent
  # no-op (rc 0, no stash entry created) — so keying the marker off the exit
  # code alone would report "1" with no stash on the stack, and a later
  # noise_stash_pop would then pop an UNRELATED stash. Gate on a porcelain
  # dirty-check so the marker can never lie.
  local dirty
  dirty="$(git status --porcelain -- "${present[@]}" 2>/dev/null)"
  [[ -z $dirty ]] && { printf ''; return 0; }
  if git stash push --include-untracked --quiet \
       -m "catalyst-worktree-rebase-noise" -- "${present[@]}" 2>/dev/null; then
    printf '1'
  else
    printf ''   # nothing got stashed (e.g. all ignored & clean) — pop must no-op
  fi
  return 0
}

# noise_stash_pop MARKER → restore the noise stash if push reported one.
# Best-effort: a pop conflict prefers the stashed (machine-local) copy and drops
# the stash, since these paths are intentionally machine-local noise.
noise_stash_pop() {
  local marker="$1"
  [[ -z $marker ]] && return 0
  if git stash pop --quiet 2>/dev/null; then return 0; fi
  # Rare: base touched a noise path. Prefer our stashed copy, then drop.
  git checkout --theirs -- "${WORKTREE_NOISE_PATHS[@]}" 2>/dev/null || true
  git stash drop --quiet 2>/dev/null || true
  return 0
}

# rebase_onto_base BASE → 0 clean, 2 conflict (aborted), 1 fetch/other failure.
rebase_onto_base() {
  local base="$1" marker
  git fetch --quiet origin "$base" 2>/dev/null || return 1
  marker="$(noise_stash_push)"
  if git rebase --quiet "origin/${base}" 2>/dev/null; then
    noise_stash_pop "$marker"
    return 0
  fi
  git rebase --abort 2>/dev/null || true
  noise_stash_pop "$marker"
  return 2
}
