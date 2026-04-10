#!/usr/bin/env bash
# Resolve ticket ID from multiple sources
# Usage: resolve-ticket.sh [explicit-ticket]
# Returns: ticket ID or empty string
#
# Resolution order:
#   1. Explicit argument (if provided and not "null")
#   2. Branch name regex (matches TEAMKEY-123 pattern)
#   3. currentTicket from .catalyst/workflow-context.json

set -euo pipefail

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
EXPLICIT="${1:-}"

# 1. Explicit argument
if [[ -n "$EXPLICIT" && "$EXPLICIT" != "null" ]]; then
  echo "$EXPLICIT"
  exit 0
fi

# 2. Branch name regex
TEAM_KEY=$(jq -r '.catalyst.linear.teamKey // "PROJ"' "${PROJECT_ROOT}/.catalyst/config.json" 2>/dev/null || echo "PROJ")
BRANCH=$(git branch --show-current 2>/dev/null || echo "")
if [[ "$BRANCH" =~ ($TEAM_KEY-[0-9]+) ]]; then
  echo "${BASH_REMATCH[1]}"
  exit 0
fi

# 3. currentTicket from workflow-context.json
TICKET=$(jq -r '.currentTicket // empty' "${PROJECT_ROOT}/.catalyst/workflow-context.json" 2>/dev/null || echo "")
if [[ -n "$TICKET" ]]; then
  echo "$TICKET"
  exit 0
fi

# No ticket found
echo ""
