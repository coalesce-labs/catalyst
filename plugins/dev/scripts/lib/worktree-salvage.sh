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

# _wsv_diff <wt> <diff-args...> — every recovery-patch `git diff` invocation
# routes through here (Codex P1 x2): `--no-ext-diff` neutralizes a repo/global
# `diff.external`/`GIT_EXTERNAL_DIFF` config that would otherwise shell out to
# an arbitrary helper (or fail outright — an empty/broken external-diff command
# aborts the whole `git diff` with a nonzero exit) instead of writing an
# applyable patch; `-c color.ui=false` stops `color.ui=always`/`diff=always`
# from writing ANSI escapes into the patch (the nonempty-file check would still
# pass and salvage would report success while `git apply` can't restore the
# change); `--no-textconv` stops a `.gitattributes` textconv driver from
# emitting a one-way converted text hunk that `git apply` also can't apply back
# to the real (binary) bytes. Unlike `diff.external`, `--no-ext-diff`/
# `--no-textconv`/`-c color.ui=false` are command-line-level overrides that
# always win over repo/global/env config, so no env-var unset is needed here.
_wsv_diff() {
  local wt="$1"; shift
  git -c color.ui=false -C "$wt" diff --no-ext-diff --no-textconv "$@"
}

# _wsv_salvage_submodule <wt> <rel-path> <stem> — best-effort; writes
# <stem>.submodule-<sanitized-path>-<hash>.{bundle,patch,index.patch,-untracked.tar}
# for ONE submodule's own working tree (the submodule is itself a git worktree,
# so its own uncommitted diff/untracked files AND unpushed commits are invisible
# from the superproject's diff, which records only an opaque "Subproject commit
# <sha>-dirty" marker). The `-<hash>` suffix (a short hash of the FULL `rel`
# path) makes the artifact name injective even when two distinct submodule
# paths normalize to the same string under the `/`/space -> `_` substitution
# (e.g. `vendor/foo` and `vendor_foo` both naively become `vendor_foo`) — the
# `tr` component stays for human readability, the hash suffix is what actually
# guarantees no collision.
#
# Return code communicates a 3-state outcome the caller must not conflate:
#   0 = at least one artifact was written (this submodule had something to save)
#   1 = clean — no unpushed commits/diff/untracked files, nothing to save
#   2 = ATTEMPTED but at least one artifact write failed (real error, not "clean")
_wsv_salvage_submodule() {
  local wt="$1" rel="$2" stem="$3"
  local sm_dir="${wt}/${rel}"
  git -C "$sm_dir" rev-parse --git-dir >/dev/null 2>&1 || return 1
  local safe_name; safe_name="$(printf '%s' "$rel" | tr '/ ' '__')"
  local path_hash; path_hash="$(printf '%s' "$rel" | cksum | cut -d' ' -f1)"
  local base="${stem}.submodule-${safe_name}-${path_hash}"
  local saved=0 failed=0

  # Unpushed commits within the submodule itself — invisible to the superproject
  # patch (which records only the gitlink SHA), and force-removing the linked
  # worktree can take the submodule's object database with it.
  local sm_unpushed_n
  sm_unpushed_n="$(git -C "$sm_dir" rev-list --count HEAD --not --remotes 2>/dev/null || echo 0)"
  if [[ "$sm_unpushed_n" -gt 0 ]]; then
    local tmp_b="${base}.bundle.tmp.$$"
    if git -C "$sm_dir" bundle create "$tmp_b" HEAD --not --remotes >/dev/null 2>&1 \
         && mv -f "$tmp_b" "${base}.bundle" 2>/dev/null; then
      saved=1
    else
      rm -f "$tmp_b" 2>/dev/null || true
      failed=1
    fi
  fi

  if ! _wsv_diff "$sm_dir" --quiet HEAD 2>/dev/null; then
    local tmp="${base}.patch.tmp.$$"
    if _wsv_diff "$sm_dir" --binary HEAD >"$tmp" 2>/dev/null && [[ -s "$tmp" ]] && mv -f "$tmp" "${base}.patch" 2>/dev/null; then
      saved=1
    else
      rm -f "$tmp" 2>/dev/null || true
      failed=1
    fi
  fi
  if ! _wsv_diff "$sm_dir" --cached --quiet HEAD 2>/dev/null; then
    local tmpi="${base}.index.patch.tmp.$$"
    if _wsv_diff "$sm_dir" --cached --binary HEAD >"$tmpi" 2>/dev/null && [[ -s "$tmpi" ]] && mv -f "$tmpi" "${base}.index.patch" 2>/dev/null; then
      saved=1
    else
      rm -f "$tmpi" 2>/dev/null || true
      failed=1
    fi
  fi
  local sm_untracked
  sm_untracked="$(git -C "$sm_dir" ls-files --others --exclude-standard 2>/dev/null || true)"
  if [[ -n "$sm_untracked" ]]; then
    local tmpt="${base}-untracked.tar.tmp.$$"
    if ( cd "$sm_dir" && git ls-files --others --exclude-standard -z 2>/dev/null \
           | tar --null -cf "$tmpt" --files-from=- 2>/dev/null ) && mv -f "$tmpt" "${base}-untracked.tar" 2>/dev/null; then
      saved=1
    else
      rm -f "$tmpt" 2>/dev/null || true
      failed=1
    fi
  fi

  if [[ "$saved" -eq 1 ]]; then
    return 0
  elif [[ "$failed" -eq 1 ]]; then
    return 2
  else
    return 1
  fi
}

# salvage_worktree <wt> <ticket> [--base <ref>] [--reason <str>] [--orch <id>] [--site <str>]
# ALWAYS returns 0. Emits exactly one worktree.salvage.{created,skipped,failed}.
# Also sets the global `_WSV_LAST_STATUS` to "created"|"skipped"|"failed" for a
# caller that needs the real per-invocation outcome without breaking the
# always-succeeds return-code contract (e.g. orphan-sweep.sh's dedup wrapper,
# which must NOT remember a failed attempt as "already saved").
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
    _WSV_LAST_STATUS="failed"
    emit_salvage_failed --ticket "$ticket" --orch "$orch" \
      --payload-json "$(jq -nc --arg s "$site" --arg r "$reason" '{site:$s,reason:$r,error:"not-a-worktree"}')"
    return 0
  fi

  local dir ts uniq stem bundle patch idxpatch untar
  dir="$(_wsv_salvage_dir)"; ts="$(date -u +%Y%m%dT%H%M%SZ)"
  if ! mkdir -p "$dir" 2>/dev/null; then
    _WSV_LAST_STATUS="failed"
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

  # (a2) Two DISTINCT index bits make `git status`/`git diff` blind to a real
  #      tracked-file edit, and the removal classifiers rely on that same
  #      status/diff — so a worktree can be classified SAFE/skipped and
  #      force-removed while it holds unique local bytes:
  #        - `git update-index --assume-unchanged` (lowercase `h` in
  #          `git ls-files -v`) — a local-only "trust me, it's clean" hint.
  #        - `git update-index --skip-worktree` (uppercase `S`) — sparse-checkout's
  #          "don't even look at the working copy" bit; distinct flag, distinct
  #          clear command, and `git ls-files -v` reports it with its own
  #          (uppercase) letter, not folded into the `h` case above.
  #      Clear both before diffing so (b) below actually sees the edit; the
  #      worktree is doomed either way, so mutating its index has no downside.
  local au_files sw_files
  au_files="$(git -C "$wt" ls-files -v 2>/dev/null | awk '/^h /{ $1=""; sub(/^ /,""); print }')"
  if [[ -n "$au_files" ]]; then
    ( cd "$wt" && printf '%s\n' "$au_files" | xargs -I{} git update-index --no-assume-unchanged -- {} ) 2>/dev/null || true
  fi
  sw_files="$(git -C "$wt" ls-files -v 2>/dev/null | awk '/^S /{ $1=""; sub(/^ /,""); print }')"
  if [[ -n "$sw_files" ]]; then
    ( cd "$wt" && printf '%s\n' "$sw_files" | xargs -I{} git update-index --no-skip-worktree -- {} ) 2>/dev/null || true
  fi

  # (b) Tracked uncommitted work → patch(es). Two DISTINCT deltas must each be
  #     captured or force-removal discards them:
  #       - working-tree-vs-HEAD (`git diff HEAD`): staged + unstaged combined.
  #       - index-vs-HEAD (`git diff --cached HEAD`): the staged delta ALONE, which
  #         `git diff HEAD` misses entirely when a later unstaged edit restores the
  #         working file back to its HEAD content (staged work then invisible).
  #     `--binary` so a changed tracked BINARY file's bytes are in the patch (plain
  #     `git diff` writes only a "Binary files ... differ" marker that can't restore).
  #     Routed through `_wsv_diff` so a repo/global `diff.external`/color config or a
  #     `.gitattributes` textconv driver can't substitute non-applyable output.
  if ! _wsv_diff "$wt" --quiet HEAD 2>/dev/null; then
    local tmp_p="${patch}.tmp.$$"
    if _wsv_diff "$wt" --binary HEAD >"$tmp_p" 2>/dev/null && [[ -s "$tmp_p" ]] && mv -f "$tmp_p" "$patch" 2>/dev/null; then
      saved_patch="$patch"
      files_changed="$(git -C "$wt" diff --name-only HEAD 2>/dev/null | grep -c . || echo 0)"
    else
      rm -f "$tmp_p" 2>/dev/null || true
      [[ -z "$err" ]] && err="patch-failed"
    fi
  fi
  # Index-only delta: snapshot the staged content separately whenever it differs
  # from HEAD, regardless of what the working tree shows.
  if ! _wsv_diff "$wt" --cached --quiet HEAD 2>/dev/null; then
    local tmp_ip="${idxpatch}.tmp.$$"
    if _wsv_diff "$wt" --cached --binary HEAD >"$tmp_ip" 2>/dev/null && [[ -s "$tmp_ip" ]] && mv -f "$tmp_ip" "$idxpatch" 2>/dev/null; then
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

  # (d) Dirty/uninitialized submodule state → recurse into each submodule (any
  #     depth via `--recursive`) and archive ITS OWN uncommitted diff +
  #     untracked files. The top-level diff above only records an opaque
  #     "Subproject commit <sha>-dirty" marker with none of the changed bytes,
  #     and (c) above (top-level `ls-files --others`) never descends into a
  #     submodule's own working tree at all.
  local submodules_saved=0
  local sm_status_lines
  sm_status_lines="$(git -C "$wt" submodule status --recursive 2>/dev/null || true)"
  if [[ -n "$sm_status_lines" ]]; then
    local sm_line sm_status sm_rest sm_path sm_rc
    while IFS= read -r sm_line; do
      [[ -z "$sm_line" ]] && continue
      sm_status="${sm_line:0:1}"
      # '-' = not initialized — no checked-out working tree under it to salvage.
      [[ "$sm_status" == "-" ]] && continue
      # `git submodule status` format after the 1-char status: "<sha> <path>[ (<describe>)]".
      # A plain `awk '{print $2}'` truncates a path containing spaces to its first
      # word — strip the fixed-width leading "<sha> " and the optional trailing
      # " (...)" describe suffix instead, leaving any spaces IN the path intact.
      sm_rest="${sm_line:1}"
      sm_path="$(printf '%s' "$sm_rest" | sed -E 's/^[0-9a-f]+ //; s/ \([^)]*\)$//')"
      [[ -z "$sm_path" || ! -d "${wt}/${sm_path}" ]] && continue
      _wsv_salvage_submodule "$wt" "$sm_path" "$stem"
      sm_rc=$?
      if [[ "$sm_rc" -eq 0 ]]; then
        submodules_saved=$((submodules_saved + 1))
      elif [[ "$sm_rc" -eq 2 ]]; then
        # Attempted but at least one artifact write failed — do NOT let the
        # top-level opaque dirty-gitlink patch mask this: the missing
        # submodule bytes are unrecoverable once force-removal proceeds.
        [[ -z "$err" ]] && err="submodule-salvage-failed"
      fi
    done <<<"$sm_status_lines"
  fi

  local payload
  payload="$(jq -nc \
    --arg b "$saved_bundle" --arg p "$saved_patch" --arg ip "$saved_idxpatch" --arg u "$saved_untar" \
    --arg r "$reason" --arg s "$site" --arg t "$ticket" \
    --argjson cs "${commits_saved:-0}" --argjson fc "${files_changed:-0}" --argjson uc "${untracked_count:-0}" \
    --argjson sms "${submodules_saved:-0}" \
    '{ticket:$t,site:$s,reason:$r,bundle:$b,patch:$p,index_patch:$ip,untracked_tar:$u,
      commits_saved:$cs,files_changed:$fc,untracked_count:$uc,submodules_saved:$sms}')" || payload="{}"

  # _WSV_LAST_STATUS: an optional out-of-band signal for callers that need to
  # know whether THIS invocation actually succeeded — `salvage_worktree` itself
  # deliberately always `return 0`s (its documented, relied-upon contract: a
  # salvage failure must never block the destructive removal it's guarding),
  # so the return code alone can't carry this. Set right before the matching
  # emit so a caller reading it immediately after the call sees the true
  # per-invocation outcome (created/skipped/failed), not a stale prior value.
  if [[ -n "$err" ]]; then
    _WSV_LAST_STATUS="failed"
    emit_salvage_failed --ticket "$ticket" --orch "$orch" \
      --payload-json "$(printf '%s' "$payload" | jq -c --arg e "$err" '. + {error:$e}')"
  elif [[ -n "$saved_bundle" || -n "$saved_patch" || -n "$saved_idxpatch" || -n "$saved_untar" || "$submodules_saved" -gt 0 ]]; then
    _WSV_LAST_STATUS="created"
    emit_salvage_created --ticket "$ticket" --orch "$orch" --payload-json "$payload"
  else
    _WSV_LAST_STATUS="skipped"
    emit_salvage_skipped --ticket "$ticket" --orch "$orch" --payload-json "$payload"
  fi
  return 0
}

# salvage_raw_directory <dir> <ticket> [--reason <str>] [--orch <id>] [--site <str>]
# For a directory that is NOT a valid git worktree (e.g. orphan-sweep's
# ORPHAN_GITFILE case — a stale/missing `.git` file pointer) `salvage_worktree`
# can't inspect it with git at all, but a stale/missing gitdir pointer does not
# imply the remaining working files carry no unique local edits. Archives the
# whole directory to a plain tar (no git involved) before the caller `rm -rf`s
# it. Best-effort/fail-open — ALWAYS returns 0, same contract as salvage_worktree.
salvage_raw_directory() {
  local target="${1:-}" ticket="${2:-}"; shift 2 2>/dev/null || true
  local reason="" orch="" site=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --reason) reason="$2"; shift 2 ;;
      --orch)   orch="$2";   shift 2 ;;
      --site)   site="$2";   shift 2 ;;
      *) shift ;;
    esac
  done

  if [[ -z "$target" || ! -d "$target" ]]; then
    emit_salvage_failed --ticket "$ticket" --orch "$orch" \
      --payload-json "$(jq -nc --arg s "$site" --arg r "$reason" '{site:$s,reason:$r,error:"not-a-directory"}')"
    return 0
  fi

  local dir ts uniq stem tarfile
  dir="$(_wsv_salvage_dir)"; ts="$(date -u +%Y%m%dT%H%M%SZ)"
  if ! mkdir -p "$dir" 2>/dev/null; then
    emit_salvage_failed --ticket "$ticket" --orch "$orch" \
      --payload-json "$(jq -nc --arg s "$site" '{site:$s,error:"mkdir-failed"}')"
    return 0
  fi
  uniq="$$-${RANDOM:-0}"
  stem="${dir}/${ticket}-${ts}-${uniq}"
  tarfile="${stem}-raw.tar"

  # Nothing to archive at all — an empty directory is not an error.
  if [[ -z "$(ls -A "$target" 2>/dev/null)" ]]; then
    emit_salvage_skipped --ticket "$ticket" --orch "$orch" \
      --payload-json "$(jq -nc --arg s "$site" --arg r "$reason" --arg t "$ticket" '{ticket:$t,site:$s,reason:$r,raw_tar:""}')"
    return 0
  fi

  local tmp_t="${tarfile}.tmp.$$"
  if ( cd "$target" && tar -cf "$tmp_t" . 2>/dev/null ) && mv -f "$tmp_t" "$tarfile" 2>/dev/null; then
    emit_salvage_created --ticket "$ticket" --orch "$orch" \
      --payload-json "$(jq -nc --arg s "$site" --arg r "$reason" --arg t "$ticket" --arg rt "$tarfile" \
        '{ticket:$t,site:$s,reason:$r,raw_tar:$rt}')"
  else
    rm -f "$tmp_t" 2>/dev/null || true
    emit_salvage_failed --ticket "$ticket" --orch "$orch" \
      --payload-json "$(jq -nc --arg s "$site" --arg r "$reason" --arg t "$ticket" '{ticket:$t,site:$s,reason:$r,error:"raw-tar-failed"}')"
  fi
  return 0
}

# Allow direct invocation for ad-hoc use / the JS shell-out seam. When executed
# (not sourced), `return` fails and we forward argv to salvage_worktree.
if ! (return 0 2>/dev/null); then salvage_worktree "$@"; fi
