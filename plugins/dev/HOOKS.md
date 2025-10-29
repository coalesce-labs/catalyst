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

`.claude/.workflow-context.json` is updated with:
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
rm .claude/.workflow-context.json
# Will auto-initialize on next update
```

## Testing

### Manual Test

Test the hook script directly:
```bash
CLAUDE_FILE_PATHS="thoughts/shared/plans/test.md" \
  bash plugins/dev/hooks/update-workflow-context.sh

# Check it worked
cat .claude/.workflow-context.json | jq '.workflow.plans[0]'
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

## Future Enhancements

Potential improvements:

1. **Metadata Extraction**: Read YAML frontmatter for richer context
2. **Cross-References**: Track document relationships
3. **Validation Hooks**: Verify document structure on write
4. **Notifications**: Alert when context updates
5. **Analytics**: Track document creation patterns

## See Also

- [Workflow Context Script](../scripts/workflow-context.sh)
- [Hook Script](../hooks/update-workflow-context.sh)
- [Hooks Configuration](../hooks.toml)
- [Claude Code Hooks Documentation](https://docs.claude.com/en/docs/claude-code/hooks)
