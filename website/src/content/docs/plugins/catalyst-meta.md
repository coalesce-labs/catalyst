---
title: catalyst-meta
description: Workflow discovery, creation, and management plugin for advanced users.
---

Tools for discovering, importing, creating, and validating Catalyst workflows.

## Skills

| Skill | Description |
|-------|-------------|
| `/catalyst-meta:discover_workflows` | Research external Claude Code repositories for workflow patterns |
| `/catalyst-meta:import_workflow` | Import and adapt workflows from other repositories |
| `/catalyst-meta:create_workflow` | Create new agents or skills from discovered patterns |
| `/catalyst-meta:validate_frontmatter` | Check frontmatter consistency across all workflows |
| `/catalyst-meta:audit_references` | Audit plugin health and find broken references |
| `/catalyst-meta:reorganize` | Analyze and reorganize directory structures |

## Workflow Discovery

Research community repositories for reusable patterns:

```
/catalyst-meta:discover_workflows
```

Catalogs agents and skills from external Claude Code repositories, documenting their patterns and approaches.

## Importing Workflows

Adapt workflows from other repositories to your project:

```
/catalyst-meta:import_workflow
```

Adapts naming conventions, tool access, and configuration to match your existing Catalyst setup.

## Creating Workflows

Build new agents or skills from templates:

```
/catalyst-meta:create_workflow
```

Uses the [frontmatter standard](/contributing/creating-workflows/) and provides templates for both agents and skills.

## Frontmatter Validation

```
/catalyst-meta:validate_frontmatter
```

Checks all agents and skills against the standard, reporting missing fields, invalid tool references, and version format issues.

## Installation

```bash
/plugin install catalyst-meta
```
