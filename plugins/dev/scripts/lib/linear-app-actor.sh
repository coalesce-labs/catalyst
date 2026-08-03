#!/usr/bin/env bash
# lib/linear-app-actor.sh — CTL-1577: shared Linear app-actor token mint for daemon start paths.
#
# Extracted from catalyst-execution-core's CTL-785 inline block so BOTH long-lived
# daemons (execution-core AND the broker) authenticate to Linear as the Catalyst
# Orchestrator app-actor — its own per-app 5000/hr OAuth bucket — instead of
# inheriting the operator's personal lin_api_ key from the login shell. All
# personal keys share ONE per-user 2500/hr bucket, so a daemon that leaks through
# on the env token drains the operator's interactive quota fleet-wide (the
# broker's cache-reconcile board walk was the CTL-1577 RCA).
#
# linear_app_actor_auth <daemon-name>
#   Mints a fresh client_credentials token from
#   catalyst.linear.bot.orchestrator.{clientId,clientSecret} in the global config
#   and exports it as LINEAR_API_TOKEN + LINEAR_API_KEY. --noproxy keeps the mint
#   off the audit MITM (curl can't trust its CA). Fail-open (parity with CTL-785):
#   a failed mint logs a loud warning and leaves the existing env token intact so
#   the daemon still starts; a missing orchestrator app config is a silent no-op.
#   <daemon-name> prefixes the log lines so each daemon's log stays attributable.
#
# Idempotent-source guard — safe to source multiple times.
[[ -n "${_CATALYST_LINEAR_APP_ACTOR_SH_LOADED:-}" ]] && return 0
_CATALYST_LINEAR_APP_ACTOR_SH_LOADED=1

# CTL-1616 PR4: the Layer-2 selection chain + clientId/clientSecret READ are folded onto the
# shared secret contract (catalyst_resolve_secret linear-orchestrator-actor) so the chain is
# defined ONCE — this file no longer hand-rolls its own copy of the
# CATALYST_LAYER2_CONFIG_FILE > CATALYST_MACHINE_CONFIG > XDG > ~/.config/… chain (this row's
# chain IS that canonical chain; the registry adopted it, not vice versa — design §2/§8). MINT
# mechanics below (the curl POST) are UNCHANGED.
_LAA_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${_LAA_LIB_DIR}/catalyst-secret-contract.sh"

linear_app_actor_auth() {
  local _daemon="${1:?linear_app_actor_auth: daemon name required}"
  local _ocid _ocsec _otok _creds
  catalyst_resolve_secret linear-orchestrator-actor >/dev/null
  _creds="$CATALYST_SECRET_LAST_VALUE"
  # Clear the breadcrumb the moment it's copied (#2924 post-merge Codex P2):
  # this shell goes on to exec the long-lived daemon runtime, and a lingering
  # credential variable in the daemon shell serves nobody. (The lib no longer
  # exports the VALUE at all; this unset is belt-and-braces for THIS shell.)
  unset CATALYST_SECRET_LAST_VALUE
  if [[ -n "$_creds" ]]; then
    _ocid=$(printf '%s' "$_creds" | jq -r '.clientId // empty' 2>/dev/null)
    _ocsec=$(printf '%s' "$_creds" | jq -r '.clientSecret // empty' 2>/dev/null)
  fi
  if [[ -n "${_ocid:-}" && -n "${_ocsec:-}" ]]; then
    # Secret travels via --data @- on stdin, never argv (process-table hygiene —
    # house style: linear-remint.mjs buildMintCurlArgs), values URL-encoded via
    # jq @uri (parity with the re-minter's URLSearchParams — a form-reserved
    # char in a credential must not silently corrupt the body). Connection +
    # transfer bounded so a hung OAuth endpoint cannot wedge daemon start.
    # Encoder input rides stdin too (jq -sRr) — `--arg` would put the secret
    # right back into a process-table argv, the exposure this block avoids.
    local _eid _esec
    _eid=$(printf '%s' "$_ocid" | jq -sRr '@uri' 2>/dev/null)
    _esec=$(printf '%s' "$_ocsec" | jq -sRr '@uri' 2>/dev/null)
    _otok=$(printf 'grant_type=client_credentials&client_id=%s&client_secret=%s&scope=read,write,comments:create,app:assignable,app:mentionable&actor=app' \
      "$_eid" "$_esec" |
      curl -s --connect-timeout 5 --max-time 30 --noproxy '*' -X POST \
        https://api.linear.app/oauth/token --data @- 2>/dev/null |
      jq -r '.access_token // empty' 2>/dev/null)
    if [[ -n "$_otok" ]]; then
      export LINEAR_API_TOKEN="$_otok" LINEAR_API_KEY="$_otok"
      echo "${_daemon}: authenticated as Catalyst Orchestrator app-actor (isolated 5000/hr bucket)" >&2
    else
      echo "${_daemon}: WARNING orchestrator token mint failed — daemon using existing LINEAR_API_TOKEN" >&2
    fi
  fi
}
