# Configuration Guide

This workspace uses a simple configuration system to make commands portable across different
projects and teams.

## Configuration File

The configuration is stored in `.claude/config.json`:

```json
{
  "project": {
    "ticketPrefix": "PROJ",
    "defaultTicketPrefix": "PROJ"
  },
  "linear": {
    "teamId": null,
    "projectId": null,
    "thoughtsRepoUrl": null
  },
  "thoughts": {
    "user": null
  }
}
```

## How It Works

### Ticket Prefix Configuration

Commands like `/create_plan`, `/create_handoff`, etc. use ticket references in filenames and
examples.

**Default behavior** (no config):

- Uses generic format: `PROJ-123`, `PROJ-456`
- Examples show `PROJ` as placeholder

**With config** (`.claude/config.json`):

```json
{
  "project": {
    "ticketPrefix": "ENG"
  }
}
```

- Commands will use: `ENG-123`, `ENG-456`
- Filenames: `thoughts/shared/plans/2025-01-08-ENG-123-feature.md`
- Handoffs: `thoughts/shared/handoffs/ENG-123/...`

### Linear Configuration

The `/linear` command uses self-configuration on first use:

```json
{
  "linear": {
    "teamId": "abc123",
    "projectId": "proj456",
    "thoughtsRepoUrl": "https://github.com/coalesce-labs/thoughts/blob/main"
  }
}
```

These values are:

- Prompted on first `/linear` use
- Saved automatically
- Used for all Linear operations
- Safe to commit (no secrets, just IDs)

### Thoughts Configuration

Detected automatically from HumanLayer config:

```json
{
  "thoughts": {
    "user": "ryan"
  }
}
```

This is read from `~/.config/humanlayer/config.json` and used in:

- File paths: `thoughts/ryan/notes.md`
- Handoff metadata
- Plan authorship

---

## Setting Up Configuration

### Option 1: Manual Setup

Create or edit `.claude/config.json` in your project:

```json
{
  "project": {
    "ticketPrefix": "ENG"
  }
}
```

### Option 2: First-Time Prompts

Some commands prompt for configuration on first use:

**`/linear` command**:

```
This Linear command needs one-time configuration...

1. What's your Linear team ID?
   Team ID: abc123

2. What's your default project ID?
   Project ID: proj456

3. What's your thoughts repository URL?
   Your pattern: https://github.com/coalesce-labs/thoughts/blob/main

✅ Configuration complete!
Please commit: git add .claude/config.json
```

After configuration, the command updates `.claude/config.json` automatically.

---

## Per-Project vs Shared Configuration

### Shared Workspace (ryan-claude-workspace)

**Don't commit configured values** in the shared workspace:

```json
{
  "project": {
    "ticketPrefix": "PROJ" // Keep generic
  },
  "linear": {
    "teamId": null, // Keep null
    "projectId": null,
    "thoughtsRepoUrl": null
  }
}
```

**Why**: The workspace is a template for multiple projects.

### Project Repository

**Do commit configured values** in your actual projects:

```json
{
  "project": {
    "ticketPrefix": "ENG" // Your actual prefix
  },
  "linear": {
    "teamId": "abc123", // Your actual team ID
    "projectId": "proj456",
    "thoughtsRepoUrl": "https://github.com/coalesce-labs/thoughts/blob/main"
  }
}
```

**Why**: Your team shares these settings.

---

## Configuration Priority

Commands read configuration in this order:

1. **Project config**: `.claude/config.json` (highest priority)
2. **Defaults**: Built-in defaults in each command
3. **Environment**: HumanLayer config for thoughts user

---

## Common Ticket Prefixes

Different teams use different formats:

| Team        | Prefix | Example    |
| ----------- | ------ | ---------- |
| Engineering | `ENG`  | `ENG-123`  |
| Features    | `FEAT` | `FEAT-456` |
| Bugs        | `BUG`  | `BUG-789`  |
| Design      | `DES`  | `DES-101`  |
| Product     | `PROD` | `PROD-202` |
| Generic     | `PROJ` | `PROJ-303` |

Choose what works for your team!

---

## Example Configurations

### Startup with Linear

```json
{
  "project": {
    "ticketPrefix": "ENG"
  },
  "linear": {
    "teamId": "abc123",
    "projectId": "proj456",
    "thoughtsRepoUrl": "https://github.com/startup/thoughts/blob/main"
  }
}
```

### Consulting Project

```json
{
  "project": {
    "ticketPrefix": "CLIENT"
  },
  "linear": {
    "teamId": "xyz789",
    "projectId": "proj999",
    "thoughtsRepoUrl": "https://github.com/consulting/client-thoughts/blob/main"
  }
}
```

### Open Source Project (No Linear)

```json
{
  "project": {
    "ticketPrefix": "ISSUE"
  },
  "linear": {
    "teamId": null,
    "projectId": null,
    "thoughtsRepoUrl": "https://github.com/myorg/project-thoughts/blob/main"
  }
}
```

---

## Updating Configuration

### Change Ticket Prefix

Edit `.claude/config.json`:

```json
{
  "project": {
    "ticketPrefix": "FEAT" // Changed from ENG
  }
}
```

Commit the change:

```bash
git add .claude/config.json
git commit -m "Update ticket prefix to FEAT"
```

### Update Linear Settings

Re-run the Linear setup:

```bash
/linear
# It will detect existing config and ask if you want to reconfigure
```

Or edit `.claude/config.json` directly.

---

## Multi-Config Setup (Advanced)

If you work across multiple clients, use the `hl-switch` system:

**Client A** (`config-client-a.json`):

```json
{
  "project": { "ticketPrefix": "ACME" },
  "linear": {
    "teamId": "acme123",
    "thoughtsRepoUrl": "https://github.com/acme/thoughts/blob/main"
  }
}
```

**Client B** (`config-client-b.json`):

```json
{
  "project": { "ticketPrefix": "BETA" },
  "linear": {
    "teamId": "beta456",
    "thoughtsRepoUrl": "https://github.com/beta/thoughts/blob/main"
  }
}
```

Switch between them:

```bash
hl-switch client-a  # Uses ACME tickets
hl-switch client-b  # Uses BETA tickets
```

See [MULTI_CONFIG_GUIDE.md](MULTI_CONFIG_GUIDE.md) for details.

---

## Troubleshooting

### "Commands still use ENG-XXX"

**Issue**: Old HumanLayer examples in commands

**Fix**: Commands now use `PROJ-XXX` as generic placeholder. If you see `ENG-`, it's just an
example. The actual commands will use your configured prefix when you run them.

### "Config not being read"

**Check**:

1. File exists: `ls .claude/config.json`
2. Valid JSON: `cat .claude/config.json | jq`
3. Correct location: Must be in `.claude/` directory

### "Which config to edit?"

**Rule of thumb**:

- **In `ryan-claude-workspace/`**: Keep generic (PROJ, null values)
- **In your project**: Use actual values (ENG, team IDs)

---

## Best Practices

### 1. Commit Project Config

Always commit `.claude/config.json` in your project repos:

```bash
git add .claude/config.json
git commit -m "Configure Claude workspace for this project"
```

### 2. Don't Commit Workspace Config

In `ryan-claude-workspace`, keep it generic:

```bash
# .gitignore could include:
# .claude/config.json

# But we keep a template with null values
```

### 3. Document Your Choices

Add a comment in your project's README:

```markdown
## Claude Code Setup

This project uses:

- Ticket prefix: `ENG-XXX`
- Linear team: Engineering
- See `.claude/config.json` for configuration
```

### 4. Share With Team

After configuration:

```bash
git add .claude/config.json .claude/commands/
git commit -m "Set up Claude Code workspace"
git push
```

Now your whole team has the same configuration!

---

## Summary

**Configuration makes commands portable**:

- ✅ No hardcoded values
- ✅ Easy to customize per-project
- ✅ Safe to share with team
- ✅ Self-configuring where possible

**Two-step setup**:

1. **Install workspace**: Copy agents/commands
2. **Configure project**: Set ticket prefix and Linear settings

**Result**: Commands work perfectly for your team's workflow!
