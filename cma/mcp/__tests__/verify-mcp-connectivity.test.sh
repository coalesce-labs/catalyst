#!/usr/bin/env bash
# Manual smoke test for CMA MCP connectors (CTL-456).
#
# Verifies the Path A REST connectivity for Granola, Google Drive, and
# Google Calendar against real external APIs. Not run in CI — consumes
# live credentials and external rate limits.
#
# Usage:
#   bash cma/mcp/__tests__/verify-mcp-connectivity.test.sh
#
# Required env vars (each subtest skips if its vars are missing):
#   Granola         : GRANOLA_API_KEY
#   Google Drive    : GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
#                     GOOGLE_OAUTH_REFRESH_TOKEN
#   Google Calendar : same Google OAuth env vars as Drive (single OAuth
#                     client, shared refresh token; see cma/mcp/google-drive.md)
#
# Exits 0 when no subtest fails. A missing-env-var subtest counts as "skip"
# (not "fail"), so the bare invocation with no credentials exits 0.

set -uo pipefail

PASS=0
FAIL=0
SKIP=0

# ---------------------------------------------------------------------------
# Granola — Path A REST with Personal API key
# ---------------------------------------------------------------------------
check_granola() {
  echo
  echo "== Granola =="
  if [ -z "${GRANOLA_API_KEY:-}" ]; then
    echo "skip — GRANOLA_API_KEY not set"
    SKIP=$((SKIP + 1))
    return 0
  fi
  local body status
  body=$(curl -s -w '\n%{http_code}' \
    -H "Authorization: Bearer ${GRANOLA_API_KEY}" \
    "https://public-api.granola.ai/v1/notes?page_size=3" 2>&1) || {
      echo "fail — curl errored"
      FAIL=$((FAIL + 1))
      return 0
    }
  status=$(printf '%s' "$body" | tail -n1)
  local payload
  payload=$(printf '%s' "$body" | sed '$d')
  if [ "$status" = "200" ]; then
    local count
    count=$(printf '%s' "$payload" | jq '.notes | length' 2>/dev/null || echo "?")
    echo "pass — HTTP 200, ${count} notes returned"
    PASS=$((PASS + 1))
  else
    echo "fail — HTTP ${status}"
    printf '%s' "$payload" | head -c 300
    echo
    FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------------------
# Shared helper — exchange Google refresh_token for an access_token
# ---------------------------------------------------------------------------
_exchange_google_access_token() {
  if [ -z "${GOOGLE_OAUTH_CLIENT_ID:-}" ] \
     || [ -z "${GOOGLE_OAUTH_CLIENT_SECRET:-}" ] \
     || [ -z "${GOOGLE_OAUTH_REFRESH_TOKEN:-}" ]; then
    printf ''
    return 1
  fi
  curl -s -X POST https://oauth2.googleapis.com/token \
    --data-urlencode "client_id=${GOOGLE_OAUTH_CLIENT_ID}" \
    --data-urlencode "client_secret=${GOOGLE_OAUTH_CLIENT_SECRET}" \
    --data-urlencode "refresh_token=${GOOGLE_OAUTH_REFRESH_TOKEN}" \
    --data-urlencode "grant_type=refresh_token" \
    | jq -r '.access_token // empty'
}

# ---------------------------------------------------------------------------
# Google Drive — Path A REST (Drive v3)
# ---------------------------------------------------------------------------
check_google_drive() {
  echo
  echo "== Google Drive =="
  local token
  token=$(_exchange_google_access_token)
  if [ -z "$token" ]; then
    echo "skip — GOOGLE_OAUTH_{CLIENT_ID,CLIENT_SECRET,REFRESH_TOKEN} not all set, or token exchange returned empty"
    SKIP=$((SKIP + 1))
    return 0
  fi
  local since body status payload
  since=$(date -u +%Y-%m-01T00:00:00Z)
  body=$(curl -s -w '\n%{http_code}' \
    -H "Authorization: Bearer ${token}" \
    --get \
    --data-urlencode "q=modifiedTime>'${since}'" \
    --data-urlencode "pageSize=3" \
    "https://www.googleapis.com/drive/v3/files" 2>&1) || {
      echo "fail — curl errored"
      FAIL=$((FAIL + 1))
      return 0
    }
  status=$(printf '%s' "$body" | tail -n1)
  payload=$(printf '%s' "$body" | sed '$d')
  if [ "$status" = "200" ]; then
    local count
    count=$(printf '%s' "$payload" | jq '.files | length' 2>/dev/null || echo "?")
    echo "pass — HTTP 200, ${count} files returned"
    PASS=$((PASS + 1))
  else
    echo "fail — HTTP ${status}"
    printf '%s' "$payload" | head -c 300
    echo
    FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------------------
# Google Calendar — Path A REST (Calendar v3)
# ---------------------------------------------------------------------------
check_google_calendar() {
  echo
  echo "== Google Calendar =="
  local token
  token=$(_exchange_google_access_token)
  if [ -z "$token" ]; then
    echo "skip — same env-var requirement as Google Drive"
    SKIP=$((SKIP + 1))
    return 0
  fi
  local today tomorrow body status payload
  today=$(date -u +%Y-%m-%dT00:00:00Z)
  tomorrow=$(date -u -v+1d +%Y-%m-%dT00:00:00Z 2>/dev/null \
    || date -u -d tomorrow +%Y-%m-%dT00:00:00Z)
  body=$(curl -s -w '\n%{http_code}' \
    -H "Authorization: Bearer ${token}" \
    --get \
    --data-urlencode "timeMin=${today}" \
    --data-urlencode "timeMax=${tomorrow}" \
    --data-urlencode "singleEvents=true" \
    --data-urlencode "orderBy=startTime" \
    "https://www.googleapis.com/calendar/v3/calendars/primary/events" 2>&1) || {
      echo "fail — curl errored"
      FAIL=$((FAIL + 1))
      return 0
    }
  status=$(printf '%s' "$body" | tail -n1)
  payload=$(printf '%s' "$body" | sed '$d')
  if [ "$status" = "200" ]; then
    local count
    count=$(printf '%s' "$payload" | jq '.items | length' 2>/dev/null || echo "?")
    echo "pass — HTTP 200, ${count} events today"
    PASS=$((PASS + 1))
  else
    echo "fail — HTTP ${status}"
    printf '%s' "$payload" | head -c 300
    echo
    FAIL=$((FAIL + 1))
  fi
}

check_granola
check_google_drive
check_google_calendar

echo
echo "Pass: ${PASS}  Fail: ${FAIL}  Skip: ${SKIP}"
[ "${FAIL}" -eq 0 ]
