#!/usr/bin/env bash
# linear-comment-post.sh — Post a Linear comment using the app-actor identity.
#
# Usage: linear-comment-post.sh <ticket-identifier> <literal-markdown-text>
# E.g.:  linear-comment-post.sh CTL-550 "Hello from Catalyst agent"
# Note:  pass the LITERAL text, never a file path — use "$(cat FILE)" or '--body - < FILE'
#
# Reads credentials from env vars (CATALYST_LINEAR_AGENT_CLIENT_ID /
# CATALYST_LINEAR_AGENT_CLIENT_SECRET) or the project Layer-2 config.
# Mints a fresh client_credentials token per-call (no caching).
# Exits 0 on success, non-zero on any failure.
set -euo pipefail

TICKET="${1:?ticket identifier required (e.g. CTL-550)}"
BODY="${2:?comment body required}"

# CTL-2127: reject/auto-read a body that is actually a file path (silent data-loss guard).
# bash 3.2-safe: uses [[ == glob ]] and [[:space:]], not =~ PCRE or mapfile.
if [[ "$BODY" != *[[:space:]]* ]] && \
   { [[ "$BODY" == /* || "$BODY" == ./* || "$BODY" == ../* ]] || \
     [[ "$BODY" == *.md || "$BODY" == *.txt || "$BODY" == *.json ]]; }; then
  if [[ -f "$BODY" && -r "$BODY" ]]; then
    echo "linear-comment-post: '$BODY' is a readable file; posting its CONTENT. Prefer piping content instead of a path." >&2
    BODY="$(cat "$BODY")"
  else
    echo "linear-comment-post: '$BODY' looks like a file path but is not a readable file. Refusing to post a bare path (silent data loss). Pass the literal text or \"\$(cat FILE)\"." >&2
    exit 2
  fi
fi

LINEAR_API="https://api.linear.app"

# Scope for the client_credentials app-actor mint. `comments:create` is REQUIRED
# for the commentCreate mutation below; `read` covers the issue-identifier
# resolution query. Without an explicit scope Linear rejects the mint with
# `400 invalid_scope` (CTL-835), so the mirror would fail open and the comment
# would silently never post. This matches the canonical mints in
# execution-core/linear-remint.mjs (MINT_SCOPE) and catalyst-execution-core.
MINT_SCOPE="read,write,comments:create,app:assignable,app:mentionable"

# CTL-1616 PR4: the credential-env-pair check + the THREE config-json tiers below (NEW global
# bot.worker → OLD per-team agent → OLD global agent) are folded onto the shared secret
# contract's linear-worker-actor row (catalyst_resolve_secret linear-worker-actor) — ALL THREE
# TIERS PRESERVED VERBATIM (deprecating them is an explicit follow-up ticket, design §12 Q6;
# collapsing live credential paths on a recovering fleet is exactly what this fold defers).
# The directory walk-up + its CTL-1111 loud stderr warning now live in
# lib/catalyst-secret-contract.sh's _csc_resolve_legacy_per_team_path (same wording, same
# stderr channel — __tests__/linear-comment-post.test.sh's warning assertions are unaffected).
_LCP_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${_LCP_LIB_DIR}/catalyst-secret-contract.sh"

CLIENT_ID=""
CLIENT_SECRET=""
catalyst_resolve_secret linear-worker-actor >/dev/null
if [[ -n "$CATALYST_SECRET_LAST_VALUE" ]]; then
  CLIENT_ID=$(printf '%s' "$CATALYST_SECRET_LAST_VALUE" | jq -r '.clientId // empty' 2>/dev/null)
  CLIENT_SECRET=$(printf '%s' "$CATALYST_SECRET_LAST_VALUE" | jq -r '.clientSecret // empty' 2>/dev/null)
fi
# Secret hygiene (#2924 post-merge Codex P2): drop the breadcrumb once copied.
unset CATALYST_SECRET_LAST_VALUE

# CTL-1111 back-compat: the pre-fold script ran the per-team directory walk-up (and its "no
# projectKey found" loud warning) UNCONDITIONALLY whenever the env-credential-pair was absent
# — even when the global bot.worker tier already won — because a misconfigured worktree
# (missing .catalyst/config.json ancestry) is worth flagging regardless of which tier
# ultimately supplied the credential. catalyst_resolve_secret's chain only consults the
# per-team tier LAZILY (once every earlier tier misses), so this call preserves that
# diagnostic side effect explicitly; its return value is discarded — the credential itself
# always comes solely from the canonical resolution above.
#
# A2 FIX (CTL-1616 PR4 remediation, duplicate-warning regression): fires ONLY when the
# PRIMARY tier itself won (source "config-json" — unique to that tier for this row, since it
# is the only tier that resolves without ever touching a legacy tier). That is the ONE case
# where catalyst_resolve_secret's own chain returns EARLY without ever invoking the per-team
# walk-up at all, so calling it here is genuinely the FIRST and ONLY invocation. Every OTHER
# outcome ("inherited" — the env pair won; "legacy-config-json"/"none" — the primary tier
# missed) means the chain's own legacyConfigTiers loop ALREADY tried the per-team-legacy tier
# as its first rung (and already fired the loud warning if no projectKey was found) —
# calling this again here would print the SAME warning a second time, which is exactly the
# regression this fix closes (the old unconditional-except-"inherited" guard fired here in
# BOTH the "already handled internally" cases above, not just the one that needed it).
if [[ "$CATALYST_SECRET_LAST_SOURCE" == "config-json" ]]; then
  _csc_resolve_legacy_per_team_path >/dev/null
fi

if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
  echo "linear-comment-post: catalyst.linear.bot.worker.{clientId,clientSecret} (global) or legacy catalyst.linear.agent.* (per-team / global) not found" >&2
  exit 1
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
