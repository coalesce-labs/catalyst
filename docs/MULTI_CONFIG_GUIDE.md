# Multi-Config Guide: Managing Multiple Thoughts Repositories

This guide explains how to manage separate thoughts repositories for different clients and projects.

## Overview

You can maintain completely separate thoughts repositories for:
- **Personal/Coalesce Labs work** - Your own projects
- **Client A work** - One client's projects
- **Client B work** - Another client's projects
- **Open source contributions** - Community projects

Each configuration points to a different thoughts repository, keeping contexts completely isolated.

## Quick Reference

```bash
# Switch between configurations
hl-switch                    # Interactive menu
hl-switch coalesce-labs     # Personal work
hl-switch brkthru           # Client work
hl-switch status            # Show current config

# Add new client configuration
add-client-config acme      # Interactive setup
add-client-config acme ~/clients/acme/thoughts
```

## Initial Setup (Already Done!)

Your initial setup created:

1. **Personal config** (default):
   - File: `~/.config/humanlayer/config.json` → `config-coalesce-labs.json`
   - Repo: `~/thoughts`
   - GitHub: `coalesce-labs/thoughts` (private)

2. **BRKTHRU config**:
   - File: `~/.config/humanlayer/config-brkthru.json`
   - Repo: `~/code-repos/github/brkthru/bravo_code/thoughts`
   - GitHub: Client's repository

## Daily Workflow

### Starting Work on Personal Project

```bash
# Make sure you're on the right config
hl-switch coalesce-labs

# Work as normal
cd ~/code-repos/my-project
humanlayer thoughts init
/create_plan
```

### Starting Work on Client Project

```bash
# Switch to client config
hl-switch brkthru

# Work as normal
cd ~/code-repos/github/brkthru/project
humanlayer thoughts init
/create_plan
```

### Checking Which Config Is Active

```bash
hl-switch status

# Output:
# Current configuration:
#   coalesce-labs
#   Repository: /Users/ryan/thoughts
```

## Adding a New Client

When you start work with a new client:

### Option 1: Interactive Setup (Recommended)

```bash
add-client-config acme
```

This will:
1. Ask for the thoughts repository path
2. Create the config file
3. Optionally create and initialize the thoughts repo
4. Optionally push to GitHub

### Option 2: Command Line

```bash
# Create config pointing to specific path
add-client-config acme ~/clients/acme/thoughts

# Or use a standard location
add-client-config megacorp ~/code-repos/github/megacorp/thoughts
```

### Option 3: Manual Creation

Create `~/.config/humanlayer/config-<client>.json`:

```json
{
  "thoughts": {
    "thoughtsRepo": "/Users/ryan/clients/acme/thoughts",
    "reposDir": "repos",
    "globalDir": "global",
    "user": "ryan",
    "repoMappings": {}
  }
}
```

Then initialize the thoughts repo:

```bash
mkdir -p ~/clients/acme/thoughts
cd ~/clients/acme/thoughts
git init
mkdir -p repos global/ryan global/shared
git add .
git commit -m "Initial acme thoughts repository"
```

## Configuration File Locations

All configs are stored in `~/.config/humanlayer/`:

```
~/.config/humanlayer/
├── config.json                    # Symlink to active config
├── config-coalesce-labs.json     # Personal work
├── config-brkthru.json           # BRKTHRU client
├── config-acme.json              # ACME client (example)
└── config-megacorp.json          # MegaCorp client (example)
```

The **active** config is always `config.json`, which is a **symlink** to one of the named configs.

## Thoughts Repository Layout

Each client gets their own isolated repository:

```
~/thoughts/                        # Personal (coalesce-labs)
~/code-repos/github/brkthru/bravo_code/thoughts/  # BRKTHRU
~/clients/acme/thoughts/          # ACME (example)
~/clients/megacorp/thoughts/      # MegaCorp (example)
```

Each repository has the same internal structure:

```
thoughts/
├── repos/              # Project-specific
│   ├── project-a/
│   │   ├── ryan/
│   │   └── shared/
│   └── project-b/
│       ├── ryan/
│       └── shared/
└── global/            # Cross-project
    ├── ryan/
    └── shared/
```

## GitHub Strategy

### Personal Thoughts
- **Organization**: `coalesce-labs`
- **Repository**: `coalesce-labs/thoughts` (private)
- **Purpose**: Your IP, personal notes, patterns

### Client Thoughts

**Option 1: Keep Local Only**
- Don't push to GitHub at all
- Client-specific knowledge stays on your machine
- Good for sensitive work

**Option 2: Push to Your Private Repo**
```bash
cd ~/clients/acme/thoughts
gh repo create ryan/acme-thoughts --private --source=. --push
```

**Option 3: Push to Client's Organization** (if allowed)
```bash
cd ~/clients/acme/thoughts
gh repo create acme-org/thoughts --private --source=. --push
```

## Advanced Usage

### List All Configurations

```bash
hl-switch list

# Output:
# Available configurations:
#   - brkthru
#   - coalesce-labs
```

### Interactive Selection

```bash
hl-switch

# Output:
# Current configuration:
#   coalesce-labs
#
# Available configurations:
#   [1] brkthru
#       → /Users/ryan/code-repos/github/brkthru/bravo_code/thoughts
#   [2] coalesce-labs
#       → /Users/ryan/thoughts
#
# Select configuration (1-2):
```

### Direct Switching

```bash
# Fast switching
hl-switch brkthru        # Switch to BRKTHRU
hl-switch coalesce-labs  # Switch back to personal

# No need to remember paths or --config-file arguments!
```

### Using with Worktrees

```bash
# Switch to client config first
hl-switch brkthru

# Create worktree (uses current config)
cd ~/code-repos/github/brkthru/project
./scripts/create-worktree.sh ENG-123

# The worktree automatically uses brkthru thoughts repo
cd ~/wt/project/ENG-123
humanlayer thoughts init  # Uses BRKTHRU config
```

## Troubleshooting

### "Which config am I using?"

```bash
hl-switch status
```

### "I initialized thoughts with wrong config"

```bash
# Switch to correct config
hl-switch coalesce-labs

# Re-initialize (will use correct repo)
cd /path/to/project
humanlayer thoughts init --force
```

### "I want to see what a config points to"

```bash
cat ~/.config/humanlayer/config-brkthru.json

# Or use jq for pretty output
jq '.thoughts.thoughtsRepo' ~/.config/humanlayer/config-brkthru.json
```

### "Add hl-switch to PATH manually"

If the setup script didn't add it:

```bash
# Add to ~/.zshrc
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

## Best Practices

### 1. Always Check Before Starting Work

```bash
# Start of workday
hl-switch status  # Verify you're on the right config
```

### 2. Use Descriptive Client Names

Good:
- `brkthru` - Clear client name
- `acme-corp` - Full client name
- `google-consulting` - Specific engagement

Bad:
- `client1` - Not memorable
- `work` - Too vague
- `temp` - Will get confusing

### 3. Keep Configs in Sync with Projects

If you organize projects like:
```
~/code-repos/github/brkthru/...
~/clients/acme/...
```

Keep thoughts organized similarly:
```
~/code-repos/github/brkthru/thoughts/
~/clients/acme/thoughts/
```

### 4. Document Client Configs

Add notes in the thoughts repo README:

```markdown
# ACME Corp Thoughts

**Client**: ACME Corporation
**Contract**: Jan 2025 - Dec 2025
**Projects**: acme-api, acme-web, acme-mobile

## Switching to This Config

hl-switch acme
```

### 5. Backup Strategy

**Personal thoughts**:
- Push to GitHub: `coalesce-labs/thoughts` (private)
- Your IP, back it up!

**Client thoughts**:
- Check your contract/NDA
- Keep local, or push to client's org
- Consider Time Machine/cloud backup

## Summary

The multi-config system gives you:

✅ **Complete isolation** - Client work never mixes with personal
✅ **Easy switching** - `hl-switch <name>` is all you need
✅ **No complex commands** - Just works with normal `humanlayer thoughts` commands
✅ **Scalable** - Add unlimited clients with `add-client-config`
✅ **Simple** - One symlink, many configs

You're now set up to manage thoughts across all your projects professionally and efficiently! 🎉
