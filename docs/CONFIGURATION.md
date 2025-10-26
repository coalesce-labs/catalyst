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
    "teamKey": "[NEEDS_SETUP]",
    "defaultTeam": "[NEEDS_SETUP]",
    "apiToken": "[NEEDS_SETUP]",
    "thoughtsRepoUrl": null
  },
  "railway": {
    "projectId": "[NEEDS_SETUP]",
    "defaultService": "[NEEDS_SETUP]"
  },
  "sentry": {
    "org": "[NEEDS_SETUP]",
    "project": "[NEEDS_SETUP]",
    "authToken": "[NEEDS_SETUP]"
  },
  "posthog": {
    "apiKey": "[NEEDS_SETUP]",
    "projectId": "[NEEDS_SETUP]"
  },
  "exa": {
    "apiKey": "[NEEDS_SETUP]"
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

The `/linear` command uses Linearis CLI and requires configuration:

```json
{
  "linear": {
    "teamKey": "ENG",
    "defaultTeam": "Backend",
    "apiToken": "[NEEDS_SETUP]",
    "thoughtsRepoUrl": "https://github.com/coalesce-labs/thoughts/blob/main"
  }
}
```

**Fields**:
- `teamKey` - Your Linear team key (e.g., "ENG", "PROD")
- `defaultTeam` - Default team name for operations
- `apiToken` - Linear API token (or set `LINEAR_API_TOKEN` env var)
- `thoughtsRepoUrl` - GitHub URL for linking docs to Linear tickets

**Installation**:
```bash
npm install -g --install-links ryanrozich/linearis#feat/cycles-cli
```

**Authentication**:
Set `LINEAR_API_TOKEN` environment variable or store in `~/.linear_api_token`

### Thoughts Configuration

**Per-Project HumanLayer Config** (New in v1.1):

```json
{
  "thoughts": {
    "user": null,
    "configName": "brkthru"
  }
}
```

**Fields**:
- `user` - Auto-detected from HumanLayer config (don't set manually)
- `configName` - Which HumanLayer config to use (e.g., "brkthru", "coalesce-labs", "acme")

**How it works**:

When `configName` is set, Catalyst commands automatically use:
```
~/.config/humanlayer/config-{configName}.json
```

**Example**: If `configName` is "brkthru", commands will use `~/.config/humanlayer/config-brkthru.json`

**Benefits**:
- ✅ Work on multiple projects simultaneously (personal + client)
- ✅ No manual config switching needed
- ✅ Each project declares its own HumanLayer config
- ✅ Team members automatically use correct config

**Setup**:

```bash
# 1. Create client config
./scripts/humanlayer/add-client-config brkthru ~/path/to/brkthru-thoughts

# 2. Initialize project with config
cd ~/client-project
./scripts/humanlayer/init-project.sh . project-name brkthru

# 3. Automatic! .claude/config.json now contains:
#    "configName": "brkthru"
```

**Legacy** (if configName is null):
- Uses global `~/.config/humanlayer/config.json`
- `user` field is read from global config for file paths, handoff metadata, and plan authorship

### Railway Configuration

For deployment and infrastructure management:

```json
{
  "railway": {
    "projectId": "your-project-id",
    "defaultService": "web"
  }
}
```

**Installation**:
```bash
npm install -g @railway/cli
railway login
```

### Sentry Configuration

For error tracking and release management:

```json
{
  "sentry": {
    "org": "your-org",
    "project": "your-project",
    "authToken": "[NEEDS_SETUP]"
  }
}
```

**Installation**:
```bash
curl -sL https://sentry.io/get-cli/ | sh
```

**Authentication**: Set `SENTRY_AUTH_TOKEN` or configure `~/.sentryclirc`

### PostHog Configuration

For product analytics (optional MCP):

```json
{
  "posthog": {
    "apiKey": "[NEEDS_SETUP]",
    "projectId": "[NEEDS_SETUP]"
  }
}
```

### Exa Configuration

For web search via MCP (optional):

```json
{
  "exa": {
    "apiKey": "[NEEDS_SETUP]"
  }
}
```

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
git add .claude/config.json
git commit -m "Set up Claude Code workspace configuration"
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

1. **Install plugins**: `/plugin install catalyst-dev`
2. **Configure project**: Set ticket prefix and Linear settings in `.claude/config.json`

**Result**: Commands work perfectly for your team's workflow!
