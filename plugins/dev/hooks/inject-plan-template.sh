#!/usr/bin/env bash
# Hook: Inject plan structure guidance when in Claude Code plan mode
# Event: UserPromptSubmit (no matcher — script filters by permission_mode)
#
# On every user prompt:
# 1. Reads stdin JSON, checks permission_mode
# 2. If NOT "plan" → exits 0 immediately (no-op, <10ms overhead)
# 3. If in plan mode → returns JSON with additionalContext containing
#    Catalyst plan structure guidance (phases, success criteria, etc.)
#
# The guidance is advisory — Claude's plan mode is free-form, but this
# nudges toward the structure that /implement-plan expects.

set -euo pipefail

# Read stdin JSON
INPUT=$(cat)

# Fast-path: check permission_mode, exit immediately if not plan mode
PERMISSION_MODE=$(echo "$INPUT" | jq -r '.permission_mode // empty' 2>/dev/null || echo "")
if [[ "$PERMISSION_MODE" != "plan" ]]; then
  exit 0
fi

# --- In plan mode: build structure guidance ---

# Read ticket prefix from config (best-effort)
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || echo "")}"
TICKET_PREFIX="PROJ"
if [[ -n "$PROJECT_DIR" && -f "$PROJECT_DIR/.catalyst/config.json" ]]; then
  CONFIGURED_PREFIX=$(jq -r '.catalyst.project.ticketPrefix // empty' "$PROJECT_DIR/.catalyst/config.json" 2>/dev/null || echo "")
  if [[ -n "$CONFIGURED_PREFIX" ]]; then
    TICKET_PREFIX="$CONFIGURED_PREFIX"
  fi
fi

# Output JSON with additionalContext
cat <<GUIDANCE
{
  "additionalContext": "## Catalyst Plan Structure Guidance\n\nWhen writing this plan, follow this structure so it integrates with the Catalyst workflow system (/implement-plan, /validate-plan):\n\n### Required Sections\n\n1. **Title**: Use a \`# Heading\` as the first line. Include the ticket ID if available (e.g., \`# ${TICKET_PREFIX}-123 Feature Name\`).\n\n2. **Overview**: Brief description of what we're implementing and why.\n\n3. **Current State Analysis**: What exists now, what's missing, key constraints.\n\n4. **Desired End State**: Specification of the end state and how to verify it.\n\n5. **What We're NOT Doing**: Explicitly list out-of-scope items.\n\n6. **Implementation Phases**: Break work into numbered phases (Phase 1, Phase 2, etc.). Each phase should have:\n   - Overview of what the phase accomplishes\n   - Specific file changes with paths\n   - Success criteria with checkboxes:\n     - **Automated Verification**: \`- [ ] Tests pass\`, \`- [ ] Type check passes\`\n     - **Manual Verification**: \`- [ ] Feature works as expected\`\n\n7. **Testing Strategy**: Unit tests, integration tests, manual testing steps.\n\n### Tips\n- Reference files with \`file_path:line_number\` format\n- Keep phases independently verifiable\n- Include both automated AND manual success criteria\n- This plan will be saved to the thoughts system automatically when you exit plan mode"
}
GUIDANCE

exit 0
