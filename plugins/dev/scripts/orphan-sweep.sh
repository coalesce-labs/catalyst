#!/usr/bin/env bash
# orphan-sweep.sh — Periodic belt-and-suspenders sweep for orphaned resources
# on unattended hosts. Complements the execution-core real-time reaper (CTL-657).
#
# Vectors:
#   1. Stale bun/node/turbo procs whose backing worktree is gone
#   2. Orphaned/idle worktrees (multi-signal classifier, CTL-1030)
#   3. Stale phase signals: status=running + dead bg_job_id >30 min
#   4. Trunk repo cache dirs, mtime >30 days
#   5. Leaked agent-browser browsers/daemons (CTL-1500): a per-session daemon owns
#      a real "Chrome for Testing" / chrome-headless-shell browser (Playwright,
#      under ms-playwright) that OUTLIVES the CLI and has no idle timeout in old
#      versions. Reap when a browser subtree is CPU-pegged (runaway) or older than
#      a TTL. Targets ONLY the ms-playwright browser — NEVER /Applications personal
#      Chrome.
#
# Usage:
#   orphan-sweep.sh [--dry-run] [--print-config] [--count-dirty]
#                   [--classify <path> [--trunk <ref>]] [--help]
#
# Env overrides (all have production defaults):
#   SWEEP_TRUNK_CACHE_DIR       — default: $HOME/.cache/trunk/repos
#   SWEEP_WORKERS_GLOB_ROOT     — default: $HOME/catalyst  (scans */workers/*/phase-*.json)
#   SWEEP_WT_ROOT               — default: $HOME/catalyst/wt
#   SWEEP_STALE_SECS            — default: 1800 (30 min)
#   SWEEP_CACHE_MTIME_DAYS      — default: 30
#   SWEEP_AB_ENABLED            — agent-browser reaper on/off (default 1)
#   SWEEP_AB_CPU_THRESHOLD      — runaway browser %CPU threshold (default 30)
#   SWEEP_AB_MIN_AGE_SECS       — min browser age for the runaway rule (default 600)
#   SWEEP_AB_TTL_SECS           — absolute leaked-browser age cap (default 14400 / 4h)
#   SWEEP_AB_SOCKET_DIR         — agent-browser sock/pid dir (default: $AGENT_BROWSER_SOCKET_DIR
#                                 else $XDG_RUNTIME_DIR/agent-browser else ~/.agent-browser)
#   SWEEP_IDLE_HOURS            — idle window before a worktree qualifies (default from config / 48)
#   SWEEP_MAX_REMOVALS          — per-run deletion cap (default from config / 20)
#   SWEEP_SALVAGE_PUSH          — 1 to push salvage branch before remove (default from config / 0)
#   SWEEP_INTERVAL_HOURS        — launchd schedule token (1|2|3h, default from config / 2)
#   SWEEP_INCLUDE_GLOBAL_CLAUDE_WT — scan ~/.claude/worktrees (default 1)
#   SWEEP_PROJECT_CLAUDE_WT     — project .claude/worktrees path
#   SWEEP_DRY_RUN               — set to 1 or use --dry-run flag
#   SWEEP_RUN_ID                — default: timestamp-based (set in tests for determinism)
#   SWEEP_FORCE_POWER           — 1 to force sweep even on battery

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
  SWEEP_INCLUDE_GLOBAL_CLAUDE_WT="${SWEEP_INCLUDE_GLOBAL_CLAUDE_WT:-1}"
  SWEEP_PROJECT_CLAUDE_WT="${SWEEP_PROJECT_CLAUDE_WT:-${SCRIPT_DIR%/plugins/dev/scripts}/.claude/worktrees}"
  SWEEP_CONFIG_PATH="${SWEEP_CONFIG_PATH:-$(_resolve_sweep_config_path)}"
  # CTL-1500: agent-browser reaper knobs (production defaults; all overridable).
  SWEEP_AB_ENABLED="${SWEEP_AB_ENABLED:-1}"
  SWEEP_AB_CPU_THRESHOLD="${SWEEP_AB_CPU_THRESHOLD:-30}"
  SWEEP_AB_MIN_AGE_SECS="${SWEEP_AB_MIN_AGE_SECS:-600}"
  SWEEP_AB_TTL_SECS="${SWEEP_AB_TTL_SECS:-14400}"
  _load_sweep_config
}

# OTel sweep counters
_SWEEP_REMOVED=0
_SWEEP_SALVAGE_SKIPPED=0
_SWEEP_ACTIVE_SKIPPED=0
_SWEEP_KEEP=0
_SWEEP_RECLAIMED_KB=0
_SWEEP_START_EPOCH=0

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

emit_sweep_completed() {
  command -v emit-otel-event.sh >/dev/null 2>&1 || return 0
  local now dur bytes host
  now="$(date -u +%s)"
  dur=$(( (now - _SWEEP_START_EPOCH) * 1000 ))
  [[ $dur -lt 0 ]] && dur=0
  bytes=$(( _SWEEP_RECLAIMED_KB * 1024 ))
  host="$(hostname 2>/dev/null || echo unknown)"
  emit-otel-event.sh \
    --event "worktree.sweep.completed" --outcome success \
    --session-id "$SWEEP_RUN_ID" \
    --attr "reclaimedBytes=${bytes}" --attr "removed=${_SWEEP_REMOVED}" \
    --attr "salvageSkipped=${_SWEEP_SALVAGE_SKIPPED}" \
    --attr "activeSkipped=${_SWEEP_ACTIVE_SKIPPED}" \
    --attr "durationMs=${dur}" --attr "host=${host}" >/dev/null 2>&1 || true
}

_sweep_count() {
  case "$1" in
    removed)        _SWEEP_REMOVED=$((_SWEEP_REMOVED+1)) ;;
    salvageSkipped) _SWEEP_SALVAGE_SKIPPED=$((_SWEEP_SALVAGE_SKIPPED+1)) ;;
    activeSkipped)  _SWEEP_ACTIVE_SKIPPED=$((_SWEEP_ACTIVE_SKIPPED+1)) ;;
    keep)           _SWEEP_KEEP=$((_SWEEP_KEEP+1)) ;;
  esac
}

_du_kb() { du -sk "$1" 2>/dev/null | awk '{print $1+0}' || echo 0; }

_sweep_add_kb() { _SWEEP_RECLAIMED_KB=$((_SWEEP_RECLAIMED_KB+${1:-0})); }

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

# ─── vector 2: multi-signal worktree reclamation (CTL-1030) ─────────────────

should_run_on_power() {
  local override="${SWEEP_FORCE_POWER:-}"
  case "$override" in ac|AC) return 0 ;; battery|BATTERY) return 1 ;; esac
  if command -v pmset >/dev/null 2>&1; then
    pmset -g batt 2>/dev/null | grep -q "AC Power" && return 0
    pmset -g batt 2>/dev/null | grep -q "Battery Power" && return 1
    return 0
  fi
  local f
  for f in /sys/class/power_supply/*/online; do
    [[ -e "$f" ]] && [[ "$(cat "$f" 2>/dev/null)" == "1" ]] && return 0
  done
  return 0
}

resolve_trunk_ref() {
  git -C "$1" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null \
    || printf 'origin/main'
}

discover_worktree_roots() {
  printf '%s\n' "$SWEEP_WT_ROOT"
  if [[ "${SWEEP_INCLUDE_GLOBAL_CLAUDE_WT:-1}" == "1" ]]; then
    local global_wt="${HOME}/.claude/worktrees"
    [[ -d "$global_wt" ]] && printf '%s\n' "$global_wt"
  fi
  local proj_wt="${SWEEP_PROJECT_CLAUDE_WT:-}"
  [[ -n "$proj_wt" && -d "$proj_wt" && "$proj_wt" != "${HOME}/.claude/worktrees" ]] \
    && printf '%s\n' "$proj_wt"
}

enumerate_worktree_dirs() {
  local root="$1"
  [[ -d "$root" ]] || return 0
  find "$root" -mindepth 1 -maxdepth 2 -type d -print0 2>/dev/null \
  | while IFS= read -r -d '' d; do
      [[ -e "${d}/.git" ]] && printf '%s\0' "$d"
    done
}

_is_primary_checkout() {
  local wt="$1"
  local primary
  primary="$(git -C "$wt" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -1)"
  [[ -z "$primary" ]] && return 1
  local wt_real primary_real
  wt_real="$(cd "$wt" 2>/dev/null && pwd -P)"
  primary_real="$(cd "$primary" 2>/dev/null && pwd -P)"
  [[ "$wt_real" == "$primary_real" ]]
}

salvage_push_then_remove() {
  local wt="$1" ticket="$2" sha branch
  sha="$(git -C "$wt" rev-parse --short HEAD 2>/dev/null)"
  branch="salvage/${ticket}-${sha}"
  if is_dry; then log "[dry-run] would push ${branch} then remove: $wt"; return 1; fi
  if git -C "$wt" push -u origin "HEAD:refs/heads/${branch}" 2>/dev/null; then
    log "salvage pushed ${branch} from $wt"; return 0
  fi
  log "salvage push failed for $wt (${branch}) — keeping"; return 1
}

sweep_worktrees() {
  if ! should_run_on_power; then
    log "on battery — deferring worktree sweep (cheap vectors already ran)"
    return 0
  fi

  local root wt trunk verdict wt_id kb
  local removed_count=0 deferred=0

  while IFS= read -r root; do
    while IFS= read -r -d '' wt; do
      wt_id="$(basename "$wt")"

      # never remove the primary checkout of any git repo
      if _is_primary_checkout "$wt" 2>/dev/null; then
        log "skip primary checkout: $wt"
        continue
      fi

      trunk="$(resolve_trunk_ref "$wt")"
      verdict="$(classify_worktree "$wt" "$trunk")"

      case "$verdict" in
        SAFE)
          if [[ -n "${SWEEP_MAX_REMOVALS:-}" && "$removed_count" -ge "$SWEEP_MAX_REMOVALS" ]]; then
            deferred=$((deferred+1)); continue
          fi
          if is_dry; then
            log "[dry-run] would remove worktree (SAFE): $wt"
            _sweep_count removed; removed_count=$((removed_count+1))
            continue
          fi
          if command -v worktree-presweep.sh >/dev/null 2>&1; then
            worktree-presweep.sh "$wt" 2>/dev/null || {
              log "skip (sessions remain): $wt"; _sweep_count activeSkipped; continue
            }
          fi
          kb="$(_du_kb "$wt")"
          git worktree remove --force "$wt" 2>/dev/null && {
            log "removed worktree (SAFE): $wt"
            _sweep_count removed; removed_count=$((removed_count+1))
            _sweep_add_kb "$kb"
            emit_reclaim worktree "$wt"
          }
          ;;
        ORPHAN_GITFILE)
          if [[ -n "${SWEEP_MAX_REMOVALS:-}" && "$removed_count" -ge "$SWEEP_MAX_REMOVALS" ]]; then
            deferred=$((deferred+1)); continue
          fi
          if is_dry; then
            log "[dry-run] would remove orphan gitfile dir: $wt"
            _sweep_count removed; removed_count=$((removed_count+1))
            continue
          fi
          kb="$(_du_kb "$wt")"
          rm -rf "$wt" && {
            log "removed orphan gitfile dir: $wt"
            _sweep_count removed; removed_count=$((removed_count+1))
            _sweep_add_kb "$kb"
            emit_reclaim orphan_gitfile "$wt"
          }
          ;;
        SALVAGE_UNPUSHED)
          wt_id="$(basename "$wt")"
          if [[ "$SWEEP_SALVAGE_PUSH" == "1" ]]; then
            if salvage_push_then_remove "$wt" "$wt_id"; then
              if [[ -n "${SWEEP_MAX_REMOVALS:-}" && "$removed_count" -ge "$SWEEP_MAX_REMOVALS" ]]; then
                deferred=$((deferred+1)); continue
              fi
              git worktree remove --force "$wt" 2>/dev/null \
                && { log "removed (salvage) worktree: $wt"; emit_reclaim worktree "$wt"; removed_count=$((removed_count+1)); }
            fi
          else
            log "salvage (unpushed commits, skip+report): $wt"
            _sweep_count salvageSkipped
          fi
          ;;
        SALVAGE_DIRTY)
          log "skip SALVAGE_DIRTY (has real uncommitted changes): $wt"
          _sweep_count salvageSkipped
          ;;
        KEEP)
          _sweep_count keep
          ;;
      esac
    done < <(enumerate_worktree_dirs "$root")
  done < <(discover_worktree_roots)

  [[ "$deferred" -gt 0 ]] && log "cap reached (${SWEEP_MAX_REMOVALS}), ${deferred} deferred"
  # SWEEP_LINEAR_TEAMS deprecated — Linear Done query removed (CTL-1030)
}

# ─── vector 5: leaked agent-browser browser/daemon reaper (CTL-1500) ─────────
#
# agent-browser runs a PERSISTENT per-session daemon that owns a real "Chrome for
# Testing" (or chrome-headless-shell) browser. It has NO idle timeout in current
# builds, so when the Claude worker that ran `agent-browser open` exits/crashes the
# daemon + browser + its renderer children survive until reboot — and a leaked
# browser left on the auto-refreshing orch-monitor SPA re-renders every 20-40s,
# pegging ~1 core. This reaper kills those leaks.
#
# SAFETY (non-negotiable): every kill target is command-validated to be an
# agent-browser process. Browsers are the automation-only "Google Chrome for
# Testing" (bundle com.google.chrome.for.testing) / "chrome-headless-shell" binary,
# owned by agent-browser/Playwright (path under `~/.agent-browser/`, `ms-playwright/`,
# a `--user-data-dir=…/agent-browser-chrome-*` or `…/playwright_chromiumdev_profile-*`).
# ANY command under `/Applications/` is HARD-EXCLUDED, so the user's personal
# `/Applications/Google Chrome.app` (which is "Google Chrome", NEVER "for Testing")
# can never be a target. Verified version-agnostic across agent-browser 0.9.x
# (Playwright ms-playwright cache) and 0.3x (compiled daemon + ~/.agent-browser
# browsers) on macOS.

# _ab_socket_dir: mirror the daemon's app-dir resolution order.
_ab_socket_dir() {
  if [[ -n "${SWEEP_AB_SOCKET_DIR:-}" ]]; then printf '%s' "$SWEEP_AB_SOCKET_DIR"; return 0; fi
  if [[ -n "${AGENT_BROWSER_SOCKET_DIR:-}" ]]; then printf '%s' "$AGENT_BROWSER_SOCKET_DIR"; return 0; fi
  if [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then printf '%s' "${XDG_RUNTIME_DIR}/agent-browser"; return 0; fi
  printf '%s' "${HOME}/.agent-browser"
}

# _is_agent_browser_cmd <cmd>: true iff cmd is agent-browser's automation browser —
# a "Chrome for Testing"/chrome-headless-shell process owned by agent-browser or
# Playwright. Version-agnostic; HARD-EXCLUDES anything under /Applications, so the
# personal desktop Chrome ("Google Chrome", never "for Testing") can never match.
_is_agent_browser_cmd() {
  local cmd="$1"
  case "$cmd" in */Applications/*) return 1 ;; esac
  case "$cmd" in
    *"Chrome for Testing"*|*"chrome-headless-shell"*) ;;
    *) return 1 ;;
  esac
  case "$cmd" in
    *"/.agent-browser/"*|*"/ms-playwright/"*|*"agent-browser-chrome-"*|*"playwright_chromiumdev_profile"*) return 0 ;;
    *) return 1 ;;
  esac
}

# _is_agent_browser_root_cmd <cmd>: true iff cmd is the TOP-LEVEL browser process
# (not a `--type=` helper, not the crashpad handler) — killing it cascades the
# whole browser subtree.
_is_agent_browser_root_cmd() {
  local cmd="$1"
  _is_agent_browser_cmd "$cmd" || return 1
  case "$cmd" in *"--type="*|*crashpad*) return 1 ;; esac
  return 0
}

# _is_agent_browser_owned_cmd <cmd>: true iff cmd carries an agent-browser-SPECIFIC
# ownership anchor (~/.agent-browser/ or the agent-browser-chrome- user-data-dir),
# proving it is agent-browser's OWN browser rather than one merely sharing the
# generic Playwright cache/profile. The shared /ms-playwright/ and
# playwright_chromiumdev_profile markers are NOT agent-browser-specific — an
# unrelated Playwright job uses them too — so a browser matched only by those is
# reaped only when a live agent-browser daemon owns it (see the safety gate in
# sweep_agent_browser). CTL-1500 review P1.
_is_agent_browser_owned_cmd() {
  local cmd="$1"
  case "$cmd" in
    *"/.agent-browser/"*|*"agent-browser-chrome-"*) return 0 ;;
  esac
  return 1
}

# _is_agent_browser_daemon_cmd <cmd>: true iff cmd is an agent-browser daemon binary.
# Covers BOTH the 0.3x compiled `…/node_modules/agent-browser/bin/agent-browser-<platform>`
# AND the 0.9.x node daemon `node …/node_modules/agent-browser/dist/daemon.js` — the
# 0.9.x daemon lives under dist/, not bin/, so a bin/-only match would reject the live
# owning daemon of a 0.9.x leak, reap the browser alone, and leave the daemon +
# .pid/.sock behind (CTL-1500 review P2).
_is_agent_browser_daemon_cmd() {
  local cmd="$1"
  case "$cmd" in */Applications/*) return 1 ;; esac
  case "$cmd" in
    *"/node_modules/agent-browser/bin/"*|*"/node_modules/agent-browser/dist/"*) return 0 ;;
  esac
  return 1
}

# _etime_to_secs "<ps-etime>": parse macOS ps etime ([DD-]HH:MM:SS or MM:SS) → seconds.
# (macOS ps has no `etimes` keyword, so we parse the human `etime`.)
_etime_to_secs() {
  local e="${1// /}" days=0 a b c
  [[ -n "$e" ]] || { printf '0'; return 0; }
  if [[ "$e" == *-* ]]; then days="${e%%-*}"; e="${e#*-}"; fi
  local IFS=:
  read -r a b c <<<"$e"
  if [[ -n "$c" ]]; then
    printf '%s' $(( 10#${days:-0}*86400 + 10#${a:-0}*3600 + 10#${b:-0}*60 + 10#${c:-0} ))
  else
    printf '%s' $(( 10#${days:-0}*86400 + 10#${a:-0}*60 + 10#${b:-0} ))
  fi
}

_ab_children() { pgrep -P "$1" 2>/dev/null || true; }
_ab_ppid()     { ps -o ppid= -p "$1" 2>/dev/null | tr -d ' '; }

# Candidate browser-root pids: the union of the two automation-browser signatures.
# pgrep excludes its own pid, and `Chrome for Testing`/`chrome-headless-shell` never
# match the personal `/Applications/Google Chrome.app` — validation narrows further.
_ab_browser_roots() {
  { pgrep -f 'Chrome for Testing' 2>/dev/null; pgrep -f 'chrome-headless-shell' 2>/dev/null; } \
    | sort -un
}

_ab_max_cpu() {
  local pid maxc=0 c
  for pid in "$@"; do
    c="$(ps -o pcpu= -p "$pid" 2>/dev/null | awk 'NR==1{printf "%d", $1+0.5}')"
    [[ -n "$c" ]] || continue
    [[ "$c" -gt "$maxc" ]] && maxc="$c"
  done
  printf '%s' "$maxc"
}

# _ab_reap <daemon_pid|""> <root_browser_pid> <sockdir> <reason>
_ab_reap() {
  local dpid="$1" root="$2" sockdir="$3" reason="$4"
  if is_dry; then
    log "[dry-run] would reap agent-browser (${dpid:+daemon=$dpid }root=${root}): ${reason}"
    return 0
  fi
  # TERM the owning daemon first (its SIGTERM handler closes the browser), then TERM
  # the root browser (cascades its helper children). Both targets are command-
  # validated agent-browser processes — never the personal Chrome.
  [[ -n "$dpid" ]] && env kill "$dpid" 2>/dev/null || true
  [[ -n "$root" ]] && env kill "$root" 2>/dev/null || true
  log "reaped agent-browser (${dpid:+daemon=$dpid }root=${root}): ${reason}"
  emit_reclaim agent_browser "${dpid:+daemon=$dpid,}root=${root}"
  # Drop the sock/pid whose .pid content == this daemon pid.
  [[ -n "$dpid" && -d "$sockdir" ]] || return 0
  local pidf base cpid
  for pidf in "$sockdir"/*.pid; do
    [[ -e "$pidf" ]] || continue
    cpid="$(tr -dc '0-9' < "$pidf" 2>/dev/null)"
    [[ "$cpid" == "$dpid" ]] && { base="${pidf%.pid}"; rm -f "${base}.pid" "${base}.sock"; }
  done
}

sweep_agent_browser() {
  [[ "${SWEEP_AB_ENABLED:-1}" == "1" ]] || return 0
  command -v pgrep >/dev/null 2>&1 || return 0
  command -v ps    >/dev/null 2>&1 || return 0

  local sockdir; sockdir="$(_ab_socket_dir)"

  # (1) Reap runaway / leaked agent-browser browsers — whether the owning daemon is
  #     still alive (the common leak: daemon outlives the CLI) or already dead (an
  #     orphaned browser reparented to init). Browser-centric so it is agnostic to
  #     the daemon-binary shape across agent-browser versions.
  local root rcmd subtree helper root_age max_cpu reason ppid pcmd daemon_owner
  while IFS= read -r root; do
    [[ "$root" =~ ^[0-9]+$ ]] || continue
    rcmd="$(ps -o command= -p "$root" 2>/dev/null)"
    _is_agent_browser_root_cmd "$rcmd" || continue

    subtree="$root"
    while IFS= read -r helper; do
      [[ "$helper" =~ ^[0-9]+$ ]] && subtree="$subtree $helper"
    done < <(_ab_children "$root")

    root_age="$(_etime_to_secs "$(ps -o etime= -p "$root" 2>/dev/null)")"
    # shellcheck disable=SC2086
    max_cpu="$(_ab_max_cpu $subtree)"

    reason=""
    if [[ "$root_age" -ge "$SWEEP_AB_TTL_SECS" ]]; then
      reason="ttl age=${root_age}s>=${SWEEP_AB_TTL_SECS}s cpu=${max_cpu}%"
    elif [[ "$root_age" -ge "$SWEEP_AB_MIN_AGE_SECS" && "$max_cpu" -ge "$SWEEP_AB_CPU_THRESHOLD" ]]; then
      reason="runaway cpu=${max_cpu}%>=${SWEEP_AB_CPU_THRESHOLD}% age=${root_age}s"
    fi
    if [[ -z "$reason" ]]; then
      log "keep agent-browser (root=${root} age=${root_age}s cpu=${max_cpu}%)"
      continue
    fi

    # Resolve the owning daemon: the parent, when it validates as an agent-browser
    # daemon binary (the common leak = the daemon outlives the CLI).
    ppid="$(_ab_ppid "$root")"
    pcmd="$(ps -o command= -p "$ppid" 2>/dev/null)"
    daemon_owner=""
    if [[ "$ppid" =~ ^[0-9]+$ ]] && _is_agent_browser_daemon_cmd "$pcmd"; then
      daemon_owner="$ppid"
    fi

    # SHARED-PLAYWRIGHT SAFETY GATE (CTL-1500 review P1): a browser matched ONLY by
    # the generic Playwright markers (ms-playwright cache / playwright_chromiumdev_profile)
    # — with no agent-browser-specific anchor AND no live agent-browser daemon parent —
    # may belong to an UNRELATED Playwright job, so it must NEVER be reaped. Reap a
    # shared-marker browser only when a live agent-browser daemon owns it; a browser
    # with an agent-browser-specific anchor is reaped regardless (incl. orphaned).
    if [[ -z "$daemon_owner" ]] && ! _is_agent_browser_owned_cmd "$rcmd"; then
      log "keep agent-browser (root=${root}): shared-playwright browser, no agent-browser owner (age=${root_age}s cpu=${max_cpu}%)"
      continue
    fi

    # Reap the owning daemon (and drop its sock/pid) when present; an orphaned but
    # agent-browser-owned browser (parent = init or gone) is reaped on its own.
    if [[ -n "$daemon_owner" ]]; then
      _ab_reap "$daemon_owner" "$root" "$sockdir" "$reason"
    else
      _ab_reap "" "$root" "$sockdir" "${reason} (orphaned, no live daemon)"
    fi
  done < <(_ab_browser_roots)

  # (2) Housekeeping: drop stale sock/pid whose recorded daemon pid is dead.
  #     Pure file cleanup — kill -0 (shell builtin) never signals a process.
  [[ -d "$sockdir" ]] || return 0
  local pidf pid base
  for pidf in "$sockdir"/*.pid; do
    [[ -e "$pidf" ]] || continue
    pid="$(tr -dc '0-9' < "$pidf" 2>/dev/null)"
    if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
      base="${pidf%.pid}"
      if is_dry; then
        log "[dry-run] would remove stale agent-browser sock/pid: $(basename "$base")"
      else
        rm -f "${base}.pid" "${base}.sock"
        log "removed stale agent-browser sock/pid: $(basename "$base")"
      fi
    fi
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

  log "starting sweep (vectors: trunk_cache, signals, procs, worktrees, agent_browser)"

  _SWEEP_START_EPOCH="$(date -u +%s)"
  sweep_trunk_cache
  sweep_procs
  sweep_signals
  sweep_worktrees
  sweep_agent_browser
  emit_sweep_completed

  log "sweep complete"
  exit 0
}

main "$@"
