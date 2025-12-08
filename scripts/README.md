# scripts/ Directory: One-Time Setup Utilities

This directory contains **one-time setup scripts** for initializing HumanLayer thoughts and Linear
workflows. These scripts are **not bundled in the Catalyst plugin** - they're used during initial
setup only.

**Note**: Runtime scripts (workflow-context.sh, check-prerequisites.sh, create-worktree.sh, etc.)
are bundled in the plugin at `plugins/dev/scripts/` and `plugins/meta/scripts/`.

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
./scripts/humanlayer/init-project.sh [project_path] [directory_name] [profile]
```

**Arguments**:

- `project_path` - Path to project (default: current directory)
- `directory_name` - Name for thoughts directory (optional, prompts if omitted)
- `profile` - HumanLayer profile name (e.g., "coalesce-labs", "acme")
  - If not provided, auto-detects from current directory via `humanlayer thoughts status`

**Examples**:

```bash
# Auto-detect profile from current environment
./scripts/humanlayer/init-project.sh ~/my-project my-project

# Use specific profile
./scripts/humanlayer/init-project.sh ~/client-project client-project acme
```

**What it does**:

- Creates `<project>/thoughts/` symlink to central repo
- Uses `--profile` flag to specify which HumanLayer profile
- Auto-detects profile if not specified (from parent directory's configuration)

**When to use**: After installing Catalyst plugin, before using workflow commands

---

### add-client-config

**Create a new HumanLayer profile for a client**

```bash
./scripts/humanlayer/add-client-config <client-name> [thoughts-path]
```

**Examples**:

```bash
# Create profile for ACME client
./scripts/humanlayer/add-client-config acme ~/clients/acme/thoughts
```

**What it does**:

- Creates a new HumanLayer profile via `humanlayer thoughts profile create`
- Prompts for thoughts repository path if not provided

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

HumanLayer now supports profiles for managing multiple thoughts repositories.

### Setup (one time)

```bash
# 1. Install HumanLayer CLI
pip install humanlayer

# 2. Set up thoughts (creates default profile)
./scripts/humanlayer/setup-thoughts.sh

# 3. Create profiles for each client
humanlayer thoughts profile create acme --repo ~/clients/acme/thoughts
humanlayer thoughts profile create megacorp --repo ~/clients/megacorp/thoughts

# 4. Initialize projects with profiles
cd ~/clients/acme/project1
humanlayer thoughts init --profile acme

cd ~/clients/megacorp/project2
humanlayer thoughts init --profile megacorp

cd ~/my-personal-project
humanlayer thoughts init --profile coalesce-labs
```

### Daily Work (automatic)

```bash
# Work on ACME project
cd ~/clients/acme/project1
/research-codebase  # HumanLayer auto-detects profile via repoMappings

# Switch to MegaCorp project
cd ~/clients/megacorp/project2
/create-plan  # HumanLayer auto-detects profile

# Switch to personal project
cd ~/my-personal-project
/implement-plan  # HumanLayer auto-detects profile
```

**No manual switching needed!** HumanLayer's `repoMappings` automatically map directories to profiles.

### How Profile Auto-Detection Works

1. When you run `humanlayer thoughts init --profile X` in a directory
2. HumanLayer records the mapping: `/path/to/project` → profile `X`
3. Future commands in that directory auto-detect the profile
4. Check current profile: `humanlayer thoughts status` shows `Profile: <name>`

---

## Worktree Profile Inheritance

When creating worktrees, the profile is automatically inherited:

```bash
# In a project using profile "acme"
cd ~/clients/acme/project
humanlayer thoughts status  # Shows: Profile: acme

# Create worktree - profile is auto-detected and passed
/create-worktree feature-branch
# The new worktree automatically uses the same "acme" profile
```

The `create-worktree.sh` script:
1. Detects the current profile via `humanlayer thoughts status`
2. Passes `--profile <detected>` when initializing thoughts in the worktree
3. No manual configuration needed

---

## Configuration Files

### HumanLayer Profile Storage

HumanLayer stores profiles in its config file:

```bash
# List available profiles
humanlayer thoughts profile list

# Show profile details
humanlayer thoughts profile show acme

# Check current directory's profile
humanlayer thoughts status
```

### .claude/config.json (Per-Project)

```json
{
  "catalyst": {
    "projectKey": "acme",
    "project": {
      "ticketPrefix": "ACME"
    },
    "thoughts": {
      "user": null
    }
  }
}
```

Note: `projectKey` is used for secrets config (`~/.config/catalyst/config-{projectKey}.json`).
HumanLayer profile is detected automatically via `repoMappings`, not stored in this file.

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

These scripts are no longer needed with HumanLayer's profile system:

- ❌ `hl-switch` - Manual config switching (replaced by automatic profile detection)
- ❌ `setup-multi-config.sh` - Multi-config setup (replaced by `humanlayer thoughts profile create`)

---

## Troubleshooting

### "humanlayer command not found"

```bash
pip install humanlayer
# or
pipx install humanlayer
```

### "Profile not found"

```bash
# List available profiles
humanlayer thoughts profile list

# Create missing profile
humanlayer thoughts profile create xyz --repo ~/path/to/thoughts
```

### "Which profile am I using?"

```bash
humanlayer thoughts status
# Output shows: Profile: <name>
```

### "jq not found" warning

```bash
brew install jq  # macOS
apt-get install jq  # Linux
```

---

## See Also

- [QUICKSTART.md](../QUICKSTART.md) - Getting started guide
- [docs/MULTI_CONFIG_GUIDE.md](../docs/MULTI_CONFIG_GUIDE.md) - Advanced multi-client setup
- [docs/THOUGHTS_SETUP.md](../docs/THOUGHTS_SETUP.md) - Thoughts system setup
