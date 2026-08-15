#!/usr/bin/env bash
# claude-json-mutate.sh — Single, locked owner for ~/.claude.json mutations.
# CTL-1890: two concurrent callers (trust-workspace.sh, create-worktree.sh)
# both used jq→mktemp→mv with zero synchronisation, silently losing updates.
#
# Usage: bash claude-json-mutate.sh <subcommand> [args]
# Subcommands:
#   trust-project <path>                     — trust a directory in Claude Code
#   converge-owned <topLevelKey> <specJson>  — (Phase 2) marker-aware converge
#
# Lock design: mirrors acquire_watchdog_lock / acquire_forward_lock in
# catalyst-monitor.sh — mkdir test-and-set + dead-owner stale reaper + bounded
# wait. No advisory file-lock: stock macOS ships none. Portable to bash 3.2 + restricted PATH.
#
# Environment overrides (for hermetic tests):
#   CLAUDE_JSON              target file (default: ~/.claude.json)
#   CLAUDE_JSON_LOCK_TURNS   max acquire retries (default: 100, ~10s at 0.1s/turn)
#   CLAUDE_JSON_LOCK_SLEEP   sleep between retries in seconds (default: 0.1)
set -euo pipefail

CLAUDE_JSON="${CLAUDE_JSON:-${HOME}/.claude.json}"
_CJM_LOCK_DIR="${CLAUDE_JSON}.lockd"
_CJM_LOCK_TURNS="${CLAUDE_JSON_LOCK_TURNS:-100}"
_CJM_LOCK_SLEEP="${CLAUDE_JSON_LOCK_SLEEP:-0.1}"
_CJM_LOCK_HELD=""

# ── Portable mkdir lock ───────────────────────────────────────────────────────
# Same test-and-set + dead-owner reaper as catalyst-monitor.sh's
# acquire_watchdog_lock / acquire_forward_lock. Kept as an explicit copy rather
# than a sourced library so the lock traps (EXIT/INT/TERM) are isolated to this
# child process and cannot clobber the callers' own traps.

_cjm_lock_is_stale() {
  local owner
  owner="$(cat "${_CJM_LOCK_DIR}/owner" 2>/dev/null)" || return 1
  [[ -n "$owner" ]] || return 0          # no owner recorded → debris → stale
  kill -0 "$owner" 2>/dev/null && return 1  # owner alive → genuinely held
  return 0                                  # owner dead → stale
}

_cjm_release() {
  [[ -n "$_CJM_LOCK_HELD" ]] || return 0
  rm -rf "$_CJM_LOCK_DIR" 2>/dev/null || true
  _CJM_LOCK_HELD=""
}

# Signal handler: release then EXIT so a trapped signal never resumes a mutation
# mid-flight (a returning handler would let bash continue after the signal).
_cjm_signal_exit() {
  _cjm_release
  exit 143  # 128 + SIGTERM — conventional signal-terminated status
}

_cjm_acquire() {
  local waited=0
  [[ -n "$_CJM_LOCK_HELD" ]] && return 0  # reentrant: already ours
  while [[ $waited -lt $_CJM_LOCK_TURNS ]]; do
    if mkdir "$_CJM_LOCK_DIR" 2>/dev/null; then
      echo "$$" > "${_CJM_LOCK_DIR}/owner" 2>/dev/null || true
      _CJM_LOCK_HELD=1
      trap _cjm_release EXIT
      trap _cjm_signal_exit INT TERM
      return 0
    fi
    if _cjm_lock_is_stale; then
      rm -rf "$_CJM_LOCK_DIR" 2>/dev/null || true
      continue  # retry immediately after removing stale lock
    fi
    sleep "$_CJM_LOCK_SLEEP"
    waited=$((waited + 1))
  done
  return 1
}

# ── Single locked read-jq-mv primitive ───────────────────────────────────────
# _cjm_mutate <jq-filter> [extra-jq-args...]
# Acquires the lock, reads CLAUDE_JSON, applies the filter, writes back atomically.
# Fails closed on lock timeout — never proceeds unlocked.
_cjm_mutate() {
  local filter="$1"; shift
  if ! _cjm_acquire; then
    echo "claude-json-mutate: lock timeout on ${_CJM_LOCK_DIR} — NOT proceeding unlocked" >&2
    return 1
  fi
  [[ -f "$CLAUDE_JSON" ]] || {
    echo "claude-json-mutate: ${CLAUDE_JSON} not found" >&2
    return 1
  }
  local tmpfile
  tmpfile="$(mktemp "${CLAUDE_JSON}.XXXXXX")"
  if jq "$@" "$filter" "$CLAUDE_JSON" > "$tmpfile"; then
    mv "$tmpfile" "$CLAUDE_JSON"
  else
    rm -f "$tmpfile"
    return 1
  fi
  # Lock released on EXIT via trap set in _cjm_acquire.
}

# ── Subcommand: trust-project <path> ─────────────────────────────────────────
# Trusts a directory in Claude Code's project table. The check for whether the
# entry exists is performed INSIDE the lock (a single jq if-then-else) so there
# is no TOCTOU race between the read and the write.
#
# Ownership-marker rule (Case F / Case G):
#   - NEW entry  → stamped with _catalystManaged:true  (Phase 2 addition; Phase 1
#                  creates without the marker, Case F asserts its absence)
#   - PRE-EXISTING entry → trust flag flipped; marker never added (we did not
#                          create this entry — it may be operator-managed)
_cmd_trust_project() {
  local raw_path="${1:?usage: trust-project <path>}"
  local path
  path="$(cd "$raw_path" 2>/dev/null && pwd)" || {
    echo "claude-json-mutate: trust-project: path does not exist: ${raw_path}" >&2
    return 1
  }

  # shellcheck disable=SC2016  # $p is a jq variable, not a shell variable
  _cjm_mutate '
    if .projects[$p] then
      .projects[$p].hasTrustDialogAccepted = true
    else
      .projects[$p] = {
        "allowedTools": [],
        "mcpContextUris": [],
        "mcpServers": {},
        "enabledMcpjsonServers": [],
        "disabledMcpjsonServers": [],
        "hasTrustDialogAccepted": true,
        "projectOnboardingSeenCount": 0,
        "hasClaudeMdExternalIncludesApproved": false,
        "hasClaudeMdExternalIncludesWarningShown": false,
        "hasCompletedProjectOnboarding": false
      }
    end
  ' --arg p "$path"

  echo "Trusted: ${path}"
}

# ── Subcommand: converge-owned <topLevelKey> <ownedSpecJson> ─────────────────
# (Phase 2 — placeholder; wired in the Phase 2 commit)
_cmd_converge_owned() {
  echo "claude-json-mutate: converge-owned is not yet implemented (Phase 2)" >&2
  return 2
}

# ── Dispatch ──────────────────────────────────────────────────────────────────
case "${1:-}" in
  trust-project)    _cmd_trust_project "${2:-}";;
  converge-owned)   _cmd_converge_owned "${2:-}" "${3:-}";;
  *)
    echo "Usage: claude-json-mutate.sh <subcommand> [args]" >&2
    echo "  trust-project <path>                  trust a directory in Claude Code" >&2
    echo "  converge-owned <topLevelKey> <spec>   marker-aware converge (Phase 2)" >&2
    exit 2
    ;;
esac
