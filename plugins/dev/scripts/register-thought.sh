#!/usr/bin/env bash
# PostToolUse Write hook: auto-registers any thoughts/shared/ write to workflow-context.
# Receives PostToolUse tool call data as JSON on stdin.
# Runs after every Write tool call; exits 0 (no-op) if not a thoughts/shared/ write.
#
# Installed to ~/.catalyst/bin/register-thought by install-cli.sh.
# Referenced from ~/.claude/settings.json PostToolUse > Write hook.

set -euo pipefail

INPUT=$(cat 2>/dev/null || true)
[[ -z "$INPUT" ]] && exit 0

FILE_PATH=$(echo "$INPUT" | python3 -c \
  "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" \
  2>/dev/null || true)

[[ "$FILE_PATH" != *"thoughts/shared/"* ]] && exit 0

# Derive type from subdirectory: thoughts/shared/<type>/...
TYPE=$(echo "$FILE_PATH" | sed 's|.*thoughts/shared/\([^/]*\)/.*|\1|')
[[ -z "$TYPE" || "$TYPE" == "$FILE_PATH" ]] && exit 0

# Extract ticket ID from path (first PROJ-123 pattern found)
TICKET=$(echo "$FILE_PATH" | grep -oE '[A-Z]+-[0-9]+' | head -1 || true)

# Find workflow-context.sh: installed bin dir first, then plugin cache fallback
WC_SCRIPT=""
for candidate in \
  "$HOME/.catalyst/bin/workflow-context" \
  "$HOME/.catalyst/bin/workflow-context.sh" \
  "${CLAUDE_PLUGIN_ROOT:-__missing__}/scripts/workflow-context.sh" \
  "$(find "$HOME/.claude/plugins" -name "workflow-context.sh" -maxdepth 8 2>/dev/null | head -1)" \
; do
  [[ -x "$candidate" ]] && WC_SCRIPT="$candidate" && break
done

[[ -z "$WC_SCRIPT" ]] && exit 0

"$WC_SCRIPT" add "$TYPE" "$FILE_PATH" "${TICKET:-}" 2>/dev/null || true
