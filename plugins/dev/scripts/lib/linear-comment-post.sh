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
#    Capture the body + HTTP status WITHOUT -f so a 400 (e.g. invalid_scope)
#    surfaces the real error JSON instead of being discarded — the single
#    diagnostic line below then carries the actual cause (CTL-835).
TOKEN_HTTP=$(curl -s -w '\n%{http_code}' -X POST "${LINEAR_API}/oauth/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}" \
  -d "scope=${MINT_SCOPE}" \
  -d "actor=app" \
  -H "Content-Type: application/x-www-form-urlencoded" 2>/dev/null) || {
  echo "linear-comment-post: token mint request failed (curl error)" >&2
  exit 1
}
TOKEN_CODE="${TOKEN_HTTP##*$'\n'}"
TOKEN_RESPONSE="${TOKEN_HTTP%$'\n'*}"
ACCESS_TOKEN=$(printf '%s' "$TOKEN_RESPONSE" | jq -r '.access_token // empty' 2>/dev/null)
if [[ -z "$ACCESS_TOKEN" ]]; then
  # One clear diagnostic carrying the HTTP status + Linear's error/description so
  # invalid_scope (and any future mint rejection) is no longer silent.
  ERR_DETAIL=$(printf '%s' "$TOKEN_RESPONSE" | jq -r '[.error, .error_description] | map(select(. != null and . != "")) | join(": ") // empty' 2>/dev/null)
  echo "linear-comment-post: token mint failed (HTTP ${TOKEN_CODE:-?}${ERR_DETAIL:+; }${ERR_DETAIL}) — comment NOT posted" >&2
  exit 1
fi

# 2. Resolve ticket identifier → issue UUID.
#    CTL-1439: `issues(filter:{identifier:{eq:...}})` no longer validates — Linear
#    removed the `identifier` field from IssueFilter, so the old query 400s
#    (GRAPHQL_VALIDATION_FAILED) and EVERY comment post fleet-wide silently died
#    at this step (a root cause of the audit's "0/7 recovery-pass comments"
#    finding). `issue(id:)` accepts the human identifier directly. Captured
#    WITHOUT -f (mirrors the mint above) so a schema/HTTP failure surfaces its
#    actual cause instead of a generic curl error.
ISSUE_QUERY=$(jq -nc \
  --arg q 'query($id:String!){issue(id:$id){id}}' \
  --arg id "$TICKET" \
  '{query: $q, variables: {id: $id}}')
ISSUE_HTTP=$(curl -s -w '\n%{http_code}' -X POST "${LINEAR_API}/graphql" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -d "$ISSUE_QUERY" 2>/dev/null) || {
  echo "linear-comment-post: issue identifier resolution failed (curl error)" >&2
  exit 1
}
ISSUE_CODE="${ISSUE_HTTP##*$'\n'}"
ISSUE_RESPONSE="${ISSUE_HTTP%$'\n'*}"
# Linear returns GraphQL errors in an `errors` array even on HTTP 200 (schema/
# authorization failures) — check it regardless of status so the real cause is
# named instead of collapsing into "no issue found" (Codex P3, CTL-1439).
ERR_DETAIL=$(printf '%s' "$ISSUE_RESPONSE" | jq -r '.errors[0].message // empty' 2>/dev/null)
if [[ "$ISSUE_CODE" != "200" || -n "$ERR_DETAIL" ]]; then
  echo "linear-comment-post: issue identifier resolution failed (HTTP ${ISSUE_CODE}${ERR_DETAIL:+; }${ERR_DETAIL})" >&2
  exit 1
fi
ISSUE_UUID=$(printf '%s' "$ISSUE_RESPONSE" | jq -r '.data.issue.id // empty' 2>/dev/null)
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
