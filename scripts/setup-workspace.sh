#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CONFIG_FILE=""
for cfg in "${REPO_ROOT}/.catalyst/config.json" "${REPO_ROOT}/.claude/config.json"; do
	if [[ -f "$cfg" ]]; then
		CONFIG_FILE="$cfg"
		break
	fi
done

THOUGHTS_PROFILE=""
THOUGHTS_DIRECTORY=""

if [[ -n "$CONFIG_FILE" ]]; then
	THOUGHTS_PROFILE="$(jq -r '.catalyst.thoughts.profile // empty' "$CONFIG_FILE" 2>/dev/null)"
	THOUGHTS_DIRECTORY="$(jq -r '.catalyst.thoughts.directory // empty' "$CONFIG_FILE" 2>/dev/null)"

	if [[ -z "$THOUGHTS_DIRECTORY" ]]; then
		THOUGHTS_DIRECTORY="$(jq -r '.catalyst.projectKey // empty' "$CONFIG_FILE" 2>/dev/null)"
	fi
fi

if [[ -z "$THOUGHTS_DIRECTORY" ]]; then
	THOUGHTS_DIRECTORY="$(basename "$REPO_ROOT")"
fi

cd "$REPO_ROOT"

if command -v humanlayer >/dev/null 2>&1; then
	STATUS_OUTPUT="$(humanlayer thoughts status 2>/dev/null || true)"
	if grep -q "Status: ✓ Initialized" <<<"$STATUS_OUTPUT"; then
		echo "Thoughts already initialized for this workspace"
	else
		HL_CMD=(humanlayer thoughts init --directory "$THOUGHTS_DIRECTORY")
		if [[ -n "$THOUGHTS_PROFILE" ]]; then
			HL_CMD+=(--profile "$THOUGHTS_PROFILE")
		fi

		echo "Running: ${HL_CMD[*]}"
		"${HL_CMD[@]}"
	fi

	echo "Running: humanlayer thoughts sync"
	humanlayer thoughts sync
else
	echo "Warning: humanlayer CLI not found, skipping thoughts setup" >&2
fi

if command -v direnv >/dev/null 2>&1 && [[ -f "${REPO_ROOT}/.envrc" ]]; then
	echo "Running: direnv allow ${REPO_ROOT}/.envrc"
	direnv allow "${REPO_ROOT}/.envrc" || true
fi

if [[ -x "$HOME/.claude/scripts/trust-workspace.sh" ]]; then
	echo "Running: ~/.claude/scripts/trust-workspace.sh \"${REPO_ROOT}\""
	"$HOME/.claude/scripts/trust-workspace.sh" "${REPO_ROOT}"
fi
