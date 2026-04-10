#!/usr/bin/env bash
# Resolve ticket ID from multiple sources (priority order)
#
# Resolution order:
#   1. Explicit argument
#   2. source_ticket frontmatter in most recent workflow document
#   3. Branch name regex (e.g., ryan/ctl-26-feature → CTL-26)
#   4. currentTicket from workflow-context.json
#
# Usage: resolve-ticket.sh [explicit-ticket]
# Output: ticket ID (e.g., "CTL-26") or empty string

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# --- Source 1: Explicit argument ---
TICKET="${1-}"
if [[ -n $TICKET && $TICKET != "null" ]]; then
	echo "$TICKET"
	exit 0
fi

# --- Source 2: source_ticket from most recent document frontmatter ---
WORKFLOW_SCRIPT="${SCRIPT_DIR}/workflow-context.sh"
if [[ -f $WORKFLOW_SCRIPT ]]; then
	RECENT_DOC=$("$WORKFLOW_SCRIPT" most-recent 2>/dev/null || echo "")
	RECENT_PATH="${PROJECT_ROOT}/${RECENT_DOC}"
	if [[ -n $RECENT_DOC && -f $RECENT_PATH ]]; then
		TICKET=$(awk '/^---$/{if(++c==2)exit}c==1 && /^source_ticket:/{gsub(/^source_ticket:[[:space:]]*/, ""); print}' "$RECENT_PATH" 2>/dev/null || echo "")
		if [[ -n $TICKET && $TICKET != "null" ]]; then
			echo "$TICKET"
			exit 0
		fi
	fi
fi

# --- Source 3: Branch name regex ---
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [[ -n $BRANCH ]]; then
	# Try the branch name as-is (handles feature/PROJ-123-description)
	if [[ $BRANCH =~ ([A-Z]+-[0-9]+) ]]; then
		echo "${BASH_REMATCH[1]}"
		exit 0
	fi
	# Try uppercase (handles ryan/ctl-26-description → CTL-26)
	UPPER_BRANCH=$(echo "$BRANCH" | tr '[:lower:]' '[:upper:]')
	if [[ $UPPER_BRANCH =~ ([A-Z]+-[0-9]+) ]]; then
		echo "${BASH_REMATCH[1]}"
		exit 0
	fi
fi

# --- Source 4: currentTicket from workflow-context.json ---
for ctx_file in "${PROJECT_ROOT}/.catalyst/.workflow-context.json" "${PROJECT_ROOT}/.claude/.workflow-context.json"; do
	if [[ -f $ctx_file ]]; then
		TICKET=$(jq -r '.currentTicket // empty' "$ctx_file" 2>/dev/null || echo "")
		if [[ -n $TICKET && $TICKET != "null" ]]; then
			echo "$TICKET"
			exit 0
		fi
		break
	fi
done

# No ticket found
echo ""
