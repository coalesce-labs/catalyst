---
title: Configuration
description: Two-layer configuration system for project settings and secrets management.
---

Catalyst uses a **two-layer configuration system** that keeps secrets out of git while allowing project metadata to be shared with your team.

## Layer 1: Project Config

**Location**: `.claude/config.json` (in your project root — safe to commit)

This file contains non-sensitive project metadata:

```json
{
  "catalyst": {
    "projectKey": "acme",
    "repository": {
      "org": "acme-corp",
      "name": "api"
    },
    "project": {
      "ticketPrefix": "ACME",
      "name": "Acme Corp Project"
    },
    "thoughts": {
      "user": null
    }
  }
}
```

Key fields:

- `catalyst.projectKey` — Links to your secrets config file
- `catalyst.project.ticketPrefix` — Your Linear/project ticket prefix (e.g., "ENG", "PROJ")
- Project name and repository metadata

## Layer 2: Secrets Config

**Location**: `~/.config/catalyst/config-{projectKey}.json` (never committed)

This file contains API tokens and secrets:

```json
{
  "catalyst": {
    "linear": {
      "apiToken": "lin_api_...",
      "teamKey": "ACME",
      "defaultTeam": "ACME"
    },
    "sentry": {
      "org": "acme-corp",
      "project": "acme-web",
      "authToken": "sntrys_..."
    },
    "railway": {
      "token": "...",
      "projectId": "..."
    },
    "posthog": {
      "apiKey": "...",
      "projectId": "..."
    },
    "exa": {
      "apiKey": "..."
    }
  }
}
```

## Setup

The unified setup script handles both layers:

```bash
curl -fsSL https://raw.githubusercontent.com/coalesce-labs/catalyst/main/setup-catalyst.sh | bash
```

You'll be asked for:

1. Project location (existing repo or clone fresh)
2. Project key (defaults to GitHub org name)
3. Ticket prefix (e.g., "ENG", "PROJ")
4. Your name (for the thoughts system)
5. API tokens for integrations (optional ones can be skipped)

The script is idempotent — safe to re-run to add or update integrations.

## Thoughts System Setup

The thoughts system provides git-backed persistent context across sessions.

The setup script handles this automatically, but for manual setup:

```bash
cd /path/to/your-project
humanlayer thoughts init

# Or with a specific profile
humanlayer thoughts init --profile coalesce-labs
```

The resulting directory structure:

```
<org_root>/
├── thoughts/                    # Shared by all org projects
│   ├── repos/
│   │   ├── project-a/
│   │   │   ├── {your_name}/
│   │   │   └── shared/
│   │   └── project-b/
│   └── global/
├── project-a/
│   └── thoughts/                # Symlinks to ../thoughts/repos/project-a/
└── project-b/
    └── thoughts/                # Symlinks to ../thoughts/repos/project-b/
```

### Syncing Thoughts

```bash
humanlayer thoughts sync
humanlayer thoughts status
humanlayer thoughts sync -m "Updated research on feature X"
```

### Backing Up to GitHub

```bash
cd <org_root>/thoughts
gh repo create my-thoughts --private --source=. --push
```

## Switching Between Projects

Change the `projectKey` in `.claude/config.json`:

```json
{
  "catalyst": {
    "projectKey": "work"
  }
}
```

Each project key maps to a different secrets file in `~/.config/catalyst/`.

## Troubleshooting

### Config not being read

1. File exists: `ls .claude/config.json`
2. Valid JSON: `cat .claude/config.json | jq`
3. Correct location: must be in the `.claude/` directory
4. Secrets file exists: `ls ~/.config/catalyst/config-{projectKey}.json`

### Thoughts not syncing

```bash
humanlayer thoughts status
humanlayer thoughts init  # Re-initialize if needed
```
