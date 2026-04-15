---
title: Multi-Project Setup
description: Managing separate thoughts repositories for different clients and projects.
sidebar:
  order: 3
---

Catalyst supports completely isolated contexts for different clients and projects using HumanLayer profiles.

## Overview

Each profile points to a different thoughts repository, keeping contexts completely isolated:

- **Personal work** — Your own projects
- **Client A** — One client's projects
- **Client B** — Another client's projects
- **Open source** — Community projects

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
```

## Adding a New Client

```bash
# Create profile
humanlayer thoughts profile create acme --repo ~/clients/acme/thoughts

# Initialize a project with this profile
cd /path/to/acme-project
humanlayer thoughts init --profile acme
```

## How Auto-Detection Works

HumanLayer maintains `repoMappings` that map working directories to profiles:

1. Run `humanlayer thoughts init --profile acme` in `/path/to/project`
2. HumanLayer records the mapping: `/path/to/project` → `acme` profile
3. Future `humanlayer thoughts` commands in that directory auto-detect the profile
4. No need to specify `--profile` on every command

## Repository Layout

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

## Daily Workflow

### Starting Work on a Personal Project

```bash
cd ~/code-repos/my-project
humanlayer thoughts init --profile coalesce-labs
/create-plan  # Works as normal
```

### Starting Work on a Client Project

```bash
cd ~/code-repos/github/acme/project
humanlayer thoughts init --profile acme
/create-plan  # Uses client-specific context
```

## Backup Strategy

**Personal thoughts**: Push to GitHub as a private repo — it's your IP.

**Client thoughts**: Check your contract/NDA. Options:

- Keep local only (good for sensitive work)
- Push to your private repo
- Push to the client's organization (if allowed)

```bash
cd ~/clients/acme/thoughts
gh repo create ryan/acme-thoughts --private --source=. --push
```

## Environment Isolation with direnv

HumanLayer profiles isolate _thoughts and context_. For API key and credential isolation, pair them
with [direnv](https://direnv.net/) profiles:

```bash
# ~/.config/direnv/profiles/personal.env  — your global defaults
# ~/.config/direnv/profiles/acme.env      — client-specific API keys

# ~/code-repos/github/acme/project/.envrc
use_profile personal
use_profile acme
use_otel_context "acme"
```

This gives you per-project API keys, OTel telemetry labels, and secrets scoping — automatically,
just by `cd`-ing into a directory. See [direnv Setup](/reference/configuration/#direnv-setup-recommended) for the full setup guide.

## Best Practices

Use descriptive profile names (`acme`, `coalesce-labs`, `google-consulting`) rather than vague ones (`client1`, `work`, `temp`).

Initialize projects immediately when starting work in a new directory.
