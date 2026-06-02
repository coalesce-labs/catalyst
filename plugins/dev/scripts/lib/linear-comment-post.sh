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

_find_layer2_config() {
  local dir="$PWD"
  while [[ "$dir" != "/" ]]; do
    local cfg="$dir/.catalyst/config.json"
    if [[ -f "$cfg" ]]; then
      local key
      key=$(jq -r '.projectKey // empty' "$cfg" 2>/dev/null) || true
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
  LAYER2_CONFIG="$(_find_layer2_config)"
  if [[ ! -f "$LAYER2_CONFIG" ]]; then
    echo "linear-comment-post: Layer-2 config not found at $LAYER2_CONFIG" >&2
    exit 1
  fi
  CLIENT_ID=$(jq -r '.catalyst.linear.agent.clientId // empty' "$LAYER2_CONFIG" 2>/dev/null)
  CLIENT_SECRET=$(jq -r '.catalyst.linear.agent.clientSecret // empty' "$LAYER2_CONFIG" 2>/dev/null)
  if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
    echo "linear-comment-post: catalyst.linear.agent.{clientId,clientSecret} not found in $LAYER2_CONFIG" >&2
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
