#!/usr/bin/env bash
# orphan-sweep.sh — Periodic belt-and-suspenders sweep for orphaned resources
# on unattended hosts. Complements the execution-core real-time reaper (CTL-657).
#
# Vectors:
#   1. Stale bun/node/turbo procs whose backing worktree is gone
#   2. Done-ticket worktrees not cleaned by /teardown
#   3. Stale phase signals: status=running + dead bg_job_id >30 min
#   4. Trunk repo cache dirs, mtime >30 days
#
# Usage:
#   orphan-sweep.sh [--dry-run] [--help]
#
# Env overrides (all have production defaults):
#   SWEEP_TRUNK_CACHE_DIR     — default: $HOME/.cache/trunk/repos
#   SWEEP_WORKERS_GLOB_ROOT   — default: $HOME/catalyst  (scans */workers/*/phase-*.json)
#   SWEEP_WT_ROOT             — default: $HOME/catalyst/wt
#   SWEEP_STALE_SECS          — default: 1800 (30 min)
#   SWEEP_CACHE_MTIME_DAYS    — default: 30
#   SWEEP_LINEAR_TEAMS        — default: "CTL ADV"
#   SWEEP_DRY_RUN             — set to 1 or use --dry-run flag
#   SWEEP_RUN_ID              — default: timestamp-based (set in tests for determinism)

set -uo pipefail

# Resolve script dir so sibling scripts (emit-otel-event.sh) are found.
_SRC="${BASH_SOURCE[0]}"
while [[ -L "$_SRC" ]]; do _SRC="$(readlink "$_SRC")"; done
SCRIPT_DIR="$(cd "$(dirname "$_SRC")" && pwd)"
unset _SRC
export PATH="${PATH}:${SCRIPT_DIR}"

# ─── arg parsing ────────────────────────────────────────────────────────────

DRY_RUN="${SWEEP_DRY_RUN:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "orphan-sweep: unknown flag: $1" >&2
      echo "usage: orphan-sweep.sh [--dry-run] [--help]" >&2
      exit 1
      ;;
  esac
done

# ─── roots (overridable via env) ────────────────────────────────────────────

_init_roots() {
  SWEEP_TRUNK_CACHE_DIR="${SWEEP_TRUNK_CACHE_DIR:-${HOME}/.cache/trunk/repos}"
  SWEEP_WORKERS_GLOB_ROOT="${SWEEP_WORKERS_GLOB_ROOT:-${HOME}/catalyst}"
  SWEEP_WT_ROOT="${SWEEP_WT_ROOT:-${HOME}/catalyst/wt}"
  SWEEP_STALE_SECS="${SWEEP_STALE_SECS:-1800}"
  SWEEP_CACHE_MTIME_DAYS="${SWEEP_CACHE_MTIME_DAYS:-30}"
  SWEEP_LINEAR_TEAMS="${SWEEP_LINEAR_TEAMS:-CTL ADV}"
  SWEEP_RUN_ID="${SWEEP_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
}

_init_roots

# global cache for live bg_job_ids (populated once per run by _live_bg_ids)
_LIVE_BG_IDS=""
_LIVE_BG_LOADED="0"

# ─── helpers ────────────────────────────────────────────────────────────────

log() { echo "[orphan-sweep ${SWEEP_RUN_ID}] $*"; }

is_dry() { [[ "$DRY_RUN" == "1" ]]; }

emit_reclaim() {
  local vector="$1" resource="$2"
  command -v emit-otel-event.sh >/dev/null 2>&1 || return 0
  emit-otel-event.sh \
    --event "catalyst.sweep.reclaim" \
    --outcome success \
    --session-id "$SWEEP_RUN_ID" \
    --attr "vector=${vector}" \
    --attr "resource=${resource}" >/dev/null 2>&1 || true
}

# ─── vector 4: trunk cache GC ───────────────────────────────────────────────

sweep_trunk_cache() {
  local root="${SWEEP_TRUNK_CACHE_DIR}" d
  [[ -d "$root" ]] || return 0
  while IFS= read -r -d '' d; do
    if is_dry; then
      log "[dry-run] would remove trunk cache: $d"
      continue
    fi
    rm -rf "$d" && { log "removed trunk cache: $d"; emit_reclaim trunk_cache "$d"; }
  done < <(find "$root" -mindepth 1 -maxdepth 1 -type d -mtime "+${SWEEP_CACHE_MTIME_DAYS}" -print0 2>/dev/null)
}

# ─── vector 3: stale phase-signal flip ──────────────────────────────────────

_live_bg_ids() {
  if [[ "$_LIVE_BG_LOADED" -eq 0 ]]; then
    _LIVE_BG_IDS="$(claude agents --json 2>/dev/null || echo '[]')"
    _LIVE_BG_LOADED=1
  fi
  echo "$_LIVE_BG_IDS"
}

_is_live_bg() {
  local job_id="$1"
  [[ -n "$job_id" ]] || return 1
  local agents_json
  agents_json="$(_live_bg_ids)"
  # interactive-kind sessions are never live-bg for our purposes
  # match any live session (background OR interactive) — never flip a signal
  # whose bg_job_id resolves to any live agent, regardless of kind
  echo "$agents_json" | jq -e --arg id "$job_id" '
    .[] | select(.sessionId | startswith($id))
  ' >/dev/null 2>&1
}

_age_secs() {
  local ts="${1%Z}"  # strip trailing Z; macOS date -j needs it absent
  local epoch_then epoch_now
  # macOS: TZ=UTC0 forces parsing as UTC (without it, date -j treats input as local time)
  # GNU date: date -d with Z suffix
  epoch_then="$(TZ=UTC0 date -j -f '%Y-%m-%dT%H:%M:%S' "$ts" +%s 2>/dev/null \
    || TZ=UTC date -d "${ts}" +%s 2>/dev/null \
    || echo 0)"
  epoch_now="$(date -u +%s)"
  echo $(( epoch_now - epoch_then ))
}

# Artifact files to exclude from signal sweeping (by basename)
_is_artifact_file() {
  local basename="$1"
  case "$basename" in
    triage.json|verify.json|review.json) return 0 ;;
    *-yield-*) return 0 ;;
    *) return 1 ;;
  esac
}

sweep_signals() {
  local root="${SWEEP_WORKERS_GLOB_ROOT}"
  [[ -d "$root" ]] || return 0

  local f basename status bg_job_id updated_at age_secs
  while IFS= read -r f; do
    basename="$(basename "$f")"

    # exclude artifact files
    _is_artifact_file "$basename" && continue
    # only process phase-*.json (not triage.json, verify.json, review.json)
    [[ "$basename" == phase-*.json ]] || continue

    # read fields
    status="$(jq -r '.status // empty' "$f" 2>/dev/null)" || continue
    [[ -n "$status" ]] || continue

    # only flip running signals
    [[ "$status" == "running" ]] || continue

    bg_job_id="$(jq -r '.bg_job_id // empty' "$f" 2>/dev/null)" || continue

    updated_at="$(jq -r '.updatedAt // empty' "$f" 2>/dev/null)" || continue
    [[ -n "$updated_at" ]] || continue

    # staleness check
    age_secs="$(_age_secs "$updated_at")"
    if [[ "$age_secs" -lt "$SWEEP_STALE_SECS" ]]; then
      continue
    fi

    # liveness check — skip if bg_job_id is live
    if [[ -n "$bg_job_id" ]] && _is_live_bg "$bg_job_id"; then
      continue
    fi

    # flip it
    if is_dry; then
      log "[dry-run] would flip stale signal: $f (bg_job_id=${bg_job_id}, age=${age_secs}s)"
      continue
    fi

    # CTL-1065: build structured explanation via CLI shim (always exits 0).
    local sig_ticket sig_phase
    sig_ticket="$(jq -r '.ticket // empty' "$f" 2>/dev/null)"
    sig_phase="$(jq -r '.phase // empty' "$f" 2>/dev/null)"
    local expl_json
    expl_json="$(node "${SCRIPT_DIR}/execution-core/escalation-explain.mjs" \
      --ticket "$sig_ticket" --phase "$sig_phase" \
      --what-failed "orphan-sweep found a stale phase signal for ${sig_ticket}/${sig_phase}" \
      --observed "$(jq -nc --arg job "$bg_job_id" '{bgJobId:$job,staleMarker:"orphan-sweep-stale"}' 2>/dev/null || echo '{}')" \
      --why-gave-up "the bg job is gone but the signal was never finalized" \
      --human-question "re-dispatch ${sig_ticket}/${sig_phase}, or mark it abandoned?" \
      2>/dev/null || echo '{}')"
    # CTL-1065: guard on a prior line — `${expl_json:-{}}` is a bash trap: the
    # parser closes the expansion at the FIRST `}`, so a non-empty value like
    # `{"a":1}` expands to `{"a":1}}` (trailing brace → invalid JSON → jq exit 2
    # → the `&& mv` is skipped and the stale signal is never flipped). Verified
    # in bash 3.2 and 5.x. Pass the variable directly instead.
    [ -n "$expl_json" ] || expl_json='{}'
    local tmp="${f}.tmp.$$"
    jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson expl "$expl_json" \
       '.status = "failed" | .failureReason = "orphan-sweep-stale" | .explanation = $expl | .updatedAt = $ts' \
       "$f" > "$tmp" && mv "$tmp" "$f"
    log "flipped stale signal: $f"
    emit_reclaim stale_signal "$f"

  done < <(find "$root" -name 'phase-*.json' -type f 2>/dev/null | sort)
}

# ─── vector 1: stale bun/node/turbo proc kill ───────────────────────────────

_proc_cwd() {
  lsof -p "$1" -a -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

_candidate_pids() {
  pgrep -f 'bun run|turbo|node' 2>/dev/null || true
}

sweep_procs() {
  local pid cwd
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    cwd="$(_proc_cwd "$pid")"
    [[ -n "$cwd" ]] || continue    # unknown cwd → conservative skip
    [[ -d "$cwd" ]] && continue    # cwd exists → live, skip
    if is_dry; then
      log "[dry-run] would kill $pid (cwd gone: $cwd)"
      continue
    fi
    env kill "$pid" 2>/dev/null && { log "killed $pid (cwd gone: $cwd)"; emit_reclaim bun_proc "$pid"; }
  done < <(_candidate_pids)
}

# ─── vector 2: Done-ticket worktree removal ─────────────────────────────────

sweep_worktrees() {
  local team id wt
  for team in $SWEEP_LINEAR_TEAMS; do
    while IFS= read -r id; do
      [[ -n "$id" ]] || continue

      # locate worktree: $SWEEP_WT_ROOT/*/$id
      wt=""
      local candidate
      for candidate in "${SWEEP_WT_ROOT}"/*/"$id"; do
        [[ -d "$candidate" ]] && { wt="$candidate"; break; }
      done
      [[ -n "$wt" ]] || continue

      # clean check first (cheap)
      if [[ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]]; then
        log "skip dirty worktree: $wt"
        continue
      fi

      if is_dry; then
        log "[dry-run] would remove worktree: $wt"
        continue
      fi

      # presweep: stop sessions (gate before irreversible remove)
      if command -v worktree-presweep.sh >/dev/null 2>&1; then
        worktree-presweep.sh "$wt" 2>/dev/null || { log "skip (sessions remain): $wt"; continue; }
      fi

      git worktree remove "$wt" 2>/dev/null \
        && { log "removed worktree: $wt"; emit_reclaim worktree "$wt"; }

    done < <(linearis issues list --team "$team" --status "Done" --limit 200 2>/dev/null \
               | jq -r '.[].identifier' 2>/dev/null || true)
  done
}

# ─── main ───────────────────────────────────────────────────────────────────

main() {
  if is_dry; then
    log "=== DRY RUN — no changes will be made ==="
  fi

  log "starting sweep (vectors: trunk_cache, signals, procs, worktrees)"

  sweep_trunk_cache
  sweep_procs
  sweep_signals
  sweep_worktrees

  log "sweep complete"
  exit 0
}

main "$@"
