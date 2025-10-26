# Quick Start Guide

Get up and running with Catalyst in 5 minutes.

## Prerequisites

1. **Claude Code** installed and working
2. **HumanLayer CLI** installed (for thoughts system)

   ```bash
   # Install with pip or pipx
   pip install humanlayer
   # or
   pipx install humanlayer

   # Verify installation
   humanlayer --version
   ```

## Setup (One-Time)

### Step 1: Install Catalyst Plugin

```bash
# Add Catalyst to your plugin marketplace
/plugin marketplace add coalesce-labs/catalyst

# Install the development workflow plugin
/plugin install catalyst-dev

# Optional: Install the meta/workflow creation plugin
/plugin install catalyst-meta
```

This makes all agents and commands available in Claude Code.

### Step 2: Set Up Thoughts Repository

```bash
# Download the setup script from the Catalyst repository
curl -O https://raw.githubusercontent.com/coalesce-labs/catalyst/main/scripts/setup-thoughts.sh
chmod +x setup-thoughts.sh
./setup-thoughts.sh
```

This will:

- Check for HumanLayer CLI
- Guide you through creating `~/thoughts/` repository
- Configure your username
- Save config to `~/.config/humanlayer/config.json`

### Step 3: Restart Claude Code

Restart Claude Code to load the Catalyst plugin.

## Using in a Project

### Initialize a Project

```bash
cd /path/to/your-project

# Download the init script
curl -O https://raw.githubusercontent.com/coalesce-labs/catalyst/main/scripts/init-project.sh
chmod +x init-project.sh
./init-project.sh . my-project
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

### 1. Research Phase

In Claude Code:

```
/research-codebase
```

Follow the prompts to research your codebase. This saves findings to `thoughts/shared/research/`.

### 2. Planning Phase

```
/create-plan
```

This:

1. Spawns parallel research agents (codebase-locator, thoughts-locator)
2. Interactively builds a plan with you
3. Saves to `thoughts/shared/plans/YYYY-MM-DD-TICKET-description.md`

### 3. Implementation Phase

```
/implement-plan
```

**Note**: If you just created a plan, you can omit the path - the command will automatically find your most recent plan!

This:

1. Reads the plan (auto-discovered from workflow context)
2. Implements each phase
3. Runs automated tests
4. Updates checkboxes as it progresses

### 4. Validation Phase

```
/validate-plan
```

This:

1. Verifies all success criteria
2. Runs automated tests
3. Documents deviations
4. Provides manual testing checklist

### 5. Create PR

```
/create-pr
```

Automatically creates a PR with comprehensive description pulled from your research and plan.

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

```
/create-worktree TICKET-123 main
```

This creates:

```
~/wt/your-project/TICKET-123/
```

With:

- Isolated git worktree
- Separate branch
- Shared `.claude/` configuration (via symlink)
- Thoughts automatically synced
- Dependencies installed

## Tips

### Workflow Context Auto-Discovery

Catalyst tracks your workflow automatically via `.claude/.workflow-context.json`:

- `/research-codebase` saves research → `/create-plan` can reference it
- `/create-plan` saves plan → `/implement-plan` auto-finds it
- `/create-handoff` saves handoff → `/resume-handoff` auto-finds it

**You don't need to specify file paths** - commands remember your most recent work!

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

## Common Commands

| Command                    | Purpose                            |
| -------------------------- | ---------------------------------- |
| `/research-codebase`       | Research codebase and save findings |
| `/create-plan`             | Interactive planning with research |
| `/implement-plan`          | Execute a plan (auto-finds recent) |
| `/validate-plan`           | Verify implementation              |
| `/create-pr`               | Create PR with rich description    |
| `/merge-pr`                | Merge PR and update Linear         |
| `/create-worktree`         | Set up parallel workspace          |
| `/create-handoff`          | Save context for later             |
| `/resume-handoff`          | Restore previous context           |

## Common Agents

| Agent                     | Purpose                   |
| ------------------------- | ------------------------- |
| `codebase-locator`        | Find files by topic       |
| `codebase-analyzer`       | Understand implementation |
| `thoughts-locator`        | Find historical docs      |
| `codebase-pattern-finder` | Find code examples        |
| `thoughts-analyzer`       | Extract key insights      |

## Troubleshooting

### "humanlayer command not found"

Install the HumanLayer CLI:

```bash
pip install humanlayer
# or
pipx install humanlayer
```

### Commands not showing up

1. Check plugin installation:
   ```bash
   /plugin list
   ```
2. Reinstall if needed:
   ```bash
   /plugin install catalyst-dev
   ```
3. Restart Claude Code

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
- Visit [GitHub repository](https://github.com/coalesce-labs/catalyst)

---

**You're ready!** Start with `/research-codebase` or `/create-plan` in your next Claude Code session.
