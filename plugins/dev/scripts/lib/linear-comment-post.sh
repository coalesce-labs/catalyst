#!/usr/bin/env bash
# linear-comment-post.sh — Post a Linear comment using the app-actor identity.
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
  echo "$HOME/.config/catalyst/config.json"
}

CLIENT_ID="${CATALYST_LINEAR_AGENT_CLIENT_ID:-}"
CLIENT_SECRET="${CATALYST_LINEAR_AGENT_CLIENT_SECRET:-}"

if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
  GLOBAL_CONFIG="$HOME/.config/catalyst/config.json"
  LAYER2_CONFIG="$(_find_layer2_config)"

  # 1. NEW global path (~/.config/catalyst/config.json):
  #    catalyst.linear.bot.worker.{clientId,clientSecret}
  if [[ -f "$GLOBAL_CONFIG" ]]; then
    CLIENT_ID=$(jq -r '.catalyst.linear.bot.worker.clientId // empty' "$GLOBAL_CONFIG" 2>/dev/null)
    CLIENT_SECRET=$(jq -r '.catalyst.linear.bot.worker.clientSecret // empty' "$GLOBAL_CONFIG" 2>/dev/null)
  fi

  # 2. OLD per-team path fallback (config-<key>.json, resolved above):
  #    catalyst.linear.agent.{clientId,clientSecret}. During the transition the
  #    worker creds may still live in the per-team file under the legacy key.
  if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]] && [[ -f "$LAYER2_CONFIG" ]]; then
    CLIENT_ID=$(jq -r '.catalyst.linear.agent.clientId // empty' "$LAYER2_CONFIG" 2>/dev/null)
    CLIENT_SECRET=$(jq -r '.catalyst.linear.agent.clientSecret // empty' "$LAYER2_CONFIG" 2>/dev/null)
  fi

  # 3. OLD global path fallback: legacy catalyst.linear.agent.* in the global
  #    config.json (covers a global-only legacy layout when no per-team file
  #    exists or the resolver already pointed at config.json).
  if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]] && [[ -f "$GLOBAL_CONFIG" ]]; then
    CLIENT_ID=$(jq -r '.catalyst.linear.agent.clientId // empty' "$GLOBAL_CONFIG" 2>/dev/null)
    CLIENT_SECRET=$(jq -r '.catalyst.linear.agent.clientSecret // empty' "$GLOBAL_CONFIG" 2>/dev/null)
  fi

  if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
    echo "linear-comment-post: catalyst.linear.bot.worker.{clientId,clientSecret} (global) or legacy catalyst.linear.agent.* (per-team $LAYER2_CONFIG / global $GLOBAL_CONFIG) not found" >&2
    exit 1
  fi
fi

# 1. Mint app-actor token via client_credentials grant.
TOKEN_RESPONSE=$(curl -sf -X POST "${LINEAR_API}/oauth/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}" \
  -H "Content-Type: application/x-www-form-urlencoded" 2>/dev/null) || {
  echo "linear-comment-post: token mint failed" >&2
  exit 1
}
ACCESS_TOKEN=$(printf '%s' "$TOKEN_RESPONSE" | jq -r '.access_token // empty' 2>/dev/null)
if [[ -z "$ACCESS_TOKEN" ]]; then
  echo "linear-comment-post: access_token missing in token response" >&2
  exit 1
fi

# 2. Resolve ticket identifier → issue UUID.
ISSUE_QUERY=$(jq -nc \
  --arg q 'query($id:String!){issues(filter:{identifier:{eq:$id}}){nodes{id}}}' \
  --arg id "$TICKET" \
  '{query: $q, variables: {id: $id}}')
ISSUE_RESPONSE=$(curl -sf -X POST "${LINEAR_API}/graphql" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -d "$ISSUE_QUERY" 2>/dev/null) || {
  echo "linear-comment-post: issue identifier resolution failed" >&2
  exit 1
}
ISSUE_UUID=$(printf '%s' "$ISSUE_RESPONSE" | jq -r '.data.issues.nodes[0].id // empty' 2>/dev/null)
if [[ -z "$ISSUE_UUID" ]]; then
  echo "linear-comment-post: no issue found for identifier $TICKET" >&2
  exit 1
fi

# 3. Post the comment.
MUTATION=$(jq -nc \
  --arg q 'mutation($input:CommentCreateInput!){commentCreate(input:$input){success}}' \
  --arg issueId "$ISSUE_UUID" \
  --arg body "$BODY" \
  '{query: $q, variables: {input: {issueId: $issueId, body: $body}}}')
COMMENT_RESPONSE=$(curl -sf -X POST "${LINEAR_API}/graphql" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -d "$MUTATION" 2>/dev/null) || {
  echo "linear-comment-post: comment mutation request failed" >&2
  exit 1
}
SUCCESS=$(printf '%s' "$COMMENT_RESPONSE" | jq -r '.data.commentCreate.success // false' 2>/dev/null)
if [[ "$SUCCESS" != "true" ]]; then
  echo "linear-comment-post: commentCreate returned success=false" >&2
  exit 1
fi
