# Personal Configuration

This directory contains **individual developer customization** that isn't shared with the team.

## Purpose

**Three-tier configuration:**

1. **Workspace template** (`ryan-claude-workspace/.claude/config.json`) - Generic, shareable
2. **Project config** (`.claude/config.json`) - Team-shared, versioned
3. **Personal config** (`.claude/config.local.json`) - Yours only ← YOU ARE HERE

## config.local.json

Personal configuration overrides team config.

**Create**: `.claude/config.local.json`

**Example:**

```json
{
  "telemetry": {
    "enabled": true,
    "prometheusEndpoint": "http://localhost:9090",
    "grafanaUrl": "http://localhost:3000",
    "queries": {
      "sessionCost": "sum(claude_tokens_total * 0.000003)",
      "sessionDuration": "sum(claude_session_duration_seconds)",
      "tokensPerIssue": "sum(claude_tokens_total) by (issue_id)"
    }
  },
  "personal": {
    "customCommands": [
      ".claude/.personal/commands/analyze-costs.md",
      ".claude/.personal/commands/query-prometheus.md"
    ],
    "defaultProject": "project-id-i-work-on-most",
    "preferences": {
      "verboseLogging": true,
      "autoSyncThoughts": true
    }
  },
  "commit": {
    "scopes": ["personal-scope", "my-feature-area"]
  }
}
```

### Merge Behavior

Config precedence (highest to lowest):
1. `.claude/config.local.json` (personal)
2. `.claude/config.json` (team)
3. Command defaults

Example:
```json
// Team config (.claude/config.json)
{
  "commit": {
    "scopes": ["api", "frontend", "database"]
  }
}

// Your config (.claude/config.local.json)
{
  "commit": {
    "scopes": ["api", "frontend", "database", "my-feature"]
  }
}

// Result: Your scopes include team scopes + your additions
```

## Personal Commands

Create commands in `.claude/.personal/commands/` that only you use.

**Example**: `.claude/.personal/commands/analyze-costs.md`

```markdown
---
description: Analyze Claude Code usage costs (personal)
category: personal
---

# Analyze Session Costs

Read telemetry configuration:

\`\`\`bash
PROMETHEUS_URL=$(jq -r '.telemetry.prometheusEndpoint // "http://localhost:9090"' .claude/config.local.json)
COST_QUERY=$(jq -r '.telemetry.queries.sessionCost' .claude/config.local.json)

# Query Prometheus
curl -s "${PROMETHEUS_URL}/api/v1/query" \
  --data-urlencode "query=${COST_QUERY}" \
  | jq '.data.result'

# Display results
echo "Session cost: $cost"
\`\`\`
```

**Usage**: `/analyze-costs`

## Personal Prompts

Create prompts in `.claude/.personal/prompts/` for your workflow.

**Example**: Cost analysis prompt

```markdown
# Cost Analysis Prompt

When analyzing costs:

1. Query Prometheus for token usage
2. Calculate cost (tokens * $0.000003)
3. Break down by:
   - Issue ID
   - Session duration
   - Command type
4. Show trends over time
5. Highlight expensive operations

Provide actionable insights:
- "Research phase costs X% more than implementation"
- "Consider batching Y operations"
```

## Use Cases

### 1. Telemetry and Monitoring

Track your Claude Code usage:

```json
{
  "telemetry": {
    "enabled": true,
    "backend": "prometheus",
    "exportInterval": 60
  }
}
```

### 2. Custom Tooling Integration

Integrate with your personal tools:

```json
{
  "integrations": {
    "slack": {
      "webhookUrl": "https://hooks.slack.com/...",
      "notifyOnComplete": true
    },
    "notion": {
      "apiKey": "secret_...",
      "databaseId": "..."
    }
  }
}
```

### 3. Development Preferences

Set your personal preferences:

```json
{
  "preferences": {
    "autoFormat": true,
    "verboseLogging": true,
    "autoCommit": false,
    "defaultBranch": "my-name/feature"
  }
}
```

### 4. Extended Scopes

Add scopes for your feature areas:

```json
{
  "commit": {
    "scopes": ["api", "frontend", "my-ml-feature", "my-experimental"]
  }
}
```

## Commands Reading Personal Config

Update commands to check for `config.local.json`:

```bash
# Read from both configs
CONFIG_FILE=".claude/config.json"
LOCAL_CONFIG=".claude/config.local.json"

# Use jq to merge (local overrides team)
if [[ -f "$LOCAL_CONFIG" ]]; then
  CONFIG_DATA=$(jq -s '.[0] * .[1]' "$CONFIG_FILE" "$LOCAL_CONFIG")
else
  CONFIG_DATA=$(cat "$CONFIG_FILE")
fi

# Read values from merged config
TEAM_ID=$(echo "$CONFIG_DATA" | jq -r '.linear.teamId')
```

## Security Notes

### What's Safe to Put Here

✅ **Safe**:
- Prometheus/Grafana URLs
- Tool preferences
- Custom scopes
- Personal workflow settings
- Non-sensitive API endpoints

❌ **NOT Safe** (use environment variables instead):
- API keys (use `ANTHROPIC_API_KEY` env var)
- Passwords
- Access tokens
- SSH keys
- Database credentials

### Best Practices

1. **Never commit config.local.json**:
   ```bash
   # Verify gitignored
   git check-ignore .claude/config.local.json
   # Should output: .claude/config.local.json
   ```

2. **Use environment variables for secrets**:
   ```json
   {
     "integrations": {
       "slack": {
         "webhookUrl": "${SLACK_WEBHOOK_URL}"
       }
     }
   }
   ```

3. **Document your setup** (in personal notes, not committed):
   ```bash
   # In your personal notes
   echo "My config.local.json setup" > ~/notes/claude-config.md
   ```

## Sharing Personal Patterns

If you create a useful personal command/prompt:

1. **Generalize it**: Remove personal details
2. **Create PR**: Add to workspace as optional feature
3. **Document**: Add to commands/ with clear use case
4. **Team benefit**: Everyone can use it if they want

## Summary

**Personal config enables**:
- ✅ Individual customization without team impact
- ✅ Telemetry and monitoring for your usage
- ✅ Personal tooling integration
- ✅ Extended scopes and preferences
- ✅ Experimentation without breaking team workflow

**Key principle**: Personal config is for **you**, project config is for **team**.
