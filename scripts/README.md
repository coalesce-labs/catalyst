# scripts/ Directory: One-Time Setup Utilities

This directory contains **one-time setup scripts** for initializing HumanLayer thoughts and Linear workflows. These scripts are **not bundled in the Catalyst plugin** - they're used during initial setup only.

**Note**: Runtime scripts (workflow-context.sh, check-prerequisites.sh, create-worktree.sh, etc.) are bundled in the plugin at `plugins/dev/scripts/` and `plugins/meta/scripts/`.

## Directory Structure

```
scripts/
├── humanlayer/          # HumanLayer thoughts setup
│   ├── setup-thoughts.sh
│   ├── init-project.sh
│   ├── add-client-config
│   └── setup-personal-thoughts.sh
├── linear/              # Linear workflow setup
│   └── setup-linear-workflow
└── README.md            # This file
```

---

## HumanLayer Thoughts Scripts

### setup-thoughts.sh

**Initial HumanLayer setup (one-time, global)**

```bash
# Install HumanLayer CLI first
pip install humanlayer  # or: pipx install humanlayer

# Run setup
./scripts/humanlayer/setup-thoughts.sh
```

**What it does**:
- Creates `~/.config/humanlayer/config.json`
- Initializes `~/thoughts/` repository
- Configures your username
- Sets up directory structure

**When to use**: First-time setup on a new machine

---

### init-project.sh

**Initialize thoughts in a specific project**

```bash
./scripts/humanlayer/init-project.sh [project_path] [directory_name] [config_name]
```

**Arguments**:
- `project_path` - Path to project (default: current directory)
- `directory_name` - Name for thoughts directory (optional, prompts if omitted)
- `config_name` - HumanLayer config to use (e.g., "acme", "coalesce-labs")

**Examples**:

```bash
# Personal project (uses default config)
./scripts/humanlayer/init-project.sh ~/my-project my-project

# Client project (uses specific config)
./scripts/humanlayer/init-project.sh ~/client-project client-project acme
```

**What it does**:
- Creates `<project>/thoughts/` symlink to central repo
- Uses `--config-file` to specify which HumanLayer config
- Stores `configName` in `.claude/config.json` for per-project config
- Initializes git repo if needed

**Per-Project Configuration**:

When you provide a `config_name`, the script:
1. Uses `~/.config/humanlayer/config-{name}.json` for initialization
2. Stores `configName` in `.claude/config.json`:
   ```json
   {
     "thoughts": {
       "configName": "acme"
     }
   }
   ```
3. All Catalyst commands will automatically use this config

**Benefits**:
- ✅ Each project declares its HumanLayer config
- ✅ Work on multiple projects simultaneously (personal + client)
- ✅ No manual config switching needed
- ✅ Team members use same config (commit `.claude/config.json`)

**When to use**: After installing Catalyst plugin, before using workflow commands

---

### add-client-config

**Create a new HumanLayer config for a client**

```bash
./scripts/humanlayer/add-client-config <client-name> [thoughts-path]
```

**Examples**:

```bash
# Create config for ACME client
./scripts/humanlayer/add-client-config acme ~/code-repos/github/acme/thoughts

# Create config for Acme Corp
./scripts/humanlayer/add-client-config acme ~/clients/acme/thoughts
```

**What it does**:
- Creates `~/.config/humanlayer/config-{client-name}.json`
- Optionally creates thoughts repository at specified path
- Optionally creates private GitHub repository
- Initializes git with standard structure

**When to use**: Adding a new client to your setup

---

### setup-personal-thoughts.sh

**Advanced setup for personal thoughts separate from client work**

```bash
./scripts/humanlayer/setup-personal-thoughts.sh
```

**What it does**:
- Creates separate personal thoughts config
- Distinguishes personal vs client contexts
- For consultants managing multiple contexts

**When to use**: Optional, for consultants with complex multi-client setups

---

## Linear Workflow Scripts

### setup-linear-workflow

**Generate Linear workflow status setup**

```bash
./scripts/linear/setup-linear-workflow TEAM-KEY
```

**What it does**:
- Creates GraphQL mutation file at `/tmp/linear-workflow-setup.graphql`
- Defines workflow statuses:
  - Backlog → Triage → Research → Planning → In Progress → In Review → Done
- Provides setup instructions

**When to use**: Initial Linear integration setup (optional, can manage statuses manually)

---

## Multi-Client Workflow

### Example: Working with Multiple Clients Simultaneously

**Setup** (one time):

```bash
# 1. Install HumanLayer CLI
pip install humanlayer

# 2. Set up thoughts (creates default config)
./scripts/humanlayer/setup-thoughts.sh

# 3. Add client configs
./scripts/humanlayer/add-client-config acme ~/code-repos/github/acme/thoughts
./scripts/humanlayer/add-client-config acme ~/clients/acme/thoughts

# 4. Initialize projects with specific configs
cd ~/code-repos/github/acme/project1
./scripts/humanlayer/init-project.sh . project1 acme

cd ~/clients/acme/project2
./scripts/humanlayer/init-project.sh . project2 acme

cd ~/my-personal-project
./scripts/humanlayer/init-project.sh . personal coalesce-labs
```

**Daily work** (automatic):

```bash
# Work on ACME project
cd ~/code-repos/github/acme/project1
/research-codebase  # Automatically uses acme config

# Switch to Acme project
cd ~/clients/acme/project2
/create-plan  # Automatically uses acme config

# Switch to personal project
cd ~/my-personal-project
/implement-plan  # Automatically uses coalesce-labs config
```

**No manual switching needed!** Each project's `.claude/config.json` specifies its config.

---

## Configuration Files

### ~/.config/humanlayer/ Structure

```
~/.config/humanlayer/
├── config.json              # Default/personal config
├── config-acme.json      # Client 1
├── config-acme.json         # Client 2
└── config-coalesce-labs.json # Personal (if using add-client-config)
```

### .claude/config.json (Per-Project)

```json
{
  "project": {
    "ticketPrefix": "ACME"
  },
  "thoughts": {
    "configName": "acme"
  }
}
```

This tells Catalyst commands to use `~/.config/humanlayer/config-acme.json` automatically.

---

## Deleted Scripts (Now in Plugins)

These scripts used to be in `scripts/` but are now bundled in the Catalyst plugin:

- ❌ `check-prerequisites.sh` → `plugins/dev/scripts/check-prerequisites.sh`
- ❌ `create-worktree.sh` → `plugins/dev/scripts/create-worktree.sh`
- ❌ `workflow-context.sh` → `plugins/dev/scripts/workflow-context.sh`
- ❌ `frontmatter-utils.sh` → `plugins/dev/scripts/frontmatter-utils.sh`
- ❌ `validate-frontmatter.sh` → `plugins/meta/scripts/validate-frontmatter.sh`

**Use commands instead**:
- `/create-worktree` - Creates worktrees
- `/validate-frontmatter` - Validates frontmatter

---

## Obsolete Scripts (Deleted)

These scripts are no longer needed with per-project config:

- ❌ `hl-switch` - Manual config switching (replaced by automatic per-project config)
- ❌ `setup-multi-config.sh` - Multi-config setup (replaced by add-client-config)

---

## Troubleshooting

### "humanlayer command not found"

```bash
pip install humanlayer
# or
pipx install humanlayer
```

### "Config not found: config-xyz.json"

```bash
# List available configs
ls ~/.config/humanlayer/config-*.json

# Create missing config
./scripts/humanlayer/add-client-config xyz ~/path/to/thoughts
```

### "jq not found" warning

```bash
brew install jq  # macOS
apt-get install jq  # Linux
```

The script works without jq but you'll need to manually edit `.claude/config.json`.

---

## See Also

- [QUICKSTART.md](../QUICKSTART.md) - Getting started guide
- [docs/CONFIGURATION.md](../docs/CONFIGURATION.md) - Configuration reference
- [docs/MULTI_CONFIG_GUIDE.md](../docs/MULTI_CONFIG_GUIDE.md) - Advanced multi-client setup
