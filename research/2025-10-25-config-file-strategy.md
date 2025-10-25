# Catalyst Configuration File Strategy

## Problem Statement

`.claude/config.json` needs to:
1. Store sensitive data (API keys, tokens)
2. Store project-specific settings (team names, IDs)
3. Be shared across Claude Code sessions
4. NOT be committed to git
5. Have a template for new users

## Solution: Template + Local Pattern

### File Structure

```
.claude/
├── config.template.json    # Template (committed to git)
├── config.json             # User's actual config (gitignored)
└── .gitignore              # Ensures config.json never committed
```

### config.template.json (COMMITTED)

Generic template with `[NEEDS_SETUP]` markers:

```json
{
  "project": {
    "ticketPrefix": "PROJ",
    "defaultTicketPrefix": "PROJ"
  },
  "linear": {
    "teamKey": "[NEEDS_SETUP]",
    "defaultTeam": "[NEEDS_SETUP]",
    "apiToken": "[NEEDS_SETUP]"
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
  "exa": {
    "apiKey": "[NEEDS_SETUP]"
  },
  "posthog": {
    "apiKey": "[NEEDS_SETUP]",
    "projectId": "[NEEDS_SETUP]"
  },
  "thoughts": {
    "user": null
  }
}
```

### config.json (GITIGNORED)

User's actual config with real values:

```json
{
  "project": {
    "ticketPrefix": "ENG",
    "defaultTicketPrefix": "ENG"
  },
  "linear": {
    "teamKey": "ENG",
    "defaultTeam": "Backend",
    "apiToken": "lin_api_abc123..."
  },
  "railway": {
    "projectId": "proj_xyz789",
    "defaultService": "api"
  },
  "sentry": {
    "org": "my-company",
    "project": "backend-api",
    "authToken": "sntrys_abc123..."
  },
  "exa": {
    "apiKey": "exa_abc123..."
  },
  "posthog": {
    "apiKey": "phc_abc123...",
    "projectId": "12345"
  },
  "thoughts": {
    "user": "ryan"
  }
}
```

### .claude/.gitignore

```
# User configuration (contains secrets)
config.json

# Workflow context (temporary state)
.workflow-context.json

# Any local overrides
*.local.json
```

## Implementation Strategy

### 1. Plugin Installation

When user installs catalyst-dev plugin:

```bash
# Plugin postinstall script
if [ ! -f .claude/config.json ]; then
  cp .claude/config.template.json .claude/config.json
  echo "✅ Created .claude/config.json from template"
  echo "⚠️  Please edit .claude/config.json and fill in [NEEDS_SETUP] values"
fi
```

### 2. First-Run Detection

Commands check for `[NEEDS_SETUP]` markers:

```bash
#!/usr/bin/env bash
CONFIG_FILE=".claude/config.json"

# Read config value
LINEAR_TOKEN=$(jq -r '.linear.apiToken' "$CONFIG_FILE")

# Check if needs setup
if [[ "$LINEAR_TOKEN" == "[NEEDS_SETUP]" ]]; then
  echo "❌ Linear not configured. Please edit .claude/config.json"
  echo "   Set: .linear.apiToken to your Linear API token"
  exit 1
fi
```

### 3. Interactive Setup (Optional)

Create a `/catalyst-setup` command that walks through configuration:

```bash
/catalyst-setup linear
> "Let's configure Linear integration..."
> "Linear API token: [user pastes]"
> "Team key (e.g., ENG): [user types]"
> "Default team name: [user types]"
> ✅ Saved to .claude/config.json
```

## Root .gitignore

Ensure project root `.gitignore` includes:

```
# Catalyst configuration (contains secrets)
.claude/config.json
.claude/*.local.json
.claude/.workflow-context.json
```

## Claude Code Plugin Distribution

### What Gets Packaged in Plugin:

```
catalyst-dev/
├── agents/
├── commands/
├── scripts/
└── templates/
    └── config.template.json  # Template only
```

### What User Creates Locally:

```
<user-project>/.claude/
├── config.json          # Created from template
├── .gitignore           # Created by plugin install
└── .workflow-context.json  # Runtime state
```

## Security Best Practices

### 1. Never Commit Secrets

**Template (committed)**:
```json
{
  "linear": {
    "apiToken": "[NEEDS_SETUP]"
  }
}
```

**User config (gitignored)**:
```json
{
  "linear": {
    "apiToken": "lin_api_abc123..."
  }
}
```

### 2. Environment Variable Fallback

Commands should support both:

```bash
# Prefer config file
LINEAR_TOKEN=$(jq -r '.linear.apiToken' .claude/config.json)

# Fallback to environment
if [[ "$LINEAR_TOKEN" == "[NEEDS_SETUP]" ]]; then
  LINEAR_TOKEN="${LINEAR_API_TOKEN:-}"
fi

if [[ -z "$LINEAR_TOKEN" ]]; then
  echo "❌ Linear token not found in config or LINEAR_API_TOKEN env var"
  exit 1
fi
```

### 3. File Permissions

```bash
# Make config readable only by user
chmod 600 .claude/config.json
```

## Migration Strategy

For existing ryan-claude-workspace installations:

```bash
# In hack/migrate-config.sh
if [ -f .claude/config.json ]; then
  echo "⚠️  Existing config found"
  echo "   Backing up to .claude/config.json.backup"
  cp .claude/config.json .claude/config.json.backup
fi

cp .claude/config.template.json .claude/config.json
echo "✅ Config template installed"
echo "   Restore your values from .claude/config.json.backup"
```

## Documentation

### README.md Section

```markdown
## Configuration

Catalyst uses `.claude/config.json` for project-specific settings.

### First-Time Setup

1. Copy the template:
   ```bash
   cp .claude/config.template.json .claude/config.json
   ```

2. Edit `.claude/config.json` and replace `[NEEDS_SETUP]` values:
   - Linear API token (get from Linear → Settings → API)
   - Sentry auth token (get from Sentry → Settings → Auth Tokens)
   - Railway project ID (get from Railway → Project Settings)
   - Exa API key (get from dashboard.exa.ai)
   - PostHog API key and project ID (get from PostHog → Project Settings)

3. **IMPORTANT**: Never commit `.claude/config.json` to git!
   The template ensures this file is gitignored.

### Configuration Reference

See `.claude/config.template.json` for all available options.
```

## Command Behavior

### Graceful Degradation

Commands should handle missing config gracefully:

```bash
# Linear command
if ! LINEAR_CONFIGURED; then
  echo "⚠️  Linear not configured - some features unavailable"
  echo "   Run: /catalyst-setup linear"
  # Continue with limited functionality
fi

# Research command
if ! EXA_CONFIGURED; then
  echo "ℹ️  Exa not configured - web search unavailable"
  echo "   Research will use DeepWiki and Context7 only"
  # Continue without Exa
fi
```

## Summary

**Template**: `config.template.json` - Committed, generic, safe to share
**User Config**: `config.json` - Gitignored, secrets, never committed
**Pattern**: Standard practice (like `.env` files)
**Security**: chmod 600, gitignore, environment variable fallback
**UX**: Copy template on first run, interactive setup optional
