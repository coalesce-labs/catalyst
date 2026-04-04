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

# Resolve project root for path normalization
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Normalize FILE_PATH to a relative path from project root.
# Handles: absolute paths, symlink-resolved paths, already-relative paths.
normalize_path() {
  local raw_path="$1"

  # If it already contains the relative pattern, extract it
  if [[ "$raw_path" =~ (thoughts/shared/(research|plans|handoffs|prs)/.*) ]]; then
    echo "${BASH_REMATCH[1]}"
    return
  fi

  # For absolute paths, try to make them relative to project root
  if [[ "$raw_path" == /* ]]; then
    # Check if path is under project root directly
    if [[ "$raw_path" == "${PROJECT_ROOT}/"* ]]; then
      echo "${raw_path#"${PROJECT_ROOT}/"}"
      return
    fi

    # Resolve the thoughts/shared symlink target and check if path is under it
    if [[ -L "${PROJECT_ROOT}/thoughts/shared" ]]; then
      local resolved_target
      resolved_target="$(cd -P "${PROJECT_ROOT}/thoughts/shared" 2>/dev/null && pwd)"
      if [[ -n "$resolved_target" && "$raw_path" == "${resolved_target}/"* ]]; then
        echo "thoughts/shared/${raw_path#"${resolved_target}/"}"
        return
      fi
    fi
  fi

  # Return as-is if we can't normalize
  echo "$raw_path"
}

FILE_PATH="$(normalize_path "$FILE_PATH")"

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
elif [[ "$FILE_PATH" =~ /([A-Z]+-[0-9]+)/ ]]; then
  # Also check directory name for ticket-based handoffs
  TICKET="${BASH_REMATCH[1]}"
fi

# Find the workflow-context.sh script
SCRIPT_PATH=""
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -f "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" ]]; then
  SCRIPT_PATH="${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh"
elif [[ -f "${PROJECT_ROOT}/plugins/dev/scripts/workflow-context.sh" ]]; then
  SCRIPT_PATH="${PROJECT_ROOT}/plugins/dev/scripts/workflow-context.sh"
elif [[ -f "${PROJECT_ROOT}/.claude/plugins/dev/scripts/workflow-context.sh" ]]; then
  SCRIPT_PATH="${PROJECT_ROOT}/.claude/plugins/dev/scripts/workflow-context.sh"
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
