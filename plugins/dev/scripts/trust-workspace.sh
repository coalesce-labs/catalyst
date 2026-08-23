#!/bin/bash
# trust-workspace.sh — Pre-trust a directory in Claude Code's ~/.claude.json
# Usage: trust-workspace.sh [path]
#   path: Directory to trust (defaults to current directory)
#
# Mutations are serialized via lib/claude-json-mutate.sh (CTL-1890), which uses a
# portable mkdir lock so concurrent calls from create-worktree.sh cannot race.

set -euo pipefail

CLAUDE_CONFIG="${CLAUDE_JSON:-${HOME}/.claude.json}"
WORKSPACE_PATH="${1:-$(pwd)}"

if [ ! -f "$CLAUDE_CONFIG" ]; then
  echo "Error: $CLAUDE_CONFIG not found" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "${SCRIPT_DIR}/lib/claude-json-mutate.sh" trust-project "$WORKSPACE_PATH"
