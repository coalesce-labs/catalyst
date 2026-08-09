#!/usr/bin/env bash
# orphan-sweep.sh — Periodic belt-and-suspenders sweep for orphaned resources
# on unattended hosts. Complements the execution-core real-time reaper (CTL-657).
#
# Vectors:
#   1. Stale procs whose backing directory is gone. TWO branches (a UNION — the
#      widened branch never narrows the legacy one):
#        a. legacy  — command matches `bun run|turbo|node`, cwd resolvable, cwd
#                     gone. Path-unrestricted (it reclaims debris in /tmp,
#                     ~/.codex/plugins/cache and <repo>/.claude/worktrees too).
#        b. widened — CTL-1531. ANY command, but ONLY on hard ownership evidence:
#                     cwd under $SWEEP_WT_ROOT AND that cwd no longer exists AND
#                     ppid == 1, plus a never-kill argv allowlist, a command
#                     denylist, and self/ancestor protection. Motivated by four
#                     `sh -c "while :; do :; done"` orphans that pegged ~4 cores
#                     for 16.5h from a deleted worktree while the hourly sweep
#                     walked past them ~16 times (a bare `sh` never matched the
#                     legacy pgrep pattern).
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
#   SWEEP_PROC_WIDEN            — vector-1 widened branch: off|shadow|enforce.
#                                 DEFAULT shadow — ADR-023 "dark by default": a new
#                                 destructive vector ships observing, and the flip to
#                                 enforce is operator-owned (set it in the LaunchAgent's
#                                 EnvironmentVariables), never enable-on-merge.
#   SWEEP_PROC_WIDEN_MAX_KILLS  — per-run cap on widened kills (default 5, 0 = uncapped)
#   SWEEP_PROC_WIDEN_MIN_AGE_SECS — min process age for a widened kill (default 900 / 15 min)
#   SWEEP_PROC_WIDEN_GRACE_SECS — seconds to wait for a CONFIRMED exit after each of
#                                 SIGTERM and SIGKILL before recording a widened
#                                 reclamation (default 5). All three are parsed as
#                                 BOUNDED base-10 integers; anything bash arithmetic
#                                 could not evaluate falls back to the default loudly.
#   SWEEP_PROC_CWD_TIMEOUT_SECS — deadline for the per-pid `lsof` cwd probe (default 5,
#                                 0 = unbounded). `lsof` blocks in the kernel on a hung
#                                 or stale mount, and this runs from a LaunchAgent, so
#                                 one such candidate would wedge the whole run. A timed-
#                                 out probe yields an UNKNOWN cwd (which spares), never
#                                 a truncated path.
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
#   SWEEP_PLUGIN_SOURCE_WT      — plugin-source .claude/worktrees path (default: auto from config)
#   SWEEP_WF_STALE_DAYS         — days idle before wf_* worktrees are SAFE (default 7, CTL-1473)
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

# CTL-1417: self-protection guard — a final belt (fail-closed lsof + cwd check)
# on the SAFE / SALVAGE_UNPUSHED --force removals below, covering non-`claude`
# foreign holders and bash-3.2 (where presweep's mapfile fail-closes without
# ever reaching the removal). No side effects on source.
# shellcheck source=lib/worktree-remove-guard.sh
# shellcheck disable=SC1091
[ -r "${SCRIPT_DIR}/lib/worktree-remove-guard.sh" ] && source "${SCRIPT_DIR}/lib/worktree-remove-guard.sh"

# CTL-1639: local salvage primitive — snapshot unpushed commits + dirty tree to
# ~/catalyst/salvage/ before a destructive worktree removal (additive to the
# push-based salvage_push_then_remove below; fail-open, never blocks a removal).
# shellcheck source=lib/worktree-salvage.sh
# shellcheck disable=SC1091
[ -r "${SCRIPT_DIR}/lib/worktree-salvage.sh" ] && source "${SCRIPT_DIR}/lib/worktree-salvage.sh"

# _ows_fingerprint_path <wt> — per-worktree dedup-state file under the salvage
# dir, keyed by a sanitized absolute path (stable across sweep runs).
_ows_fingerprint_path() {
  local wt="$1" dir key
  dir="$(command -v _wsv_salvage_dir >/dev/null 2>&1 && _wsv_salvage_dir || printf '%s' "${CATALYST_SALVAGE_DIR:-${CATALYST_DIR:-$HOME/catalyst}/salvage}")"
  key="$(printf '%s' "$wt" | tr '/ ' '__')"
  printf '%s/.state/%s.fp' "$dir" "$key"
}

# _ows_fingerprint <wt> — a single hash summarizing "is there anything NEW to
# salvage since last time": HEAD sha + a content hash of the working diff, the
# staged diff, and the untracked-file set (by git BLOB hash, so a content edit
# to an already-untracked file is caught too, not just add/remove) — AND, for
# each initialized submodule, the same three components taken from the
# submodule's OWN working tree. Without the submodule component, a retained
# SALVAGE_DIRTY worktree whose top-level state is stable but whose submodule
# content keeps changing would fingerprint identically forever (the top-level
# diff only ever sees the stable opaque "Subproject commit <sha>-dirty"
# marker) — salvage_worktree_dedup would then skip every later archive and the
# newest submodule edits would never reach a recovery artifact. Mirrors the
# same submodule-path-parsing care as the primitive's own loop (a path can
# contain spaces; a plain `awk '{print $2}'` would truncate it).
# _ows_diff — _wsv_diff when the salvage library is loaded, else the plain git diff.
#
# CTL-1639 (Codex #3026 P1): the library is sourced CONDITIONALLY above
# (`[ -r ... ] && source ...`), so _wsv_diff can legitimately be undefined. Calling it
# unguarded would emit "command not found" and hash EMPTY output for every worktree —
# making all fingerprints identical, so the dedup would match everything and no tree
# would ever be re-salvaged before removal. Degrade to the previous bare-diff behavior
# instead: weaker than _wsv_diff, but correct, and never silently uniform.
_ows_diff() {
  local dir="$1"; shift
  if command -v _wsv_diff >/dev/null 2>&1; then
    _wsv_diff "$dir" "$@"
  else
    git -C "$dir" diff "$@"
  fi
}

_ows_fingerprint() {
  local wt="$1"
  {
    git -C "$wt" rev-parse HEAD 2>/dev/null || echo "no-head"
    # CTL-1639 (Codex #3026 P1): route through _wsv_diff, which the salvage library
    # defines precisely to neutralize `diff.external`/GIT_EXTERNAL_DIFF, forced color,
    # and .gitattributes textconv drivers. A bare `git diff` here can hash CONVERTED
    # output, so a real content change whose textconv output is identical hashes the
    # same and the dedup skips a worktree whose contents actually changed — the tree
    # is then never re-salvaged before removal.
    _ows_diff "$wt" HEAD 2>/dev/null | git -C "$wt" hash-object --stdin 2>/dev/null
    _ows_diff "$wt" --cached HEAD 2>/dev/null | git -C "$wt" hash-object --stdin 2>/dev/null
    git -C "$wt" ls-files --others --exclude-standard -z 2>/dev/null \
      | xargs -0 -I{} git -C "$wt" hash-object {} 2>/dev/null | sort
    local sm_line sm_status sm_rest sm_path sm_dir
    git -C "$wt" submodule status --recursive 2>/dev/null | while IFS= read -r sm_line; do
      [[ -z "$sm_line" ]] && continue
      sm_status="${sm_line:0:1}"
      [[ "$sm_status" == "-" ]] && continue
      sm_rest="${sm_line:1}"
      sm_path="$(printf '%s' "$sm_rest" | sed -E 's/^[0-9a-f]+ //; s/ \([^)]*\)$//')"
      [[ -z "$sm_path" || ! -d "${wt}/${sm_path}" ]] && continue
      sm_dir="${wt}/${sm_path}"
      git -C "$sm_dir" rev-parse HEAD 2>/dev/null
      _ows_diff "$sm_dir" HEAD 2>/dev/null | git -C "$sm_dir" hash-object --stdin 2>/dev/null
      _ows_diff "$sm_dir" --cached HEAD 2>/dev/null | git -C "$sm_dir" hash-object --stdin 2>/dev/null
      git -C "$sm_dir" ls-files --others --exclude-standard -z 2>/dev/null \
        | xargs -0 -I{} git -C "$sm_dir" hash-object {} 2>/dev/null | sort
    done
  } | git -C "$wt" hash-object --stdin 2>/dev/null
}

# salvage_worktree_dedup <wt> <ticket> [salvage_worktree args...] — CTL-1639
# Codex round-2 P1: the sweep runs every 1–3h and the salvage dir has no
# retention/dedup, so a worktree that stays in SALVAGE_UNPUSHED/SALVAGE_DIRTY
# across many sweeps (the default SWEEP_SALVAGE_PUSH=0 keeps it, and
# SALVAGE_DIRTY is always kept) would otherwise re-archive an IDENTICAL
# bundle/patch/tar under a new unique name every single sweep, growing the
# salvage dir without bound. Skip the real call (no new artifacts, no
# telemetry) when the fingerprint is unchanged since the worktree's last
# recorded salvage. Scoped to the sweep's OWN call sites, not inside
# salvage_worktree itself — the primitive's other callers (dispatcher L3
# recreate, the JS reaper, phase-teardown) each act on a worktree exactly
# once, and salvage_worktree's own multi-call contract (two rapid calls on the
# same worktree keep two distinct artifacts) stays intact for them.
salvage_worktree_dedup() {
  local wt="$1" ticket="$2"; shift 2 2>/dev/null || true
  if ! command -v salvage_worktree >/dev/null 2>&1; then return 0; fi
  local fp_path fp_now fp_prev dir
  fp_path="$(_ows_fingerprint_path "$wt")"
  fp_now="$(_ows_fingerprint "$wt")"
  fp_prev=""
  [[ -r "$fp_path" ]] && fp_prev="$(cat "$fp_path" 2>/dev/null || true)"
  if [[ -n "$fp_now" && "$fp_now" == "$fp_prev" ]]; then
    log "salvage unchanged since last sweep, skipping re-archive: $wt"
    return 0
  fi
  _WSV_LAST_STATUS=""
  salvage_worktree "$wt" "$ticket" "$@"
  # Only remember this fingerprint as "already saved" when the attempt ITSELF
  # actually succeeded (created or clean-skipped) — checking merely that the
  # salvage dir was `-w` at this point is not enough: `salvage_worktree`
  # deliberately always `return 0`s (its fail-open contract), so a real
  # mid-write failure (ENOSPC hit mid-bundle, a corrupt object, a partial
  # tar) can still leave the directory itself writable while the actual
  # artifact is missing or incomplete. `_WSV_LAST_STATUS` (set by
  # `salvage_worktree` right before its matching emit) carries the true
  # per-invocation outcome; only "created"/"skipped" earn the dedup-skip on
  # the next sweep — "failed" must keep being retried (and keep reporting
  # worktree.salvage.failed) until the underlying problem is fixed.
  if [[ -n "$fp_now" && "$_WSV_LAST_STATUS" != "failed" ]]; then
    dir="$(command -v _wsv_salvage_dir >/dev/null 2>&1 && _wsv_salvage_dir || printf '%s' "${CATALYST_SALVAGE_DIR:-${CATALYST_DIR:-$HOME/catalyst}/salvage}")"
    if [[ -w "$dir" ]]; then
      mkdir -p "$(dirname "$fp_path")" 2>/dev/null && printf '%s' "$fp_now" >"$fp_path" 2>/dev/null || true
    fi
  fi
}

# _removal_guard_ok <path> — the SINGLE fail-closed predicate every `git worktree
# remove --force` site gates on (CTL-1417). Returns 0 (safe to force-remove) ONLY
# when the guard function loaded AND it cleared the path. If the guard lib was
# missing/unreadable at source-time, `assert_worktree_removal_safe` is undefined —
# and guard-ABSENCE is treated as a REFUSAL (fail-closed), not a bypass, so a
# stripped/broken checkout can never reopen the data-loss path. Reason on stderr.
_removal_guard_ok() {
  local _wt="${1:-}"
  if ! command -v assert_worktree_removal_safe >/dev/null 2>&1; then
    echo "worktree-remove-guard: unavailable — refusing forced removal of ${_wt}" >&2
    return 1
  fi
  assert_worktree_removal_safe "$_wt"
}

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
  # CTL-1612 round 7 post-merge hygiene: explicit if/else instead of
  # `A && B || C` — shellcheck SC2015 flags that idiom because C also runs
  # when A is true but B fails, which is not the if-then-else it visually
  # reads as. Same short-circuit semantics, unambiguous now.
  if [[ ! -f "${SWEEP_CONFIG_PATH:-}" ]] || ! command -v jq >/dev/null 2>&1; then
    printf ''
    return 0
  fi
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
  # CTL-1473: wf_* worktrees (Workflow tool artifacts inside plugin-source) are SAFE
  # after SWEEP_WF_STALE_DAYS days idle, regardless of unpushed commits.
  if [[ -z "${SWEEP_WF_STALE_DAYS:-}" ]]; then
    v="$(_cfg_str '.catalyst.sweep.wfStaleDays')"; SWEEP_WF_STALE_DAYS="${v:-7}"
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

# CTL-1473 remediate: swallow a failing inner git so the pipeline never returns
# non-zero under `set -o pipefail`. Previously, on a non-repo path git exited
# non-zero, the pipeline failed, and the call site's `|| echo 0` appended a second
# "0" on top of the stdin helper's own "0" — yielding a two-line "0\n0" that made
# `[[ "$dirty" -gt 0 ]]` raise a syntax error. `_real_dirty_count_stdin` already
# prints 0 for empty input, so the call site no longer needs `|| echo 0`.
_real_dirty_count() { { git -C "$1" status --porcelain 2>/dev/null || true; } | _real_dirty_count_stdin; }

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
  # CTL-1473: plugin-source .claude/worktrees — Workflow tool bakes wf_* here.
  # Default to ~/catalyst/plugin-source/.claude/worktrees (standard install path).
  SWEEP_PLUGIN_SOURCE_WT="${SWEEP_PLUGIN_SOURCE_WT:-${HOME}/catalyst/plugin-source/.claude/worktrees}"
  SWEEP_WF_STALE_DAYS="${SWEEP_WF_STALE_DAYS:-}"  # loaded in _load_sweep_config; pre-declare for -u safety
  SWEEP_CONFIG_PATH="${SWEEP_CONFIG_PATH:-$(_resolve_sweep_config_path)}"
  # PARITY: shadow-default
  # CTL-1531: vector-1 widened (any-command) branch. off|shadow|enforce.
  # DEFAULT shadow, per ADR-023 ("Dark by default"; "Rejected: enable-on-merge").
  # This branch is the WEAKER-gated of the two widened implementations — unlike
  # proc-reaper.mjs it has no live-agent correlation and no two-sweep persistence,
  # so it kills on FIRST observation.
  #
  # This in-script default is the FLOOR, not the production value: since CTL-1531
  # the shipped plist template carries an explicit
  # `EnvironmentVariables/SWEEP_PROC_WIDEN`, and install-orphan-sweep.sh resolves
  # it (env → .catalyst/config.json `catalyst.sweep.procWiden` → the value already
  # in the installed plist → shadow). So the operator's flip lives in the
  # TEMPLATE-backed plist and SURVIVES the unconditional plist regeneration that
  # every `catalyst-stack install-services` performs — hand-editing the installed
  # plist is no longer the mechanism, and would still be reverted by the next
  # install. See install-orphan-sweep.sh `_resolve_widen_mode`.
  SWEEP_PROC_WIDEN="${SWEEP_PROC_WIDEN:-shadow}"
  case "$SWEEP_PROC_WIDEN" in
    off|shadow|enforce) ;;
    *) log "sweep config: SWEEP_PROC_WIDEN='${SWEEP_PROC_WIDEN}' invalid (allowed off|shadow|enforce); falling back to shadow" >&2
       SWEEP_PROC_WIDEN=shadow ;;
  esac
  # CTL-1531 corroboration bounds for the widened branch (see sweep_procs_widened).
  SWEEP_PROC_WIDEN_MAX_KILLS="${SWEEP_PROC_WIDEN_MAX_KILLS:-5}"
  SWEEP_PROC_WIDEN_MIN_AGE_SECS="${SWEEP_PROC_WIDEN_MIN_AGE_SECS:-900}"
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

# CTL-1473 remediate: portable file/dir mtime (epoch seconds). GNU and BSD stat
# differ — GNU uses `stat -c %Y`, BSD/macOS uses `stat -f %m`. The previous
# BSD-first `stat -f '%m' … || stat -c '%Y' …` order was NOT a safe fallback on
# Linux: there `-f` means --file-system, so `stat -f '%m' FILE` treats `%m` as a
# (missing) file operand and prints a multi-line filesystem block for FILE to
# stdout *before* exiting non-zero. The `|| stat -c '%Y'` then also runs, so the
# mtime stream is polluted with filesystem-block numbers and `sort -nr | head -1`
# returns garbage — the wf_* classify path produced no SAFE/KEEP verdict on Linux
# (CI RED T67/T68). Detect the working flavour once at load time instead.
if stat -c '%Y' /dev/null >/dev/null 2>&1; then
  _stat_mtime() { stat -c '%Y' "$1" 2>/dev/null || echo 0; }
else
  _stat_mtime() { stat -f '%m' "$1" 2>/dev/null || echo 0; }
fi

_wt_newest_mtime() {
  find "$1" -type f \
    -not -path '*/node_modules/*' -not -path '*/.cache/*' \
    -not -path '*/.trunk/*' -not -path '*/dist/*' -not -path '*/build/*' \
    2>/dev/null \
  | while IFS= read -r f; do
      _stat_mtime "$f"
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

# CTL-1473: _wt_idle_secs_ge — has the worktree been idle for at least N seconds?
# Falls back to directory mtime when no files exist (avoids misclassifying an empty
# but freshly-created wf_* worktree as stale). Returns 1 (not idle) on any unknown.
_wt_idle_secs_ge() {
  local wt="$1" threshold_secs="$2"
  local newest now
  newest="$(_wt_newest_mtime "$wt")"
  if [[ -z "$newest" || "$newest" == "0" ]]; then
    # No files — fall back to the directory's own mtime (portable, CTL-1473).
    newest="$(_stat_mtime "$wt")"
  fi
  [[ -z "$newest" || "$newest" == "0" ]] && return 1  # unknown → conservative: not idle
  now="$(date -u +%s)"
  [[ $(( now - newest )) -ge $threshold_secs ]]
}

classify_worktree() {
  local wt="$1" trunk="${2:-origin/main}" dirty unpushed
  [[ -d "$wt" ]] || { printf 'KEEP'; return 0; }
  _wt_active_session "$wt" 2>/dev/null && { printf 'KEEP'; return 0; }
  if _is_orphan_gitfile_dir "$wt" 2>/dev/null; then
    _wt_is_idle "$wt" && { printf 'ORPHAN_GITFILE'; return 0; }
    printf 'KEEP'; return 0
  fi
  dirty="$(_real_dirty_count "$wt" 2>/dev/null)"; dirty="${dirty:-0}"
  [[ "$dirty" -gt 0 ]] && { printf 'SALVAGE_DIRTY'; return 0; }
  # CTL-1473: wf_* worktrees are Workflow tool session artifacts baked inside the
  # plugin-source checkout. They are always disposable — the Workflow tool creates a
  # fresh one per run. After SWEEP_WF_STALE_DAYS idle days, classify SAFE (skip the
  # unpushed-commits salvage path — there is nothing worth salvaging in a wf_* branch).
  # Ordering: AFTER active-session and dirty checks so a dirty wf_* still hits SALVAGE_DIRTY.
  local wt_base; wt_base="$(basename "$wt")"
  if [[ "$wt_base" == wf_* ]]; then
    local wf_stale_secs=$(( ${SWEEP_WF_STALE_DAYS:-7} * 86400 ))
    if _wt_idle_secs_ge "$wt" "$wf_stale_secs"; then
      printf 'SAFE'; return 0
    fi
    printf 'KEEP'; return 0
  fi
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

# ─── vector 1: stale proc kill (legacy + CTL-1531 widened branch) ───────────

# PARITY: probe-deadline
# _proc_cwd <pid> — the process's cwd, or "" when it cannot be determined.
#
# CTL-1531 round 2 (Codex): the probe is BOUNDED. `lsof` blocks in the kernel on
# a hung or stale mount (a dropped NFS/SMB share, a spun-down external disk) and
# had NO deadline here at all. In the SHIPPED shadow mode every old PPID-1
# process that clears argv + age reaches this call, so ONE candidate sitting on a
# bad mount wedges the LaunchAgent indefinitely and starves the signal, worktree
# and browser vectors queued behind it. The JS sibling got `timeout: 5000` on its
# execFile in round 1; this is the mirror.
#
# Deliberately NOT `timeout(1)` / `gtimeout`: stock macOS — the fleet's primary
# launchd environment — ships neither and GNU coreutils is not a dependency
# (AGENTS.md, "make the LOOP ITSELF self-limiting"). The portable idiom is a
# watchdog child, and it costs NOTHING on the fast path: `wait` returns the
# instant lsof exits and the watchdog is killed before its sleep elapses.
#
# `kill` here is the BASH BUILTIN, never `env kill`. It only ever targets THIS
# function's own children, so it stays invisible both to the candidate-signalling
# audit and to the test harness's $MOCKBIN/kill mock (which would otherwise
# record probe traffic as if it were a destructive signal).
_PROC_CWD_TIMEOUT_DEFAULT=5
_proc_cwd() {
  local pid="$1" limit tmp lpid wpid
  limit="${SWEEP_PROC_CWD_TIMEOUT_SECS:-$_PROC_CWD_TIMEOUT_DEFAULT}"
  [[ "$limit" =~ ^[0-9]{1,4}$ ]] || limit="$_PROC_CWD_TIMEOUT_DEFAULT"
  # CTL-1531 (Codex P2): force BASE 10 before any arithmetic. The regex above
  # happily accepts "08"/"09", but bash reads a leading-zero operand as OCTAL, so
  # `[[ "$limit" -gt 0 ]]` below errors on the invalid digit and evaluates FALSE —
  # no watchdog is started and the `wait` on a hung `lsof` can block forever. The
  # malformed value bypassed the deadline entirely instead of degrading to 5.
  # Affects the legacy sweep too, not only the widened class.
  limit=$((10#$limit))
  tmp="${TMPDIR:-/tmp}/orphan-sweep-cwd.$$.${pid}"
  : > "$tmp" 2>/dev/null || return 0        # cannot stage a probe → unknown
  rm -f "${tmp}.timedout"
  lsof -p "$pid" -a -d cwd -Fn > "$tmp" 2>/dev/null &
  lpid=$!
  wpid=""
  if [[ "$limit" -gt 0 ]]; then
    # The marker is written BEFORE the kill so that observing it is race-free:
    # if it exists, the probe was cut short and its output must not be trusted.
    ( sleep "$limit"; : > "${tmp}.timedout"; kill -9 "$lpid" 2>/dev/null ) >/dev/null 2>&1 &
    wpid=$!
  fi
  wait "$lpid" 2>/dev/null
  if [[ -n "$wpid" ]]; then kill -9 "$wpid" 2>/dev/null; wait "$wpid" 2>/dev/null; fi
  if [[ -e "${tmp}.timedout" ]]; then
    # A killed lsof can leave a TRUNCATED path mid-line, and a truncated path
    # under the worktree root is exactly the shape of a perfect widened kill
    # candidate (it "does not exist"). Discard the whole answer — unknown spares.
    # `log` goes to stdout and this function's stdout IS the return value, so the
    # warning must go to stderr.
    log "cwd probe for pid ${pid} exceeded ${limit}s (hung mount?) — treating cwd as UNKNOWN" >&2
    rm -f "$tmp" "${tmp}.timedout"
    return 0
  fi
  sed -n 's/^n//p' "$tmp" 2>/dev/null | head -1
  rm -f "$tmp"
  return 0
}

_candidate_pids() {
  pgrep -f 'bun run|turbo|node' 2>/dev/null || true
}

# ── CTL-1531: self / ancestor protection ────────────────────────────────────
# The legacy branch was spared only ACCIDENTALLY: `/bin/bash orphan-sweep.sh`
# never matched `bun run|turbo|node`. Under an any-command candidate set that
# accident is gone, so self-protection has to be an explicit gate. The set is
# seeded with $$, $PPID and pid 1, then walked up the real ancestor chain.
#
# _sweep_self_pids POPULATES the cache but prints NOTHING. The caller must read
# $_SWEEP_SELF_PIDS directly: reading it through a command substitution — the
# original `case "$(_sweep_self_pids)"` — runs the whole function in a SUBSHELL,
# so the memo assignment is discarded and the ancestor walk (up to 32 `ps` forks)
# re-ran on EVERY candidate. With ~1000 ppid==1 rows on a real host that is tens
# of thousands of wasted forks per sweep.
_SWEEP_SELF_PIDS=""
_sweep_self_pids() {
  [[ -n "$_SWEEP_SELF_PIDS" ]] && return 0
  local p="$$" n=0 parent
  _SWEEP_SELF_PIDS=" 1 $$ ${PPID:-1} "
  while [[ "$p" =~ ^[0-9]+$ ]] && [[ "$p" -gt 1 ]] && [[ $n -lt 32 ]]; do
    parent="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ' | head -1)"
    [[ "$parent" =~ ^[0-9]+$ ]] || break
    _SWEEP_SELF_PIDS="${_SWEEP_SELF_PIDS}${parent} "
    p="$parent"
    n=$((n+1))
  done
  return 0
}

_is_self_or_ancestor() {
  _sweep_self_pids                       # no $( ) — must mutate THIS shell
  case "$_SWEEP_SELF_PIDS" in *" $1 "*) return 0 ;; esac
  return 1
}

# ── PARITY: allowlist — CTL-1531 never-kill argv allowlist ──────────────────
# Mirrors proc-reaper.mjs DEFAULT_ALLOWLIST_PATTERNS — the fleet's own control
# plane must never be reapable, and a hand-started daemon
# (`cd ~/catalyst/wt/CTL-x && bun run … & disown`) is ppid 1 with cwd under wt.
# `orphan-sweep.sh` and `catalyst-stack` are here because both are PPID-1 BY
# CONSTRUCTION (LaunchAgent-run; `nohup … & disown`), so the ppid gate cannot
# spare them: without these entries the sweep can reap ITSELF or the supervisor
# that restarts the fleet.
_PROC_ALLOWLIST_RE='execution-core/daemon\.mjs|broker/index\.mjs|orch-monitor/server\.ts|tailscale|ipnextension|orphan-sweep\.sh|catalyst-stack'
# PARITY: denylist
# Denylist of command basenames: session multiplexers and login/init plumbing.
# A tmux/screen server is daemonized (ppid 1 BY CONSTRUCTION) and inherits its
# cwd from whatever shell first started it — one kill nukes every pane the
# operator has open. An orphaned ssh tunnel keeps working with a deleted cwd.
#
# The trailing `:?` is LOAD-BEARING. These processes advertise themselves with
# setproctitle's `progname: ` form, verified against real title strings:
#     "tmux: server (/private/tmp/tmux-501/default)"  → argv[0] = "tmux:"
#     "sshd: ryan [priv]"                             → argv[0] = "sshd:"
# so the original bare `^tmux$` anchor did NOT deny the very processes the
# denylist exists to protect — only the rare `/opt/homebrew/bin/tmux new-session`
# form matched. Mirrored in proc-reaper.mjs DEFAULT_DENY_COMMAND_RE.
_PROC_DENY_CMD_RE='^(tmux|tmux-server|screen|sshd|ssh|mosh-server|login|launchd|init|systemd|nohup):?$'

# _argv_denied <argv> — true when ANY whitespace-separated argv token basenames
# to a denied command. Scanning the FULL argv (not just argv[0]) is deliberate:
# `nohup tmux …`, `/usr/bin/env screen …` and `sh -c "ssh …"` all hide the denied
# program past position 0. Over-SPARING is the safe direction for a killer.
# Pure bash tokenization + ONE grep (the old form forked awk + basename + 2 greps
# per candidate, and there are ~1000 ppid==1 rows on a real host).
_argv_denied() {
  local argv="$1" tok out="" noglob_was_set=0
  local IFS=$' \t\n'
  case "$-" in *f*) noglob_was_set=1 ;; esac
  set -f                                   # tokens may contain * or ? — never glob
  for tok in $argv; do
    tok="${tok##*/}"                       # basename, no subprocess
    [[ -n "$tok" ]] && out="${out}${tok}"$'\n'
  done
  [[ "$noglob_was_set" == "1" ]] || set +f
  [[ -n "$out" ]] || return 1
  printf '%s' "$out" | grep -qiE "$_PROC_DENY_CMD_RE"
}

# lsof reports the PHYSICAL (symlink-resolved) path, so compare the cwd against
# both the configured root and its `pwd -P` form. Segment-anchored, never a
# substring match (~/catalyst/wt-backup must not match ~/catalyst/wt).
_wt_root_forms() {
  local root="${SWEEP_WT_ROOT%/}" phys
  [[ -n "$root" ]] || return 0
  printf '%s\n' "$root"
  if [[ -d "$root" ]]; then
    phys="$(cd "$root" 2>/dev/null && pwd -P)"
    [[ -n "$phys" && "$phys" != "$root" ]] && printf '%s\n' "$phys"
  fi
  return 0
}

_cwd_under_wt_root() {
  local cwd="$1" root
  [[ -n "$cwd" ]] || return 1
  while IFS= read -r root; do
    [[ -n "$root" ]] || continue
    [[ "$cwd" == "$root" || "$cwd" == "$root"/* ]] && return 0
  done < <(_wt_root_forms)
  return 1
}

_widened_candidate_pids() {
  ps -axo pid=,ppid= 2>/dev/null | awk '$2 == 1 { print $1 }'
}

# _proc_etime_secs <pid> — process age in seconds, or "" when unreadable.
# ps etime forms: MM:SS / HH:MM:SS / DD-HH:MM:SS. Unreadable/malformed → "" so
# the caller fails CLOSED (an unknown age can never clear the floor).
_proc_etime_secs() {
  ps -o etime= -p "$1" 2>/dev/null | head -1 | awk '
    { gsub(/^[ \t]+|[ \t]+$/, "", $0); if ($0 == "") exit 0
      d = 0; s = $0
      i = index(s, "-"); if (i > 0) { d = substr(s, 1, i-1) + 0; s = substr(s, i+1) }
      n = split(s, p, ":")
      if (n == 2)      secs = p[1]*60 + p[2]
      else if (n == 3) secs = p[1]*3600 + p[2]*60 + p[3]
      else exit 0
      print d*86400 + secs }'
}

# ── CTL-1531 P1-c: bounded base-10 integer config parsing ───────────────────
#
# `[[ "$v" =~ ^[0-9]+$ ]]` is NOT sufficient validation for a value that is later
# fed to bash arithmetic. It accepts:
#   • `08` / `09`  — bash's arithmetic context treats a leading zero as OCTAL, so
#     `[[ 08 -gt 0 ]]` is a fatal "value too great for base" error. Under
#     `set -uo pipefail` (no `-e`) that error is printed and the test evaluates
#     FALSE, which silently turns the per-run cap OFF for every candidate — a
#     destructive sweep running UNCAPPED.
#   • values past bash's signed 64-bit range — `999…9` (20+ digits) wraps to a
#     NEGATIVE integer, so `acted >= cap` is false forever: uncapped again.
# Both failure modes are silent and both fail OPEN, which is the wrong direction
# for a killer. Parse explicitly in base 10 (`10#`), bound the digit count so the
# `10#` conversion itself can never overflow, range-check, and fall back to the
# safe default LOUDLY.
#
# Returns through the global $_SWEEP_INT rather than stdout: `log` writes to
# stdout, so a `$(...)`-capturing helper would swallow its own warning into the
# parsed value.
_SWEEP_INT=0
_sweep_bounded_int() {
  local raw="$1" def="$2" min="$3" max="$4" name="$5" val
  _SWEEP_INT="$def"
  # ≤9 digits ⇒ ≤999,999,999, comfortably inside every arithmetic range.
  if [[ ! "$raw" =~ ^[0-9]{1,9}$ ]]; then
    log "sweep config: ${name}='${raw}' is not a base-10 integer in [${min},${max}] — falling back to ${def}"
    return 0
  fi
  val=$((10#$raw))                          # 10# defuses the 08/09 octal trap
  if [[ "$val" -lt "$min" || "$val" -gt "$max" ]]; then
    log "sweep config: ${name}='${raw}' out of range [${min},${max}] — falling back to ${def}"
    return 0
  fi
  _SWEEP_INT="$val"
  return 0
}

# ── PARITY: tri-state-cwd-probe (present | gone | unknown) — CTL-1531 P2-h ──
#
# `[[ -d "$cwd" ]]` is FALSE for a deleted directory AND for one that merely
# cannot be stat'd — EACCES (a mode-000 or root-owned parent), EIO (failing
# disk), ESTALE / ENOTCONN (a dropped NFS or SMB mount), EPERM (sandbox). On the
# widened branch "the cwd is gone" is the ONLY ownership evidence for killing an
# arbitrary process, so reading an unanswerable probe as "gone" is a fail-OPEN
# inversion — and the unanswerable cases are exactly the CORRELATED ones (one
# unmounted volume makes every process beneath it look orphaned at once).
#
# Reserve the kill path for a definite ENOENT: `stat` surfaces the errno in its
# message, so "No such file or directory" is separable from every other failure.
# Anything we cannot classify stays `unknown`, and unknown SPARES.
# Result lands in $_SWEEP_CWD_STATE (global, for the same stdout reason as above).
_SWEEP_CWD_STATE=unknown
_probe_cwd_state() {
  local p="$1" err rc
  _SWEEP_CWD_STATE=unknown
  [[ -n "$p" ]] || return 0
  if [[ -d "$p" ]]; then _SWEEP_CWD_STATE=present; return 0; fi
  # LC_ALL=C pins the errno TEXT we match on. Under a non-English locale the
  # message would not match and the state would fall through to `unknown` —
  # safe (it spares) but it would silently disable the whole widened branch.
  err="$(LC_ALL=C stat -- "$p" 2>&1 >/dev/null)"; rc=$?
  if [[ "$rc" -eq 0 ]]; then
    # stat succeeds but `-d` was false: the path EXISTS and is not a directory.
    # Not our debris — never kill on it.
    _SWEEP_CWD_STATE=present
    return 0
  fi
  case "$err" in
    *"No such file or directory"*) _SWEEP_CWD_STATE=gone ;;
    *) _SWEEP_CWD_STATE=unknown ;;
  esac
  return 0
}

# ── PARITY: confirmed-exit — TRI-STATE liveness probe + confirmed-exit wait ──
#
# Deliberately `ps`, never `kill -0`: the sweep signals through `env kill`, so a
# `kill -0` liveness probe would be indistinguishable from the destructive call
# in an audit (and in the test harness's mock).
#
# CTL-1531 round 2 (Codex): the old form tested only for EMPTY OUTPUT
# (`[[ -n "$(ps …)" ]]`), which made a transient process-table / resource /
# fork failure INDISTINGUISHABLE from an absent pid. `_proc_gone_within` then
# self-certified an exit, the caller logged "killed $pid" and emitted an
# `orphan_proc` reclamation — while the target might still be running. Same
# fail-open class as the earlier findings, this time inside the confirmation
# probe itself, and the JS sibling had it too (`killProc(pid,0)` collapses
# ESRCH and EPERM into one `false`; fixed there as `defaultProbeAlive`).
#
# Three outcomes, kept separate, matching real `ps` on this fleet (verified on
# macOS 26: an absent-but-in-range pid exits 1 with EMPTY stdout AND EMPTY
# stderr; a probe that could not run says so on stderr):
#   alive   — rc 0 and a pid on stdout
#   gone    — rc != 0, nothing on stdout, and NOTHING ON STDERR (a clean "no
#             such process" answer)
#   unknown — anything else: stderr non-empty (`ps` itself failed / was not
#             found / refused), or rc 0 with no output. UNKNOWN NEVER CLAIMS
#             AN EXIT.
# Result lands in the global $_SWEEP_PROC_ALIVE_STATE (same stdout-collision
# reason as _probe_cwd_state).
_SWEEP_PROC_ALIVE_STATE=unknown
_SWEEP_PROBE_ERR_FILE=""
_proc_alive_state() {
  local pid="$1" out rc
  _SWEEP_PROC_ALIVE_STATE=unknown
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  if [[ -z "$_SWEEP_PROBE_ERR_FILE" ]]; then
    _SWEEP_PROBE_ERR_FILE="${TMPDIR:-/tmp}/orphan-sweep-probe.$$"
  fi
  : > "$_SWEEP_PROBE_ERR_FILE" 2>/dev/null || return 0   # cannot stage → unknown
  out="$(LC_ALL=C ps -o pid= -p "$pid" 2>"$_SWEEP_PROBE_ERR_FILE")"
  rc=$?
  out="$(printf '%s' "$out" | tr -d ' \t\n')"
  if [[ "$rc" -eq 0 && -n "$out" ]]; then
    _SWEEP_PROC_ALIVE_STATE=alive
  elif [[ -s "$_SWEEP_PROBE_ERR_FILE" ]]; then
    _SWEEP_PROC_ALIVE_STATE=unknown          # the PROBE failed, not the process
  elif [[ "$rc" -ne 0 && -z "$out" ]]; then
    _SWEEP_PROC_ALIVE_STATE=gone             # clean "no such process"
  fi
  rm -f "$_SWEEP_PROBE_ERR_FILE"
  return 0
}

# _proc_alive <pid> — back-compat boolean wrapper. 0 = NOT confirmed gone (alive
# OR unprobeable), 1 = confirmed gone. Never used to claim an exit on its own.
# shellcheck disable=SC2329 # not called anywhere in this file today — kept
# as the documented back-compat boolean-wrapper API surface per its own
# comment above, for a caller that sources this file and wants the simple
# true/false shape instead of _proc_alive_state's three-way result.
_proc_alive() {
  _proc_alive_state "$1"
  [[ "$_SWEEP_PROC_ALIVE_STATE" != "gone" ]]
}

# _proc_gone_within <pid> <grace_secs> — 0 ONLY when the pid is CONFIRMED gone.
# Probes immediately, then once per second up to <grace_secs>. An `unknown`
# probe is NOT an exit: it keeps polling and, at the deadline, returns 1 so the
# caller falls through to the escalation / "no reclamation recorded" path.
_proc_gone_within() {
  local pid="$1" grace="$2" i=0
  while :; do
    _proc_alive_state "$pid"
    [[ "$_SWEEP_PROC_ALIVE_STATE" == "gone" ]] && return 0
    [[ "$i" -ge "$grace" ]] && return 1
    sleep 1
    i=$((i+1))
  done
}

# ── PARITY: pre-signal-revalidation ─────────────────────────────────────────
#
# _widen_still_owned <pid> <argv> — re-prove the ENTIRE widened ownership
# conjunction from reads taken NOW. 0 = still ours, 1 = not (or cannot tell).
# The freshly-observed cwd is returned through $_SWEEP_WIDEN_CWD_NOW.
#
# Called TWICE per candidate, and that is the point (CTL-1531 round 2, Codex):
#   • before SIGTERM — a worktree can be recreated and a pid recycled between
#     the classification gate and the signal;
#   • before SIGKILL — the grace wait is a SECOND stale-evidence window. If the
#     original process exits under SIGTERM and its pid is REUSED during the
#     grace, `_proc_gone_within` sees only that the numeric pid is alive, and an
#     unconditional SIGKILL then lands on the REPLACEMENT process. The first
#     signal has an identity re-match; the second one needs the same.
# Every ambiguous probe FAILS CLOSED (returns 1 → no signal).
_SWEEP_WIDEN_CWD_NOW=""
_widen_still_owned() {
  local pid="$1" argv="$2" min_age_now="${3:-0}"
  _SWEEP_WIDEN_CWD_NOW=""
  # identity: still reparented to launchd, still the SAME full argv (pid-reuse)
  [[ "$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' | head -1)" == "1" ]] || return 1
  [[ "$(ps -o command= -p "$pid" 2>/dev/null | head -1)" == "$argv" ]] || return 1
  # P2-g: RE-PROBE the cwd. Re-reading ppid and argv while testing a CACHED cwd
  # defeats the point — the pid that matters here is a *recycled* one, and a
  # recycled pid has its own cwd this loop has never looked at. (A worktree
  # recreated under the same path by a concurrent `create-worktree.sh` is the
  # other half.) Ask lsof again and re-apply BOTH gates to whatever it answers.
  local cwd_now
  cwd_now="$(_proc_cwd "$pid")"
  [[ -n "$cwd_now" ]] || return 1
  _cwd_under_wt_root "$cwd_now" || return 1
  _probe_cwd_state "$cwd_now"
  [[ "$_SWEEP_CWD_STATE" == "gone" ]] || return 1
  # NOT PINNED BY A TEST (CTL-1531 round 3). Both re-checks below are correct and
  # fail CLOSED — they can only ever SPARE a candidate, never signal one that the
  # pre-existing gates would have refused — so shipping them unpinned does not add
  # kill risk. But they are NOT covered: an isolated fixture for each needs the ps
  # mock to change a value BETWEEN the classification read and the guard read, and
  # the WETIME2_ mechanism added for that fired at gate (h) instead, making the
  # test vacuous (it passed with the re-read deleted). The vacuous test was removed
  # rather than left standing. Follow-up: fix the mock's per-call counter, then pin
  # both with a control that IS killed in the same run.
  #
  # 6v_g: RE-CHECK THE ROOT ITSELF, not just this candidate's cwd. The one-time
  # presence check happens before the loop; if $SWEEP_WT_ROOT is deleted or
  # unmounted *during* the loop, every surviving cwd beneath it still matches the
  # configured logical prefix and then answers "gone" — so a single correlated
  # ROOT failure reads as N independent deleted worktrees and signals up to the
  # ceiling. Re-asserting the root here makes the root-absent bail hold for the
  # whole run, not just its first instant.
  _probe_cwd_state "$SWEEP_WT_ROOT"
  [[ "$_SWEEP_CWD_STATE" == "present" ]] || return 1
  # 6v_i: RE-READ THE AGE. Every other identity check here is fresh, but the age
  # came from the classification pass. A pid recycled inside the grace window can
  # present the same argv, ppid 1 and an inherited deleted cwd while being seconds
  # old — passing every fresh check on a CACHED age and defeating the documented
  # floor. The floor is only meaningful against the process being signalled NOW.
  local age_now
  age_now="$(_proc_etime_secs "$pid")"
  [[ "$age_now" =~ ^[0-9]+$ ]] || return 1
  [[ "$age_now" -ge "$min_age_now" ]] || return 1
  _SWEEP_WIDEN_CWD_NOW="$cwd_now"
  return 0
}

# PARITY: argv-redaction
# _argv_basename <argv> — argv[0]'s basename, into $_SWEEP_ARGV_BASE.
# CTL-1531 P1-e: this is the MOST that may appear in a log line. See the log
# calls in sweep_procs_widened for why the full argv must never be written.
_SWEEP_ARGV_BASE=""
_argv_basename() {
  local first="${1%% *}"
  _SWEEP_ARGV_BASE="${first##*/}"
  [[ -n "$_SWEEP_ARGV_BASE" ]] || _SWEEP_ARGV_BASE="?"
  return 0
}

# sweep_procs_widened — the CTL-1531 branch. Gates, in order, ALL of which must
# hold; every ambiguous probe FAILS CLOSED (skip, never kill).
#
# CORROBORATION + BOUNDS (CTL-1531 review). Unlike proc-reaper.mjs this branch has
# no live-agent correlation and no two-sweep persistence — it kills on FIRST
# observation — so "cwd is gone" is doing almost all the work. That predicate is
# CORRELATED across the whole host: rename or unmount $SWEEP_WT_ROOT and EVERY
# process beneath it satisfies it in the same pass. Three cheap bounds:
#   • root-absent early bail — if the root itself is missing, the signal is about
#     the ROOT, not about any individual process. Never mass-signal on it.
#   • per-run cap (SWEEP_PROC_WIDEN_MAX_KILLS, default 5) — mirrors the sibling
#     destructive vector's SWEEP_MAX_REMOVALS. A real orphan leak is a handful of
#     procs; anything larger is a root-level event and wants a human.
#   • age floor (SWEEP_PROC_WIDEN_MIN_AGE_SECS, default 900) — matches
#     proc-reaper.mjs minEtimeSec, and keeps a just-spawned process (whose
#     worktree is mid-teardown) out of the candidate set.
sweep_procs_widened() {
  local mode="${SWEEP_PROC_WIDEN:-shadow}"
  [[ "$mode" == "off" ]] && return 0

  # PARITY: root-absent-bail
  # BOUND 1 — root-absent early bail. `[[ -d $cwd ]]` would be false for every
  # process under a renamed/unmounted root at once; that is a root-level fault,
  # not N independent orphans.
  local root="${SWEEP_WT_ROOT%/}"
  if [[ -z "$root" || ! -d "$root" ]]; then
    log "widened proc sweep: worktree root '${root}' is absent — skipping (a missing root makes EVERY cwd under it look gone)"
    return 0
  fi

  # P1-c: explicit bounded base-10 parsing. A value bash's arithmetic cannot
  # evaluate (`08`, `09`, a 20-digit number) previously made every later `[[ …
  # -gt … ]]` error out and evaluate FALSE, silently uncapping the sweep.
  local cap min_age grace
  _sweep_bounded_int "${SWEEP_PROC_WIDEN_MAX_KILLS:-5}" 5 0 100000 SWEEP_PROC_WIDEN_MAX_KILLS
  cap="$_SWEEP_INT"
  _sweep_bounded_int "${SWEEP_PROC_WIDEN_MIN_AGE_SECS:-900}" 900 0 999999999 SWEEP_PROC_WIDEN_MIN_AGE_SECS
  min_age="$_SWEEP_INT"
  _sweep_bounded_int "${SWEEP_PROC_WIDEN_GRACE_SECS:-5}" 5 0 300 SWEEP_PROC_WIDEN_GRACE_SECS
  grace="$_SWEEP_INT"
  # Two counters, two ceilings (P2-i made them distinguishable):
  #   acted     — CONFIRMED terminations. Bounded by `cap`. Counting confirmed
  #               exits rather than delivered signals is what stops a process
  #               that traps/ignores SIGTERM from consuming a cap slot — and
  #               therefore crowding a REAL orphan out of the run — every single
  #               sweep, forever.
  #   signalled — SIGNALS DELIVERED. Incremented on the SIGTERM *and* on the
  #               SIGKILL, because that is what the `cap * 2` ceiling claims to
  #               bound: a candidate is worth at most two signals (SIGTERM, then
  #               SIGKILL), so `cap` candidates are worth at most `cap * 2`
  #               signals. Counting once PER CANDIDATE (the CTL-1531 round-1
  #               form) silently let a cap of N authorize 2N candidates and 4N
  #               delivered signals. This is the blast-radius bound that the
  #               confirmation-based cap cannot provide on its own: a host where
  #               nothing responds to signals must not turn "cap 5" into
  #               unbounded signalling.
  local acted=0 deferred=0 signalled=0
  local pid ppid cwd cwd_now argv age
  while IFS= read -r pid; do
    # (a) a well-formed pid that is not init
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [[ "$pid" -gt 1 ]] || continue
    # (b) SELF-PROTECTION: never the sweep, its shell, or any ancestor
    _is_self_or_ancestor "$pid" && continue
    # (c) already considered by the legacy branch this run → no double-signal
    case " ${_SWEEP_PROC_SEEN} " in *" ${pid} "*) continue ;; esac
    # (d) PPID must be EXACTLY 1, re-read here rather than trusted from the
    #     enumeration (a stale snapshot must never widen the candidate set)
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' | head -1)"
    [[ "$ppid" == "1" ]] || continue
    # (e) argv must be readable; unreadable → skip (cannot check the allowlist)
    argv="$(ps -o command= -p "$pid" 2>/dev/null | head -1)"
    [[ -n "$argv" ]] || continue
    # (f) hard never-kill argv allowlist
    printf '%s' "$argv" | grep -qiE "$_PROC_ALLOWLIST_RE" && continue
    # (g) hard command denylist (session multiplexers / login / init plumbing),
    #     matched over the FULL argv with the `progname:` form anchored
    _argv_denied "$argv" && continue
    # PARITY: age-floor
    # (h) BOUND 3 — age floor; unreadable age fails CLOSED. Mirrors
    #     proc-reaper.mjs minEtimeSec: a just-spawned process whose worktree is
    #     mid-teardown must not be reaped out from under the teardown.
    age="$(_proc_etime_secs "$pid")"
    [[ "$age" =~ ^[0-9]+$ ]] || continue
    [[ "$age" -ge "$min_age" ]] || continue
    # (i) cwd must be resolvable; unknown → skip (conservative, as legacy)
    cwd="$(_proc_cwd "$pid")"
    [[ -n "$cwd" ]] || continue
    # (j) cwd MUST be inside catalyst-managed worktree space. Nothing outside
    #     $SWEEP_WT_ROOT is ever a widened candidate, whatever its ppid/command.
    _cwd_under_wt_root "$cwd" || continue
    # (k) P2-h — that cwd must be DEFINITELY gone. `[[ -d ]]` alone cannot tell a
    #     deleted worktree from one we simply cannot stat (EACCES/EIO/ESTALE);
    #     only a definite ENOENT reaches the kill path, everything else spares.
    _probe_cwd_state "$cwd"
    [[ "$_SWEEP_CWD_STATE" == "gone" ]] || continue

    # P1-e: log the pid, the command BASENAME and the reason — NEVER the full
    # argv. The widened branch admits ARBITRARY commands, and an arbitrary argv
    # routinely carries an API token, a password, an `Authorization:` header or a
    # pre-signed URL (`curl -H "Authorization: Bearer …"`, `psql "postgres://…"`,
    # `foo --api-key=…`). These lines go to the PERSISTENT ~/catalyst/orphan-
    # sweep.log, so merely OBSERVING this class in the DEFAULT shadow mode would
    # write secrets to disk — no enforce flip required. The full argv stays in
    # the `$argv` shell variable only, where it is load-bearing: the pre-kill
    # TOCTOU re-match below is a pid-reuse guard and needs an exact comparison.
    _argv_basename "$argv"
    if is_dry; then
      log "[dry-run] would kill $pid (cmd: ${_SWEEP_ARGV_BASE}; orphan; cwd gone under wt root: $cwd)"
      continue
    fi
    if [[ "$mode" == "shadow" ]]; then
      log "[shadow] would kill $pid (cmd: ${_SWEEP_ARGV_BASE}; orphan; cwd gone under wt root: $cwd)"
      continue
    fi
    # PARITY: per-run-cap
    # BOUND 2 — per-run cap on CONFIRMED terminations. Counted only on the
    # enforcing path so shadow keeps reporting the FULL candidate set (that is
    # the signal the operator needs to size the cap before flipping to enforce).
    if [[ "$cap" -gt 0 && "$acted" -ge "$cap" ]]; then
      deferred=$((deferred+1))
      continue
    fi
    # BOUND 2b — blast-radius bound on DELIVERED SIGNALS. Reached only when
    # signals are being delivered without producing exits, i.e. a host in a state
    # no sweep can fix. Stop rather than pile on more.
    #
    # CTL-1531 round 3: admit only if this candidate's WORST CASE still fits under
    # the ceiling. A candidate is worth up to TWO signals (SIGTERM, then SIGKILL)
    # and this test runs at ADMISSION — so `signalled -ge cap*2` admits one at
    # `cap*2 - 1`, which then spends two more and delivers `cap*2 + 1`. ODD parity
    # provokes it: cap=2 (ceiling 4), one candidate exiting under SIGTERM (1
    # signal) then stubborn ones ⇒ 1+2+2 = 5.
    if [[ "$cap" -gt 0 && $((signalled + 2)) -gt $((cap * 2)) ]]; then
      log "widened proc sweep: signal bound reached ($((cap * 2))) with only ${acted} confirmed termination(s) — stopping this run (a human should look at this host)"
      break
    fi
    # TOCTOU re-check immediately before signalling: a worktree can be recreated,
    # and a pid can be recycled, between the gate and the kill.
    # The spare is LOGGED (CTL-1531 round 3). It used to be a bare `continue`, so
    # a candidate dropped here was indistinguishable in the log from one that
    # never qualified — which also made the gate unobservable to the behavioural
    # parity check. The JS sibling already warns at the same point.
    if ! _widen_still_owned "$pid" "$argv" "$min_age"; then
      log "widened proc sweep: $pid no longer matches the candidate at signal time (pid reuse, re-created worktree, or an unreadable probe) — sparing"
      continue
    fi
    cwd_now="$_SWEEP_WIDEN_CWD_NOW"

    # P2-i: `kill` reports that the signal was DELIVERED, not that the target
    # EXITED. A process that traps or ignores SIGTERM used to be logged as
    # "killed", consume a cap slot and emit a false `orphan_proc` reclamation on
    # every single run, forever. Confirm the exit before recording anything:
    # SIGTERM → wait → re-probe → escalate to SIGKILL → wait → re-probe.
    if ! env kill "$pid" 2>/dev/null; then
      log "widened proc sweep: SIGTERM to $pid failed (already gone, or not ours) — nothing recorded"
      continue
    fi
    signalled=$((signalled+1))
    if ! _proc_gone_within "$pid" "$grace"; then
      # PARITY: pre-signal-revalidation — the SIGKILL is a SECOND signal and gets
      # the SAME identity re-match the SIGTERM had. The confirmation wait above
      # only proves "the numeric pid is not confirmed gone"; if the original
      # process exited and its pid was REUSED during the grace, an unconditional
      # `kill -9` lands on the replacement. (It also covers the case where the
      # probe could not answer at all — unknown fails closed here.)
      if ! _widen_still_owned "$pid" "$argv" "$min_age"; then
        log "widened proc sweep: $pid no longer matches the candidate after the ${grace}s grace (pid reuse, re-created worktree, or an unreadable probe) — NOT escalating to SIGKILL"
        continue
      fi
      cwd_now="$_SWEEP_WIDEN_CWD_NOW"
      log "widened proc sweep: $pid survived SIGTERM after ${grace}s — escalating to SIGKILL"
      env kill -9 "$pid" 2>/dev/null || true
      # BOUND 2b accounting: SIGKILL is a DELIVERED SIGNAL and counts. Counting
      # only once per candidate let a cap of N authorize 2N candidates and 4N
      # signals — the ceiling has to bound what it claims to bound.
      signalled=$((signalled+1))
      if ! _proc_gone_within "$pid" "$grace"; then
        log "widened proc sweep: $pid STILL alive after SIGKILL — no reclamation recorded (cmd: ${_SWEEP_ARGV_BASE}; cwd: $cwd_now)"
        continue
      fi
    fi
    acted=$((acted+1))
    log "killed $pid (cmd: ${_SWEEP_ARGV_BASE}; orphan; cwd gone under wt root: $cwd_now)"
    emit_reclaim orphan_proc "$pid"
  done < <(_widened_candidate_pids)
  [[ "$deferred" -gt 0 ]] && log "widened proc sweep: cap reached (${cap}), ${deferred} deferred to the next run"
  return 0
}

# pids already considered by the legacy branch this run (dedupe across branches).
_SWEEP_PROC_SEEN=""

sweep_procs() {
  local pid cwd
  _SWEEP_PROC_SEEN=""
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    # CTL-1531: never signal the sweep itself, its shell, or any ancestor.
    _is_self_or_ancestor "$pid" && continue
    _SWEEP_PROC_SEEN="${_SWEEP_PROC_SEEN} ${pid}"
    cwd="$(_proc_cwd "$pid")"
    [[ -n "$cwd" ]] || continue    # unknown cwd → conservative skip
    [[ -d "$cwd" ]] && continue    # cwd exists → live, skip
    if is_dry; then
      log "[dry-run] would kill $pid (cwd gone: $cwd)"
      continue
    fi
    env kill "$pid" 2>/dev/null && { log "killed $pid (cwd gone: $cwd)"; emit_reclaim bun_proc "$pid"; }
  done < <(_candidate_pids)
  sweep_procs_widened
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
  # CTL-1473: plugin-source Workflow worktrees. The Workflow tool bakes wf_* dirs
  # here; they are abandoned AI session artifacts and should be swept on a shorter
  # idle window than ticket worktrees.
  local ps_wt="${SWEEP_PLUGIN_SOURCE_WT:-}"
  if [[ -n "$ps_wt" && -d "$ps_wt" \
        && "$ps_wt" != "${HOME}/.claude/worktrees" \
        && "$ps_wt" != "${proj_wt:-}" ]]; then
    printf '%s\n' "$ps_wt"
  fi
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
    [[ -d "$root" ]] && log "scanning worktree root: ${root}"
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
          # CTL-1417: final self-protection belt — skip if the tree is our cwd
          # or a live process holds a handle under it (never yank a tree an
          # operator or `make test` is inside).
          if ! _removal_guard_ok "$wt"; then
            log "skip (guard refused/unavailable — live handle/self): $wt"; _sweep_count activeSkipped; continue
          fi
          # CTL-1639: salvage before remove. SAFE means nothing to save, so this
          # emits worktree.salvage.skipped — cheap and harmless, and it defends
          # against a stale SAFE verdict racing an eleventh-hour local edit.
          command -v salvage_worktree >/dev/null 2>&1 && \
            salvage_worktree "$wt" "$wt_id" --site "orphan-sweep-safe" || true
          # CTL-1639 Codex round-2 P1: salvage is synchronous and can take a
          # moment on a large tree; a worker or operator could enter the
          # worktree during that interval. Re-assert the guard immediately
          # before the force-remove rather than acting on the pre-salvage
          # result computed above (mirrors the dispatcher's L3 fix —
          # `_removal_guard_ok` re-checked right after salvage,
          # phase-agent-dispatch).
          if ! _removal_guard_ok "$wt"; then
            log "skip (guard refused/unavailable post-salvage — live handle/self): $wt"; _sweep_count activeSkipped; continue
          fi
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
          # CTL-1639: a stale/missing gitdir pointer isn't a usable git
          # worktree, so salvage_worktree (git-based) can't inspect it at
          # all — but that doesn't mean the remaining working files carry no
          # unique local edits. Archive the raw directory to a plain tar
          # first (fail-open, never blocks the removal).
          command -v salvage_raw_directory >/dev/null 2>&1 && \
            salvage_raw_directory "$wt" "$wt_id" --site "orphan-sweep-gitfile" || true
          rm -rf "$wt" && {
            log "removed orphan gitfile dir: $wt"
            _sweep_count removed; removed_count=$((removed_count+1))
            _sweep_add_kb "$kb"
            emit_reclaim orphan_gitfile "$wt"
          }
          ;;
        SALVAGE_UNPUSHED)
          wt_id="$(basename "$wt")"
          # CTL-1639: always snapshot the unpushed commits locally FIRST, before
          # any removal and independent of SWEEP_SALVAGE_PUSH — the local bundle
          # is the always-on additive safety net the network push (default-off,
          # HEAD-only) never was. Dry-run stays side-effect free (Codex P2): a
          # preview log, no bundle/patch/tar artifacts and no telemetry, mirroring
          # the SAFE branch's early is_dry check.
          if is_dry; then
            log "[dry-run] would salvage unpushed commits (bundle to salvage dir): $wt"
          else
            # CTL-1639 Codex round-2 P1: dedup — a retained SALVAGE_UNPUSHED
            # worktree is re-visited every sweep; only re-archive when the
            # content actually changed since the last salvage of THIS tree.
            salvage_worktree_dedup "$wt" "$wt_id" --site "orphan-sweep-unpushed"
          fi
          if [[ "$SWEEP_SALVAGE_PUSH" == "1" ]]; then
            if salvage_push_then_remove "$wt" "$wt_id"; then
              if [[ -n "${SWEEP_MAX_REMOVALS:-}" && "$removed_count" -ge "$SWEEP_MAX_REMOVALS" ]]; then
                deferred=$((deferred+1)); continue
              fi
              if ! _removal_guard_ok "$wt"; then
                # Mirror the SAFE path: a guard refusal (or an unavailable guard)
                # RETAINS the tree, so count it as an active skip or activeSkipped
                # undercounts the worktrees left behind exactly when the guard
                # fires/is absent (CTL-1417).
                log "skip (guard refused/unavailable — live handle/self): $wt"; _sweep_count activeSkipped
              else
                git worktree remove --force "$wt" 2>/dev/null \
                  && { log "removed (salvage) worktree: $wt"; emit_reclaim worktree "$wt"; removed_count=$((removed_count+1)); }
              fi
            fi
          else
            log "salvage (unpushed commits, skip+report): $wt"
            _sweep_count salvageSkipped
          fi
          ;;
        SALVAGE_DIRTY)
          # CTL-1639: the sweep still KEEPS a dirty tree (does not remove it), but
          # snapshot the uncommitted diff to ~/catalyst/salvage/ first so the work
          # is on disk even if an operator later force-cleans the tree by hand —
          # closing the "preserved only by never being reaped" data-loss gap.
          # Dry-run stays side-effect free (Codex P2): preview only.
          if is_dry; then
            log "[dry-run] would salvage uncommitted changes (patch to salvage dir), keeping tree: $wt"
          else
            # CTL-1639 Codex round-2 P1: dedup — see SALVAGE_UNPUSHED above.
            # SALVAGE_DIRTY is ALWAYS kept, so without this a long-lived dirty
            # tree would re-archive an identical patch every sweep forever.
            salvage_worktree_dedup "$wt" "$(basename "$wt")" --site "orphan-sweep-dirty"
            log "skip SALVAGE_DIRTY (snapshotted uncommitted changes, keeping tree): $wt"
          fi
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
    printf 'SWEEP_IDLE_HOURS=%s\nSWEEP_INTERVAL_HOURS=%s\nSWEEP_SALVAGE_PUSH=%s\nSWEEP_MAX_REMOVALS=%s\nSWEEP_WF_STALE_DAYS=%s\nSWEEP_PLUGIN_SOURCE_WT=%s\n' \
      "$SWEEP_IDLE_HOURS" "$SWEEP_INTERVAL_HOURS" "$SWEEP_SALVAGE_PUSH" "$SWEEP_MAX_REMOVALS" \
      "$SWEEP_WF_STALE_DAYS" "$SWEEP_PLUGIN_SOURCE_WT"
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

  log "starting sweep (vectors: trunk_cache, signals, procs[widen=${SWEEP_PROC_WIDEN}], worktrees, agent_browser)"

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
