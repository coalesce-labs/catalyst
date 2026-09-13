#!/usr/bin/env bash
# gather-drive.sh — Pull Google Drive files modified yesterday in the designated folder.
#
# Usage:
#   gather-drive.sh [--date YYYY-MM-DD] [--folder-id FOLDERID] [--limit N]
#
# Requires GOOGLE_OAUTH_ACCESS_TOKEN in env (the caller is responsible for
# refresh; MVP doesn't manage the refresh dance). Optional GOOGLE_DRIVE_FOLDER_ID
# narrows to a folder (e.g. the meeting notes folder).
# Degrades silently to {} when creds are missing or network fails.

set -uo pipefail

DATE=""
FOLDER_ID="${GOOGLE_DRIVE_FOLDER_ID:-}"
LIMIT=20

while [[ $# -gt 0 ]]; do
  case "$1" in
    --date) DATE="$2"; shift 2 ;;
    --folder-id) FOLDER_ID="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "gather-drive.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

if [[ -z "${GOOGLE_OAUTH_ACCESS_TOKEN:-}" ]]; then
  echo '{}'
  exit 0
fi
if ! command -v curl >/dev/null 2>&1; then
  echo '{}'
  exit 0
fi

if [[ -z "$DATE" ]]; then
  DATE="$(date -u +%Y-%m-%d)"
fi

YESTERDAY=$(date -u -d "${DATE} -1 day" +%Y-%m-%d 2>/dev/null \
  || date -u -j -v-1d -f "%Y-%m-%d" "$DATE" +%Y-%m-%d 2>/dev/null \
  || echo "")
if [[ -z "$YESTERDAY" ]]; then
  echo '{}'
  exit 0
fi

QUERY="modifiedTime >= '${YESTERDAY}T00:00:00Z' and modifiedTime < '${DATE}T00:00:00Z'"
if [[ -n "$FOLDER_ID" ]]; then
  QUERY="${QUERY} and '${FOLDER_ID}' in parents"
fi

# URL-encode the query — Drive API is picky.
ENCODED_Q=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$QUERY" 2>/dev/null || echo "")
if [[ -z "$ENCODED_Q" ]]; then
  echo '{}'
  exit 0
fi

RESP=$(curl -fsSL --max-time 10 \
  -H "Authorization: Bearer ${GOOGLE_OAUTH_ACCESS_TOKEN}" \
  "https://www.googleapis.com/drive/v3/files?q=${ENCODED_Q}&pageSize=${LIMIT}&fields=files(id,name,modifiedTime,webViewLink)" \
  2>/dev/null || echo "")

if [[ -z "$RESP" ]]; then
  echo '{}'
  exit 0
fi

echo "$RESP" | jq -c '
  {drive: (
    (.files // [])
    | map({
        id: (.id // ""),
        title: (.name // ""),
        modified: (.modifiedTime // ""),
        url: (.webViewLink // "")
      })
    | map(select(.id != ""))
  )}
' 2>/dev/null || echo '{}'
