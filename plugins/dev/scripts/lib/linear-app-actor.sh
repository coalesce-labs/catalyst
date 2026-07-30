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

linear_app_actor_auth() {
  local _daemon="${1:?linear_app_actor_auth: daemon name required}"
  local _g="${HOME}/.config/catalyst/config.json" _ocid _ocsec _otok
  _ocid=$(jq -r '.catalyst.linear.bot.orchestrator.clientId // empty' "$_g" 2>/dev/null)
  _ocsec=$(jq -r '.catalyst.linear.bot.orchestrator.clientSecret // empty' "$_g" 2>/dev/null)
  if [[ -n "$_ocid" && -n "$_ocsec" ]]; then
    _otok=$(curl -s --noproxy '*' -X POST https://api.linear.app/oauth/token \
      -d grant_type=client_credentials -d "client_id=$_ocid" -d "client_secret=$_ocsec" \
      -d 'scope=read,write,comments:create,app:assignable,app:mentionable' \
      -d 'actor=app' 2>/dev/null | jq -r '.access_token // empty' 2>/dev/null)
    if [[ -n "$_otok" ]]; then
      export LINEAR_API_TOKEN="$_otok" LINEAR_API_KEY="$_otok"
      echo "${_daemon}: authenticated as Catalyst Orchestrator app-actor (isolated 5000/hr bucket)" >&2
    else
      echo "${_daemon}: WARNING orchestrator token mint failed — daemon using existing LINEAR_API_TOKEN" >&2
    fi
  fi
}
