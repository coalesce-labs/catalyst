# scripts/ Directory: Setup & Development Utilities

This directory contains shell scripts for setting up the Catalyst development environment. These scripts handle thoughts system initialization, worktree creation, and various development utilities.

**Note**: With the plugin-based distribution system, installation/update scripts have been removed. Users install Catalyst via the Claude Code plugin marketplace.

## Quick Reference

| Script                      | Purpose                          | When to Use                           |
| --------------------------- | -------------------------------- | ------------------------------------- |
| `setup-thoughts.sh`         | Initialize thoughts system       | First-time global setup               |
| `init-project.sh`           | Add thoughts to project          | After plugin installation             |
| `create-worktree.sh`        | Create isolated workspace        | Work on multiple features in parallel |
| `setup-multi-config.sh`     | Setup multi-client configs       | For consultants with multiple clients |
| `hl-switch`                 | Switch between configs           | After multi-config setup              |
| `add-client-config`         | Add new client config            | Add another client to multi-config    |
| `setup-linear-workflow`     | Setup Linear statuses            | Configure Linear workflow automation  |
| `check-prerequisites.sh`    | Verify required tools            | Bundled in plugin, used by commands   |
| `workflow-context.sh`       | Context management functions     | Bundled in plugin, used by commands   |
| `frontmatter-utils.sh`      | Parse YAML frontmatter           | Bundled in plugin, used by commands   |
| `validate-frontmatter.sh`   | Validate frontmatter consistency | Development tool for workspace        |

## Plugin Distribution

Catalyst is distributed via the Claude Code plugin marketplace:

```bash
# Install the development workflow plugin
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-dev

# Optional: Install the meta/workflow creation plugin
/plugin install catalyst-meta
```

The following scripts are **bundled into plugins** and run automatically by commands:
- `check-prerequisites.sh` - Validates CLI tools are installed
- `create-worktree.sh` - Creates git worktrees
- `workflow-context.sh` - Manages workflow state
- `frontmatter-utils.sh` - YAML parsing utilities

## Thoughts System Scripts

### setup-thoughts.sh

**Initialize the global thoughts system (HumanLayer).**

```bash
./scripts/setup-thoughts.sh
```

**What it does:**

- Creates `~/.config/humanlayer/config.json`
- Initializes `~/thoughts/` repository
- Sets up git for version control
- Configures directory structure

**When to use:**

- First-time setup on a new machine
- Before using any thought-based commands
- Before `init-project.sh`

**This is a prerequisite** for:

- `/research-codebase`
- `/create-plan`
- `/implement-plan`
- Any command that saves to `thoughts/`

---

### init-project.sh

**Initialize thoughts support in a specific project.**

```bash
./scripts/init-project.sh /path/to/project project-name
```

**What it does:**

- Creates `<project>/thoughts/` symlink to central repo
- Creates project-specific directory in `~/thoughts/repos/project-name/`
- Initializes git repo if needed
- Creates searchable index

**When to use:**

- After installing Catalyst plugin to a project
- Before using workflow commands in that project
- When setting up a new project

**Requires:**

- `setup-thoughts.sh` already run globally
- Git repository in the project

## Multi-Client Configuration Scripts

### setup-multi-config.sh

**Setup multiple HumanLayer configurations for different clients.**

```bash
./scripts/setup-multi-config.sh
```

**What it does:**

- Renames existing config to `config-{client}.json`
- Creates `config-{personal}.json`
- Installs `hl-switch` tool to `~/bin/`
- Adds `~/bin` to your shell PATH

**When to use:**

- You're a consultant working with multiple clients
- You need separate thoughts repos for different contexts
- You want easy switching between configurations

**After setup:**

```bash
hl-switch                    # Interactive selection
hl-switch personal           # Switch to personal
hl-switch client-name        # Switch to client
```

---

### hl-switch

**Switch between HumanLayer configurations.**

```bash
hl-switch                    # Interactive menu
hl-switch status             # Show current config
hl-switch list               # List all configs
hl-switch client-name        # Switch to specific config
```

**What it does:**

- Manages symlink from `config.json` to `config-{name}.json`
- Shows current configuration and thoughts repository
- Lists available configurations

**When to use:**

- Switching between client and personal work
- Checking which config is active
- After `setup-multi-config.sh`

---

### add-client-config

**Add a new client to your multi-config setup.**

```bash
./scripts/add-client-config acme-corp /path/to/acme-thoughts
```

**What it does:**

- Creates `config-acme-corp.json`
- Optionally creates thoughts repository at specified path
- Optionally creates private GitHub repository
- Initializes git with standard structure

**When to use:**

- Adding a new client to existing multi-config
- After running `setup-multi-config.sh`
- When starting work with a new client

## Development Scripts

### create-worktree.sh

**Create an isolated git worktree for parallel development.**

```bash
./scripts/create-worktree.sh feature-name base-branch
```

**What it does:**

- Creates git worktree at `~/wt/{repo-name}/feature-name/`
- Creates or uses existing branch
- Symlinks `.claude/` from main worktree (shared plugins and config)
- Installs dependencies (make setup, npm install, or bun install)
- Initializes thoughts for the worktree (automatically shared via HumanLayer)

**When to use:**

- Working on multiple features simultaneously
- Creating isolated environment for a ticket
- Avoiding constant branch switching
- Parallel development without conflicts

**Customize location:**

```bash
export RYAN_WORKTREE_BASE="/custom/path"
./scripts/create-worktree.sh feature-name
```

**Cleanup:**

```bash
git worktree remove ~/wt/repo-name/feature-name
git branch -D feature-name  # If you want to delete the branch
```

**Note**: Worktrees share `.claude/` via symlink, meaning:
- Same plugin installation across all worktrees
- Shared workflow-context.json state
- Single source of truth for configuration
- Thoughts automatically shared via HumanLayer's centralized `~/thoughts/`

## Linear Integration Scripts

### setup-linear-workflow

**Generate Linear workflow status mutations.**

```bash
./scripts/setup-linear-workflow TEAM-KEY
```

**What it does:**

- Creates GraphQL mutation file at `/tmp/linear-workflow-setup.graphql`
- Defines workflow statuses:
  - Backlog → Triage → Research → Planning → In Progress → In Review → Done
- Provides setup instructions

**When to use:**

- Initial Linear integration setup
- Creating standardized workflow statuses
- Before using `/create-plan`, `/implement-plan` commands

**Setup options:**

1. **Linearis CLI** (recommended): Use linearis to manage workflow states
2. **GraphQL API**: Edit generated file and execute mutations
3. **Manual**: Create statuses in Linear UI

## Bundled Plugin Scripts

These scripts are automatically included in the catalyst-dev plugin and used by commands:

### check-prerequisites.sh

**Validates required CLI tools are installed:**

- humanlayer (thoughts system)
- jq (JSON processing)
- linearis (Linear CLI)
- gh (GitHub CLI)

Used by commands that depend on external tools.

---

### workflow-context.sh

**Manages workflow state tracking:**

Functions for reading/writing `.claude/.workflow-context.json` which tracks:
- Most recent research documents
- Most recent plans
- Most recent handoffs
- Current ticket being worked on

Used by commands like `/implement-plan`, `/resume-handoff`, `/create-plan`.

---

### frontmatter-utils.sh

**Library for parsing YAML frontmatter from markdown files.**

Functions:
- `get_frontmatter_bool()` - Extract boolean field from frontmatter
- `extract_frontmatter()` - Get full frontmatter block

Used by meta commands for workflow validation.

---

### validate-frontmatter.sh

**Development tool for validating frontmatter consistency.**

Used by `/validate-frontmatter` command to ensure all agents and commands have proper YAML frontmatter.

## Common Workflows

### First-Time Setup

```bash
# 1. Install Catalyst plugin
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-dev

# 2. Setup thoughts system globally
./scripts/setup-thoughts.sh

# 3. Initialize thoughts in project
./scripts/init-project.sh ~/myapp my-app

# 4. Configure Linear (optional)
# Start using: /linear command
```

### Multi-Client Consultant Setup

```bash
# 1. Install plugin and setup thoughts
/plugin install catalyst-dev
./scripts/setup-thoughts.sh

# 2. Setup multi-client configuration
./scripts/setup-multi-config.sh

# 3. Add client configurations
./scripts/add-client-config acme-corp ~/thoughts-acme
./scripts/add-client-config initech ~/thoughts-initech

# 4. Switch between clients
hl-switch acme-corp    # Work on client project
hl-switch initech      # Switch to different client
```

### Parallel Development with Worktrees

```bash
# 1. Create worktree for feature A
./scripts/create-worktree.sh PROJ-123-auth-feature main

# 2. Work in worktree (shares .claude/ and thoughts/)
cd ~/wt/myapp/PROJ-123-auth-feature
# Make changes, test, commit

# 3. Create another worktree for feature B
./scripts/create-worktree.sh PROJ-456-api-changes main

# 4. Switch between worktrees without branch switching
cd ~/wt/myapp/PROJ-123-auth-feature  # Work on auth
cd ~/wt/myapp/PROJ-456-api-changes   # Work on API

# 5. Cleanup when done
git worktree remove ~/wt/myapp/PROJ-123-auth-feature
```

## Troubleshooting

### HumanLayer thoughts not working

**Check:**

```bash
# Is humanlayer installed?
which humanlayer

# Is config created?
cat ~/.config/humanlayer/config.json

# Run setup if missing
./scripts/setup-thoughts.sh
```

### Multi-config not switching

**Check:**

```bash
# Is hl-switch in PATH?
which hl-switch

# Add ~/bin to PATH if needed
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### Plugin not loading

**Solution:**

```bash
# Restart Claude Code to reload plugins
# OR check plugin installation
/plugin list
```

## See Also

- `../README.md` - Workspace overview and quick start
- `../CLAUDE.md` - Instructions for Claude Code
- Plugin documentation at `../plugins/dev/` and `../plugins/meta/`
