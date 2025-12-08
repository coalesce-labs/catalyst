# Multi-Config Guide: Managing Multiple Thoughts Repositories

This guide explains how to manage separate thoughts repositories for different clients and projects using HumanLayer profiles.

## Overview

HumanLayer now supports profiles for managing multiple thoughts repositories:

```bash
# List available profiles
humanlayer thoughts profile list

# Create a new profile
humanlayer thoughts profile create acme --repo ~/clients/acme/thoughts

# Initialize a project with a profile
cd /path/to/acme-project
humanlayer thoughts init --profile acme
```

You can maintain completely separate thoughts repositories for:

- **Personal/Coalesce Labs work** - Your own projects
- **Client A work** - One client's projects
- **Client B work** - Another client's projects
- **Open source contributions** - Community projects

Each profile points to a different thoughts repository, keeping contexts completely isolated.

## Quick Reference

```bash
# List profiles
humanlayer thoughts profile list

# Create new profile
humanlayer thoughts profile create acme --repo ~/clients/acme/thoughts

# Initialize project with profile
cd /path/to/acme-project
humanlayer thoughts init --profile acme

# Check current status
humanlayer thoughts status

# Or use helper scripts
./scripts/humanlayer/add-client-config acme ~/clients/acme/thoughts
./scripts/humanlayer/init-project.sh . project-name acme
```

## Daily Workflow

### Starting Work on Personal Project

```bash
# Initialize project with default profile (or specific profile)
cd ~/code-repos/my-project
humanlayer thoughts init --profile coalesce-labs

# Work as normal
/catalyst-dev:create_plan
```

### Starting Work on Client Project

```bash
# Initialize project with client profile
cd ~/code-repos/github/acme/project
humanlayer thoughts init --profile acme

# Work as normal
/catalyst-dev:create_plan
```

### Checking Current Configuration

```bash
humanlayer thoughts status

# Output shows:
# - Current profile
# - Repository path
# - Mapped directories
```

## Adding a New Client

When you start work with a new client:

### Option 1: HumanLayer CLI (Recommended)

```bash
# Create profile
humanlayer thoughts profile create acme --repo ~/clients/acme/thoughts

# Initialize a project with this profile
cd /path/to/acme-project
humanlayer thoughts init --profile acme
```

### Option 2: Helper Script

```bash
# Interactive setup
./scripts/humanlayer/add-client-config acme

# Or with explicit path
./scripts/humanlayer/add-client-config acme ~/clients/acme/thoughts
```

## How Profile Auto-Detection Works

HumanLayer maintains `repoMappings` that automatically map working directories to profiles:

1. When you run `humanlayer thoughts init --profile acme` in `/path/to/project`
2. HumanLayer records: `/path/to/project` → `acme` profile
3. Future `humanlayer thoughts` commands in that directory auto-detect the profile
4. No need to specify `--profile` on every command

## Thoughts Repository Layout

Each profile gets its own isolated repository:

```
~/thoughts/                        # Personal (default)
~/clients/acme/thoughts/           # ACME client
~/clients/megacorp/thoughts/       # MegaCorp client
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

## Troubleshooting

### "Which profile am I using?"

```bash
humanlayer thoughts status
```

### "I initialized thoughts with wrong profile"

```bash
# Re-initialize with correct profile
cd /path/to/project
humanlayer thoughts init --profile correct-profile
```

### "List all profiles"

```bash
humanlayer thoughts profile list
```

### "How do I see profile details?"

```bash
# The HumanLayer config stores all profiles
humanlayer thoughts status --verbose
```

## Best Practices

### 1. Use Descriptive Profile Names

Good:
- `acme` - Clear client name
- `coalesce-labs` - Full organization name
- `google-consulting` - Specific engagement

Bad:
- `client1` - Not memorable
- `work` - Too vague
- `temp` - Will get confusing

### 2. Initialize Projects Immediately

When starting work in a new project directory:

```bash
cd /path/to/new-project
humanlayer thoughts init --profile appropriate-profile
```

### 3. Backup Strategy

**Personal thoughts**:
- Push to GitHub: `coalesce-labs/thoughts` (private)
- Your IP, back it up!

**Client thoughts**:
- Check your contract/NDA
- Keep local, or push to client's org
- Consider Time Machine/cloud backup

## Summary

The HumanLayer profile system gives you:

✅ **Complete isolation** - Client work never mixes with personal
✅ **Auto-detection** - HumanLayer knows which profile to use via repoMappings
✅ **Simple commands** - Just `humanlayer thoughts init --profile <name>`
✅ **Scalable** - Add unlimited profiles for different clients
✅ **Native integration** - No custom scripts needed
