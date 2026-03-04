#!/usr/bin/env bash
# Catalyst Meta Plugin Prerequisites Check
# Only checks tools that meta commands actually use

set -euo pipefail

# Meta plugin only requires jq (used by audit_references.md)
REQUIRED_TOOLS=(
	"jq:brew install jq"
)

missing=()
for entry in "${REQUIRED_TOOLS[@]}"; do
	tool="${entry%%:*}"
	install="${entry#*:}"
	if ! command -v "$tool" &>/dev/null; then
		missing+=("  $tool — Install: $install")
	fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
	echo "❌ Missing required tools:"
	printf '%s\n' "${missing[@]}"
	exit 1
fi

echo "✅ Meta plugin prerequisites OK"
