# commands/ Directory: Claude Code Slash Commands

This directory contains markdown files that become Claude Code slash commands. Each `.md` file with YAML frontmatter is automatically discovered and registered as a command you can invoke with `/command-name`.

## How It Works

**Filename → Command Mapping:**

- Filename: `research_codebase.md` (underscores)
- Slash command: `/research-codebase` (hyphens)

**Discovery Process:**

1. Claude Code scans `.claude/commands/*.md` on startup
2. Reads YAML frontmatter from each file
3. Registers command based on filename
4. Makes tools available per frontmatter specification

**No manifest file needed** - it's automatic based on filename!

## Command Types

### Portable Commands (15 commands)

**These travel with installations and work in any project.**

#### Core Workflow Commands

- `/research-codebase` - Research codebase with parallel sub-agents
- `/create-plan` - Create implementation plans
- `/implement-plan` - Execute implementation plans
- `/validate-plan` - Verify plan completion

#### Linear Integration

- `/linear` - Manage Linear tickets and workflow
- `/linear-setup-workflow` - Configure Linear statuses (install-once)

#### PR Lifecycle (Complete Git/GitHub Workflow)

- `/commit` - Create conventional commits with auto-detection
- `/create-pr` - Create PR with auto-rebase and Linear integration
- `/describe-pr` - Generate/update PR descriptions incrementally
- `/merge-pr` - Safely merge PR with verification and cleanup

#### Handoff System

- `/create-handoff` - Pause work and create handoff document
- `/resume-handoff` - Resume from handoff document

#### Utilities

- `/create-worktree` - Create git worktree for parallel work
- `/debug` - Debugging assistance
- `/workflow-help` - Interactive workflow guidance

### Workspace-Only Commands (5 commands)

**These are excluded from project installations (unless installing to workspace itself).**

#### Meta-Development Tools

- `/validate-frontmatter` - Validate command/agent frontmatter consistency
- `/update-project` - Update project's `.claude/` from workspace
- `/discover-workflows` - Research external repos for workflow patterns
- `/import-workflow` - Import discovered workflows into workspace
- `/create-workflow` - Create new agents/commands from templates

**Why workspace-only?**

- They modify the workspace itself (agents/, commands/ directories)
- They're for workspace development, not project work
- They reference workspace-specific paths

## Command File Structure

Every command file has this structure:

```markdown
---
description: What this command does
category: workflow
tools: Read, Write, Bash, Task
model: inherit
version: 1.0.0
workspace_only: true # Optional: exclude from project installs
install_once: true # Optional: install once, skip updates
---

# Command Implementation

The markdown content here becomes the command's prompt...
```

### Required Frontmatter Fields

- `description` - One-line description of what the command does
- `category` - Classification (workflow, planning, git, etc.)
- `tools` - Tools available during execution
- `model` - AI model to use (usually "inherit")
- `version` - Semantic version

### Optional Frontmatter Fields

- `workspace_only: true` - Exclude from project installations
- `install_once: true` - Install once, skip on updates
- `argument-hint` - Usage hint shown in Claude Code
- `source` - Attribution for adapted commands
- `adapted` - Original source information

**Important:** Commands use filename as identifier. Do NOT add a `name` field (that's for agents only).

## Installation Behavior

### User Installation (`./hack/install-user.sh`)

**What gets installed:**

- All 20 commands (including workspace-only)

**Available in:** ALL your Claude Code projects

**No filtering** - this is for workspace developers who want everything everywhere.

---

### Project Installation (`./hack/install-project.sh /path/to/project`)

**What gets installed:**

- 15 portable commands
- Excludes 5 workspace-only commands

**Available in:** ONLY that specific project

**Filtered out:**

- `/validate-frontmatter`
- `/update-project`
- `/discover-workflows`
- `/import-workflow`
- `/create-workflow`

**Exception:** If installing to workspace itself, ALL commands are included (dogfooding).

---

### Project Update (`./hack/update-project.sh /path/to/project`)

**How commands are updated:**

| Command Type                                  | Update Behavior                     |
| --------------------------------------------- | ----------------------------------- |
| New command                                   | Added automatically                 |
| Unchanged                                     | Skipped                             |
| Workspace-only                                | Skipped (not in projects)           |
| Install-once (e.g., `/linear-setup-workflow`) | Skipped                             |
| `/linear` if configured                       | Skipped (preserves your Linear IDs) |
| Modified, not customized                      | Prompted (Y/n)                      |
| Marked as customized                          | Conflict resolution (3 options)     |

**Smart handling:**

- Preserves your customizations
- Updates workspace improvements
- Interactive prompts when conflicts exist

## Command Categories

### workflow

Core development workflow commands like research, planning, implementation.

### planning

Planning and design commands.

### implementation

Code change execution commands.

### validation

Testing and verification commands.

### project-task-management

Linear integration and ticket management.

### git

Version control operations.

### workflow-discovery

Meta-workflow tools for discovering and creating workflows.

### general

Miscellaneous utilities.

## Examples

### Portable Command: research_codebase.md

```yaml
---
description: Conduct comprehensive codebase research using parallel sub-agents
category: workflow
tools: Read, Write, Grep, Glob, Task, TodoWrite, Bash
model: inherit
version: 1.0.0
---
```

**Characteristics:**

- No `workspace_only` field → Gets installed to projects
- Uses config from `.claude/config.json` for ticket prefixes
- Saves to `thoughts/shared/research/` (configurable per project)
- Works in any project directory

---

### Workspace-Only Command: validate_frontmatter.md

```yaml
---
description: Validate and fix frontmatter consistency across all workflows
category: workflow-discovery
tools: Read, Edit, Glob, Grep
model: inherit
version: 1.0.0
workspace_only: true
---
```

**Characteristics:**

- `workspace_only: true` → Excluded from project installs
- Validates files in `agents/` and `commands/` directories
- Creates `docs/FRONTMATTER_STANDARD.md`
- Only useful when developing the workspace itself

---

### Self-Configuring Command: linear.md

```yaml
---
description: Manage Linear tickets with workflow automation
category: project-task-management
---
```

**Characteristics:**

- Contains `[NEEDS_SETUP]` markers for first-time config
- Prompts for teamId, projectId, thoughtsRepoUrl on first use
- Updates itself after configuration
- Skipped by update script once configured (preserves your Linear IDs)

---

### Install-Once Command: linear_setup_workflow.md

```yaml
---
description: Set up recommended workflow statuses in Linear
category: project-task-management
install_once: true
---
```

**Characteristics:**

- `install_once: true` → Installed initially, skipped on updates
- Typically run once during project setup
- May contain project-specific configuration after first run

## Configuration-Driven Design

Portable commands read configuration from `.claude/config.json`:

```json
{
  "project": {
    "ticketPrefix": "PROJ",
    "defaultTicketPrefix": "PROJ"
  },
  "linear": {
    "teamId": null,
    "projectId": null,
    "thoughtsRepoUrl": null
  },
  "thoughts": {
    "user": null
  }
}
```

**In workspace:** Keep values generic/null (it's a template)

**In projects:** Fill in real values:

```json
{
  "project": {
    "ticketPrefix": "ENG"
  },
  "linear": {
    "teamId": "abc123",
    "projectId": "proj456",
    "thoughtsRepoUrl": "https://github.com/yourorg/thoughts/blob/main"
  }
}
```

## Common Patterns

### Pattern 1: Workspace References (Workspace-Only)

```markdown
**Task 1**: Validate agents in workspace
Path: /Users/ryan/code-repos/ryan-claude-workspace/agents/

Run: ./hack/update-project.sh /path/to/project
```

### Pattern 2: Configurable Paths (Portable)

```markdown
Save plan to: thoughts/shared/plans/YYYY-MM-DD-PROJ-XXXX-description.md
Replace PROJ with your ticket prefix from .claude/config.json
```

### Pattern 3: Self-Configuration (Portable)

```markdown
## ⚠️ FIRST-TIME SETUP REQUIRED

Check if this file contains `[NEEDS_SETUP]` markers.
If yes, prompt user for configuration and update this file.
Replace `[NEEDS_SETUP:TEAM_ID]` with actual value.
```

## Creating New Commands

### Step 1: Create Markdown File

```bash
# Create file with underscore-separated name
touch commands/my_new_command.md
```

### Step 2: Add Frontmatter

```yaml
---
description: Clear, concise description of what this does
category: workflow
tools: Read, Write, Bash
model: inherit
version: 1.0.0
workspace_only: false # Or true for workspace-only
---
```

### Step 3: Write Command Logic

The markdown content after frontmatter becomes the command's prompt.

### Step 4: Test

```bash
# Install to workspace for testing (if not already)
./hack/install-project.sh .

# Restart Claude Code
# Invoke with: /my-new-command
```

### Step 5: Validate Frontmatter

```bash
# Run validation (workspace-only command)
# In Claude Code: /validate-frontmatter
```

## Workflow Integration

### Complete PR Lifecycle (with Linear)

```
Feature Development
    ↓
/commit  (conventional commits with auto-detection)
    ↓
/create-pr  (auto-rebase, create PR, describe, Linear → In Review)
    ↓
Code Review (push more commits)
    ↓
/describe-pr  (incremental update, preserves manual edits)
    ↓
/merge-pr  (test, squash merge, delete branches, Linear → Done)
```

### Core Workflow Sequence

```
/research-codebase "How does X work?"
    ↓ (creates research document)
/create-plan
    ↓ (creates implementation plan)
/implement-plan path/to/plan.md
    ↓ (implements changes)
/validate-plan
    ↓ (verifies completion)
/commit
    ↓ (create conventional commits)
/create-pr
    ↓ (creates PR with description)
/merge-pr
    ↓ (merges after verification)
```

### Linear Integration Workflow

```
/linear create thoughts/shared/research/topic.md
    ↓ (creates Linear ticket in Backlog)
/research-codebase PROJ-123
    ↓ (moves ticket to Research, assigns to you)
/create-plan
    ↓ (moves ticket to Planning)
/implement-plan
    ↓ (moves ticket to In Progress)
/create-pr
    ↓ (moves ticket to In Review, assigns to you, links PR)
/merge-pr
    ↓ (moves ticket to Done)
```

### Handoff Workflow

```
/create-handoff
    ↓ (creates handoff document, saves context)
[Clear context, pause work]
[Resume later in fresh session]
/resume-handoff
    ↓ (loads handoff, restores context)
```

## Frontmatter Validation

The workspace includes `/validate-frontmatter` (workspace-only) to ensure consistency.

**Validates:**

- Required fields present
- Valid category values
- Valid tool references
- Proper structure

**Auto-fixes:**

- Adds missing optional fields
- Standardizes formatting
- Creates `docs/FRONTMATTER_STANDARD.md`

**Run validation:**

```
# In Claude Code (workspace only)
/validate-frontmatter
```

## Troubleshooting

### Command not appearing after creation

**Check:**

1. File in `.claude/commands/` directory? (not just `commands/`)
2. Valid YAML frontmatter?
3. Restarted Claude Code?

**Solution:**

```bash
# Copy to .claude/ if needed
cp commands/my_command.md .claude/commands/

# Restart Claude Code
```

### Workspace-only command showing in project

**Check:**

- Did you use `install-user.sh`? (includes all commands)
- Or `install-project.sh`? (filters workspace-only)

**Expected behavior:**

- User install: All commands (for workspace developers)
- Project install: Portable commands only

### Command customization lost after update

**This is by design** if:

- You marked the command as customized (chose "keep local")
- OR it's `linear.md` and you configured it

**To keep customizations:**

- Update script will prompt you
- Choose option 1: "Keep local version"
- OR option 3: "View diff and decide"

### Can't find frontmatter validation

**Remember:** `/validate-frontmatter` is workspace-only.

**Only available if:**

- Installed with `install-user.sh`
- OR installed to workspace itself
- NOT available in regular project installations

## See Also

- `../hack/README.md` - Installation and setup scripts
- `../docs/FRONTMATTER_STANDARD.md` - Frontmatter validation rules
- `../docs/USAGE.md` - Comprehensive workspace usage
- `../README.md` - Workspace overview
- `../CLAUDE.md` - Instructions for Claude Code
