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

# CAT-140 (Codex #3214 P1): the `states` connection MUST be paginated. Linear's
# GraphQL connections default to 50 nodes per page, so a team with more workflow
# states than one page silently yielded a TRUNCATED-but-nonempty set. That set
# was then written to the cache and treated as authoritative by
# linear-transition.sh's `state-absent` gate — which would latch an entire team's
# dispatch on a state that actually exists, just on a later page. Walk
# `pageInfo.hasNextPage` to exhaustion and record `statesComplete` so consumers
# can PROVE the set is complete before ever latching absence; anything short of a
# fully-drained connection leaves the set inconclusive (fail-open).
QUERY='query($teamKey: String!, $after: String) { teams(filter: { key: { eq: $teamKey } }) { nodes { id states(first: 250, after: $after) { nodes { id name type } pageInfo { hasNextPage endCursor } } } } }'

TEAM_ID=""
STATE_NODES='[]'
STATES_COMPLETE=false
STATE_AFTER=""
STATE_PAGE=0
# 250 states/page × 20 pages = 5000 — orders of magnitude above any real team,
# so exhausting this bound means something is wrong; stop and stay inconclusive
# rather than looping forever against the API.
STATE_MAX_PAGES=20

while [ "$STATE_PAGE" -lt "$STATE_MAX_PAGES" ]; do
  STATE_PAGE=$((STATE_PAGE + 1))
  if [ -n "$STATE_AFTER" ]; then
    PAYLOAD=$(jq -nc --arg q "$QUERY" --arg k "$TEAM_KEY" --arg a "$STATE_AFTER" \
      '{query: $q, variables: {teamKey: $k, after: $a}}')
  else
    PAYLOAD=$(jq -nc --arg q "$QUERY" --arg k "$TEAM_KEY" \
      '{query: $q, variables: {teamKey: $k, after: null}}')
  fi

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
  PAGE_NODES=$(echo "$TEAM_NODE" | jq -c '.states.nodes // []' 2>/dev/null)
  [ -n "$PAGE_NODES" ] || PAGE_NODES='[]'
  STATE_NODES=$(jq -nc --argjson acc "$STATE_NODES" --argjson page "$PAGE_NODES" '$acc + $page')

  HAS_NEXT=$(echo "$TEAM_NODE" | jq -r '.states.pageInfo.hasNextPage // false' 2>/dev/null)
  if [ "$HAS_NEXT" != "true" ]; then
    # The connection drained: this set is provably the team's complete state set.
    # A server that omits pageInfo entirely also lands here — it returned every
    # node it intended to, which is the same guarantee.
    STATES_COMPLETE=true
    break
  fi
  STATE_AFTER=$(echo "$TEAM_NODE" | jq -r '.states.pageInfo.endCursor // empty' 2>/dev/null)
  # hasNextPage=true with no cursor to advance on: we cannot drain the
  # connection, so the set stays incomplete rather than pretending otherwise.
  [ -n "$STATE_AFTER" ] || break
done

STATE_IDS=$(echo "$STATE_NODES" | jq '(map({(.name): .id}) | add) // {}')
STATE_COUNT=$(echo "$STATE_NODES" | jq 'length')

if [ "$DRY_RUN" -eq 1 ]; then
  if [ "$JSON_OUT" -eq 1 ]; then
    jq -nc --arg tid "$TEAM_ID" --argjson sids "$STATE_IDS" --argjson count "$STATE_COUNT" \
      --argjson complete "$STATES_COMPLETE" \
      '{action:"dry-run",teamId:$tid,stateIds:$sids,stateCount:$count,statesComplete:$complete}'
  else
    echo "Would write teamId to $CONFIG_PATH:"
    echo "  teamId: $TEAM_ID"
    echo "Would write stateIds to $REGISTRY_PATH (team $TEAM_KEY, $STATE_COUNT states, complete=$STATES_COMPLETE):"
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
# CAT-140: `statesComplete` records whether the connection was fully drained.
# linear-transition.sh's absence gate requires it to be true before refusing a
# write, so a truncated page can never latch a team on a state that exists.
if jq --arg t "$TEAM_KEY" --argjson sids "$STATE_IDS" --arg at "$RESOLVED_AT" \
    --argjson complete "$STATES_COMPLETE" \
    '.[$t] = {resolvedAt: $at, statesComplete: $complete, stateIds: $sids}' \
    "$REGISTRY_PATH" > "${REGISTRY_PATH}.tmp" && mv "${REGISTRY_PATH}.tmp" "$REGISTRY_PATH"; then
  :
else
  rm -f "${REGISTRY_PATH}.tmp"
  echo "ERROR: failed to write stateIds registry at $REGISTRY_PATH" >&2
  exit 2
fi

if [ "$JSON_OUT" -eq 1 ]; then
  jq -nc --arg tid "$TEAM_ID" --argjson sids "$STATE_IDS" --argjson count "$STATE_COUNT" \
    --arg reg "$REGISTRY_PATH" --argjson complete "$STATES_COMPLETE" \
    '{action:"resolved",teamId:$tid,stateIds:$sids,stateCount:$count,statesComplete:$complete,registry:$reg}'
else
  echo "Resolved and cached $STATE_COUNT workflow states for team $TEAM_KEY (complete=$STATES_COMPLETE)"
  echo "  teamId:   $TEAM_ID  ($CONFIG_PATH)"
  echo "  stateIds: $REGISTRY_PATH"
fi
