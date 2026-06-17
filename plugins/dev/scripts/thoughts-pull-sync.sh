#!/usr/bin/env bash
# thoughts-pull-sync.sh (CTL-1236) — keep every HumanLayer thoughts checkout
# fast-forwarded so cross-host research/plans read fresh peer state.
#
# DATA-DRIVEN: reads the HumanLayer config and pulls every DISTINCT thoughtsRepo
# (global fallback + all profiles). Self-maintaining — add or remove profiles /
# repos and this auto-tracks them; nothing host- or repo-specific is hardcoded.
#
# SAFE: fast-forward ONLY. If a checkout has un-pushed local commits (a phase
# mid-write) or has diverged, the merge is refused (logged + skipped) — it never
# clobbers in-flight work. Auth is non-interactive (matches the headless cron).
set -uo pipefail

HL_CONFIG="${HL_CONFIG:-$HOME/.config/humanlayer/humanlayer.json}"
LOG="${THOUGHTS_PULL_LOG:-$HOME/catalyst/thoughts-pull-sync.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
log() { echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*" >>"$LOG"; }

command -v jq >/dev/null 2>&1 || { log "ERROR: jq not found"; exit 1; }
command -v git >/dev/null 2>&1 || { log "ERROR: git not found"; exit 1; }
[[ -f "$HL_CONFIG" ]] || { log "ERROR: no HumanLayer config at $HL_CONFIG"; exit 0; }

total=0 pulled=0 skipped=0 failed=0
while IFS= read -r repo; do
  [[ -z "$repo" ]] && continue
  case "$repo" in "~/"*) repo="$HOME/${repo#\~/}" ;; "~") repo="$HOME" ;; esac
  total=$((total + 1))
  if [[ ! -d "$repo/.git" ]]; then
    log "SKIP (not a git repo): $repo"; skipped=$((skipped + 1)); continue
  fi
  # Fetch (auth/network) is distinct from the ff-merge (local-state) so the log
  # tells a real-credential/network failure apart from a benign local-ahead skip.
  if ! ferr="$(git -C "$repo" -c credential.interactive=false fetch --quiet 2>&1)"; then
    log "FETCH-FAIL $repo: ${ferr%%$'\n'*}"; failed=$((failed + 1)); continue
  fi
  before="$(git -C "$repo" rev-parse --short HEAD 2>/dev/null || echo '?')"
  if git -C "$repo" merge --ff-only --quiet '@{u}' >/dev/null 2>&1; then
    after="$(git -C "$repo" rev-parse --short HEAD 2>/dev/null || echo '?')"
    if [[ "$before" != "$after" ]]; then
      log "PULLED $repo: $before -> $after"; pulled=$((pulled + 1))
    else
      skipped=$((skipped + 1))
    fi
  else
    # ff-only refused: local has un-pushed commits / diverged / no upstream.
    log "FF-SKIP $repo ($before): local ahead, diverged, or no upstream"; skipped=$((skipped + 1))
  fi
done < <(jq -r '
  ([ .thoughts.thoughtsRepo ] + [ .thoughts.profiles[]?.thoughtsRepo ])
  | map(select(. != null and . != "")) | unique | .[]' "$HL_CONFIG" 2>/dev/null)

log "done: $total repos | $pulled pulled | $skipped skipped | $failed failed"
