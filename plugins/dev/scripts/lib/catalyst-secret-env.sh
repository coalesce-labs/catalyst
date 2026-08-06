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

# CTL-1623: the FILE-READ tier of catalyst_project_github_token/_webhook_secret below now
# delegates to lib/catalyst-secret-contract.sh's catalyst_resolve_secret (the CTL-1616
# registry/engine) instead of hand-rolling its own file-candidate search, so the github-token
# and webhook-secret bare-file chains can never drift from the registry again — the exact
# failure class CTL-1612 (this file) and CTL-1616 (the registry) both exist to close.
# catalyst_read_secret_file itself is UNCHANGED below (other callers still use it directly);
# only the two exported projection functions are re-pointed. Same sibling-lib sourcing
# pattern as lib/linear-app-actor.sh / lib/linear-comment-post.sh.
_CSE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${_CSE_LIB_DIR}/catalyst-secret-contract.sh"

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
  # ALL trailing terminators, not just the last pair: callers that read via `$(cat …)`
  # already had every trailing \n eaten by command substitution, and the JS re-arm
  # (github-auth-preflight.mjs) strips /[\r\n]+$/ — a file ending in `\r\n\r\n` must
  # resolve to the same bytes on every path.
  while [[ "$s" == *$'\n' || "$s" == *$'\r' ]]; do
    s="${s%$'\n'}"
    s="${s%$'\r'}"
  done
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
#   So: OBSERVE the assignment. Source the file in a subshell with every probed variable
#   pre-set to a sentinel and see which sentinels survived. Hermetic (the subshell cannot
#   touch our env), and it reports what the shell actually did rather than what the text
#   looks like.
#
#   ONE source for ALL names: the launcher has already sourced this file for real, and an
#   env file may legitimately carry executed commands (a command substitution fetching a
#   token, a `mkdir`, a rate-limited credential-helper call). Probing per-name would re-run
#   those side effects once per alias on every daemon start; batching keeps the probe to a
#   single extra execution.
#
# catalyst_env_file_assigned_names <env-file> <var>...
#   Prints (one per line) the names that sourcing the file assigned.
catalyst_env_file_assigned_names() {
  local _file="${1:-}"
  shift || true
  [[ -r "$_file" && $# -gt 0 ]] || return 1
  local _sentinel="__catalyst_unset_sentinel_$$__"
  (
    local _v
    for _v in "$@"; do export "$_v=$_sentinel"; done
    # shellcheck disable=SC1090
    source "$_file" >/dev/null 2>&1 || true
    for _v in "$@"; do
      [[ "${!_v}" != "$_sentinel" ]] && printf '%s\n' "$_v"
    done
    true
  )
}

# catalyst_env_file_assigns <env-file> <var> — single-name convenience wrapper.
catalyst_env_file_assigns() {
  local _file="${1:-}" _var="${2:?catalyst_env_file_assigns: var required}"
  [[ "$(catalyst_env_file_assigned_names "$_file" "$_var")" == "$_var" ]]
}

# catalyst_project_github_token
#   Arm GITHUB_TOKEN + GH_TOKEN from the shared file. FILE WINS over any inherited value —
#   that stale inherited value IS the bug; a fill-if-unset projection would leave it winning
#   and fix nothing. Both names, because `gh` resolves GH_TOKEN BEFORE GITHUB_TOKEN, so a
#   stale GH_TOKEN anywhere in the launcher's ancestry would otherwise shadow the fix.
#   Absent/empty/unreadable everywhere = TOTAL no-op; never exports "" (bash ${X:-default}
#   and JS ?? both treat "" as SET, which would defeat gh's hosts.yml/keyring fallback).
#   Never logs or echoes the value.
#
#   CTL-1623: the FILE-READ tier is now catalyst_resolve_secret's own bare-file chain
#   (CATALYST_GITHUB_TOKEN_FILE override → CATALYST_CONFIG_DIR → cluster-sync's own
#   destination dir → XDG dir — identical priority order to the pre-fold
#   catalyst_read_secret_file call). This function's OWN inherited-alias precedence (the
#   elif chain below) is untouched — the engine's own inherited-fallback branch is
#   deliberately NOT trusted here (gated out by the source check) so those elif rungs keep
#   deciding GH_TOKEN-vs-GITHUB_TOKEN precedence exactly as before.
catalyst_project_github_token() {
  local _tok _src
  catalyst_resolve_secret "github-token" >/dev/null
  _tok="$CATALYST_SECRET_LAST_VALUE"
  _src="$CATALYST_SECRET_LAST_SOURCE"
  # SECRET HYGIENE (CTL-1623): this launcher's env is inherited by every long-lived daemon
  # and child it spawns. CATALYST_SECRET_LAST_VALUE is deliberately never exported by
  # _csc_set_result (#2924/#2925 post-merge Codex P2 fixes) — unset it here too, defensively,
  # so a plain (unexported) shell variable holding the raw credential does not linger in this
  # launcher's shell past the point it is needed.
  unset CATALYST_SECRET_LAST_VALUE
  # Both "shared-file" (the default/config-dir candidates) and "operator-override" (the
  # explicit CATALYST_GITHUB_TOKEN_FILE override) collapse to this wrapper's single
  # "shared-file" breadcrumb — this function has never distinguished the two; only
  # catalyst_reconcile_github_token_aliases (below) emits "operator-override", for a
  # DIFFERENT override mechanism (a machine-local env file sourced after this runs).
  if [[ -n "$_tok" && ( "$_src" == "shared-file" || "$_src" == "operator-override" ) ]]; then
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
  local _gh_pinned=0 _gt_pinned=0 _name
  if [[ -n "$_env_file" ]]; then
    # One hermetic source covering both aliases — see catalyst_env_file_assigned_names for
    # why probing per-alias would multiply the env file's side effects.
    while IFS= read -r _name; do
      case "$_name" in
        GH_TOKEN) _gh_pinned=1 ;;
        GITHUB_TOKEN) _gt_pinned=1 ;;
      esac
    done < <(catalyst_env_file_assigned_names "$_env_file" GH_TOKEN GITHUB_TOKEN || true)
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
#
#   CTL-1623: same FILE-READ-tier fold as catalyst_project_github_token above — the file
#   chain now runs through catalyst_resolve_secret's webhook-secret row (identical candidate
#   priority to the pre-fold catalyst_read_secret_file call). The registry's webhook-secret
#   row is "boot-only" rotation class, but that only affects ARM classification
#   (catalyst_arm_secret) elsewhere — this function only ever RESOLVES, so it is unaffected.
#   The leave-inherited-alone no-op is preserved exactly: gated on the same
#   shared-file/operator-override source check as the github-token wrapper, so an
#   inherited-only or absent resolution changes nothing here, matching the pre-fold
#   function's silent no-op on that path byte for byte.
catalyst_project_webhook_secret() {
  local _val _src
  catalyst_resolve_secret "webhook-secret" >/dev/null
  _val="$CATALYST_SECRET_LAST_VALUE"
  _src="$CATALYST_SECRET_LAST_SOURCE"
  # SECRET HYGIENE (CTL-1623): see the identical unset in catalyst_project_github_token above.
  unset CATALYST_SECRET_LAST_VALUE
  if [[ -n "$_val" && ( "$_src" == "shared-file" || "$_src" == "operator-override" ) ]]; then
    export CATALYST_WEBHOOK_SECRET="$_val"
  fi
  # Absent/empty/inherited-only → leave whatever was inherited. Never export "": webhook-config
  # treats an empty secret as "route unconfigured", which disables verification instead of
  # failing.
}
