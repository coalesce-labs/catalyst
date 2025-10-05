---
description: Update a project's .claude/ directory from workspace with intelligent merging
category: workflow
tools: Bash, Read, Write, Edit, Glob, Grep
model: inherit
version: 1.0.0
---

# Update Project

You are tasked with updating a target project's `.claude/` directory from this workspace, intelligently merging changes while preserving local customizations.

## Purpose

This command helps you:
- Push workspace improvements to projects
- Preserve local customizations (config values, configured commands)
- Intelligently merge config files
- Track what's installed and detect drift
- Safely update with backups

## Initial Response

When invoked:

```
I'll help you update a project from this workspace.

Please provide the path to the project you want to update.

Example: /Users/ryan/code-repos/my-project

Or just press enter to update the current directory.
```

Then wait for the user's input.

## Process

### Step 1: Validate Target Project

1. **Get project path** from user (or use current directory)
2. **Check project has .claude/ directory**:
   - If not: Error - "Project not initialized. Run install-project.sh first."
   - If yes: Proceed

3. **Verify workspace location**:
   - Confirm we're running from ryan-claude-workspace
   - Check .claude/ directory exists in workspace

### Step 2: Run Update Script

**Execute the update script**:

```bash
./scripts/update-project.sh /path/to/project
```

**The script will**:
1. Check git status (warn if dirty)
2. Create backup: `.claude-backup-TIMESTAMP/`
3. Scan all files for changes
4. Process updates with intelligent merging
5. Handle conflicts interactively
6. Update metadata file
7. Show summary

### Step 3: Monitor and Assist

**While script runs**:
- Show progress to user
- If script prompts for decisions, relay to user
- Capture any errors or warnings
- Track what was updated

**Key decision points the script handles**:

**For config.json**:
- Smart merge: workspace structure + local values
- New fields added automatically
- Local values always preserved

**For linear.md**:
- If configured (no `[NEEDS_SETUP]`): Skip update, warn about workspace changes
- If unconfigured: Update normally

**For agents**:
- Always update (pure logic, no customization expected)

**For other commands**:
- Check for local modifications
- Prompt user: Update or keep local?
- Show diff if requested

### Step 4: Present Summary

After script completes, show summary:

```
✅ Project updated successfully!

## Update Summary

**Added**: {N} new files
- agents/new-agent.md
- commands/new-command.md

**Updated**: {N} files
- agents/codebase-locator.md
- commands/create_plan.md
- config.json (smart merged)

**Skipped**: {N} files
- commands/linear.md (configured, has local values)
- commands/custom-command.md (user chose to keep local)

**Conflicts handled**: {N}

**Backup**: .claude-backup-{timestamp}/
**Workspace version**: {commit-hash}

---

## Next Steps

1. **Test your project**: Make sure everything still works
2. **Review changes**: `git diff .claude/`
3. **Commit if happy**:
   ```bash
   git add .claude/
   git commit -m "Update workspace to version {short-hash}"
   ```
4. **Remove backup**: `rm -rf .claude-backup-{timestamp}/`

## 📊 Context Status

Current usage: {X}% ({Y}K/{Z}K tokens)

{If >60%}:
Update complete! Clear context if you're done.
```

### Step 5: Offer Additional Help

```
Would you like me to:
1. Show what changed in a specific file
2. Help review the diff
3. Test the updated commands
4. Update another project
```

## Important Notes

### What Gets Updated

**Always Updated (Auto)**:
- All agents (pure logic)
- New files (non-destructive)

**Smart Merged**:
- config.json (workspace structure + local values)

**Preserved if Configured**:
- linear.md (if has real values, no `[NEEDS_SETUP]`)

**User Decision**:
- Commands with local modifications
- Files marked as customized in metadata

### Metadata System

The script creates/updates `.claude/.workspace-metadata.json`:

```json
{
  "workspaceVersion": "abc123def456",
  "lastUpdated": "2025-01-08T10:30:00Z",
  "installedFiles": {
    "agents/codebase-locator.md": {
      "checksum": "abc123...",
      "modified": false,
      "customized": false
    },
    "commands/linear.md": {
      "checksum": "def456...",
      "modified": false,
      "customized": true
    }
  }
}
```

This tracks:
- What workspace version was installed
- Which files have been customized
- File checksums to detect changes

### Safety Features

**Automatic Backup**:
- Created before any changes: `.claude-backup-{timestamp}/`
- Can be deleted after verifying update
- Or kept for rollback if needed

**Git Check**:
- Warns if project has uncommitted changes
- Recommends committing first
- Can continue anyway if user approves

**Interactive Decisions**:
- User approves conflicting changes
- Can view diffs before deciding
- Can skip updates for specific files

### Common Scenarios

**Scenario 1: You improved agents**
```
✓ All agents auto-update (pure logic)
No conflicts, fast update
```

**Scenario 2: You added new config field**
```
config.json: Smart merged
New field added, local values preserved
```

**Scenario 3: You improved command user customized**
```
⚠️  Conflict detected
Options: Keep local / Take workspace / View diff
User decides
```

**Scenario 4: Team member runs update**
```
Same workflow, their local values preserved
Config.json merges their values + new fields
Smooth team synchronization
```

### Error Handling

**No .claude/ in project**:
```
Error: Project not initialized

Run this first:
./scripts/install-project.sh /path/to/project
```

**Workspace not found**:
```
Error: This command must be run from ryan-claude-workspace

cd /path/to/ryan-claude-workspace
Then try again
```

**Conflicts require attention**:
```
⚠️  {N} files need your decision

The script will prompt you for each conflict.
Review carefully before proceeding.
```

## Integration with Workflow

**When to update projects**:
- After improving workspace commands/agents
- When adding new features to workspace
- Periodically to stay current
- Before starting new work (get latest improvements)

**Team workflow**:
1. One person improves workspace
2. Commits workspace changes
3. Others pull workspace repo
4. Each runs `/update-project` on their projects
5. Local configs preserved, improvements shared

## Advanced Usage

### Update Multiple Projects

```bash
# From workspace
for project in ~/code-repos/*/; do
    ./scripts/update-project.sh "$project"
done
```

### Check What Would Update (Dry Run)

Currently not supported - but you can:
1. Check metadata file first
2. Compare workspace version
3. Review git diff after update

### Rollback Update

```bash
# If something went wrong
rm -rf .claude/
mv .claude-backup-{timestamp}/ .claude/
```

Or use git:
```bash
git restore .claude/
```

## Examples

### Example 1: Simple Update

```
User: /update-project /Users/ryan/code-repos/my-app

Agent: I'll update /Users/ryan/code-repos/my-app from workspace.

[Runs script]

✓ Backup created
✓ 3 agents updated
✓ 1 command updated (create_plan.md)
✓ config.json smart merged
✓ 1 file skipped (linear.md - configured)

Summary:
- Added: 0
- Updated: 4
- Skipped: 1
- Conflicts: 0

Ready to commit!
```

### Example 2: With Conflicts

```
User: /update-project /Users/ryan/code-repos/my-app

Agent: I'll update /Users/ryan/code-repos/my-app from workspace.

[Runs script, encounters conflict]

⚠️  Conflict: commands/debug.md (has local customizations)

Options:
1. Keep local version (skip update)
2. Take workspace version (lose local changes)
3. View diff and decide

User: 3

[Shows diff]

Apply workspace version? [y/N]: n

Kept local version.

Summary:
- Added: 0
- Updated: 3
- Skipped: 2
- Conflicts: 1 (resolved)

Update complete. Review changes and commit.
```

## Files Modified

**Script**: `scripts/update-project.sh`
**Metadata**: `.claude/.workspace-metadata.json` (in project)
**Backup**: `.claude-backup-{timestamp}/` (temporary)

## See Also

- `/workflow-help` - Learn about complete workflows
- `scripts/install-project.sh` - Initial project installation
- `docs/AGENTIC_WORKFLOW_GUIDE.md` - Workflow best practices
