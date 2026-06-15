#!/usr/bin/env bash
# linear-comment-post.sh — Post a Linear comment, with a two-tier strategy (CTL-1182):
#   1. App-actor: client_credentials token mint → UUID resolve → commentCreate
#   2. linearis CLI fallback: `linearis issues discuss "$TICKET" --body "$BODY"`
# Exit 0 if either path posts successfully; non-zero only when both fail.
#
# Usage: linear-comment-post.sh <ticket-identifier> <comment-body>
# E.g.:  linear-comment-post.sh CTL-550 "Hello from Catalyst agent"
#
# Reads credentials from env vars (CATALYST_LINEAR_AGENT_CLIENT_ID /
# CATALYST_LINEAR_AGENT_CLIENT_SECRET) or the project Layer-2 config.
# Mints a fresh client_credentials token per-call (no caching).
# Exits 0 on success, non-zero on any failure.
set -euo pipefail

TICKET="${1:?ticket identifier required (e.g. CTL-550)}"
BODY="${2:?comment body required}"

LINEAR_API="https://api.linear.app"

# Scope for the client_credentials app-actor mint. `comments:create` is REQUIRED
# for the commentCreate mutation below; `read` covers the issue-identifier
# resolution query. Without an explicit scope Linear rejects the mint with
# `400 invalid_scope` (CTL-835), so the mirror would fail open and the comment
# would silently never post. This matches the canonical mints in
# execution-core/linear-remint.mjs (MINT_SCOPE) and catalyst-execution-core.
MINT_SCOPE="read,write,comments:create,app:assignable,app:mentionable"

# _find_layer2_config — resolve the OLD per-team Layer-2 file
# (~/.config/catalyst/config-<key>.json) by walking up for .catalyst/config.json
# and reading the project key. The key lives at `.catalyst.projectKey` (nested);
# a bare top-level `.projectKey` is also honored for any legacy layout. Falls
# back to the GLOBAL ~/.config/catalyst/config.json when no key is found.
_find_layer2_config() {
  local dir="$PWD"
  while [[ "$dir" != "/" ]]; do
    local cfg="$dir/.catalyst/config.json"
    if [[ -f "$cfg" ]]; then
      local key
      key=$(jq -r '.catalyst.projectKey // .projectKey // empty' "$cfg" 2>/dev/null) || true
      if [[ -n "$key" ]]; then
        echo "$HOME/.config/catalyst/config-${key}.json"
        return 0
      fi
    fi
    dir="$(dirname "$dir")"
  done
  # CTL-1111: no projectKey found anywhere in the ancestry. Make the drift LOUD
  # instead of silently aliasing to the global config — name what's missing so an
  # operator can see why the per-team config-<key>.json was not consulted. Still
  # return the global path so branch 1 (global bot.worker) back-compat keeps
  # working. Warning goes to stderr; stdout remains the resolved path.
  echo "linear-comment-post: no projectKey in any .catalyst/config.json from $PWD upward — per-team config-<key>.json NOT resolved; falling back to global config.json" >&2
  echo "$HOME/.config/catalyst/config.json"
}

# ── Tier 1: post via the app-actor (client_credentials) identity ─────────────
#
# Self-contained: resolves credentials, mints the token, resolves the UUID, and
# posts the comment. Returns 1 (not exit 1) at each failure point so the caller
# can fall through to the linearis tier without exiting the process (CTL-1182).
_post_via_app_actor() {
  local client_id="${CATALYST_LINEAR_AGENT_CLIENT_ID:-}"
  local client_secret="${CATALYST_LINEAR_AGENT_CLIENT_SECRET:-}"

  if [[ -z "$client_id" || -z "$client_secret" ]]; then
    local global_config="$HOME/.config/catalyst/config.json"
    local layer2_config
    layer2_config="$(_find_layer2_config)"

    # 1. NEW global path (~/.config/catalyst/config.json):
    #    catalyst.linear.bot.worker.{clientId,clientSecret}
    if [[ -f "$global_config" ]]; then
      client_id=$(jq -r '.catalyst.linear.bot.worker.clientId // empty' "$global_config" 2>/dev/null)
      client_secret=$(jq -r '.catalyst.linear.bot.worker.clientSecret // empty' "$global_config" 2>/dev/null)
    fi

    # 2. OLD per-team path fallback (config-<key>.json, resolved above):
    #    catalyst.linear.agent.{clientId,clientSecret}. During the transition the
    #    worker creds may still live in the per-team file under the legacy key.
    if [[ -z "$client_id" || -z "$client_secret" ]] && [[ -f "$layer2_config" ]]; then
      client_id=$(jq -r '.catalyst.linear.agent.clientId // empty' "$layer2_config" 2>/dev/null)
      client_secret=$(jq -r '.catalyst.linear.agent.clientSecret // empty' "$layer2_config" 2>/dev/null)
    fi

    # 3. OLD global path fallback: legacy catalyst.linear.agent.* in the global
    #    config.json (covers a global-only legacy layout when no per-team file
    #    exists or the resolver already pointed at config.json).
    if [[ -z "$client_id" || -z "$client_secret" ]] && [[ -f "$global_config" ]]; then
      client_id=$(jq -r '.catalyst.linear.agent.clientId // empty' "$global_config" 2>/dev/null)
      client_secret=$(jq -r '.catalyst.linear.agent.clientSecret // empty' "$global_config" 2>/dev/null)
    fi

    if [[ -z "$client_id" || -z "$client_secret" ]]; then
      echo "linear-comment-post: catalyst.linear.bot.worker.{clientId,clientSecret} (global) or legacy catalyst.linear.agent.* (per-team $layer2_config / global $global_config) not found" >&2
      return 1
    fi
  fi

  # 1. Mint app-actor token via client_credentials grant.
  #    Capture the body + HTTP status WITHOUT -f so a 400 (e.g. invalid_scope)
  #    surfaces the real error JSON instead of being discarded — the single
  #    diagnostic line below then carries the actual cause (CTL-835).
  local token_http
  token_http=$(curl -s -w '\n%{http_code}' -X POST "${LINEAR_API}/oauth/token" \
    -d "grant_type=client_credentials" \
    -d "client_id=${client_id}" \
    -d "client_secret=${client_secret}" \
    -d "scope=${MINT_SCOPE}" \
    -d "actor=app" \
    -H "Content-Type: application/x-www-form-urlencoded" 2>/dev/null) || {
    echo "linear-comment-post: token mint request failed (curl error)" >&2
    return 1
  }
  local token_code="${token_http##*$'\n'}"
  local token_response="${token_http%$'\n'*}"
  local access_token
  access_token=$(printf '%s' "$token_response" | jq -r '.access_token // empty' 2>/dev/null)
  if [[ -z "$access_token" ]]; then
    # One clear diagnostic carrying the HTTP status + Linear's error/description so
    # invalid_scope (and any future mint rejection) is no longer silent.
    local err_detail
    err_detail=$(printf '%s' "$token_response" | jq -r '[.error, .error_description] | map(select(. != null and . != "")) | join(": ") // empty' 2>/dev/null)
    echo "linear-comment-post: token mint failed (HTTP ${token_code:-?}${err_detail:+; }${err_detail}) — comment NOT posted" >&2
    return 1
  fi

  # 2. Resolve ticket identifier → issue UUID.
  local issue_query
  issue_query=$(jq -nc \
    --arg q 'query($id:String!){issues(filter:{identifier:{eq:$id}}){nodes{id}}}' \
    --arg id "$TICKET" \
    '{query: $q, variables: {id: $id}}')
  local issue_response
  issue_response=$(curl -sf -X POST "${LINEAR_API}/graphql" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${access_token}" \
    -d "$issue_query" 2>/dev/null) || {
    echo "linear-comment-post: issue identifier resolution failed" >&2
    return 1
  }
  local issue_uuid
  issue_uuid=$(printf '%s' "$issue_response" | jq -r '.data.issues.nodes[0].id // empty' 2>/dev/null)
  if [[ -z "$issue_uuid" ]]; then
    echo "linear-comment-post: no issue found for identifier $TICKET" >&2
    return 1
  fi

  # 3. Post the comment.
  local mutation
  mutation=$(jq -nc \
    --arg q 'mutation($input:CommentCreateInput!){commentCreate(input:$input){success}}' \
    --arg issueId "$issue_uuid" \
    --arg body "$BODY" \
    '{query: $q, variables: {input: {issueId: $issueId, body: $body}}}')
  local comment_response
  comment_response=$(curl -sf -X POST "${LINEAR_API}/graphql" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${access_token}" \
    -d "$mutation" 2>/dev/null) || {
    echo "linear-comment-post: comment mutation request failed" >&2
    return 1
  }
  local success
  success=$(printf '%s' "$comment_response" | jq -r '.data.commentCreate.success // false' 2>/dev/null)
  if [[ "$success" != "true" ]]; then
    echo "linear-comment-post: commentCreate returned success=false" >&2
    return 1
  fi
}

# ── Tier 2: linearis CLI fallback ─────────────────────────────────────────────
_post_via_linearis() {
  command -v linearis >/dev/null 2>&1 || {
    echo "linear-comment-post: linearis not found on PATH — fallback unavailable" >&2
    return 1
  }
  linearis issues discuss "$TICKET" --body "$BODY" >/dev/null 2>&1 || {
    echo "linear-comment-post: linearis fallback failed" >&2
    return 1
  }
}

# ── Main flow ─────────────────────────────────────────────────────────────────
if _post_via_app_actor; then exit 0; fi
echo "linear-comment-post: app-actor post failed — attempting linearis fallback" >&2
if _post_via_linearis; then exit 0; fi
echo "linear-comment-post: linearis fallback unavailable or failed — comment NOT posted" >&2
exit 1
