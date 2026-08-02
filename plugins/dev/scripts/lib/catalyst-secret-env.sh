#!/usr/bin/env bash
# lib/catalyst-secret-env.sh — CTL-1612: ONE canonical projection of the cluster-synced
# secret files into a daemon's boot environment, shared by every daemon start path.
#
# WHY THIS FILE EXISTS. A daemon captures its credentials from the environment at process
# start and never re-reads them, so a rotation reaches new login shells but never a running
# daemon — on 2026-08-02 both fleet hosts ran for hours on a revoked GitHub token while the
# valid one sat unread on disk. The launchers therefore have to arm the credential
# themselves at every start, exactly as lib/linear-app-actor.sh does for Linear.
#
# WHY IT IS SHARED. The first cut of CTL-1612 hand-wrote the same resolution chain in four
# places (execution-core launcher, monitor launcher, the launchd wrapper, and the in-process
# JS re-arm). They immediately diverged — only one honored CATALYST_CONFIG_DIR, so the
# launcher and the in-process re-arm could resolve DIFFERENT files — and every review
# finding across three rounds landed in that duplicated logic rather than in the design.
# Four copies of one chain is a defect generator; this is the single copy.
#
# THE RESOLUTION CHAIN (and why it is not simply "XDG"). cluster-sync materializes bare
# secrets into dirname(getLayer2ConfigPath()) — a HARDCODED ~/.config/catalyst, NOT
# XDG-aware — while setup-webhooks.sh and lib/linear-app-actor.sh ARE XDG-aware. Reading
# only the XDG path makes an XDG host miss every rotation. So: explicit override, then the
# writer's own destination, then the XDG location; first readable NON-EMPTY file wins.
#
# Idempotent-source guard — safe to source multiple times.
[[ -n "${_CATALYST_SECRET_ENV_SH_LOADED:-}" ]] && return 0
_CATALYST_SECRET_ENV_SH_LOADED=1

# _catalyst_strip_eol — remove ONLY the line terminator a text file ends with.
#
# Two failure modes had to be avoided here, and they pull in opposite directions:
#
#   `tr -d '[:space:]'` deletes INTERNAL whitespace, silently corrupting any secret
#   containing a space or tab. For an HMAC key that rejects every inbound delivery with no
#   error anywhere — the value looks present and is simply wrong.
#
#   A full leading/trailing trim is subtler but the same class: a signing secret may
#   legitimately BEGIN or END with a space or tab, and trimming those bytes produces a
#   different key and the identical silent rejection. The `$(cat …)` this replaced removed
#   trailing newlines but preserved boundary spaces, so trimming them would be a regression.
#
# So: strip only the trailing newline(s) a file inevitably carries, and preserve every other
# byte exactly. Command substitution has already eaten trailing \n; this also handles a
# CRLF file. Callers apply their own "is it blank?" check for the whitespace-only case.
_catalyst_strip_eol() {
  local s="$1"
  s="${s%$'\n'}"
  s="${s%$'\r'}"
  printf '%s' "$s"
}

# _catalyst_is_blank — true when the value carries no non-whitespace byte. Used so a
# whitespace-only file still counts as "absent" (never exported) WITHOUT mutating a value
# that merely has significant boundary whitespace.
_catalyst_is_blank() {
  [[ -z "${1//[[:space:]]/}" ]]
}

# catalyst_secret_dirs — the directories to search, in priority order.
_catalyst_secret_dirs() {
  # cluster-sync's own destination first, resolved the way the WRITER resolves it, so a
  # Layer-2 override moves reader and writer together.
  local _l2="${CATALYST_LAYER2_CONFIG_FILE:-${HOME}/.config/catalyst/config.json}"
  printf '%s\n' "$(dirname "$_l2")"
  printf '%s\n' "${XDG_CONFIG_HOME:-${HOME}/.config}/catalyst"
}

# catalyst_read_secret_file <basename> [explicit-path] [explicit-dir]
#   Echoes the first readable NON-EMPTY value found, or nothing. Never echoes a partial or
#   whitespace-only value. An explicit path or dir short-circuits the chain entirely — an
#   operator who names a location means it, so we do NOT silently fall back past it.
catalyst_read_secret_file() {
  local _base="${1:?catalyst_read_secret_file: basename required}"
  local _explicit_path="${2:-}" _explicit_dir="${3:-}"
  local _f _raw _val
  local -a _cands=()
  if [[ -n "$_explicit_path" ]]; then
    _cands=("$_explicit_path")
  elif [[ -n "$_explicit_dir" ]]; then
    _cands=("${_explicit_dir}/${_base}")
  else
    local _d
    while IFS= read -r _d; do
      [[ -n "$_d" ]] && _cands+=("${_d}/${_base}")
    done < <(_catalyst_secret_dirs)
  fi
  for _f in "${_cands[@]}"; do
    [[ -r "$_f" ]] || continue
    _raw="$(cat "$_f" 2>/dev/null)" || continue
    _val="$(_catalyst_strip_eol "$_raw")"
    # Blank-check WITHOUT mutating: a whitespace-only file is treated as absent, while a
    # value with significant boundary whitespace is emitted byte-for-byte.
    if ! _catalyst_is_blank "$_val"; then
      printf '%s' "$_val"
      return 0
    fi
  done
  return 1
}

# catalyst_env_file_assigns <env-file> <var>
#   Does sourcing this env file ACTUALLY assign the variable on THIS host?
#
#   Not a value comparison: an override that pins the SAME value the shared file holds is
#   still an override, and a byte-comparison would miss it, letting a later re-arm overwrite
#   the operator's machine-local pin.
#
#   And not a raw-text grep either. A grep matches an assignment inside a branch that never
#   runs on this host (`if [[ $(hostname) == other ]]; then GITHUB_TOKEN=…; fi`) and would
#   report the alias as pinned when sourcing changed nothing — marking the projected token
#   `operator-override` and making the post-sync re-arm stand down, so an offline node keeps
#   its stale credential and hands it to resumed workers. Exactly the bug we are fixing.
#
#   So: OBSERVE the assignment. Source the file in a subshell with the variable pre-set to a
#   sentinel and see whether the sentinel survived. Hermetic (the subshell cannot touch our
#   env), and it reports what the shell actually did rather than what the text looks like.
catalyst_env_file_assigns() {
  local _file="${1:-}" _var="${2:?catalyst_env_file_assigns: var required}"
  [[ -r "$_file" ]] || return 1
  local _sentinel="__catalyst_unset_sentinel_$$__"
  local _observed
  _observed="$(
    export "$_var=$_sentinel"
    # shellcheck disable=SC1090
    source "$_file" >/dev/null 2>&1 || true
    printf '%s' "${!_var}"
  )"
  [[ "$_observed" != "$_sentinel" ]]
}

# catalyst_project_github_token
#   Arm GITHUB_TOKEN + GH_TOKEN from the shared file. FILE WINS over any inherited value —
#   that stale inherited value IS the bug; a fill-if-unset projection would leave it winning
#   and fix nothing. Both names, because `gh` resolves GH_TOKEN BEFORE GITHUB_TOKEN, so a
#   stale GH_TOKEN anywhere in the launcher's ancestry would otherwise shadow the fix.
#   Absent/empty/unreadable everywhere = TOTAL no-op; never exports "" (bash ${X:-default}
#   and JS ?? both treat "" as SET, which would defeat gh's hosts.yml/keyring fallback).
#   Never logs or echoes the value.
catalyst_project_github_token() {
  local _tok
  if _tok="$(catalyst_read_secret_file "github-token" "${CATALYST_GITHUB_TOKEN_FILE:-}" "${CATALYST_CONFIG_DIR:-}")"; then
    export GITHUB_TOKEN="$_tok" GH_TOKEN="$_tok"
    export CATALYST_GITHUB_TOKEN_SOURCE="shared-file"
  elif [[ -n "${GH_TOKEN:-}" ]]; then
    # No shared file. Keep what was inherited, but export-promote it so a BARE assignment
    # reaches the nohup'd child. GH_TOKEN is checked FIRST and preserved as-is: it
    # outranks GITHUB_TOKEN in gh's own precedence, so an explicit GH_TOKEN beside a stale
    # GITHUB_TOKEN must NOT be overwritten by the latter.
    export GH_TOKEN
    export CATALYST_GITHUB_TOKEN_SOURCE="inherited"
  elif [[ -n "${GITHUB_TOKEN:-}" ]]; then
    export GITHUB_TOKEN
    export GH_TOKEN="$GITHUB_TOKEN" # mirror only when GH_TOKEN is absent
    export CATALYST_GITHUB_TOKEN_SOURCE="inherited"
  else
    # Nothing anywhere: leave BOTH unset so `gh` falls through to hosts.yml / the keyring.
    export CATALYST_GITHUB_TOKEN_SOURCE="none"
  fi
  _CATALYST_PROJECTED_GITHUB_TOKEN="${GITHUB_TOKEN:-}"
  _CATALYST_PROJECTED_GH_TOKEN="${GH_TOKEN:-}"
}

# catalyst_reconcile_github_token_aliases [env-file]
#   MUST run AFTER the machine-local env file is sourced. The operator override is honored
#   by ORDERING (we project first, the env file sources second and wins) — but an override
#   that sets only ONE alias would leave the other holding our shared-file value, and since
#   `gh` reads GH_TOKEN first that can silently defeat the override. Re-point both names at
#   the winner and correct the provenance.
#
#   Detection is by ASSIGNMENT, not by value change: pinning the same value the shared file
#   already had is still an explicit override, and marking it operator-override is what
#   stops the in-process re-arm from later overwriting it.
catalyst_reconcile_github_token_aliases() {
  local _env_file="${1:-}"
  local _gh_changed=0 _gt_changed=0 _win=""
  [[ "${GH_TOKEN:-}" != "${_CATALYST_PROJECTED_GH_TOKEN:-}" ]] && _gh_changed=1
  [[ "${GITHUB_TOKEN:-}" != "${_CATALYST_PROJECTED_GITHUB_TOKEN:-}" ]] && _gt_changed=1
  local _gh_pinned=0 _gt_pinned=0
  if [[ -n "$_env_file" ]]; then
    catalyst_env_file_assigns "$_env_file" GH_TOKEN && _gh_pinned=1
    catalyst_env_file_assigns "$_env_file" GITHUB_TOKEN && _gt_pinned=1
  fi
  (( _gh_changed || _gt_changed || _gh_pinned || _gt_pinned )) || return 0
  # GH_TOKEN wins when it is the one the operator touched — it is the name gh resolves first.
  if (( _gh_changed || _gh_pinned )) && [[ -n "${GH_TOKEN:-}" ]]; then
    _win="$GH_TOKEN"
  elif (( _gt_changed || _gt_pinned )) && [[ -n "${GITHUB_TOKEN:-}" ]]; then
    _win="$GITHUB_TOKEN"
  fi
  # An override that BLANKS a name is not a credential — keep the pair as projected.
  [[ -n "$_win" ]] || return 0
  export GITHUB_TOKEN="$_win" GH_TOKEN="$_win"
  export CATALYST_GITHUB_TOKEN_SOURCE="operator-override"
}

# catalyst_project_webhook_secret
#   Same contract for the GitHub webhook signing secret. orch-monitor resolves this from
#   process.env ONLY (no file fallback, unlike the Linear per-team secrets) and captures it
#   once at boot, so a monitor started without it runs with the GitHub webhook route
#   silently DISABLED rather than degraded.
catalyst_project_webhook_secret() {
  local _val
  if _val="$(catalyst_read_secret_file "webhook-secret" "${CATALYST_WEBHOOK_SECRET_FILE:-}" "${CATALYST_CONFIG_DIR:-}")"; then
    export CATALYST_WEBHOOK_SECRET="$_val"
  fi
  # Absent/empty → leave whatever was inherited. Never export "": webhook-config treats an
  # empty secret as "route unconfigured", which disables verification instead of failing.
}
