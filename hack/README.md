# hack/ Directory: Installation & Setup Scripts

This directory contains shell scripts for installing, updating, and configuring the workspace. These scripts manage the distribution of agents and commands to your projects and handle various setup tasks.

## Quick Reference

| Script                  | Purpose                          | When to Use                              |
| ----------------------- | -------------------------------- | ---------------------------------------- |
| `install-user.sh`       | Install globally to `~/.claude/` | Make tools available across all projects |
| `install-project.sh`    | Install to specific project      | Add tools to one project only            |
| `update-project.sh`     | Update project from workspace    | Pull in workspace improvements           |
| `setup-thoughts.sh`     | Initialize thoughts system       | First-time global setup                  |
| `init-project.sh`       | Add thoughts to project          | After installing to project              |
| `create-worktree.sh`    | Create isolated workspace        | Work on multiple features in parallel    |
| `setup-multi-config.sh` | Setup multi-client configs       | For consultants with multiple clients    |
| `hl-switch`             | Switch between configs           | After multi-config setup                 |
| `add-client-config`     | Add new client config            | Add another client to multi-config       |
| `setup-linear-workflow` | Setup Linear statuses            | Configure Linear workflow automation     |

## Installation Scripts

### install-user.sh

**Install the workspace globally for all Claude Code projects.**

```bash
./hack/install-user.sh
```

**What it does:**

- Copies all agents and commands to `~/.claude/`
- Makes tools available in ALL your Claude Code projects
- No filtering - includes workspace-only commands too

**When to use:**

- You want these tools available everywhere
- You're a workspace developer
- You use Claude Code across many projects

**After installation:**

- Restart Claude Code
- Commands like `/research-codebase` now work in any project

---

### install-project.sh

**Install the workspace to a specific project.**

```bash
./hack/install-project.sh /path/to/project
```

**What it does:**

- Copies agents and commands to `<project>/.claude/`
- Filters out workspace-only commands (unless installing to workspace itself)
- Creates `config.json` template
- Creates `.workspace-metadata.json` for tracking

**When to use:**

- You want tools in just one project
- You're setting up a new project
- You want project-specific configuration

**After installation:**

1. Edit `<project>/.claude/config.json` for your team
2. Run `/linear` to configure Linear integration
3. Restart Claude Code

**What gets installed:**

- All 6 agents
- 13 commands (excludes workspace-only tools like `/validate-frontmatter`)
- Configuration template
- Metadata tracking file

---

### update-project.sh

**Update a project with the latest workspace improvements.**

```bash
./hack/update-project.sh /path/to/project
```

**What it does:**

- Smart merges `config.json` (keeps your values, adds new fields)
- Auto-updates agents (they're pure logic, safe to overwrite)
- Prompts for changes to customized commands
- Creates timestamped backup before any changes
- Skips workspace-only commands

**When to use:**

- Workspace has been improved and you want the updates
- After pulling workspace changes from git
- Periodic maintenance to stay in sync

**Smart features:**

- **Backup**: Creates `.claude-backup-YYYYMMDD-HHMMSS/` before changes
- **Config merge**: Your values preserved, new fields added
- **Conflict resolution**: Interactive prompts for customized files
- **linear.md handling**: Skips if you've configured it (preserves your Linear IDs)

**Example output:**

```
📊 Update Summary:
   Added:     2 files
   Updated:   5 files
   Skipped:   15 files
   Conflicts: 1 files

Workspace version: 51b9601
Backup location:   .claude-backup-20251006-112810/
```

## Thoughts System Scripts

### setup-thoughts.sh

**Initialize the global thoughts system (HumanLayer).**

```bash
./hack/setup-thoughts.sh
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
./hack/init-project.sh /path/to/project project-name
```

**What it does:**

- Creates `<project>/thoughts/` symlink to central repo
- Creates project-specific directory in `~/thoughts/repos/project-name/`
- Initializes git repo if needed
- Creates searchable index

**When to use:**

- After installing workspace to a project
- Before using workflow commands in that project
- When setting up a new project

**Requires:**

- `setup-thoughts.sh` already run globally
- Git repository in the project

## Multi-Client Configuration Scripts

### setup-multi-config.sh

**Setup multiple HumanLayer configurations for different clients.**

```bash
./hack/setup-multi-config.sh
```

**What it does:**

- Renames existing config to `config-brkthru.json` (client)
- Creates `config-coalesce-labs.json` (personal)
- Installs `hl-switch` tool to `~/bin/`
- Adds `~/bin` to your shell PATH

**When to use:**

- You're a consultant working with multiple clients
- You need separate thoughts repos for different contexts
- You want easy switching between configurations

**After setup:**

```bash
hl-switch                    # Interactive selection
hl-switch coalesce-labs      # Switch to personal
hl-switch brkthru            # Switch to client
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
./hack/add-client-config acme-corp /path/to/acme-thoughts
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
./hack/create-worktree.sh feature-name base-branch
```

**What it does:**

- Creates git worktree at `~/wt/{repo-name}/feature-name/`
- Creates or uses existing branch
- Copies `.claude/` directory
- Installs dependencies (make setup, npm install, or bun install)
- Initializes thoughts for the worktree

**When to use:**

- Working on multiple features simultaneously
- Creating isolated environment for a ticket
- Avoiding constant branch switching
- Parallel development without conflicts

**Customize location:**

```bash
export RYAN_WORKTREE_BASE="/custom/path"
./hack/create-worktree.sh feature-name
```

**Cleanup:**

```bash
git worktree remove ~/wt/repo-name/feature-name
git branch -D feature-name  # If you want to delete the branch
```

## Linear Integration Scripts

### setup-linear-workflow

**Generate Linear workflow status mutations.**

```bash
./hack/setup-linear-workflow TEAM-KEY
```

**What it does:**

- Creates GraphQL mutation file at `/tmp/linear-workflow-setup.graphql`
- Defines 12 workflow statuses:
  - Backlog → Triage → Research → Planning → In Progress → In Review → Done
- Provides setup instructions for three methods

**When to use:**

- Initial Linear integration setup
- Creating standardized workflow statuses
- Before using `/create-plan`, `/implement-plan` commands

**Three setup options:**

1. **Claude with Linear MCP** (easiest): `/linear-setup-workflow TEAM-KEY`
2. **GraphQL API**: Edit generated file and execute mutations
3. **Manual**: Create statuses in Linear UI

## Utility Scripts

### frontmatter-utils.sh

**Library for parsing YAML frontmatter from markdown files.**

**Not run directly** - sourced by other scripts:

- `install-project.sh` - Check `workspace_only` flag
- `update-project.sh` - Check `workspace_only` and `install_once` flags

**Functions:**

- `get_frontmatter_bool()` - Extract boolean field from frontmatter
- `should_skip_on_install()` - Check if command should be excluded from project install
- `should_skip_on_update()` - Check if command should be excluded from updates

## Common Workflows

### First-Time Setup

```bash
# 1. Setup thoughts system globally
./hack/setup-thoughts.sh

# 2. Install workspace globally OR to specific project
./hack/install-user.sh              # Option A: Global
# OR
./hack/install-project.sh ~/myapp  # Option B: Project-specific

# 3. Initialize thoughts in project
./hack/init-project.sh ~/myapp my-app

# 4. Configure Linear (optional)
# Start Claude Code and run: /linear
```

### Multi-Client Consultant Setup

```bash
# 1. Setup thoughts and install workspace
./hack/setup-thoughts.sh
./hack/install-user.sh

# 2. Setup multi-client configuration
./hack/setup-multi-config.sh

# 3. Add client configurations
./hack/add-client-config acme-corp ~/thoughts-acme
./hack/add-client-config initech ~/thoughts-initech

# 4. Switch between clients
hl-switch acme-corp    # Work on client project
hl-switch initech      # Switch to different client
```

### Updating Projects

```bash
# 1. Pull workspace improvements
cd ~/ryan-claude-workspace
git pull

# 2. Update your project
./hack/update-project.sh ~/myapp

# 3. Review changes
cd ~/myapp
git diff .claude/

# 4. Test and commit if satisfied
# 5. Remove backup if all is well
rm -rf .claude-backup-*
```

### Parallel Development

```bash
# 1. Create worktree for feature A
./hack/create-worktree.sh PROJ-123-auth-feature main

# 2. Work in worktree
cd ~/wt/myapp/PROJ-123-auth-feature
# Make changes, test, commit

# 3. Create another worktree for feature B
./hack/create-worktree.sh PROJ-456-api-changes main

# 4. Switch between worktrees without branch switching
cd ~/wt/myapp/PROJ-123-auth-feature  # Work on auth
cd ~/wt/myapp/PROJ-456-api-changes   # Work on API

# 5. Cleanup when done
git worktree remove ~/wt/myapp/PROJ-123-auth-feature
```

## Installation Filtering

**Understanding what gets installed where:**

### User Installation (`install-user.sh`)

- ✅ All 6 agents
- ✅ All 18 commands (including workspace-only)
- ❌ No config.json
- ❌ No metadata

### Project Installation (`install-project.sh`)

- ✅ All 6 agents
- ✅ 13 commands (excludes workspace-only unless installing to workspace itself)
- ✅ config.json template
- ✅ .workspace-metadata.json

**Workspace-only commands (excluded from projects):**

- `/validate-frontmatter` - Workspace validation tool
- `/update-project` - Workspace management
- `/discover-workflows` - Workflow catalog building
- `/import-workflow` - Import to workspace
- `/create-workflow` - Create in workspace

### Project Update (`update-project.sh`)

- ✅ Auto-updates: Agents (always)
- ✅ Smart merge: config.json
- ⏭️ Skips: workspace-only commands, install-once commands
- ⏭️ Skips: linear.md if configured
- 🤔 Prompts: Customized commands (3 options)
- 🤔 Prompts: Modified commands (Y/n)

## Troubleshooting

### "Command not found" after installation

**Solution:**

```bash
# Restart Claude Code to reload commands
# OR
# Check installation location
ls ~/.claude/commands/           # For user install
ls ~/myapp/.claude/commands/     # For project install
```

### Update script shows conflicts

**What to do:**

- Option 1: Keep local (default, safe)
- Option 2: Take workspace version (lose local changes)
- Option 3: View diff and decide

**Rollback if needed:**

```bash
rm -rf .claude/
mv .claude-backup-YYYYMMDD-HHMMSS/ .claude/
```

### HumanLayer thoughts not working

**Check:**

```bash
# Is humanlayer installed?
which humanlayer

# Is config created?
cat ~/.config/humanlayer/config.json

# Run setup if missing
./hack/setup-thoughts.sh
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

## See Also

- `../commands/README.md` - Documentation for the commands directory
- `../docs/USAGE.md` - Comprehensive workspace usage guide
- `../docs/CONFIGURATION.md` - Configuration system details
- `../README.md` - Workspace overview
