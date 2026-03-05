---
title: catalyst-meta
description: Workflow discovery, creation, and management plugin for advanced users.
---

Tools for discovering, importing, creating, and validating Catalyst workflows.

## Commands

| Command | Description |
|---------|-------------|
| `/catalyst-meta:discover_workflows` | Research external Claude Code repositories for workflow patterns |
| `/catalyst-meta:import_workflow` | Import and adapt workflows from other repositories |
| `/catalyst-meta:create_workflow` | Create new agents or commands from discovered patterns |
| `/catalyst-meta:validate_frontmatter` | Check frontmatter consistency across all workflows |
| `/catalyst-meta:workflow_help` | Interactive guide to available workflows |

## Workflow Discovery

Research community repositories for reusable patterns:

```
/catalyst-meta:discover_workflows
```

Catalogs agents and commands from external Claude Code repositories, documenting their patterns and approaches.

## Importing Workflows

Adapt workflows from other repositories to your project:

```
/catalyst-meta:import_workflow
```

Adapts naming conventions, tool access, and configuration to match your existing Catalyst setup.

## Creating Workflows

Build new agents or commands from templates:

```
/catalyst-meta:create_workflow
```

Uses the [frontmatter standard](/reference/frontmatter/) and provides templates for both agents and commands.

## Frontmatter Validation

```
/catalyst-meta:validate_frontmatter
```

Checks all agents and commands against the standard, reporting missing fields, invalid categories, tool mismatches, and version format issues.

## Installation

```bash
/plugin install catalyst-meta
```
