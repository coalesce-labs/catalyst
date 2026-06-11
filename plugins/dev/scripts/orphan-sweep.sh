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
_PRINT_CONFIG=0
_COUNT_DIRTY=0
_CLASSIFY=0
_CLASSIFY_PATH=""
_CLASSIFY_TRUNK=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --print-config) _PRINT_CONFIG=1; shift ;;
    --count-dirty) _COUNT_DIRTY=1; shift ;;
    --classify) _CLASSIFY=1; _CLASSIFY_PATH="${2:-}"; [[ -n "$_CLASSIFY_PATH" ]] && shift; shift ;;
    --trunk)    _CLASSIFY_TRUNK="${2:-}"; shift 2 ;;
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

# --- config + noise classification (CTL-1030) ---
# Segment-anchored noise (intentionally stricter than worktree-safety.mjs substring match)
SWEEP_NOISE_PATHS=( node_modules .cache .trunk dist build .DS_Store bun.lock .session-id )

_resolve_sweep_config_path() {
  local dir="$PWD"
  while [[ "$dir" != "/" && -n "$dir" ]]; do
    [[ -f "${dir}/.catalyst/config.json" ]] && { printf '%s' "${dir}/.catalyst/config.json"; return 0; }
    dir="$(dirname "$dir")"
  done
  local repo_cfg="${SCRIPT_DIR}/../../../.catalyst/config.json"
  [[ -f "$repo_cfg" ]] && { printf '%s' "$repo_cfg"; return 0; }
  printf ''
}

_cfg_str() {
  [[ -f "${SWEEP_CONFIG_PATH:-}" ]] && command -v jq >/dev/null 2>&1 || { printf ''; return 0; }
  jq -r "$1 // empty" "$SWEEP_CONFIG_PATH" 2>/dev/null || printf ''
}

_load_sweep_config() {
  local v
  if [[ -z "${SWEEP_IDLE_HOURS:-}" ]]; then
    v="$(_cfg_str '.catalyst.sweep.idleHours')"; SWEEP_IDLE_HOURS="${v:-48}"
  fi
  if [[ -z "${SWEEP_INTERVAL_HOURS:-}" ]]; then
    v="$(_cfg_str '.catalyst.sweep.intervalHours')"; SWEEP_INTERVAL_HOURS="${v:-2}"
  fi
  case "$SWEEP_INTERVAL_HOURS" in
    1|2|3) ;;
    *) log "sweep config: intervalHours='${SWEEP_INTERVAL_HOURS}' invalid (allowed 1|2|3); falling back to default 2" >&2
       SWEEP_INTERVAL_HOURS=2 ;;
  esac
  # salvagePush: do NOT use jq // default (false is jq-falsy; see draft-pr.sh:146-147)
  if [[ -z "${SWEEP_SALVAGE_PUSH:-}" ]]; then
    v="$(_cfg_str '.catalyst.sweep.salvagePush')"
    [[ "$v" == "true" ]] && SWEEP_SALVAGE_PUSH=1 || SWEEP_SALVAGE_PUSH=0
  else
    [[ "$SWEEP_SALVAGE_PUSH" == "true" || "$SWEEP_SALVAGE_PUSH" == "1" ]] && SWEEP_SALVAGE_PUSH=1 || SWEEP_SALVAGE_PUSH=0
  fi
  if [[ -z "${SWEEP_MAX_REMOVALS:-}" ]]; then
    v="$(_cfg_str '.catalyst.sweep.maxRemovalsPerRun')"; SWEEP_MAX_REMOVALS="${v:-20}"
  fi
}

_porcelain_path() {
  local body="${1:3}"
  [[ "$body" == *" -> "* ]] && body="${body##* -> }"
  body="${body#\"}" body="${body%\"}"
  printf '%s' "$body"
}

_is_noise_path() {
  local p="$1" n
  [[ "$p" == *.log ]] && return 0
  [[ "$p" == .catalyst/config.json ]] && return 0
  for n in "${SWEEP_NOISE_PATHS[@]}"; do
    [[ "$p" == "$n" || "$p" == "$n/"* || "$p" == *"/$n" || "$p" == *"/$n/"* ]] && return 0
  done
  return 1
}

_real_dirty_count_stdin() {
  local line p count=0
  while IFS= read -r line; do
    [[ -z "${line// }" ]] && continue
    p="$(_porcelain_path "$line")"
    _is_noise_path "$p" || count=$((count+1))
  done
  printf '%s\n' "$count"
}

_real_dirty_count() { git -C "$1" status --porcelain 2>/dev/null | _real_dirty_count_stdin; }

# ─── roots (overridable via env) ────────────────────────────────────────────

_init_roots() {
  SWEEP_TRUNK_CACHE_DIR="${SWEEP_TRUNK_CACHE_DIR:-${HOME}/.cache/trunk/repos}"
  SWEEP_WORKERS_GLOB_ROOT="${SWEEP_WORKERS_GLOB_ROOT:-${HOME}/catalyst}"
  SWEEP_WT_ROOT="${SWEEP_WT_ROOT:-${HOME}/catalyst/wt}"
  SWEEP_STALE_SECS="${SWEEP_STALE_SECS:-1800}"
  SWEEP_CACHE_MTIME_DAYS="${SWEEP_CACHE_MTIME_DAYS:-30}"
  SWEEP_LINEAR_TEAMS="${SWEEP_LINEAR_TEAMS:-CTL ADV}"
  SWEEP_RUN_ID="${SWEEP_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
  SWEEP_CONFIG_PATH="${SWEEP_CONFIG_PATH:-$(_resolve_sweep_config_path)}"
  _load_sweep_config
}

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

_init_roots

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

# --- vector 2 classifier (CTL-1030) ---

_LIVE_AGENTS_JSON=""
_LIVE_AGENTS_LOADED=0
_live_agents_json() {
  if [[ "$_LIVE_AGENTS_LOADED" -eq 0 ]]; then
    _LIVE_AGENTS_JSON="$(claude agents --json 2>/dev/null || echo '[]')"
    _LIVE_AGENTS_LOADED=1
  fi
  printf '%s' "$_LIVE_AGENTS_JSON"
}

_wt_active_session() {
  local wt="${1%/}" json
  json="$(_live_agents_json)"
  printf '%s' "$json" | jq -e --arg wt "$wt" \
    '[.[]? | select(.cwd != null and (.cwd == $wt or (.cwd | startswith($wt + "/"))))] | length > 0' \
    >/dev/null 2>&1
}

_is_orphan_gitfile_dir() {
  local gitfile="${1}/.git" gitdir
  [[ -f "$gitfile" ]] || return 1
  gitdir="$(sed -n 's/^gitdir: //p' "$gitfile" 2>/dev/null)"
  [[ -n "$gitdir" ]] || return 1
  [[ "$gitdir" == /* ]] || gitdir="${1}/${gitdir}"
  [[ ! -d "$gitdir" ]]
}

_wt_ancestry_ok() {
  git -C "$1" merge-base --is-ancestor HEAD "$2" >/dev/null 2>&1 && return 0
  [[ -n "$(git -C "$1" branch -r --contains HEAD 2>/dev/null)" ]] && return 0
  return 1
}

_wt_unpushed_count() {
  local ref
  local refs=()
  while IFS= read -r ref; do
    [[ -n "$ref" ]] && refs+=( "$ref" )
  done < <(git -C "$1" for-each-ref --format='%(refname)' refs/remotes/origin 2>/dev/null)
  [[ ${#refs[@]} -eq 0 ]] && { printf '0'; return 0; }
  git -C "$1" rev-list --count HEAD --not "${refs[@]}" 2>/dev/null || printf '0'
}

_wt_newest_mtime() {
  find "$1" -type f \
    -not -path '*/node_modules/*' -not -path '*/.cache/*' \
    -not -path '*/.trunk/*' -not -path '*/dist/*' -not -path '*/build/*' \
    2>/dev/null \
  | while IFS= read -r f; do
      stat -f '%m' "$f" 2>/dev/null || stat -c '%Y' "$f" 2>/dev/null || echo 0
    done \
  | sort -nr | head -1
}

_wt_is_idle() {
  local newest now
  newest="$(_wt_newest_mtime "$1")"
  [[ -z "$newest" || "$newest" == "0" ]] && return 0
  now="$(date -u +%s)"
  [[ $(( now - newest )) -ge $(( SWEEP_IDLE_HOURS * 3600 )) ]]
}

classify_worktree() {
  local wt="$1" trunk="${2:-origin/main}" dirty unpushed
  [[ -d "$wt" ]] || { printf 'KEEP'; return 0; }
  _wt_active_session "$wt" 2>/dev/null && { printf 'KEEP'; return 0; }
  if _is_orphan_gitfile_dir "$wt" 2>/dev/null; then
    _wt_is_idle "$wt" && { printf 'ORPHAN_GITFILE'; return 0; }
    printf 'KEEP'; return 0
  fi
  dirty="$(_real_dirty_count "$wt" 2>/dev/null || echo 0)"
  [[ "$dirty" -gt 0 ]] && { printf 'SALVAGE_DIRTY'; return 0; }
  unpushed="$(_wt_unpushed_count "$wt" 2>/dev/null || echo 0)"
  [[ "$unpushed" -gt 0 ]] && { printf 'SALVAGE_UNPUSHED'; return 0; }
  if _wt_ancestry_ok "$wt" "$trunk" 2>/dev/null && _wt_is_idle "$wt"; then
    printf 'SAFE'; return 0
  fi
  printf 'KEEP'
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

    # CTL-1130: build typed DECISION explanation via CLI shim (always exits 0).
    # GATE 1 passes (re-dispatch is possible); no single dominant option → DECISION.
    local sig_ticket sig_phase
    sig_ticket="$(jq -r '.ticket // empty' "$f" 2>/dev/null)"
    sig_phase="$(jq -r '.phase // empty' "$f" 2>/dev/null)"
    local expl_json
    expl_json="$(node "${SCRIPT_DIR}/execution-core/escalation-explain.mjs" \
      --ticket "$sig_ticket" --phase "$sig_phase" \
      --type decision \
      --problem "orphan-sweep found a stale phase signal for ${sig_ticket}/${sig_phase}: bg job ${bg_job_id} is gone but the signal was never finalized" \
      --call-to-action "re-dispatch ${sig_ticket}/${sig_phase}, or mark it abandoned?" \
      --options "$(jq -nc --arg t "${sig_ticket}" --arg p "${sig_phase}" \
        '[{"label":"re-dispatch \($t)/\($p)","tradeoff":"may re-hit the same failure if root cause unresolved"},{"label":"mark abandoned","tradeoff":"loses any partial work that was not committed"}]' \
        2>/dev/null || echo '[{"label":"re-dispatch","tradeoff":"may fail again"},{"label":"abandon","tradeoff":"lose progress"}]')" \
      --why-you "re-dispatch vs abandon is a priority call the orchestrator cannot compute without human context" \
      --observed "$(jq -nc --arg job "$bg_job_id" '{bgJobId:$job,staleMarker:"orphan-sweep-stale"}' 2>/dev/null || echo '{}')" \
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
  if [[ "$_PRINT_CONFIG" == "1" ]]; then
    printf 'SWEEP_IDLE_HOURS=%s\nSWEEP_INTERVAL_HOURS=%s\nSWEEP_SALVAGE_PUSH=%s\nSWEEP_MAX_REMOVALS=%s\n' \
      "$SWEEP_IDLE_HOURS" "$SWEEP_INTERVAL_HOURS" "$SWEEP_SALVAGE_PUSH" "$SWEEP_MAX_REMOVALS"
    exit 0
  fi
  [[ "$_COUNT_DIRTY" == "1" ]] && { _real_dirty_count_stdin; exit 0; }

  if [[ "$_CLASSIFY" == "1" ]]; then
    classify_worktree "$_CLASSIFY_PATH" "${_CLASSIFY_TRUNK:-origin/main}"
    echo
    exit 0
  fi

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
