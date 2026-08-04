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
#   CTL-1612 round 7 (Codex P2 follow-up): whenever <target-env-var> is set,
#   a companion "<target-env-var>_SOURCE" var is ALSO exported —
#   "minted" for a genuinely fresh mint, "inherited" for a round-6 fallback
#   reuse. A caller (server.ts) that wants to know "is this token fresh
#   enough to skip an immediate re-mint" must check this marker, not just
#   whether the target var is merely present — an inherited fallback can be
#   near its own expiry.
#
#   CTL-1612 round 4 (Codex P1 follow-up): scoped mode also CLEARS a
#   non-personal LINEAR_API_TOKEN/LINEAR_API_KEY it finds ALREADY set on
#   entry — not just "never adds" them. catalyst-broker calls this function
#   UNSCOPED at its own startup (exports the app-actor token under those two
#   names into the broker's own process env), and broker/stack-reload.mjs's
#   restart spawn carries no `env` override, so `catalyst-monitor restart` —
#   issued automatically after a plugin-source stack reload — inherits the
#   broker's env verbatim. Without the clear, that inherited bot-valued alias
#   survives into the monitor's env untouched (the scoped branch previously
#   only promised not to ADD LINEAR_API_TOKEN/LINEAR_API_KEY, never that it
#   would REMOVE an inherited one), resolveLinearToken picks it before the
#   personal Layer-2 token (env beats Layer-2), and every inline reply 502s
#   bot_identity again — the SAME P1 as round 1's original finding,
#   resurfacing through a different door (inheritance, not this script's own
#   export).
#
#   CTL-1612 round 5 (Codex P2 follow-up): the clear is PRECISE, not
#   unconditional — see linear_app_actor_clear_inherited below. A genuinely
#   personal `lin_api_*` key survives; anything else (bot/oauth-shaped, or
#   unrecognized) is cleared. A round-4 unconditional clear also deleted a
#   LEGITIMATE personal credential for an operator who runs the monitor from
#   a shell with their own `lin_api_*` exported and no Layer-2 personal token
#   configured — the estimate/title fallbacks
#   (linear-estimate-fallback.mjs/linear-title-description-fallback.mjs)
#   resolve ONLY LINEAR_API_TOKEN/LINEAR_API_KEY, with no Layer-2 tier at
#   all, so that launch configuration lost board enrichment entirely and
#   inline replies returned `no_token`.
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

# linear_app_actor_clear_inherited <daemon-name>
#   CTL-1612 rounds 4/5: clears any INHERITED LINEAR_API_TOKEN/LINEAR_API_KEY
#   that is NOT a personal `lin_api_*` key — i.e. bot/oauth-shaped or
#   unrecognized-shaped values only. A genuinely personal key survives
#   untouched (see the round-5 header comment above for why). Matching is
#   case-insensitive (lowercased before the prefix check) for parity with the
#   codebase's other credential-shape check (cluster-heartbeat.mjs/
#   cluster-claim.mjs authHeader: `/^lin_oauth/i`) — Linear's own API
#   distinguishes the two credential kinds by this exact prefix (Bearer vs.
#   raw Authorization header), a REAL, functionally load-bearing split, not
#   just a naming convention. Logs ONLY when something was actually cleared.
#
#   CTL-1612 round 6 (Codex P2 follow-up): each value is TRIMMED of
#   surrounding whitespace before the prefix check — matching
#   orch-monitor/lib/linear-comment.mjs's resolveLinearToken, the definitive
#   consumer, which does `.trim()` on its resolved env value before ever
#   comparing/using it. Without the trim, a padded personal credential
#   (`LINEAR_API_TOKEN="  lin_api_…"`) would classify as non-personal here and
#   get cleared, even though the token that reaches resolveLinearToken (which
#   sees the SAME padded value and trims it there) would have worked fine.
#
#   Factored out of linear_app_actor_auth's scoped branch so a caller that
#   needs to skip the MINT ENTIRELY (no orchestrator work to do at all — e.g.
#   catalyst-monitor.sh's loki-only or no-liveness-anchor skip paths,
#   CTL-1612 round 5) can still close the inherited-bot-alias gap without
#   attempting a network call. linear_app_actor_auth's own scoped branch
#   calls this too, so every scoped entry point gets the same guarantee
#   regardless of whether it goes on to mint.
#
#   CTL-1612 round 6 (Codex P2 follow-up, resilience refinement): before
#   clearing, the FIRST bot/oauth-shaped value found (LINEAR_API_TOKEN
#   preferred over LINEAR_API_KEY, matching linear-comment.mjs
#   resolveLinearToken's own precedence) is captured into the breadcrumb
#   LAA_LAST_CLEARED_TOKEN — reset at the top of every call, so a caller
#   always reads either THIS call's capture or empty, never a stale one from
#   a previous invocation. This is what lets linear_app_actor_auth's scoped
#   branch reuse a USABLE inherited app-actor token as a fallback if its own
#   mint then fails, instead of discarding a working credential and leaving
#   the scoped target var empty (self-reads would otherwise go dark until
#   the NEXT successful mint, even though the inherited token could have
#   served them in the meantime). The aliases are unset in EVERY case
#   regardless of what gets captured — the round-4/5 P1 contract (never let
#   a non-personal alias survive into resolveLinearToken's env-first
#   resolution) holds unconditionally.
LAA_LAST_CLEARED_TOKEN=""
linear_app_actor_clear_inherited() {
  local _daemon="${1:?linear_app_actor_clear_inherited: daemon name required}"
  local _cleared=0
  local _trimmed _lc
  LAA_LAST_CLEARED_TOKEN=""
  if [[ -n "${LINEAR_API_TOKEN:-}" ]]; then
    _trimmed="$(printf '%s' "$LINEAR_API_TOKEN" | xargs 2>/dev/null || true)"
    _lc="$(printf '%s' "$_trimmed" | tr '[:upper:]' '[:lower:]')"
    if [[ "$_lc" != lin_api_* ]]; then
      LAA_LAST_CLEARED_TOKEN="$LINEAR_API_TOKEN"
      unset LINEAR_API_TOKEN
      _cleared=1
    fi
  fi
  if [[ -n "${LINEAR_API_KEY:-}" ]]; then
    _trimmed="$(printf '%s' "$LINEAR_API_KEY" | xargs 2>/dev/null || true)"
    _lc="$(printf '%s' "$_trimmed" | tr '[:upper:]' '[:lower:]')"
    if [[ "$_lc" != lin_api_* ]]; then
      [[ -z "$LAA_LAST_CLEARED_TOKEN" ]] && LAA_LAST_CLEARED_TOKEN="$LINEAR_API_KEY"
      unset LINEAR_API_KEY
      _cleared=1
    fi
  fi
  if [[ "$_cleared" == "1" ]]; then
    echo "${_daemon}: clearing inherited LINEAR_API_TOKEN/LINEAR_API_KEY (non-personal shape — scoped mode never trusts an inherited bot/oauth alias; a personal lin_api_* key would have survived)" >&2
  fi
}

linear_app_actor_auth() {
  local _daemon="${1:?linear_app_actor_auth: daemon name required}"
  local _target_var="${2:-}"
  local _ocid _ocsec _otok _creds
  local _inherited_fallback=""

  # CTL-1612 rounds 4/5: see the header comment above — scoped mode never
  # trusts an inherited non-personal LINEAR_API_TOKEN/LINEAR_API_KEY,
  # regardless of whether OUR OWN mint below succeeds, fails, or finds no
  # orchestrator creds at all.
  #
  # CTL-1612 round 6: _inherited_fallback captures whatever
  # linear_app_actor_clear_inherited just cleared (empty if nothing was
  # cleared, or the clear never ran in unscoped mode) — read IMMEDIATELY, into
  # a local, before anything else in this function can touch the shared
  # LAA_LAST_CLEARED_TOKEN breadcrumb.
  if [[ -n "$_target_var" ]]; then
    linear_app_actor_clear_inherited "$_daemon"
    _inherited_fallback="$LAA_LAST_CLEARED_TOKEN"
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
      # A SUCCESSFUL mint always wins — even over a usable inherited fallback
      # (CTL-1612 round 6): a fresh token is preferred to a possibly-aging
      # inherited one whenever we actually have the choice.
      if [[ -n "$_target_var" ]]; then
        # Scoped mint: export ONLY the named var — LINEAR_API_TOKEN/LINEAR_API_KEY
        # are deliberately left untouched (see the header comment above).
        #
        # CTL-1612 round 7 (Codex P2 follow-up): also export
        # "${_target_var}_SOURCE=minted" — a companion PROVENANCE marker a
        # caller can use to tell "this is a genuinely fresh token" apart from
        # "this is a reused inherited token" (see the two round-6 fallback
        # branches below, which export "...=inherited" instead). server.ts
        # reads this to decide whether it's safe to seed the async
        # reminter's cooldown as if ITS OWN mint just succeeded — an inherited
        # fallback token could be near expiry, and treating it as fresh would
        # suppress the reminter's retry for the full success cooldown instead
        # of the shorter failure-retry window.
        export "${_target_var}=${_otok}"
        export "${_target_var}_SOURCE=minted"
        echo "${_daemon}: authenticated as Catalyst Orchestrator app-actor (isolated 5000/hr bucket, scoped to \$${_target_var})" >&2
      else
        export LINEAR_API_TOKEN="$_otok" LINEAR_API_KEY="$_otok"
        echo "${_daemon}: authenticated as Catalyst Orchestrator app-actor (isolated 5000/hr bucket)" >&2
      fi
    else
      # CTL-1612 round 6: creds WERE configured but the mint POST itself
      # failed (network/OAuth-endpoint issue) — the same class of failure
      # the round-2 async re-minter's failureCooldownMs exists to retry soon
      # for the server.ts side. Here at start time there is no retry loop, so
      # reuse a captured inherited app-actor token if one survived the clear
      # above — it is still USABLE (Linear doesn't invalidate a token just
      # because ITS OWN re-mint elsewhere failed) and strictly better than
      # leaving the scoped var empty until the next successful mint.
      if [[ -n "$_target_var" ]]; then
        if [[ -n "$_inherited_fallback" ]]; then
          export "${_target_var}=${_inherited_fallback}"
          # CTL-1612 round 7: "inherited", not "minted" — see the provenance
          # comment above.
          export "${_target_var}_SOURCE=inherited"
          echo "${_daemon}: orchestrator token mint failed — reusing the inherited app-actor token for \$${_target_var} (still usable until it expires; a future successful mint will replace it)" >&2
        else
          echo "${_daemon}: WARNING orchestrator token mint failed — \$${_target_var} not set (self-reads fall back to existing resolution)" >&2
        fi
      else
        echo "${_daemon}: WARNING orchestrator token mint failed — daemon using existing LINEAR_API_TOKEN" >&2
      fi
    fi
  elif [[ -n "$_target_var" && -n "$_inherited_fallback" ]]; then
    # CTL-1612 round 6: no orchestrator app configured at all (the documented
    # silent no-op — UNCHANGED for unscoped mode and for scoped mode with
    # nothing to fall back to). Scoped mode with a captured inherited token
    # is the one case that gets LOUDER than before: silence here would throw
    # away a usable credential for no reason, so seed the target var from it.
    export "${_target_var}=${_inherited_fallback}"
    # CTL-1612 round 7: "inherited", not "minted" — see the provenance
    # comment above.
    export "${_target_var}_SOURCE=inherited"
    echo "${_daemon}: no orchestrator app configured — reusing the inherited app-actor token for \$${_target_var} (still usable until it expires)" >&2
  fi
}
