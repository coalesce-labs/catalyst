#!/bin/bash
# frontmatter-utils.sh - Utilities for parsing command frontmatter

# Extract a boolean field from YAML frontmatter
# Usage: get_frontmatter_bool "file.md" "workspace_only"
# Returns: "true" if field exists and is true, "false" otherwise
get_frontmatter_bool() {
	local file="$1"
	local field="$2"

	if [[ ! -f $file ]]; then
		echo "false"
		return
	fi

	# Extract frontmatter (between first --- delimiters)
	# Then grep for the field, allowing for various YAML boolean representations
	local value=$(awk '/^---$/{if(++count==2)exit}count==1' "$file" |
		grep "^${field}:" |
		awk '{print $2}' |
		tr '[:upper:]' '[:lower:]')

	if [[ $value == "true" || $value == "yes" || $value == "1" ]]; then
		echo "true"
	else
		echo "false"
	fi
}

# Check if a command should be skipped during project installation
# Returns 0 (success) if should skip, 1 if should include
should_skip_on_install() {
	local file="$1"
	local is_workspace_only=$(get_frontmatter_bool "$file" "workspace_only")

	[[ $is_workspace_only == "true" ]]
}

# Check if a command should be skipped during project updates
# Returns 0 (success) if should skip, 1 if should include
should_skip_on_update() {
	local file="$1"
	local is_workspace_only=$(get_frontmatter_bool "$file" "workspace_only")
	local is_install_once=$(get_frontmatter_bool "$file" "install_once")

	[[ $is_workspace_only == "true" || $is_install_once == "true" ]]
}
