# Quick Start Guide

Get up and running with Ryan's Claude Workspace in 5 minutes.

## Prerequisites

1. **Claude Code** installed and working
2. **HumanLayer CLI** installed (for thoughts system)
   ```bash
   # If you have the humanlayer repo:
   cd /path/to/humanlayer/hlyr
   npm install -g .

   # Verify installation:
   humanlayer --version
   ```

## Setup (One-Time)

### Step 1: Clone This Repository

```bash
cd ~/code-repos  # or wherever you keep repos
git clone <this-repo-url> ryan-claude-workspace
cd ryan-claude-workspace
```

### Step 2: Set Up Thoughts Repository

```bash
./hack/setup-thoughts.sh
```

This will:
- Check for HumanLayer CLI
- Guide you through creating `~/thoughts/` repository
- Configure your username
- Save config to `~/.config/humanlayer/config.json`

### Step 3: Install Agents & Commands

```bash
./hack/install-user.sh
```

This installs agents and commands to `~/.claude/` making them available in **all** Claude Code projects.

### Step 4: Restart Claude Code

Restart Claude Code to load the new agents and commands.

## Using in a Project

### Initialize a Project

```bash
cd /path/to/your-project
~/code-repos/ryan-claude-workspace/hack/init-project.sh . my-project
```

This creates:
```
your-project/
└── thoughts/
    ├── {your_name}/  → ~/thoughts/repos/my-project/{your_name}/
    ├── shared/       → ~/thoughts/repos/my-project/shared/
    └── global/       → ~/thoughts/global/
```

### Create Searchable Index

```bash
humanlayer thoughts sync
```

This creates `thoughts/searchable/` with hard links for fast grepping.

## Core Workflow

### 1. Research & Planning

In Claude Code:
```
/create_plan
```

This:
1. Spawns parallel research agents (codebase-locator, thoughts-locator)
2. Interactively builds a plan with you
3. Saves to `thoughts/shared/plans/YYYY-MM-DD-description.md`

### 2. Implementation

```
/implement_plan thoughts/shared/plans/2025-01-08-my-feature.md
```

This:
1. Reads the plan
2. Implements each phase
3. Runs automated tests
4. Updates checkboxes as it progresses

### 3. Validation

```
/validate_plan
```

This:
1. Verifies all success criteria
2. Runs automated tests
3. Documents deviations
4. Provides manual testing checklist

## Research Agents

Use these for finding code and context:

- `@agent-codebase-locator` - Find files by topic
- `@agent-codebase-analyzer` - Understand how code works
- `@agent-thoughts-locator` - Find historical context
- `@agent-codebase-pattern-finder` - Find similar implementations

Example:
```
@agent-codebase-locator find all files related to authentication
```

## Parallel Work with Worktrees

Create isolated workspace for a feature:

```bash
cd /path/to/your-project
./hack/create-worktree.sh ENG-123 main
```

This creates:
```
~/wt/your-project/ENG-123/
```

With:
- Isolated git worktree
- Separate branch
- Thoughts automatically synced
- Dependencies installed

## Tips

### Sync Thoughts Regularly

```bash
humanlayer thoughts sync -m "Updated research on feature X"
```

### Check Thoughts Status

```bash
humanlayer thoughts status
```

### Back Up Thoughts to GitHub

```bash
cd ~/thoughts
gh repo create my-thoughts --private --source=. --push
```

Now thoughts sync automatically to GitHub.

### Use Project-Specific Agents

For project-specific customization:

```bash
./hack/install-project.sh /path/to/project
```

This installs to `.claude/` in the project (takes precedence over `~/.claude/`).

## Common Commands

| Command | Purpose |
|---------|---------|
| `/create_plan` | Interactive planning with research |
| `/implement_plan <path>` | Execute a plan |
| `/validate_plan` | Verify implementation |
| `/create_worktree` | Set up parallel workspace |

## Common Agents

| Agent | Purpose |
|-------|---------|
| `codebase-locator` | Find files by topic |
| `codebase-analyzer` | Understand implementation |
| `thoughts-locator` | Find historical docs |
| `codebase-pattern-finder` | Find code examples |
| `thoughts-analyzer` | Extract key insights |

## Troubleshooting

### "humanlayer command not found"

Install the HumanLayer CLI:
```bash
cd /path/to/humanlayer/hlyr
npm install -g .
```

### Agents not showing up

1. Check installation:
   ```bash
   ls ~/.claude/agents/
   ```
2. Restart Claude Code

### Thoughts not syncing

1. Check status:
   ```bash
   humanlayer thoughts status
   ```
2. Re-initialize:
   ```bash
   humanlayer thoughts init
   ```

## Next Steps

- Read [USAGE.md](docs/USAGE.md) for detailed usage
- Read [BEST_PRACTICES.md](docs/BEST_PRACTICES.md) for patterns
- Read [PATTERNS.md](docs/PATTERNS.md) to create custom agents
- Read [CONTEXT_ENGINEERING.md](docs/CONTEXT_ENGINEERING.md) for theory

## Getting Help

- Check [docs/](docs/) for comprehensive guides
- Review examples in the documentation
- Look at agent source in [agents/](agents/)

---

**You're ready!** Start with `/create_plan` in your next Claude Code session.
