#!/usr/bin/env bash
# action-ticket.sh — File a Linear ticket via linearis issues create.
#
# Usage:
#   action-ticket.sh --title T --team K [--description D] [--priority N] [--project P]
#
# Output (stdout, JSON one-liner):
#   {"identifier":"CTL-1000","url":"https://linear.app/...","status":"filed"}
# or on soft-skip:
#   {"status":"skipped","reason":"..."}
#
# Soft-skip when `linearis` is not on PATH.
# See plugins/dev/skills/linearis/SKILL.md for the canonical create syntax.

set -uo pipefail

TITLE=""
TEAM=""
DESCRIPTION=""
PRIORITY=""
PROJECT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)        TITLE="$2"; shift 2 ;;
    --team)         TEAM="$2"; shift 2 ;;
    --description)  DESCRIPTION="$2"; shift 2 ;;
    --priority)     PRIORITY="$2"; shift 2 ;;
    --project)      PROJECT="$2"; shift 2 ;;
    -h|--help)      sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "action-ticket.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$TITLE" || -z "$TEAM" ]]; then
  echo "action-ticket.sh: --title and --team are required" >&2
  exit 2
fi

if ! command -v linearis >/dev/null 2>&1; then
  jq -nc --arg reason "linearis not on PATH" \
    '{status: "skipped", reason: $reason}'
  exit 0
fi

# linearis upstream bug czottmann/linearis#56: `issues create` silently routes
# to the workspace default team when --team is a key/name instead of a UUID.
# Resolve key → UUID up front when it looks like a key (not a UUID).
RESOLVED_TEAM="$TEAM"
if ! [[ "$TEAM" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  TEAMS_JSON=$(linearis teams list 2>/dev/null || true)
  CANDIDATE=$(echo "$TEAMS_JSON" \
    | jq -r --arg k "$TEAM" \
        '.[]? | select(.key == $k or .name == $k) | .id' 2>/dev/null \
    | head -n1)
  if [[ -n "$CANDIDATE" ]]; then
    RESOLVED_TEAM="$CANDIDATE"
  fi
fi

ARGS=( issues create "$TITLE" --team "$RESOLVED_TEAM" )
[[ -n "$DESCRIPTION" ]] && ARGS+=( --description "$DESCRIPTION" )
[[ -n "$PRIORITY"    ]] && ARGS+=( --priority "$PRIORITY" )
[[ -n "$PROJECT"     ]] && ARGS+=( --project "$PROJECT" )

STDERR_FILE=$(mktemp -t action-ticket-stderr.XXXXXX)
CREATE_JSON=$(linearis "${ARGS[@]}" 2>"$STDERR_FILE")
EXIT_CODE=$?
STDERR_TAIL=$(tail -c 500 "$STDERR_FILE" 2>/dev/null || echo "")
rm -f "$STDERR_FILE"

IDENT=$(echo "$CREATE_JSON" | jq -r '.identifier // empty' 2>/dev/null || echo "")
URL=$(echo "$CREATE_JSON" | jq -r '.url // empty' 2>/dev/null || echo "")

if [[ -z "$IDENT" ]]; then
  REASON="linearis issues create returned no identifier (exit=$EXIT_CODE)"
  [[ -n "$STDERR_TAIL" ]] && REASON="${REASON}: ${STDERR_TAIL}"
  jq -nc --arg reason "$REASON" '{status: "failed", reason: $reason}'
  exit 1
fi

jq -nc --arg id "$IDENT" --arg url "$URL" \
  '{identifier: $id, url: $url, status: "filed"}'
