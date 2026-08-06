#!/usr/bin/env bash
# lib/worktree-salvage.sh — CTL-1639. Snapshot a worktree's unpushed commits +
# uncommitted changes to ~/catalyst/salvage/ BEFORE destructive removal. Local,
# no-network, best-effort/fail-open (always returns 0). Sourced by producers, or
# invoked directly (the JS reaper seam shells out to it).
#
# Uses only POSIX-portable git (no `mapfile`, no `git stash` — worktrees share
# refs/stash, memory hazard `shared-stash-across-worktrees`). Atomic writes via
# tmp + `mv`.
set -uo pipefail
if [[ -n "${__CATALYST_WORKTREE_SALVAGE_SOURCED:-}" ]]; then return 0; fi
__CATALYST_WORKTREE_SALVAGE_SOURCED=1

# Portable self-path: BASH_SOURCE under bash, prompt-expansion %x under zsh.
_WSV_SELF="${BASH_SOURCE[0]:-${(%):-%x}}"
_WSV_DIR="$(cd "$(dirname "$_WSV_SELF")" && pwd)"
# shellcheck source=./worktree-salvage-telemetry.sh
source "${_WSV_DIR}/worktree-salvage-telemetry.sh"

_wsv_salvage_dir() {
  printf '%s' "${CATALYST_SALVAGE_DIR:-${CATALYST_DIR:-$HOME/catalyst}/salvage}"
}

# salvage_worktree <wt> <ticket> [--base <ref>] [--reason <str>] [--orch <id>] [--site <str>]
# ALWAYS returns 0. Emits exactly one worktree.salvage.{created,skipped,failed}.
salvage_worktree() {
  local wt="${1:-}" ticket="${2:-}"; shift 2 2>/dev/null || true
  local base="" reason="" orch="" site=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --base)   base="$2";   shift 2 ;;
      --reason) reason="$2"; shift 2 ;;
      --orch)   orch="$2";   shift 2 ;;
      --site)   site="$2";   shift 2 ;;
      *) shift ;;
    esac
  done
  # base is accepted for forward-compat / event context; the bundle uses
  # `--not --remotes` (robust even when origin/<base> is unresolvable).
  : "${base:=}"

  # Defensive: not a git worktree → nothing we can do; report failed, never abort.
  if [[ -z "$wt" || ! -d "$wt" ]] || ! git -C "$wt" rev-parse --git-dir >/dev/null 2>&1; then
    emit_salvage_failed --ticket "$ticket" --orch "$orch" \
      --payload-json "$(jq -nc --arg s "$site" --arg r "$reason" '{site:$s,reason:$r,error:"not-a-worktree"}')"
    return 0
  fi

  local dir ts uniq stem bundle patch idxpatch untar
  dir="$(_wsv_salvage_dir)"; ts="$(date -u +%Y%m%dT%H%M%SZ)"
  if ! mkdir -p "$dir" 2>/dev/null; then
    emit_salvage_failed --ticket "$ticket" --orch "$orch" \
      --payload-json "$(jq -nc --arg s "$site" '{site:$s,error:"mkdir-failed"}')"
    return 0
  fi
  # Collision-proof stem: the second-granular UTC timestamp alone collides when two
  # salvages fire for the same ticket within one second (concurrent reaper +
  # teardown, or same-basename worktrees under separate sweep roots). Add a
  # per-invocation unique component ($$ pid + $RANDOM) so the final `mv -f` can never
  # silently overwrite a distinct earlier bundle/patch/tar.
  uniq="$$-${RANDOM:-0}"
  stem="${dir}/${ticket}-${ts}-${uniq}"
  bundle="${stem}.bundle"
  patch="${stem}.patch"
  idxpatch="${stem}.index.patch"
  untar="${stem}-untracked.tar"

  local commits_saved=0 files_changed=0 untracked_count=0 err=""
  local saved_bundle="" saved_patch="" saved_idxpatch="" saved_untar=""

  # (a) Unpushed commits → bundle. `HEAD --not --remotes` = reachable from HEAD,
  #     on no remote. `git bundle create` also fails when NOTHING qualifies
  #     ("empty bundle") — that clean case must be told apart from a real I/O error
  #     (dir full/read-only, git failure), or an otherwise-clean worktree with a
  #     genuine bundle-write failure would falsely report `skipped`. So probe the
  #     revision set first; a bundle failure with commits present IS an error.
  local unpushed_n
  unpushed_n="$(git -C "$wt" rev-list --count HEAD --not --remotes 2>/dev/null || echo 0)"
  if [[ "$unpushed_n" -gt 0 ]]; then
    local tmp_b="${bundle}.tmp.$$"
    if git -C "$wt" bundle create "$tmp_b" HEAD --not --remotes >/dev/null 2>&1 \
         && mv -f "$tmp_b" "$bundle" 2>/dev/null; then
      saved_bundle="$bundle"
      commits_saved="$unpushed_n"
    else
      rm -f "$tmp_b" 2>/dev/null || true
      err="bundle-failed"   # commits existed but the bundle/mv failed — a real error
    fi
  fi

  # (b) Tracked uncommitted work → patch(es). Two DISTINCT deltas must each be
  #     captured or force-removal discards them:
  #       - working-tree-vs-HEAD (`git diff HEAD`): staged + unstaged combined.
  #       - index-vs-HEAD (`git diff --cached HEAD`): the staged delta ALONE, which
  #         `git diff HEAD` misses entirely when a later unstaged edit restores the
  #         working file back to its HEAD content (staged work then invisible).
  #     `--binary` so a changed tracked BINARY file's bytes are in the patch (plain
  #     `git diff` writes only a "Binary files ... differ" marker that can't restore).
  if ! git -C "$wt" diff --quiet HEAD 2>/dev/null; then
    local tmp_p="${patch}.tmp.$$"
    if git -C "$wt" diff --binary HEAD >"$tmp_p" 2>/dev/null && [[ -s "$tmp_p" ]] && mv -f "$tmp_p" "$patch" 2>/dev/null; then
      saved_patch="$patch"
      files_changed="$(git -C "$wt" diff --name-only HEAD 2>/dev/null | grep -c . || echo 0)"
    else
      rm -f "$tmp_p" 2>/dev/null || true
      [[ -z "$err" ]] && err="patch-failed"
    fi
  fi
  # Index-only delta: snapshot the staged content separately whenever it differs
  # from HEAD, regardless of what the working tree shows.
  if ! git -C "$wt" diff --cached --quiet HEAD 2>/dev/null; then
    local tmp_ip="${idxpatch}.tmp.$$"
    if git -C "$wt" diff --cached --binary HEAD >"$tmp_ip" 2>/dev/null && [[ -s "$tmp_ip" ]] && mv -f "$tmp_ip" "$idxpatch" 2>/dev/null; then
      saved_idxpatch="$idxpatch"
    else
      rm -f "$tmp_ip" 2>/dev/null || true
      [[ -z "$err" ]] && err="index-patch-failed"
    fi
  fi

  # (c) Untracked files → tar (list from git, so .gitignore is respected).
  local untracked; untracked="$(git -C "$wt" ls-files --others --exclude-standard 2>/dev/null || true)"
  if [[ -n "$untracked" ]]; then
    untracked_count="$(printf '%s\n' "$untracked" | grep -c . || echo 0)"
    local tmp_t="${untar}.tmp.$$"
    if ( cd "$wt" && git ls-files --others --exclude-standard -z 2>/dev/null \
           | tar --null -cf "$tmp_t" --files-from=- 2>/dev/null ) && mv -f "$tmp_t" "$untar" 2>/dev/null; then
      saved_untar="$untar"
    else
      rm -f "$tmp_t" 2>/dev/null || true
      [[ -z "$err" ]] && err="untracked-tar-failed"
    fi
  fi

  local payload
  payload="$(jq -nc \
    --arg b "$saved_bundle" --arg p "$saved_patch" --arg ip "$saved_idxpatch" --arg u "$saved_untar" \
    --arg r "$reason" --arg s "$site" --arg t "$ticket" \
    --argjson cs "${commits_saved:-0}" --argjson fc "${files_changed:-0}" --argjson uc "${untracked_count:-0}" \
    '{ticket:$t,site:$s,reason:$r,bundle:$b,patch:$p,index_patch:$ip,untracked_tar:$u,
      commits_saved:$cs,files_changed:$fc,untracked_count:$uc}')" || payload="{}"

  if [[ -n "$err" ]]; then
    emit_salvage_failed --ticket "$ticket" --orch "$orch" \
      --payload-json "$(printf '%s' "$payload" | jq -c --arg e "$err" '. + {error:$e}')"
  elif [[ -n "$saved_bundle" || -n "$saved_patch" || -n "$saved_idxpatch" || -n "$saved_untar" ]]; then
    emit_salvage_created --ticket "$ticket" --orch "$orch" --payload-json "$payload"
  else
    emit_salvage_skipped --ticket "$ticket" --orch "$orch" --payload-json "$payload"
  fi
  return 0
}

# Allow direct invocation for ad-hoc use / the JS shell-out seam. When executed
# (not sourced), `return` fails and we forward argv to salvage_worktree.
if ! (return 0 2>/dev/null); then salvage_worktree "$@"; fi
