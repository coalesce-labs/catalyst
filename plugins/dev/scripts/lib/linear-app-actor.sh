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
# linear_app_actor_auth <daemon-name> [target-env-var]
#   Mints a fresh client_credentials token from
#   catalyst.linear.bot.orchestrator.{clientId,clientSecret} in the global config.
#   --noproxy keeps the mint off the audit MITM (curl can't trust its CA).
#   Fail-open (parity with CTL-785): a failed mint logs a loud warning and leaves
#   the existing env token intact so the daemon still starts; a missing
#   orchestrator app config is a silent no-op. <daemon-name> prefixes the log
#   lines so each daemon's log stays attributable.
#
#   Default (no target-env-var): exports LINEAR_API_TOKEN + LINEAR_API_KEY —
#   the broker/execution-core behavior, UNCHANGED.
#
#   With <target-env-var>: exports ONLY that variable, leaving
#   LINEAR_API_TOKEN/LINEAR_API_KEY untouched — and ACTIVELY CLEARS any
#   inherited LINEAR_API_TOKEN/LINEAR_API_KEY first (CTL-1612 round 4, see
#   below). CTL-1612: catalyst-monitor uses this scoped form (target var
#   CATALYST_MONITOR_APP_ACTOR_TOKEN) because the monitor is two-identity —
#   its inline-reply path (linear-comment.mjs resolveLinearToken) must keep
#   resolving the OPERATOR's personal token, and a blanket LINEAR_API_TOKEN
#   export here outranks that resolution (env beats Layer-2), making every
#   reply 502 bot_identity. Only the monitor's own self-reads (the
#   peer-heartbeat anchor read) opt into the scoped var.
#
#   CTL-1612 round 4 (Codex P1 follow-up): scoped mode also UNSETS any
#   LINEAR_API_TOKEN/LINEAR_API_KEY it finds ALREADY set on entry — not just
#   "never adds" them. catalyst-broker calls this function UNSCOPED at its own
#   startup (exports the app-actor token under those two names into the
#   broker's own process env), and broker/stack-reload.mjs's restart spawn
#   carries no `env` override, so `catalyst-monitor restart` — issued
#   automatically after a plugin-source stack reload — inherits the broker's
#   env verbatim. Without the clear, that inherited bot-valued alias survives
#   into the monitor's env untouched (the scoped branch previously only
#   promised not to ADD LINEAR_API_TOKEN/LINEAR_API_KEY, never that it would
#   REMOVE an inherited one), resolveLinearToken picks it before the personal
#   Layer-2 token (env beats Layer-2), and every inline reply 502s
#   bot_identity again — the SAME P1 as round 1's original finding,
#   resurfacing through a different door (inheritance, not this script's own
#   export). TRADEOFF: this also clears a legitimate interactively-exported
#   personal LINEAR_API_TOKEN for a human running `catalyst-monitor start`
#   from a shell with their own lin_api_* set, forcing a fall-through to the
#   Layer-2 personal-token tier. That fallback is the DOCUMENTED, supported
#   source for the monitor's personal token already — the launchd/headless
#   path relies on it exclusively (the committed launchd wrapper exports no
#   Linear token at all) — so clearing restores "launchd parity" rather than
#   degrading anything: this scoped shell never had these vars set on a clean
#   launchd start, and unsetting them here makes every start path agree.
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
  local _target_var="${2:-}"
  local _ocid _ocsec _otok _creds

  # CTL-1612 round 4: see the header comment above — scoped mode never trusts
  # an inherited LINEAR_API_TOKEN/LINEAR_API_KEY, regardless of whether OUR
  # OWN mint below succeeds, fails, or finds no orchestrator creds at all.
  if [[ -n "$_target_var" ]]; then
    if [[ -n "${LINEAR_API_TOKEN:-}" || -n "${LINEAR_API_KEY:-}" ]]; then
      echo "${_daemon}: clearing inherited LINEAR_API_TOKEN/LINEAR_API_KEY before scoped mint (scoped mode never trusts an inherited alias — see \$${_target_var} instead)" >&2
    fi
    unset LINEAR_API_TOKEN LINEAR_API_KEY
  fi

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
      if [[ -n "$_target_var" ]]; then
        # Scoped mint: export ONLY the named var — LINEAR_API_TOKEN/LINEAR_API_KEY
        # are deliberately left untouched (see the header comment above).
        export "${_target_var}=${_otok}"
        echo "${_daemon}: authenticated as Catalyst Orchestrator app-actor (isolated 5000/hr bucket, scoped to \$${_target_var})" >&2
      else
        export LINEAR_API_TOKEN="$_otok" LINEAR_API_KEY="$_otok"
        echo "${_daemon}: authenticated as Catalyst Orchestrator app-actor (isolated 5000/hr bucket)" >&2
      fi
    else
      if [[ -n "$_target_var" ]]; then
        echo "${_daemon}: WARNING orchestrator token mint failed — \$${_target_var} not set (self-reads fall back to existing resolution)" >&2
      else
        echo "${_daemon}: WARNING orchestrator token mint failed — daemon using existing LINEAR_API_TOKEN" >&2
      fi
    fi
  fi
}
