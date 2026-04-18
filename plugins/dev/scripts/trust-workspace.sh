#!/bin/bash
# trust-workspace.sh — Pre-trust a directory in Claude Code's ~/.claude.json
# Usage: trust-workspace.sh [path]
#   path: Directory to trust (defaults to current directory)

set -euo pipefail

CLAUDE_CONFIG="$HOME/.claude.json"
WORKSPACE_PATH="${1:-$(pwd)}"

# Resolve to absolute path
WORKSPACE_PATH="$(cd "$WORKSPACE_PATH" 2>/dev/null && pwd)" || {
  echo "Error: Directory '$1' does not exist" >&2
  exit 1
}

if [ ! -f "$CLAUDE_CONFIG" ]; then
  echo "Error: $CLAUDE_CONFIG not found" >&2
  exit 1
fi

LOCKFILE="$CLAUDE_CONFIG.lock"
exec 200>"$LOCKFILE"
flock -w 5 200 2>/dev/null || {
  echo "Warning: Could not acquire lock, proceeding anyway" >&2
}

TMPFILE="$(mktemp "$CLAUDE_CONFIG.XXXXXX")"
trap 'rm -f "$TMPFILE" "$LOCKFILE"' EXIT

if jq -e --arg path "$WORKSPACE_PATH" '.projects[$path]' "$CLAUDE_CONFIG" > /dev/null 2>&1; then
  # Project entry exists — just flip the trust flag
  jq --arg path "$WORKSPACE_PATH" \
    '.projects[$path].hasTrustDialogAccepted = true' \
    "$CLAUDE_CONFIG" > "$TMPFILE"
else
  # Project entry doesn't exist — create with sensible defaults
  jq --arg path "$WORKSPACE_PATH" \
    '.projects[$path] = {
      "allowedTools": [],
      "mcpContextUris": [],
      "mcpServers": {},
      "enabledMcpjsonServers": [],
      "disabledMcpjsonServers": [],
      "hasTrustDialogAccepted": true,
      "projectOnboardingSeenCount": 0,
      "hasClaudeMdExternalIncludesApproved": false,
      "hasClaudeMdExternalIncludesWarningShown": false,
      "hasCompletedProjectOnboarding": false
    }' \
    "$CLAUDE_CONFIG" > "$TMPFILE"
fi

mv "$TMPFILE" "$CLAUDE_CONFIG"
echo "Trusted: $WORKSPACE_PATH"
