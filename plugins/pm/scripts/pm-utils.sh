#!/usr/bin/env bash
# Shared utility functions for PM commands

# Resolve config file path with backward compatibility
_resolve_config_file() {
	if [[ -f ".catalyst/config.json" ]]; then
		echo ".catalyst/config.json"
	else
		echo ".claude/config.json"
	fi
}

# Get configuration value
get_config() {
	local key="$1"
	local default="${2-}"
	local config_file
	config_file=$(_resolve_config_file)
	jq -r ".catalyst.$key // \"$default\"" "$config_file"
}

# Get Linear team key
get_team_key() {
	get_config "linear.teamKey" "PROJ"
}

# Parse ticket ID from branch name
get_ticket_from_branch() {
	local branch
	branch=$(git branch --show-current)

	# Extract TEAM-123 pattern from branch name
	if [[ $branch =~ ([A-Z]+-[0-9]+) ]]; then
		echo "${BASH_REMATCH[1]}"
		return 0
	fi

	return 1
}

# Format timestamp for display
format_timestamp() {
	local ts="$1"
	date -j -f "%Y-%m-%dT%H:%M:%S" "${ts%%.*}" "+%Y-%m-%d %H:%M" 2>/dev/null || echo "$ts"
}

# Calculate progress percentage
calc_progress() {
	local completed="$1"
	local total="$2"

	if [[ $total -eq 0 ]]; then
		echo "0"
		return
	fi

	echo $(((completed * 100) / total))
}

# Export functions
export -f _resolve_config_file
export -f get_config
export -f get_team_key
export -f get_ticket_from_branch
export -f format_timestamp
export -f calc_progress
