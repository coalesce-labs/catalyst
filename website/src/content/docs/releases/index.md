---
title: Version Strategy
description: Versioning, release automation, and update procedures.
---

Catalyst uses **Release Please** for automated per-plugin releases with conventional commit messages.

## How Releases Work

1. **Merge PRs to main** with conventional commit titles
2. **Release Please opens release PRs** — one per affected plugin, accumulating changes
3. **Merge a release PR** to create: git tag, GitHub Release, updated CHANGELOG, bumped versions
4. **Marketplace syncs automatically** via post-release CI

## Commit Conventions

| Prefix | Effect | Example |
|--------|--------|---------|
| `feat(dev):` | Minor bump for catalyst-dev | `feat(dev): add new command` |
| `fix(pm):` | Patch bump for catalyst-pm | `fix(pm): correct cycle calculation` |
| `feat(dev)!:` | Major bump (breaking change) | `feat(dev)!: redesign plan format` |
| `chore(meta):` | No version bump | `chore(meta): update docs` |

## Version Locations

| File | Purpose |
|------|---------|
| `plugins/<x>/version.txt` | Primary version (Release Please) |
| `plugins/<x>/.claude-plugin/plugin.json` | Plugin manifest |
| `.claude-plugin/marketplace.json` | Marketplace registry |
| `plugins/<x>/CHANGELOG.md` | Per-plugin changelog |

## Tag Format

Tags follow `<component>-v<version>`:
- `catalyst-dev-v4.3.0`
- `catalyst-pm-v4.1.0`
- `catalyst-meta-v2.0.0`

## Updating Your Installation

```bash
# Fetch latest versions
claude plugin marketplace update catalyst

# Restart Claude Code to load updates
```

Check your current versions:

```bash
/plugin list
```

## When to Update

- **Patch** (4.3.0 → 4.3.1): Bug fixes — safe to update immediately
- **Minor** (4.3.0 → 4.4.0): New features — review changelog, then update
- **Major** (4.0.0 → 5.0.0): Breaking changes — read migration notes first

## Changelogs

Each plugin maintains its own changelog. See the sidebar for per-plugin release notes generated from the `CHANGELOG.md` files.
