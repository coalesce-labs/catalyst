# HumanLayer Commands Analysis

## What We Should Use Directly

### ✅ Copied to This Workspace

These are universally useful and work with any project:

1. **commit.md** - Smart git commit creation
   - Analyzes changes and creates logical commits
   - No HumanLayer-specific dependencies
   - Works with any git repository

2. **describe_pr.md** - PR description generation
   - Uses `gh` CLI (GitHub CLI)
   - Reads PR template from `thoughts/shared/pr_description.md`
   - Runs verification commands
   - Updates PR via GitHub API

3. **debug.md** - Debugging helper
   - Investigates logs, database, git state
   - Can be adapted for any project's logging structure
   - Helps debug without burning main context

### 🔧 HumanLayer CLI Commands (Use Directly)

These are CLI commands that should be called directly, not duplicated:

1. **humanlayer thoughts** - Thoughts repository management
   - `init` - Initialize thoughts for a project
   - `sync` - Sync thoughts to repository
   - `status` - Check sync status
   - `uninit` - Remove thoughts setup

2. **humanlayer launch** - Launch Claude Code sessions
   - Used by `/create_worktree` to spawn parallel sessions
   - Manages daemon communication
   - Handles working directory and context

### ❌ HumanLayer-Specific (Don't Copy)

These are tightly coupled to HumanLayer's infrastructure:

1. **linear.md** - Linear ticket management
   - Uses Linear MCP server
   - HumanLayer-specific workflow statuses
   - HumanLayer project IDs
   - Can be adapted if you use Linear, but needs customization

2. **ci_commit.md / ci_describe_pr.md** - CI-specific versions
   - Hardcoded for HumanLayer's CI environment
   - Different behavior than local versions

3. **create_handoff.md / resume_handoff.md** - Session handoff
   - Uses HumanLayer daemon for session management
   - Specific to their multi-Claude workflow

4. **ralph\_\*.md commands** - Internal workflows
   - Named after their process "Ralph"
   - HumanLayer-specific conventions

5. **research_codebase\*.md** - Variations of create_plan
   - Duplicates of create_plan with slight tweaks
   - We already have create_plan

6. **founder_mode.md** - Internal joke/tool
   - Not generally useful

## Recommendations

### What to Add Now

1. ✅ **commit.md** - Already copied
2. ✅ **describe_pr.md** - Already copied
3. ✅ **debug.md** - Already copied

### What to Consider Adding

If you use **Linear** for issue tracking:

- Copy `linear.md` but customize:
  - Remove HumanLayer-specific project IDs
  - Adjust workflow statuses for your team
  - Update thoughts URL mappings

### What to Keep Using from CLI

- `humanlayer thoughts init` - Don't duplicate
- `humanlayer thoughts sync` - Don't duplicate
- `humanlayer launch` - Use when creating worktrees

## Commands We Have Now

```
commands/
├── commit.md              # Git commit creation (copied from HL)
├── create_plan.md         # Interactive planning (copied from HL)
├── create_worktree.md     # Worktree management (adapted from HL)
├── debug.md               # Debugging helper (copied from HL)
├── describe_pr.md         # PR description (copied from HL)
├── implement_plan.md      # Plan execution (copied from HL)
└── validate_plan.md       # Plan validation (copied from HL)
```

## Usage Notes

### commit.md

- Run after completing work
- Creates well-structured commits
- No Claude attribution (respects user authorship)

### describe_pr.md

- Requires: `gh` CLI installed
- Requires: PR template at `thoughts/shared/pr_description.md`
- Runs verification commands automatically
- Updates PR via GitHub API

### debug.md

- Use when hitting issues during implementation
- Investigates without burning main context
- Adapt log paths for your project structure

## Creating Your Own PR Template

For `describe_pr.md` to work, create:

`thoughts/shared/pr_description.md`:

```markdown
## Summary

What does this PR do?

## Problem

What problem does this solve?

## Solution

How does it solve it?

## How to verify it

- [ ] Tests pass: `make test`
- [ ] Linting passes: `make lint`
- [ ] Manually tested: [describe how]

## Changelog

Brief user-facing description for CHANGELOG.md
```

## Extending This

You can create project-specific commands by:

1. Copying a command to `.claude/commands/` in your project
2. Customizing for your workflow
3. Project commands take precedence over user commands

Example: Create `.claude/commands/deploy.md` for your deployment workflow.
