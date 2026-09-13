#!/usr/bin/env bash
# lib/ticket-from-text.sh — CTL-2306. One rule for "which ticket does this text name".
#
# catalyst_ticket_from_text <text> → prints the ticket id, or nothing.
#   An uppercase match (`CTL-2306`) wins; otherwise the FIRST case-insensitive match,
#   uppercased (`ryan/ctl-26-feature` → CTL-26). First, not last: `ryan/ctl-26-phase-2`
#   names CTL-26. Same order as resolve-ticket.sh's branch source.
#
# Sourced, never executed. Bash-3.2 safe.

catalyst_ticket_from_text() {
	local text="${1-}" upper
	if [[ $text =~ ([A-Z]+-[0-9]+) ]]; then
		printf '%s\n' "${BASH_REMATCH[1]}"
		return 0
	fi
	upper=$(printf '%s' "$text" | tr '[:lower:]' '[:upper:]')
	if [[ $upper =~ ([A-Z]+-[0-9]+) ]]; then
		printf '%s\n' "${BASH_REMATCH[1]}"
	fi
	return 0
}
