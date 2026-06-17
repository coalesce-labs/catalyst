#!/usr/bin/env bash
# migrate-thoughts-pollution.sh — consume a Phase-1 audit manifest and move every
# MOVE-classified file from a (misrouted) source thoughts checkout into the
# coalesce-labs thoughts checkout, preserving the repos/<subdir>/… layout.
# (CTL-1246, §6 of the cluster HLT thoughts-model design, CTL-1214.)
#
# Defaults to --dry-run. Pre-checks collisions and aborts BEFORE moving anything if
# any target exists with differing content. Uses `git mv` for tracked files (plain
# `mv` for untracked) — when source and target live in the same repo this preserves
# `git log --follow` history (modeled on plugins/meta/scripts/move-and-rereference.sh
# :215-286). Idempotent: a record whose source is already drained and whose target
# is present is a safe no-op, so re-running --execute never duplicates or loses a
# file. The script stages the moves; committing/pushing is left to the operator.
#
# Usage:
#   migrate-thoughts-pollution.sh --manifest <file.jsonl>
#                                 --source-root <checkout>
#                                 --target-root <coalesce-labs checkout>
#                                 [--dry-run | --execute]
#
#   --manifest     REQUIRED. JSONL manifest from audit-thoughts-pollution.sh.
#   --source-root  REQUIRED. The checkout the MOVE paths are relative to.
#   --target-root  REQUIRED. The coalesce-labs checkout to move them into.
#   --dry-run      Default. Print the planned moves, change nothing.
#   --execute      Perform the moves (after the collision pre-check passes).
#
# Exit codes: 0 success / clean no-op · 1 bad args, missing files, or a collision.
set -euo pipefail

info() { echo "[migrate-thoughts] $*" >&2; }
fail() { echo "[migrate-thoughts] ERROR: $*" >&2; }
usage() { sed -n '2,30p' "$0" >&2; }

MANIFEST=""; SOURCE_ROOT=""; TARGET_ROOT=""; MODE="dry-run"
while [[ $# -gt 0 ]]; do case "$1" in
  --manifest)    MANIFEST="${2:-}"; shift 2 ;;
  --source-root) SOURCE_ROOT="${2:-}"; shift 2 ;;
  --target-root) TARGET_ROOT="${2:-}"; shift 2 ;;
  --dry-run)     MODE="dry-run"; shift ;;
  --execute)     MODE="execute"; shift ;;
  -h|--help)     usage; exit 0 ;;
  *) fail "unknown arg: $1"; usage; exit 1 ;;
esac; done

command -v jq  >/dev/null || { fail "jq required";  exit 1; }
command -v git >/dev/null || { fail "git required"; exit 1; }

[[ -n "$MANIFEST" ]]    || { fail "--manifest is required"; exit 1; }
[[ -f "$MANIFEST" ]]    || { fail "manifest not found: $MANIFEST"; exit 1; }
[[ -n "$SOURCE_ROOT" ]] || { fail "--source-root is required"; exit 1; }
[[ -d "$SOURCE_ROOT" ]] || { fail "--source-root does not exist: $SOURCE_ROOT"; exit 1; }
[[ -n "$TARGET_ROOT" ]] || { fail "--target-root is required"; exit 1; }
[[ -d "$TARGET_ROOT" ]] || { fail "--target-root does not exist: $TARGET_ROOT"; exit 1; }

# Absolute roots so `git mv` (which is repo-relative-aware but path-literal) works
# regardless of the caller's cwd.
SOURCE_ROOT="$(cd "$SOURCE_ROOT" && pwd)"
TARGET_ROOT="$(cd "$TARGET_ROOT" && pwd)"

# ── Select the MOVE set from the manifest ─────────────────────────────────────
declare -a MOVE_PATHS=()
while IFS= read -r p; do
  [[ -n "$p" ]] && MOVE_PATHS+=("$p")
done < <(jq -r 'select(.classification=="MOVE") | .path' "$MANIFEST" 2>/dev/null)

if ((${#MOVE_PATHS[@]} == 0)); then
  info "nothing to migrate (0 MOVE records in manifest)"
  exit 0
fi

# ── Collision pre-check (move-and-rereference.sh:215-286 behavior) ────────────
# A collision is a target that already exists with DIFFERING content. An identical
# target is treated as already-migrated (idempotent), not a conflict. Collect ALL
# conflicts and abort before touching anything.
declare -a CONFLICTS=()
for rel in "${MOVE_PATHS[@]}"; do
  src="$SOURCE_ROOT/$rel"; tgt="$TARGET_ROOT/$rel"
  if [[ -e "$src" && -e "$tgt" ]] && ! cmp -s "$src" "$tgt"; then
    CONFLICTS+=("$rel")
  fi
done
if ((${#CONFLICTS[@]})); then
  fail "collision: ${#CONFLICTS[@]} target path(s) already exist with differing content — aborting, moved nothing:"
  for c in "${CONFLICTS[@]}"; do echo "  CONFLICT: $c" >&2; done
  exit 1
fi

# ── Plan / execute ────────────────────────────────────────────────────────────
move_one() {
  local src="$1" tgt="$2"
  local src_dir tgt_dir src_repo tgt_repo
  src_dir="$(dirname "$src")"
  tgt_dir="$(dirname "$tgt")"
  mkdir -p "$tgt_dir"
  src_repo="$(git -C "$src_dir" rev-parse --show-toplevel 2>/dev/null || true)"
  tgt_repo="$(git -C "$tgt_dir" rev-parse --show-toplevel 2>/dev/null || true)"

  if [[ -n "$src_repo" ]] && git -C "$src_repo" ls-files --error-unmatch "$src" >/dev/null 2>&1; then
    # Tracked source.
    if [[ -n "$tgt_repo" && "$src_repo" == "$tgt_repo" ]]; then
      git -C "$src_repo" mv "$src" "$tgt"           # same repo → history preserved
    else
      mv "$src" "$tgt"                              # cross-repo: bytes preserved
      [[ -n "$tgt_repo" ]] && git -C "$tgt_repo" add "$tgt" >/dev/null 2>&1 || true
      git -C "$src_repo" add -A "$src_dir" >/dev/null 2>&1 || true  # stage deletion
    fi
  else
    # Untracked source → plain mv (stage in the target repo if there is one).
    mv "$src" "$tgt"
    [[ -n "$tgt_repo" ]] && git -C "$tgt_repo" add "$tgt" >/dev/null 2>&1 || true
  fi
}

planned=0; moved=0; skipped=0
for rel in "${MOVE_PATHS[@]}"; do
  src="$SOURCE_ROOT/$rel"; tgt="$TARGET_ROOT/$rel"
  if [[ ! -e "$src" && -e "$tgt" ]]; then
    info "skip (already migrated): $rel"
    skipped=$((skipped + 1)); continue
  fi
  if [[ ! -e "$src" && ! -e "$tgt" ]]; then
    info "skip (source absent, target absent — already migrated or out of scope): $rel"
    skipped=$((skipped + 1)); continue
  fi
  # source exists (target absent, or identical — pre-check cleared differing ones).
  if [[ -e "$tgt" ]]; then
    # identical target (cmp passed pre-check): leave both, do not duplicate.
    info "skip (target already identical): $rel"
    skipped=$((skipped + 1)); continue
  fi
  planned=$((planned + 1))
  if [[ "$MODE" == "execute" ]]; then
    move_one "$src" "$tgt"
    moved=$((moved + 1))
    info "moved: $rel → target"
  else
    info "[dry-run] would git mv: $rel → target"
  fi
done

if [[ "$MODE" == "execute" ]]; then
  info "migrate summary: planned=$planned moved=$moved skipped(idempotent)=$skipped"
else
  info "migrate summary (dry-run): would-move=$planned skipped(idempotent)=$skipped — re-run with --execute to apply"
fi
exit 0
