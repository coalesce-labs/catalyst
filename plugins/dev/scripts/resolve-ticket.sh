#!/usr/bin/env bash
# Resolve ticket ID from multiple sources (priority order)
#
# Resolution order:
#   1. Explicit argument
#   2. Branch name regex (e.g., ryan/ctl-26-feature → CTL-26)
#
# CTL-2306 removed the two sources that read per-worktree workflow context (the
# most recent recorded document's source_ticket, and currentTicket): nothing
# writes that state any more, and a leftover file would name a stale ticket.
#
# Usage: resolve-ticket.sh [explicit-ticket]
# Output: ticket ID (e.g., "CTL-26") or empty string

set -euo pipefail

# --- Source 1: Explicit argument ---
TICKET="${1-}"
if [[ -n $TICKET && $TICKET != "null" ]]; then
	echo "$TICKET"
	exit 0
fi

# --- Source 2: Branch name regex ---
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

# No ticket found
echo ""
