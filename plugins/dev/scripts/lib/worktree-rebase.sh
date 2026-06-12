#!/usr/bin/env bash
# lib/worktree-rebase.sh — CTL-667: front-load merge-conflict surfacing.
# Mechanically rebase a build-phase worktree onto origin/<base> at dispatch
# time, stashing machine-local noise (.catalyst/config.json, .trunk/* symlink
# dirs) across the rebase. Clean → 0; conflict → abort + restore + 2.
# CTL-707: adds rebase_onto_base_classified with 4-category conflict triage.
# Pure git/bash; NO claude, NO force-push, NO PR interaction.

set -uo pipefail

# CTL-707: source rebase-telemetry.sh best-effort so pure-mechanics callers
# (tests that don't set EVENTS_DIR) still run without the telemetry dependency.
_WR_SELF="${BASH_SOURCE[0]:-${(%):-%x}}"
_WR_DIR="$(cd "$(dirname "$_WR_SELF")" && pwd)"
# shellcheck source=./rebase-telemetry.sh
[[ -f "${_WR_DIR}/rebase-telemetry.sh" ]] && source "${_WR_DIR}/rebase-telemetry.sh" 2>/dev/null || true

# WORKTREE_NOISE_PATHS — single source of truth for files that diverge
# per-worktree (machine-local noise) and must be stashed before a rebase,
# then popped after. Mirrors the operator pattern in
# memory/project_worktree_noise_before_pr.md.
#
# CTL-678: the execution-core concurrency knobs themselves
# (catalyst.orchestration.executionCore.{maxParallel,minParallel,maxParallelCeiling})
# no longer drive drift here — their live source is now machine-canonical
# Layer-2 (~/.config/catalyst/config.json, outside any worktree). The
# committed Layer-1 block stays in .catalyst/config.json as the seed/fallback.
# We keep .catalyst/config.json in this list because it still carries other
# per-worktree state (e.g. .workflow-context.json regeneration); the .trunk/*
# paths still emit machine-local files.
# CTL-990: .claude/config.json (tracked) and .claude/settings.json are copied
# from the main checkout's working tree by create-worktree.sh and can arrive
# locally modified — they blocked rebase startup in the ADV-1326/ADV-1308
# incidents. NOTE: only these EXACT paths are noise; the rest of .claude/
# (skills/agents/rules) is real committed content and must keep classifying
# as source (see _is_noise_path).
# CTL-1076: .claude/scheduled_tasks.lock is a tracked file the Claude Code
# scheduler DELETES on worker exit (settling debris). The deletion shows in
# `git diff --name-only` and trips the precheck, but is machine-local noise.
# shellcheck disable=SC2034
WORKTREE_NOISE_PATHS=(
  .catalyst/config.json
  .claude/config.json .claude/settings.json
  .claude/scheduled_tasks.lock
  .trunk/actions .trunk/logs .trunk/notifications .trunk/out .trunk/tools
)

# _is_noise_path FILE → 0 when FILE is an exact WORKTREE_NOISE_PATHS entry.
# Keeps classify_conflicted_files in sync with the stash set without blanket-
# classifying all of .claude/ as noise.
_is_noise_path() {
  local f="$1" p
  for p in "${WORKTREE_NOISE_PATHS[@]}"; do
    [[ $f == "$p" ]] && return 0
  done
  return 1
}

# _is_settling_debris_path FILE → 0 when FILE is machine-noise that a dying
# worker leaves behind and that settles on its own (CTL-1076). Superset of
# _is_noise_path: also matches untracked build churn that is never real source.
_is_settling_debris_path() {
  local f="$1"
  _is_noise_path "$f" && return 0
  case "$f" in
    node_modules/*|*/node_modules/*) return 0 ;;
    *.log)                           return 0 ;;
  esac
  return 1
}

# _collect_precheck_dirt → fill RT_PRECHECK[] with all dirty paths (tracked
# diff, staged diff, and untracked from porcelain).
_collect_precheck_dirt() {
  RT_PRECHECK=()
  local _pf
  while IFS= read -r _pf; do
    [[ -n $_pf ]] && RT_PRECHECK+=("$_pf")
  done < <({ git diff --name-only; git diff --cached --name-only;
             git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
}

# _precheck_has_real_source → 0 if ANY path in RT_PRECHECK is NOT settling-debris.
_precheck_has_real_source() {
  local f
  for f in "${RT_PRECHECK[@]+"${RT_PRECHECK[@]}"}"; do
    _is_settling_debris_path "$f" || return 0
  done
  return 1
}

# _grace_reprobe_clears BASE MARKER → 0 if, within the grace window, the tree
# becomes clean of tracked dirt (settling-debris settled / restashed). Bounded
# by CATALYST_REBASE_GRACE_TOTAL_S (default 60) at
# CATALYST_REBASE_GRACE_INTERVAL_S (default 5) intervals. Re-runs
# noise_stash_push each probe so a freshly-settled noise path gets stashed.
# With both knobs 0, probes exactly once (test mode).
_grace_reprobe_clears() {
  local _base="$1" _marker="$2"
  local total="${CATALYST_REBASE_GRACE_TOTAL_S:-60}"
  local interval="${CATALYST_REBASE_GRACE_INTERVAL_S:-5}"
  local elapsed=0
  while :; do
    noise_stash_push >/dev/null 2>&1 || true
    if git diff --quiet 2>/dev/null && git diff --cached --quiet 2>/dev/null; then
      return 0
    fi
    _collect_precheck_dirt
    _precheck_has_real_source && return 1   # source appeared mid-window → park now
    (( elapsed >= total )) && return 1
    (( interval > 0 )) && sleep "$interval"
    elapsed=$(( elapsed + interval ))
    (( interval == 0 )) && return 1          # test mode: one probe only
  done
}

# rebase_in_progress → 0 when a rebase is mid-flight (stopped on a conflict),
# 1 otherwise. Guards `git rebase --continue` (CTL-990): calling --continue
# with nothing in progress exits non-zero and used to mis-report as
# {continue_failed, files:[], category:unknown}.
rebase_in_progress() {
  local d
  d="$(git rev-parse --git-path rebase-merge 2>/dev/null)" && [[ -d $d ]] && return 0
  d="$(git rev-parse --git-path rebase-apply 2>/dev/null)" && [[ -d $d ]] && return 0
  return 1
}

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
    # CTL-1076: include a path if present on disk OR reported changed by git
    # (a tracked-but-DELETED noise file is absent on disk — `[[ -e ]]` misses it —
    # yet shows in `git status --porcelain` and blocks the rebase precheck).
    if [[ -e $p ]] || [[ -n "$(git status --porcelain -- "$p" 2>/dev/null)" ]]; then
      present+=("$p")
    fi
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

# ─── CTL-707: Layer 2 — dispatch-time conflict classifier ────────────────────

# classify_conflicted_files — populate RT_TEST, RT_NOISE, RT_THOUGHTS, RT_SOURCE
# arrays with the current rebase's unmerged paths, bucketed by type.
# Must be called while a rebase is stopped (conflict state).
classify_conflicted_files() {
  RT_TEST=(); RT_NOISE=(); RT_THOUGHTS=(); RT_SOURCE=()
  local files f
  files="$(git diff --name-only --diff-filter=U 2>/dev/null)"
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    case "$f" in
      thoughts/*) RT_THOUGHTS+=("$f"); continue ;;
    esac
    if printf '%s' "$f" | grep -qE '(\.test\.|\.spec\.|__test__|_test\.)'; then
      RT_TEST+=("$f")
    elif printf '%s' "$f" | grep -qE '^(\.catalyst/|\.trunk/)' || _is_noise_path "$f"; then
      RT_NOISE+=("$f")
    else
      RT_SOURCE+=("$f")
    fi
  done <<<"$files"
}

# ctl708_escalate FILES… — CTL-708 coordination stub. Always returns 1
# (unavailable) until CTL-708 lands; Layer 2 treats non-zero as stall.
ctl708_escalate() { return 1; }

# _stall_and_return MARKER REASON RC — shared stall helper: abort in-progress
# rebase, pop the noise stash, emit a stalled event, return the given RC.
# CTL-990: also exports REBASE_LAST_STALL_REASON so callers (phase-agent-
# dispatch) can park the signal with the TRUE typed reason instead of
# hardcoding source_conflict_ctl708_unavailable for every rc=2.
_stall_and_return() {
  local marker="$1" reason="$2" rc="$3"
  # shellcheck disable=SC2034  # consumed by the sourcing dispatcher
  REBASE_LAST_STALL_REASON="$reason"
  git rebase --abort 2>/dev/null || true
  noise_stash_pop "$marker"
  # Build a JSON array from the stalled files for telemetry.
  local all_stalled=()
  case "$reason" in
    thoughts_symlink_broken)
      all_stalled=("${RT_THOUGHTS[@]+"${RT_THOUGHTS[@]}"}")
      ;;
    source_conflict_ctl708_unavailable|continue_failed)
      all_stalled=("${RT_SOURCE[@]+"${RT_SOURCE[@]}"}")
      ;;
    rebase_refused_dirty_tree)
      all_stalled=("${RT_PRECHECK[@]+"${RT_PRECHECK[@]}"}")
      ;;
  esac
  local files_json="[]"
  if [[ ${#all_stalled[@]} -gt 0 ]]; then
    files_json="$(printf '%s\n' "${all_stalled[@]}" | jq -R . | jq -s . 2>/dev/null || echo "[]")"
  fi
  local category
  case "$reason" in
    thoughts_symlink_broken)             category="thoughts" ;;
    source_conflict_ctl708_unavailable)  category="source"   ;;
    rebase_refused_dirty_tree)           category="precheck" ;;
    no_rebase_in_progress)               category="internal" ;;
    *)                                   category="unknown"  ;;
  esac
  emit_rebase_conflict_stalled \
    --orch     "${ORCH_ID:-}" \
    --ticket   "${TICKET:-}" \
    --phase    "${PHASE:-}" \
    --reason   "$reason" \
    --files    "$files_json" \
    --category "$category" 2>/dev/null || true
  return "$rc"
}

# rebase_onto_base_classified BASE
# Like rebase_onto_base but, on a conflict, categorizes the conflicted files
# and either auto-resolves (tests/noise only) or returns a typed sentinel.
#
# Return codes:
#   0 — clean or additively auto-resolved
#   1 — fetch / other pre-rebase failure (proceed un-rebased)
#   2 — terminal source conflict (CTL-708 unavailable) or continue failed
#   3 — thoughts/** conflict (symlink safety)
rebase_onto_base_classified() {
  local base="$1" marker
  git fetch --quiet origin "$base" 2>/dev/null || return 1
  marker="$(noise_stash_push)"

  # CTL-990 precheck: git refuses to START a rebase over dirty TRACKED changes.
  # That is a pre-flight refusal, not a conflict — no unmerged paths exist, so
  # classify_conflicted_files sees nothing and the old code cascaded into a
  # bogus `git rebase --continue` → {continue_failed, files:[], category:
  # unknown}, looping ~1,300 events per ticket.
  # CTL-1076: a finished phase's settling debris (deleted .claude/scheduled_tasks.lock
  # already stashed in Phase 1; untracked node_modules/ or *.log churn) must not
  # blanket-park the next phase. Classify surviving dirt: real source → stall NOW
  # (it never settles, CTL-1068); all-debris → bounded grace re-probe to let it
  # settle, then proceed if clean.
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    _collect_precheck_dirt
    if _precheck_has_real_source; then
      _stall_and_return "$marker" rebase_refused_dirty_tree 2
      return
    fi
    # All surviving dirt is settling-debris → grace re-probe.
    if _grace_reprobe_clears "$base" "$marker"; then
      :   # tree settled (and re-stashed); fall through to the rebase attempt
    else
      _collect_precheck_dirt
      _stall_and_return "$marker" rebase_refused_dirty_tree 2
      return
    fi
  fi

  if git rebase --quiet "origin/${base}" 2>/dev/null; then
    noise_stash_pop "$marker"
    emit_auto_rebased \
      --orch   "${ORCH_ID:-}" \
      --ticket "${TICKET:-}" \
      --phase  "${PHASE:-}" \
      --strategy clean 2>/dev/null || true
    return 0
  fi

  # Rebase stopped on a conflict — categorize before deciding.
  classify_conflicted_files
  local tc nc sc thc
  tc="${#RT_TEST[@]}"
  nc="${#RT_NOISE[@]}"
  sc="${#RT_SOURCE[@]}"
  thc="${#RT_THOUGHTS[@]}"
  emit_rebase_conflict_categorized \
    --orch          "${ORCH_ID:-}" \
    --ticket        "${TICKET:-}" \
    --phase         "${PHASE:-}" \
    --test-count    "$tc" \
    --noise-count   "$nc" \
    --source-count  "$sc" \
    --thoughts-count "$thc" 2>/dev/null || true

  # thoughts/** → always stall (symlink safety: never auto-resolve).
  if [[ $thc -gt 0 ]]; then
    _stall_and_return "$marker" thoughts_symlink_broken 3
    return
  fi

  # Source files → try CTL-708; stub always returns unavailable → stall.
  if [[ $sc -gt 0 ]]; then
    if ! ctl708_escalate "${RT_SOURCE[@]+"${RT_SOURCE[@]}"}"; then
      _stall_and_return "$marker" source_conflict_ctl708_unavailable 2
      return
    fi
    # CTL-708 resolved source files; fall through to test+noise resolution.
  fi

  # Only tests and/or noise remain — resolve additively.
  if [[ $nc -gt 0 ]]; then
    git checkout --ours   -- "${RT_NOISE[@]}" 2>/dev/null
    git add               -- "${RT_NOISE[@]}" 2>/dev/null
  fi
  if [[ $tc -gt 0 ]]; then
    git checkout --theirs -- "${RT_TEST[@]}"  2>/dev/null
    git add               -- "${RT_TEST[@]}"  2>/dev/null
  fi

  # CTL-990 guard: never call `git rebase --continue` with nothing in progress
  # — it exits non-zero and used to mis-report as continue_failed. Reaching
  # here without a rebase means git refused to START it for a reason the
  # tracked-only precheck can't see (e.g. an UNTRACKED file the incoming base
  # would overwrite). Report THAT as the dirty-tree class with the worktree's
  # dirt listed; no_rebase_in_progress is reserved for a genuinely clean tree.
  if ! rebase_in_progress; then
    RT_PRECHECK=()
    local _gf
    while IFS= read -r _gf; do
      [[ -n $_gf ]] && RT_PRECHECK+=("${_gf:3}")
    done < <(git status --porcelain 2>/dev/null)
    if [[ ${#RT_PRECHECK[@]} -gt 0 ]]; then
      _stall_and_return "$marker" rebase_refused_dirty_tree 2
    else
      _stall_and_return "$marker" no_rebase_in_progress 2
    fi
    return
  fi

  if git rebase --continue 2>/dev/null; then
    noise_stash_pop "$marker"
    emit_auto_rebased \
      --orch     "${ORCH_ID:-}" \
      --ticket   "${TICKET:-}" \
      --phase    "${PHASE:-}" \
      --strategy additive 2>/dev/null || true
    return 0
  fi

  # --continue itself conflicted; stall.
  _stall_and_return "$marker" continue_failed 2
}
