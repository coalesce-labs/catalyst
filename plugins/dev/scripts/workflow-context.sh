#!/usr/bin/env bash
# Workflow context management utilities

set -euo pipefail

# Resolve project root from git, then fall back to CWD
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
CONTEXT_DIR="${PROJECT_ROOT}/.claude"
CONTEXT_FILE="${CONTEXT_DIR}/.workflow-context.json"

# Initialize context file if it doesn't exist
init_context() {
	if [[ ! -d "$CONTEXT_DIR" ]]; then
		mkdir -p "$CONTEXT_DIR"
	fi
	if [[ ! -f "$CONTEXT_FILE" ]]; then
		cat >"$CONTEXT_FILE" <<'EOF'
{
  "lastUpdated": "",
  "currentTicket": null,
  "mostRecentDocument": null,
  "workflow": {
    "research": [],
    "plans": [],
    "handoffs": [],
    "prs": []
  }
}
EOF
	fi
}

# Add document to context
# Usage: add_document <type> <path> <ticket>
add_document() {
	local doc_type="$1"
	local doc_path="$2"
	local ticket="${3:-null}"

	init_context

	local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

	# Add to appropriate array
	jq --arg type "$doc_type" \
		--arg path "$doc_path" \
		--arg ticket "$ticket" \
		--arg ts "$timestamp" \
		'.workflow[$type] = [{path: $path, created: $ts, ticket: $ticket}] + .workflow[$type] |
      .mostRecentDocument = {type: $type, path: $path, created: $ts, ticket: $ticket} |
      .lastUpdated = $ts |
      .currentTicket = (if $ticket != "null" then $ticket else .currentTicket end)' \
		"$CONTEXT_FILE" >"${CONTEXT_FILE}.tmp"

	mv "${CONTEXT_FILE}.tmp" "$CONTEXT_FILE"
}

# Get most recent document of type (with filesystem fallback)
# Usage: get_recent <type>
get_recent() {
	local doc_type="$1"
	init_context
	local result
	result=$(jq -r --arg type "$doc_type" '.workflow[$type][0].path // empty' "$CONTEXT_FILE")
	# Filesystem fallback if workflow context has no entries for this type
	if [[ -z "$result" && -d "${PROJECT_ROOT}/thoughts/shared/${doc_type}" ]]; then
		result=$(find "${PROJECT_ROOT}/thoughts/shared/${doc_type}" -name '*.md' -type f 2>/dev/null | xargs ls -t 2>/dev/null | head -1)
		if [[ -n "$result" ]]; then
			result="${result#"${PROJECT_ROOT}/"}"
		fi
	fi
	echo "$result"
}

# Get most recent document (any type)
get_most_recent() {
	init_context
	jq -r '.mostRecentDocument.path // empty' "$CONTEXT_FILE"
}

# Get documents for ticket
# Usage: get_by_ticket <ticket>
get_by_ticket() {
	local ticket="$1"
	init_context
	jq -r --arg ticket "$ticket" '
    .workflow | to_entries | map(
      .value | map(select(.ticket == $ticket))
    ) | flatten | map(.path) | .[]
  ' "$CONTEXT_FILE"
}

# Main dispatcher
case "${1-}" in
init)
	init_context
	;;
add)
	add_document "$2" "$3" "${4:-null}"
	;;
recent)
	get_recent "$2"
	;;
most-recent)
	get_most_recent
	;;
ticket)
	get_by_ticket "$2"
	;;
*)
	echo "Usage: $0 {init|add|recent|most-recent|ticket}"
	exit 1
	;;
esac
