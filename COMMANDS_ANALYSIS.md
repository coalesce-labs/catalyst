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

2. **create_handoff.md / resume_handoff.md** - Session handoff
   - Uses HumanLayer daemon for session management
   - Specific to their multi-Claude workflow

3. **ralph\_\*.md commands** - Internal workflows
   - Named after their process "Ralph"
   - HumanLayer-specific conventions

4. **research_codebase\*.md** - Variations of create_plan
   - Duplicates of create_plan with slight tweaks
   - We already have create_plan

5. **founder_mode.md** - Internal joke/tool
   - Not generally useful

## Recommendations

### What to Add Now

1. ✅ **commit.md** - Already added
2. ✅ **describe_pr.md** - Already added
3. ✅ **iterate_plan.md** - Already added
4. ✅ **ci_commit.md** - Already added
5. ✅ **ci_describe_pr.md** - Already added
6. ✅ **oneshot.md** - Already added

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
├── ci_commit.md           # CI/automation git commit (sonnet)
├── ci_describe_pr.md      # CI/automation PR description (sonnet)
├── commit.md              # Interactive git commit creation (opus)
├── create_plan.md         # Interactive planning (opus)
├── create_worktree.md     # Worktree management (opus)
├── describe_pr.md         # Interactive PR description (opus)
├── implement_plan.md      # Plan execution (opus)
├── iterate_plan.md        # Update plans based on feedback (opus)
├── oneshot.md             # End-to-end research → plan → implement (opus)
└── validate_plan.md       # Plan validation (opus)
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

### ci_commit.md

- Non-interactive git commit for CI pipelines and automation
- Uses Sonnet model tier for cost efficiency
- Never commits sensitive files or thoughts/
- Conventional commit format maintained

### ci_describe_pr.md

- Non-interactive PR description generation for CI/automation
- Uses Sonnet model tier for cost efficiency
- Auto-detects current PR, generates and updates immediately
- Runs `humanlayer thoughts sync` automatically

### iterate_plan.md

- Update existing implementation plans based on feedback
- Uses Opus model tier for planning quality
- Research-backed modifications, not just text edits
- Reads current plan, gathers new context, produces updated plan

### oneshot.md

- End-to-end autonomous workflow: research, plan, implement
- Uses Opus model tier for quality across all phases
- Each phase runs in a fresh Claude Code session via `humanlayer launch`
- Context isolation between phases prevents token overflow

## Model Tiers

Catalyst uses a three-tier model strategy:

| Tier | Model | Use Case | Commands |
|------|-------|----------|----------|
| **Opus** | claude-opus-4-5 | Planning, implementation, complex analysis | commit, create_plan, implement_plan, iterate_plan, validate_plan, describe_pr, oneshot |
| **Sonnet** | claude-sonnet-4-5 | CI/automation, non-interactive tasks | ci_commit, ci_describe_pr |
| **Haiku** | claude-haiku-3-5 | Data collection, fast lookups | Research agents (linear-research, metrics collectors) |

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
