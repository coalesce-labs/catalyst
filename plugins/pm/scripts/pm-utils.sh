#!/usr/bin/env bash
# Shared utility functions for PM commands

# Get configuration value
get_config() {
    local key="$1"
    local default="${2:-}"
    jq -r ".catalyst.$key // \"$default\"" .claude/config.json
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
    if [[ "$branch" =~ ([A-Z]+-[0-9]+) ]]; then
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

    if [[ "$total" -eq 0 ]]; then
        echo "0"
        return
    fi

    echo $(( (completed * 100) / total ))
}

# Export functions
export -f get_config
export -f get_team_key
export -f get_ticket_from_branch
export -f format_timestamp
export -f calc_progress
