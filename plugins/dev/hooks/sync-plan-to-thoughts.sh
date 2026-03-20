#!/usr/bin/env bash
# Hook: Sync Claude Code plan mode output to Catalyst thoughts system
# Event: PermissionRequest (matcher: tool_name = "ExitPlanMode")
#
# When a user exits plan mode, this hook:
# 1. Reads plan content from stdin JSON (tool_input.plan or tool_input.allowedPrompts)
# 2. Wraps it in Catalyst frontmatter matching create_plan.md schema
# 3. Writes to thoughts/shared/plans/YYYY-MM-DD-{ticket}-{slug}.md
# 4. Updates workflow-context so /implement-plan can auto-discover it
# 5. Fires humanlayer thoughts sync in background
#
# Design: silent failure on all errors, never blocks the approval flow.
# Exit 0 with NO stdout — lets normal user approval dialog continue.

set -euo pipefail

# Read stdin JSON (Claude Code pipes hook input here)
INPUT=$(cat)

# --- Extract plan content ---
# ExitPlanMode delivers content via the plan file, not tool_input directly.
# The plan file path is at ~/.claude/plans/plan.md (Claude Code default).
# However, we also check tool_input for any content passed directly.

# Determine project directory
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || echo "")}"
if [[ -z "$PROJECT_DIR" ]]; then
  exit 0
fi

# Read the plan file from Claude Code's default location
PLAN_FILE="$HOME/.claude/plans/plan.md"
PLAN_CONTENT=""

if [[ -f "$PLAN_FILE" ]]; then
  PLAN_CONTENT=$(cat "$PLAN_FILE")
fi

# Fallback: try tool_input.plan if plan file is empty/missing
if [[ -z "$PLAN_CONTENT" ]]; then
  PLAN_CONTENT=$(echo "$INPUT" | jq -r '.tool_input.plan // empty' 2>/dev/null || echo "")
fi

# Nothing to sync if no plan content
if [[ -z "$PLAN_CONTENT" ]]; then
  exit 0
fi

# --- Extract title from first heading ---
TITLE=$(echo "$PLAN_CONTENT" | grep -m1 '^# ' | sed 's/^# //' || echo "")
if [[ -z "$TITLE" ]]; then
  TITLE="Untitled Plan"
fi

# Generate URL-safe slug from title
SLUG=$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//' | head -c 80)
if [[ -z "$SLUG" ]]; then
  SLUG="plan"
fi

# --- Extract ticket ID ---
TICKET="null"
# Check title first
if [[ "$TITLE" =~ ([A-Z]+-[0-9]+) ]]; then
  TICKET="${BASH_REMATCH[1]}"
fi
# Fallback: scan plan content (first match)
if [[ "$TICKET" == "null" ]]; then
  TICKET_MATCH=$(echo "$PLAN_CONTENT" | grep -oE '[A-Z]+-[0-9]+' | head -1 || echo "")
  if [[ -n "$TICKET_MATCH" ]]; then
    TICKET="$TICKET_MATCH"
  fi
fi

# --- Gather git metadata ---
GIT_COMMIT=$(cd "$PROJECT_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_BRANCH=$(cd "$PROJECT_DIR" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
REPO_NAME=$(cd "$PROJECT_DIR" && basename "$(git rev-parse --show-toplevel 2>/dev/null)" || echo "unknown")

# --- Generate timestamps ---
DATE_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
DATE_SHORT=$(date -u +"%Y-%m-%d")

# --- Build output filename ---
# Re-iteration safe: same date + same heading = same filename
if [[ "$TICKET" != "null" ]]; then
  OUT_FILENAME="${DATE_SHORT}-${TICKET}-${SLUG}.md"
else
  OUT_FILENAME="${DATE_SHORT}-${SLUG}.md"
fi

# --- Find thoughts/shared/plans directory ---
THOUGHTS_PLANS=""
if [[ -d "$PROJECT_DIR/thoughts/shared/plans" ]]; then
  THOUGHTS_PLANS="$PROJECT_DIR/thoughts/shared/plans"
elif [[ -d "$PROJECT_DIR/thoughts/plans" ]]; then
  THOUGHTS_PLANS="$PROJECT_DIR/thoughts/plans"
fi

# Can't write without a destination
if [[ -z "$THOUGHTS_PLANS" ]]; then
  exit 0
fi

OUT_PATH="${THOUGHTS_PLANS}/${OUT_FILENAME}"

# --- Read config for source_research ---
CONFIG_FILE="$PROJECT_DIR/.claude/config.json"
SOURCE_RESEARCH="null"

# Try to find most recent research from workflow-context
SCRIPT_PATH=""
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -f "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" ]]; then
  SCRIPT_PATH="${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh"
elif [[ -f "$PROJECT_DIR/plugins/dev/scripts/workflow-context.sh" ]]; then
  SCRIPT_PATH="$PROJECT_DIR/plugins/dev/scripts/workflow-context.sh"
elif [[ -f "$PROJECT_DIR/.claude/plugins/dev/scripts/workflow-context.sh" ]]; then
  SCRIPT_PATH="$PROJECT_DIR/.claude/plugins/dev/scripts/workflow-context.sh"
else
  HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "${HOOK_DIR}/../scripts/workflow-context.sh" ]]; then
    SCRIPT_PATH="${HOOK_DIR}/../scripts/workflow-context.sh"
  fi
fi

if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" ]]; then
  SOURCE_RESEARCH=$(cd "$PROJECT_DIR" && "$SCRIPT_PATH" recent research 2>/dev/null || echo "null")
  if [[ -z "$SOURCE_RESEARCH" ]]; then
    SOURCE_RESEARCH="null"
  fi
fi

# --- Generate Catalyst frontmatter + write file ---
TMPFILE=$(mktemp)
cat > "$TMPFILE" <<FRONTMATTER
---
date: ${DATE_ISO}
researcher: claude
git_commit: ${GIT_COMMIT}
branch: ${GIT_BRANCH}
repository: ${REPO_NAME}
topic: "${TITLE}"
tags: [plan, implementation, plan-mode]
status: ready_for_implementation
last_updated: ${DATE_SHORT}
last_updated_by: claude
type: implementation_plan
source_ticket: ${TICKET}
source_research: ${SOURCE_RESEARCH}
source: plan-mode
---

FRONTMATTER

# Append plan content
echo "$PLAN_CONTENT" >> "$TMPFILE"

# Atomic write
mv "$TMPFILE" "$OUT_PATH"

# --- Update workflow-context ---
if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" ]]; then
  # Use relative path for workflow-context (matches existing convention)
  REL_PATH="thoughts/shared/plans/${OUT_FILENAME}"
  (cd "$PROJECT_DIR" && "$SCRIPT_PATH" add plans "$REL_PATH" "$TICKET" 2>/dev/null) || true
fi

# --- Background sync ---
if command -v humanlayer &>/dev/null; then
  (humanlayer thoughts sync &>/dev/null &) || true
fi

# Exit 0 with no stdout — lets normal approval flow continue
exit 0
