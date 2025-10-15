#!/bin/bash
# validate-frontmatter.sh - Validate frontmatter in markdown files
# Used by Trunk linter for per-file validation

set -euo pipefail

FILE="${1-}"

if [[ -z $FILE ]]; then
	echo "Usage: $0 <markdown-file>"
	exit 1
fi

if [[ ! -f $FILE ]]; then
	echo "File not found: $FILE"
	exit 1
fi

# Only validate files in commands/ and agents/ directories
if [[ ! $FILE =~ (commands|agents)/.*\.md$ ]]; then
	# Not a command/agent file, skip validation
	exit 0
fi

# Skip README.md files (they're documentation, not commands/agents)
if [[ $(basename "$FILE") == "README.md" ]]; then
	exit 0
fi

# Check if file has frontmatter
if ! head -1 "$FILE" | grep -q "^---$"; then
	echo "❌ Missing frontmatter: $FILE"
	exit 1
fi

# Extract frontmatter (between first two --- delimiters)
FRONTMATTER=$(awk '/^---$/{if(++count==2)exit}count==1' "$FILE")

# Determine if this is a command or agent
if [[ $FILE =~ commands/.*\.md$ ]]; then
	# Command file - check for required fields
	REQUIRED_FIELDS=("description" "category")

	for field in "${REQUIRED_FIELDS[@]}"; do
		if ! echo "$FRONTMATTER" | grep -q "^${field}:"; then
			echo "❌ Missing required field '${field}' in $FILE"
			exit 1
		fi
	done

elif [[ $FILE =~ agents/.*\.md$ ]]; then
	# Agent file - check for required fields
	REQUIRED_FIELDS=("name" "description" "tools")

	for field in "${REQUIRED_FIELDS[@]}"; do
		if ! echo "$FRONTMATTER" | grep -q "^${field}:"; then
			echo "❌ Missing required field '${field}' in $FILE"
			exit 1
		fi
	done
fi

# All validations passed
exit 0
