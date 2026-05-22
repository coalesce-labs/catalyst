#!/usr/bin/env bash
# resolve-linear-ids — Resolve and cache Linear team UUID and workflow state
# UUIDs. Uses a single GraphQL query to fetch all states for the configured
# team, then writes `teamId` to `.catalyst/config.json` and caches `stateIds`
# per team in the machine-level registry `~/.config/catalyst/linear-state-ids.json`
# so downstream tools (linear-transition.sh) can pass UUIDs directly to
# linearis, skipping per-call name resolution. CTL-207, CTL-577.
#
# Usage:
#   resolve-linear-ids.sh [--config <path>] [--dry-run] [--json] [--force]
#
# Exit codes:
#   0  success (resolved and written, or dry-run)
#   1  usage error or missing prerequisites
#   2  API call failed

set -uo pipefail

CONFIG=""
DRY_RUN=0
JSON_OUT=0
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)   CONFIG="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    --json)     JSON_OUT=1; shift ;;
    --force)    FORCE=1; shift ;;
    -h|--help)  sed -n '2,13p' "$0" >&2; exit 0 ;;
    *)          echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

resolve_config() {
  if [ -n "$CONFIG" ]; then
    if [ -f "$CONFIG" ]; then
      echo "$CONFIG"; return 0
    else
      echo ""; return 0
    fi
  fi
  local dir
  dir="$(pwd)"
  while [ "$dir" != "/" ]; do
    if [ -f "${dir}/.catalyst/config.json" ]; then
      echo "${dir}/.catalyst/config.json"; return 0
    fi
    dir="$(dirname "$dir")"
  done
  echo ""
}

CONFIG_PATH="$(resolve_config)"
if [ -z "$CONFIG_PATH" ] || [ ! -f "$CONFIG_PATH" ]; then
  echo "ERROR: .catalyst/config.json not found" >&2
  exit 1
fi

# CTL-577: stateIds is cached in a machine-level registry, keyed by teamKey,
# so the UUID table is never committed to (and never goes stale through) git.
REGISTRY_PATH="${HOME}/.config/catalyst/linear-state-ids.json"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq required" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl required" >&2
  exit 1
fi

TEAM_KEY=$(jq -r '.catalyst.linear.teamKey // empty' "$CONFIG_PATH" 2>/dev/null)
if [ -z "$TEAM_KEY" ]; then
  echo "ERROR: catalyst.linear.teamKey not set in $CONFIG_PATH" >&2
  exit 1
fi

if [ "$FORCE" -eq 0 ]; then
  EXISTING_IDS=""
  if [ -f "$REGISTRY_PATH" ]; then
    EXISTING_IDS=$(jq -r --arg t "$TEAM_KEY" '.[$t].stateIds // empty' "$REGISTRY_PATH" 2>/dev/null)
  fi
  if [ -n "$EXISTING_IDS" ] && [ "$EXISTING_IDS" != "null" ]; then
    COUNT=$(jq --arg t "$TEAM_KEY" '.[$t].stateIds | length' "$REGISTRY_PATH" 2>/dev/null)
    if [ "$JSON_OUT" -eq 1 ]; then
      jq -nc --arg count "$COUNT" '{action:"skipped",reason:"stateIds already cached","stateCount":($count|tonumber)}'
    else
      echo "stateIds already cached ($COUNT states). Use --force to re-resolve."
    fi
    exit 0
  fi
fi

PROJECT_KEY=$(jq -r '.catalyst.projectKey // empty' "$CONFIG_PATH" 2>/dev/null)
if [ -z "$PROJECT_KEY" ]; then
  echo "ERROR: catalyst.projectKey not set in $CONFIG_PATH — needed to locate secrets" >&2
  exit 1
fi

SECRETS_PATH="${HOME}/.config/catalyst/config-${PROJECT_KEY}.json"
if [ ! -f "$SECRETS_PATH" ]; then
  echo "ERROR: secrets config not found at $SECRETS_PATH" >&2
  exit 1
fi

API_TOKEN=$(jq -r '.linear.apiToken // empty' "$SECRETS_PATH" 2>/dev/null)
if [ -z "$API_TOKEN" ]; then
  echo "ERROR: linear.apiToken not found in $SECRETS_PATH" >&2
  exit 1
fi

QUERY='query($teamKey: String!) { teams(filter: { key: { eq: $teamKey } }) { nodes { id states { nodes { id name type } } } } }'
PAYLOAD=$(jq -nc --arg q "$QUERY" --arg k "$TEAM_KEY" '{query: $q, variables: {teamKey: $k}}')

RESPONSE=$(curl -s -f -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $API_TOKEN" \
  -d "$PAYLOAD" 2>&1) || {
  echo "ERROR: Linear API call failed" >&2
  [ -n "$RESPONSE" ] && echo "$RESPONSE" >&2
  exit 2
}

TEAM_NODE=$(echo "$RESPONSE" | jq '.data.teams.nodes[0] // empty' 2>/dev/null)
if [ -z "$TEAM_NODE" ] || [ "$TEAM_NODE" = "null" ]; then
  ERRORS=$(echo "$RESPONSE" | jq -r '.errors[0].message // empty' 2>/dev/null)
  if [ -n "$ERRORS" ]; then
    echo "ERROR: Linear API error: $ERRORS" >&2
  else
    echo "ERROR: team '$TEAM_KEY' not found in Linear" >&2
  fi
  exit 2
fi

TEAM_ID=$(echo "$TEAM_NODE" | jq -r '.id')
STATE_IDS=$(echo "$TEAM_NODE" | jq '.states.nodes | map({(.name): .id}) | add')
STATE_COUNT=$(echo "$TEAM_NODE" | jq '.states.nodes | length')

if [ "$DRY_RUN" -eq 1 ]; then
  if [ "$JSON_OUT" -eq 1 ]; then
    jq -nc --arg tid "$TEAM_ID" --argjson sids "$STATE_IDS" --argjson count "$STATE_COUNT" \
      '{action:"dry-run",teamId:$tid,stateIds:$sids,stateCount:$count}'
  else
    echo "Would write teamId to $CONFIG_PATH:"
    echo "  teamId: $TEAM_ID"
    echo "Would write stateIds to $REGISTRY_PATH (team $TEAM_KEY, $STATE_COUNT states):"
    echo "$STATE_IDS" | jq -r 'to_entries[] | "    \(.key): \(.value)"'
  fi
  exit 0
fi

# teamId stays in committed config (stable; out of CTL-577 scope).
jq --arg tid "$TEAM_ID" '.catalyst.linear.teamId = $tid' \
  "$CONFIG_PATH" > "${CONFIG_PATH}.tmp" && mv "${CONFIG_PATH}.tmp" "$CONFIG_PATH"

# stateIds → machine-level per-team registry (CTL-577). Atomic tmp+mv; the
# `.[$t] = …` merge replaces only this team's entry, preserving sibling teams.
RESOLVED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "$(dirname "$REGISTRY_PATH")"
# Start from {} when the registry is missing or unparseable. It is a derived
# cache — discarding a corrupt file is safe; it repopulates on this resolve.
if [ ! -f "$REGISTRY_PATH" ] || ! jq -e . "$REGISTRY_PATH" >/dev/null 2>&1; then
  echo '{}' > "$REGISTRY_PATH"
fi
if jq --arg t "$TEAM_KEY" --argjson sids "$STATE_IDS" --arg at "$RESOLVED_AT" \
    '.[$t] = {resolvedAt: $at, stateIds: $sids}' \
    "$REGISTRY_PATH" > "${REGISTRY_PATH}.tmp" && mv "${REGISTRY_PATH}.tmp" "$REGISTRY_PATH"; then
  :
else
  rm -f "${REGISTRY_PATH}.tmp"
  echo "ERROR: failed to write stateIds registry at $REGISTRY_PATH" >&2
  exit 2
fi

if [ "$JSON_OUT" -eq 1 ]; then
  jq -nc --arg tid "$TEAM_ID" --argjson sids "$STATE_IDS" --argjson count "$STATE_COUNT" \
    --arg reg "$REGISTRY_PATH" \
    '{action:"resolved",teamId:$tid,stateIds:$sids,stateCount:$count,registry:$reg}'
else
  echo "Resolved and cached $STATE_COUNT workflow states for team $TEAM_KEY"
  echo "  teamId:   $TEAM_ID  ($CONFIG_PATH)"
  echo "  stateIds: $REGISTRY_PATH"
fi
