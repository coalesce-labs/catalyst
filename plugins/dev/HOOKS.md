# Claude Code Hooks for Catalyst Dev

Automatic workflow context tracking via Claude Code hooks system.

## Overview

The Catalyst Dev plugin includes Claude Code hooks that automatically track when you write or edit thoughts documents. No manual script calls needed - it just works!

## What Gets Tracked

### Document Types
- **Research**: `thoughts/shared/research/*`
- **Plans**: `thoughts/shared/plans/*`
- **Handoffs**: `thoughts/shared/handoffs/*`
- **PR Descriptions**: `thoughts/shared/prs/*`

### Tracked Information
- Document path
- Document type
- Ticket number (extracted from filename/path)
- Created timestamp
- Most recent document reference

## Activation

### During Plugin Installation

When you install the `catalyst-dev` plugin, Claude Code automatically:
1. Discovers the `hooks.toml` in the plugin
2. Registers all 8 hooks (4 for Write, 4 for Edit)
3. Activates them for your session

### Manual Activation

If hooks aren't working, restart Claude Code:
```bash
# Restart Claude Code to reload plugins and hooks
# Hooks will be active in the new session
```

### Verification

Check if hooks are registered:
```bash
# In Claude Code, hooks should show in settings
# Or check if workflow context updates when you write thoughts files
```

## How It Works

### 1. File Write Detected

When you write/edit a thoughts file:
```markdown
thoughts/shared/plans/2025-10-28-PROJ-123-feature.md
```

### 2. Hook Triggers

Claude Code PostToolUse hook fires for:
- Tool: `Write` or `Edit`
- File path matches: `*thoughts/shared/plans/*`

### 3. Script Executes

`hooks/update-workflow-context.sh` runs:
1. Gets file path from `$CLAUDE_FILE_PATHS` (or parses from JSON)
2. Determines document type from path
3. Extracts ticket from filename (e.g., `PROJ-123`)
4. Calls `workflow-context.sh` to update context

### 4. Context Updated

`.catalyst/workflow-context.json` is updated with:
```json
{
  "lastUpdated": "2025-10-28T22:30:00Z",
  "currentTicket": "PROJ-123",
  "mostRecentDocument": {
    "type": "plans",
    "path": "thoughts/shared/plans/2025-10-28-PROJ-123-feature.md",
    "created": "2025-10-28T22:30:00Z",
    "ticket": "PROJ-123"
  },
  "workflow": {
    "plans": [
      {
        "path": "thoughts/shared/plans/2025-10-28-PROJ-123-feature.md",
        "created": "2025-10-28T22:30:00Z",
        "ticket": "PROJ-123"
      },
      ...
    ]
  }
}
```

## Ticket Extraction

The hook automatically extracts ticket numbers from:

### Filename Patterns
- `2025-10-28-PROJ-123-description.md` → `PROJ-123`
- `ABC-456_feature.md` → `ABC-456`
- Any `[A-Z]+-[0-9]+` pattern

### Directory Names
- `thoughts/shared/handoffs/PROJ-123/handoff.md` → `PROJ-123`

### No Ticket Found
- Sets ticket to `"null"` if no pattern matches

## Commands That Use Workflow Context

These commands automatically read workflow context to find recent documents:

- `/resume-handoff` - Finds most recent handoff for a ticket
- `/create-plan` - Can reference recent research
- `/implement-plan` - Locates associated plan
- `/validate-plan` - Verifies plan was followed

Example from `/resume-handoff`:
```bash
# Finds most recent handoff automatically
RECENT_HANDOFF=$(workflow-context.sh recent handoffs)
```

## Hook Configuration

The `hooks.toml` defines 8 hooks:

### Write Hooks (4)
```toml
[[hooks]]
name = "Track Research Documents"
event = "PostToolUse"

[hooks.matcher]
tool_name = "Write"
file_paths = ["*thoughts/shared/research/*"]

[hooks.command]
command = "bash"
args = ["${CLAUDE_PLUGIN_ROOT}/hooks/update-workflow-context.sh"]
run_in_background = false
```

### Edit Hooks (4)
Same pattern for Edit tool on each document type.

## Manual Tracking (Fallback)

If hooks aren't working, commands can manually update context:

```bash
# In a command's bash section:
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" add plans "$PLAN_FILE" "PROJ-123"
fi
```

## Troubleshooting

### Hooks Not Firing

**Symptoms**: Workflow context not updating when writing thoughts files

**Solutions**:
1. Restart Claude Code (hooks load on startup)
2. Check plugin is installed: `/plugin list`
3. Verify hooks.toml exists in plugin
4. Check Claude Code hooks settings

### Empty $CLAUDE_FILE_PATHS

**Known bug** in some Claude Code versions where `$CLAUDE_FILE_PATHS` is empty.

**Workaround**: Hook script automatically falls back to parsing JSON from `$CLAUDE_TOOL_INPUT`:
```bash
if [[ -z "$FILE_PATH" ]]; then
  FILE_PATH=$(echo "$CLAUDE_TOOL_INPUT" | jq -r '.file_path // empty')
fi
```

### Script Path Not Found

**Symptom**: Hook runs but can't find `workflow-context.sh`

**Solution**: Hook script tries multiple paths:
1. `${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh`
2. `plugins/dev/scripts/workflow-context.sh`
3. `.claude/plugins/dev/scripts/workflow-context.sh`
4. Relative to hook location

### Context File Corrupted

**Solution**: Delete and reinitialize:
```bash
rm .catalyst/workflow-context.json
# Will auto-initialize on next update
```

## Testing

### Manual Test

Test the hook script directly:
```bash
CLAUDE_FILE_PATHS="thoughts/shared/plans/test.md" \
  bash plugins/dev/hooks/update-workflow-context.sh

# Check it worked
cat .catalyst/workflow-context.json | jq '.workflow.plans[0]'
```

### Integration Test

1. Write a thoughts file via Write tool
2. Check workflow context was updated
3. Verify ticket extraction worked
4. Confirm timestamp is current

## Benefits

### Automatic Tracking
- No manual script calls in commands
- Works for all thoughts document types
- Catches edits and new files

### Reliable
- Runs on every file operation
- Doesn't depend on command execution
- Multiple fallback paths

### Smart Extraction
- Auto-detects document type
- Extracts tickets from filenames
- Handles various naming patterns

### Command Integration
- Commands can trust context is current
- Auto-find recent documents
- Chain workflows seamlessly

## Plan Mode Integration

Catalyst hooks into Claude Code's built-in plan mode (Shift+Tab) to bridge it with the thoughts system. Two hooks work together:

### ExitPlanMode Hook: `sync-plan-to-thoughts.sh`

When a user exits plan mode, this hook automatically:

1. Reads plan content from `~/.claude/plans/plan.md`
2. Extracts a title from the first `# ` heading
3. Extracts a ticket ID via `[A-Z]+-[0-9]+` regex (from title, then content)
4. Gathers git metadata (commit, branch, repo)
5. Generates Catalyst frontmatter matching the `create_plan.md` schema
6. Writes to `thoughts/shared/plans/YYYY-MM-DD-{ticket}-{slug}.md`
7. Updates workflow-context so `/implement-plan` can auto-discover it
8. Fires `humanlayer thoughts sync` in background

**Key behaviors:**

- **Re-iteration safe**: Same date + same heading = same filename, so a rejected-then-revised plan overwrites the previous version
- **Silent failure**: All errors are swallowed — the hook never blocks the approval dialog
- **No auto-approve**: Exits 0 with no stdout, so the normal approval flow continues
- **Coexists with `/create-plan`**: Plans from either source end up in the same thoughts directory and workflow-context, so `/implement-plan` works identically

### UserPromptSubmit Hook: `inject-plan-template.sh`

On every user prompt, this hook checks if Claude is in plan mode:

- If `permission_mode` is NOT `"plan"` → exits immediately (< 10ms overhead)
- If in plan mode → returns `additionalContext` with Catalyst plan structure guidance

The guidance includes:
- Required sections (Overview, Phases, Success Criteria, etc.)
- Phase structure with automated and manual verification checkboxes
- Ticket ID formatting using the project's configured `ticketPrefix`
- Tips for file references and phase independence

This is advisory — Claude's plan mode remains free-form, but the guidance nudges toward the structure that `/implement-plan` expects.

### Testing Plan Mode Hooks

**Test the sync hook:**
```bash
# Create a mock plan file
mkdir -p ~/.claude/plans
cat > ~/.claude/plans/plan.md << 'EOF'
# PROJ-123 Test Feature Plan

## Overview
Testing the plan mode integration.

## Phase 1: Setup
- [ ] Create files
EOF

# Run the hook with mock input
echo '{"tool_name":"ExitPlanMode","tool_input":{},"cwd":"'$(pwd)'","permission_mode":"plan"}' \
  | CLAUDE_PROJECT_DIR=$(pwd) bash plugins/dev/hooks/sync-plan-to-thoughts.sh

# Verify output
ls thoughts/shared/plans/*test-feature-plan* 2>/dev/null
```

**Test the injection hook:**
```bash
# In plan mode — should return guidance JSON
echo '{"permission_mode":"plan","cwd":"'$(pwd)'"}' \
  | CLAUDE_PROJECT_DIR=$(pwd) bash plugins/dev/hooks/inject-plan-template.sh | jq .

# In normal mode — should produce no output
echo '{"permission_mode":"default","cwd":"'$(pwd)'"}' \
  | bash plugins/dev/hooks/inject-plan-template.sh
# (no output, exit 0)
```

### How Plan Mode Fits the Workflow

Plan mode and `/create-plan` are complementary:

| | Plan Mode (Shift+Tab) | `/create-plan` |
|---|---|---|
| **Trigger** | Keyboard shortcut | Slash command |
| **Style** | Free-form with guidance | Structured interactive |
| **Research input** | Manual | Auto-discovers recent research |
| **Output location** | `thoughts/shared/plans/` (via hook) | `thoughts/shared/plans/` (direct) |
| **Workflow context** | Updated by hook | Updated by command |
| **Next step** | `/implement-plan` | `/implement-plan` |

Both paths produce plans that `/implement-plan` can discover and execute.

## See Also

- [Workflow Context Script](../scripts/workflow-context.sh)
- [Hook Script](../hooks/update-workflow-context.sh)
- [Hooks Configuration](../hooks.toml)
- [Claude Code Hooks Documentation](https://docs.claude.com/en/docs/claude-code/hooks)
