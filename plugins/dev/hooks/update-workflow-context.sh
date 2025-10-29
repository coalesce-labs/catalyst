#!/usr/bin/env bash
# Hook script to automatically update workflow context when thoughts files are written
# Called by Claude Code hooks on PostToolUse for Write/Edit tools

set -euo pipefail

# Get the file path from environment variable or parse from stdin
FILE_PATH="${CLAUDE_FILE_PATHS:-}"

# Fallback: parse from JSON if env var is empty (known bug workaround)
if [[ -z "$FILE_PATH" ]]; then
  # Try to parse from tool input JSON
  if [[ -n "${CLAUDE_TOOL_INPUT:-}" ]]; then
    FILE_PATH=$(echo "$CLAUDE_TOOL_INPUT" | jq -r '.file_path // empty' 2>/dev/null || echo "")
  fi
fi

# Exit if no file path
if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Only process thoughts files
if [[ ! "$FILE_PATH" =~ thoughts/shared/(research|plans|handoffs|prs)/ ]]; then
  exit 0
fi

# Determine document type from path
DOC_TYPE=""
if [[ "$FILE_PATH" =~ thoughts/shared/research/ ]]; then
  DOC_TYPE="research"
elif [[ "$FILE_PATH" =~ thoughts/shared/plans/ ]]; then
  DOC_TYPE="plans"
elif [[ "$FILE_PATH" =~ thoughts/shared/handoffs/ ]]; then
  DOC_TYPE="handoffs"
elif [[ "$FILE_PATH" =~ thoughts/shared/prs/ ]]; then
  DOC_TYPE="prs"
else
  exit 0
fi

# Extract ticket from filename (common patterns: PROJ-123, ABC-456, etc.)
TICKET="null"
FILENAME=$(basename "$FILE_PATH")
if [[ "$FILENAME" =~ ([A-Z]+-[0-9]+) ]]; then
  TICKET="${BASH_REMATCH[1]}"
elif [[ "$FILENAME" =~ /([A-Z]+-[0-9]+)/ ]]; then
  # Also check directory name for ticket-based handoffs
  TICKET="${BASH_REMATCH[1]}"
fi

# Find the workflow-context.sh script
SCRIPT_PATH=""
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -f "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" ]]; then
  SCRIPT_PATH="${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh"
elif [[ -f "plugins/dev/scripts/workflow-context.sh" ]]; then
  SCRIPT_PATH="plugins/dev/scripts/workflow-context.sh"
elif [[ -f ".claude/plugins/dev/scripts/workflow-context.sh" ]]; then
  SCRIPT_PATH=".claude/plugins/dev/scripts/workflow-context.sh"
else
  # Try to find it relative to hook location
  HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "${HOOK_DIR}/../scripts/workflow-context.sh" ]]; then
    SCRIPT_PATH="${HOOK_DIR}/../scripts/workflow-context.sh"
  fi
fi

# Update workflow context if script found
if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" ]]; then
  "$SCRIPT_PATH" add "$DOC_TYPE" "$FILE_PATH" "$TICKET" 2>/dev/null || true
fi

exit 0
