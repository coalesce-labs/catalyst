---
title: catalyst-meta
description: Workflow discovery, creation, and management plugin for advanced users.
---

Tools for discovering, importing, creating, and validating Catalyst workflows.

## Commands

| Command | Description |
|---------|-------------|
| `/discover-workflows` | Research external Claude Code repositories for workflow patterns |
| `/import-workflow` | Import and adapt workflows from other repositories |
| `/create-workflow` | Create new agents or commands from discovered patterns |
| `/validate-frontmatter` | Check frontmatter consistency across all workflows |
| `/workflow-help` | Interactive guide to available workflows |

## Workflow Discovery

Research community repositories for reusable patterns:

```
/discover-workflows
```

Catalogs agents and commands from external Claude Code repositories, documenting their patterns and approaches.

## Importing Workflows

Adapt workflows from other repositories to your project:

```
/import-workflow
```

Adapts naming conventions, tool access, and configuration to match your existing Catalyst setup.

## Creating Workflows

Build new agents or commands from templates:

```
/create-workflow
```

Uses the [frontmatter standard](/reference/frontmatter/) and provides templates for both agents and commands.

## Frontmatter Validation

```
/validate-frontmatter
```

Checks all agents and commands against the standard, reporting missing fields, invalid categories, tool mismatches, and version format issues.

## Installation

```bash
/plugin install catalyst-meta
```
