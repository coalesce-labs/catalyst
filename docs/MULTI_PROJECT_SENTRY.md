# Multi-Project Sentry Support

Guide for monitoring multiple Sentry projects with Catalyst.

---

## Overview

If you have multiple Sentry projects (e.g., backend, frontend, events), you can configure Catalyst to work across all of them without specifying a single project.

## Configuration Options

### Option 1: Monitor All Projects (Recommended)

**Config**:
```json
{
  "catalyst": {
    "sentry": {
      "org": "your-org-slug",
      "authToken": "sntrys_..."
    }
  }
}
```

**Benefits**:
- ✅ Works across all projects automatically
- ✅ New projects appear without config changes
- ✅ Commands can aggregate data across projects
- ✅ Simplest configuration

### Option 2: Monitor Specific Projects

**Config**:
```json
{
  "catalyst": {
    "sentry": {
      "org": "your-org-slug",
      "projects": [
        "bravo-1-backend",
        "bravo-1-frontend",
        "bravo-1-events"
      ],
      "defaultProject": "bravo-1-backend",
      "authToken": "sntrys_..."
    }
  }
}
```

**Benefits**:
- ✅ Explicit list of monitored projects
- ✅ Ignore specific projects
- ✅ Set a default for commands that need one project

### Option 3: Single Project (Legacy)

**Config**:
```json
{
  "catalyst": {
    "sentry": {
      "org": "your-org-slug",
      "project": "bravo-1-backend",
      "authToken": "sntrys_..."
    }
  }
}
```

**Use when**:
- Only one project to monitor
- Backward compatibility needed

---

## Setup Flow

### Using Smart Setup (Auto-Discovery)

When you run `setup-catalyst.sh` with the smart Sentry config:

```
Found 3 projects:
  1. bravo-1-backend: Backend API
  2. bravo-1-frontend: Frontend App
  3. bravo-1-events: Event Processor

Options:
  A. Monitor all projects (recommended for multi-project setups)
  S. Select specific projects to monitor
  1-3. Choose one default project

Enter choice [A/S/1-3]: A

✓ Will monitor all projects in organization
```

**Choice A**: No `project` field in config (monitors all)
**Choice S**: Prompts for specific projects (e.g., "1 3")
**Choice 1-3**: Single project for backward compatibility

### Manual Setup

If entering manually (without smart discovery):

```
Sentry organization slug: your-org
Sentry project slug (or leave blank for all): [press Enter]
Sentry auth token: sntrys_...

✓ Configuration saved (monitoring all projects)
```

---

## Managing Projects

### Using the Helper Script

**List all projects**:
```bash
./scripts/sentry-project-helper.sh list

Projects in your-org:
  bravo-1-backend: Backend API (node)
  bravo-1-frontend: Frontend App (javascript)
  bravo-1-events: Event Processor (python)
```

**Show current config**:
```bash
./scripts/sentry-project-helper.sh show

Sentry Configuration

Organization: your-org
Monitoring: All projects
```

**Switch to monitor all**:
```bash
./scripts/sentry-project-helper.sh monitor-all

✓ Updated config to monitor all projects
```

**Switch to specific projects**:
```bash
./scripts/sentry-project-helper.sh monitor-specific bravo-1-backend bravo-1-frontend

✓ Updated config to monitor 2 project(s)
  - bravo-1-backend
  - bravo-1-frontend
```

---

## How Commands Use This

### Commands That Work Across Projects

When config has no `project` field or has `projects` array:

**Example: Debug command**
```bash
/debug

# Automatically searches errors across all configured projects
# Shows which project each error is from
```

**Example: Sentry MCP tools**

```bash
# Search issues across all projects
search_issues(organizationSlug='your-org', naturalLanguageQuery='errors in last hour')

# Returns issues from all projects with project info
```

### Commands That Need One Project

Some commands need a specific project. They use this logic:

1. **Check for `defaultProject`** in config
2. **Use first project** in `projects` array
3. **Ask user** which project to use
4. **Fail gracefully** if can't determine

---

## Example Scenarios

### Scenario 1: Full-Stack App

You have:
- `myapp-backend` (Node.js API)
- `myapp-frontend` (React app)
- `myapp-mobile` (React Native)

**Recommended config**:
```json
{
  "catalyst": {
    "sentry": {
      "org": "mycompany",
      "authToken": "sntrys_..."
    }
  }
}
```

**Why**: All three are part of the same product. You want to see errors across the entire stack.

### Scenario 2: Multiple Products

You have:
- `product-a-api`
- `product-a-web`
- `product-b-api`
- `product-b-web`

**Recommended config** (working on Product A):
```json
{
  "catalyst": {
    "sentry": {
      "org": "mycompany",
      "projects": ["product-a-api", "product-a-web"],
      "defaultProject": "product-a-api",
      "authToken": "sntrys_..."
    }
  }
}
```

**Why**: Focus on one product at a time, exclude others.

### Scenario 3: Single Service

You have:
- Just `my-api`

**Recommended config**:
```json
{
  "catalyst": {
    "sentry": {
      "org": "mycompany",
      "project": "my-api",
      "authToken": "sntrys_..."
    }
  }
}
```

**Why**: Simplest config for single project.

---

## Migration Guide

### From Single Project → All Projects

**Before**:
```json
{
  "catalyst": {
    "sentry": {
      "org": "your-org",
      "project": "old-project",
      "authToken": "sntrys_..."
    }
  }
}
```

**After**:
```json
{
  "catalyst": {
    "sentry": {
      "org": "your-org",
      "authToken": "sntrys_..."
    }
  }
}
```

**Using helper**:
```bash
./scripts/sentry-project-helper.sh monitor-all
```

### From Single Project → Specific Projects

**Using helper**:
```bash
./scripts/sentry-project-helper.sh monitor-specific project-1 project-2 project-3
```

---

## API Usage

### Sentry MCP Tools

The Sentry MCP server tools handle all three config formats:

```javascript
// Config with no project field
{
  sentry: {
    org: "your-org",
    authToken: "..."
  }
}
→ Searches/queries across ALL projects

// Config with projects array
{
  sentry: {
    org: "your-org",
    projects: ["proj-1", "proj-2"],
    defaultProject: "proj-1",
    authToken: "..."
  }
}
→ Searches across proj-1 and proj-2 only

// Config with single project
{
  sentry: {
    org: "your-org",
    project: "proj-1",
    authToken: "..."
  }
}
→ Searches only proj-1
```

### Catalyst Commands

Commands read config like this:

```bash
# Get org (always required)
ORG=$(jq -r '.catalyst.sentry.org' "$CONFIG_FILE")

# Get project(s)
PROJECT=$(jq -r '.catalyst.sentry.project // empty' "$CONFIG_FILE")
PROJECTS=$(jq -r '.catalyst.sentry.projects // empty' "$CONFIG_FILE")

if [[ -n "$PROJECTS" ]]; then
  # Multiple projects - iterate or use default
  DEFAULT=$(jq -r '.catalyst.sentry.defaultProject' "$CONFIG_FILE")
elif [[ -n "$PROJECT" ]]; then
  # Single project
  DEFAULT="$PROJECT"
else
  # All projects - query API for list
  curl "https://sentry.io/api/0/organizations/$ORG/projects/"
fi
```

---

## Best Practices

### Do's ✅

- **Use "all projects"** for full-stack apps
- **Use specific projects** when focusing on subset
- **Set defaultProject** when using projects array
- **Keep token permissions minimal** (org:read, project:read)

### Don'ts ❌

- **Don't hardcode project names** in scripts (read from config)
- **Don't create multiple configs** for same org (use one config)
- **Don't commit tokens** to git (use separate secrets file)

---

## Troubleshooting

### "No projects found"

**Cause**: Token doesn't have access to projects

**Fix**: Check token scopes include `project:read`

### "Project not in config"

**Cause**: Specific project not in `projects` array

**Fix**: Add project or switch to monitor-all

### "Commands only use one project"

**Cause**: Command doesn't support multi-project yet

**Fix**: Use Sentry MCP tools directly or specify project

---

## See Also

- [Smart Setup Guide](./SMART_SETUP.md)
- [Sentry Project Helper](../scripts/sentry-project-helper.sh)
- [Configuration Guide](./CONFIGURATION.md)
