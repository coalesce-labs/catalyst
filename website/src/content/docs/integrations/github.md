---
title: GitHub
description: GitHub integration for pull requests, code review, and repository management.
---

Catalyst integrates with GitHub via the `gh` CLI for pull request creation, code review, and repository management.

## Commands

| Command | Description |
|---------|-------------|
| `/catalyst-dev:create_pr` | Create pull requests with auto-generated descriptions |
| `/catalyst-dev:describe_pr` | Generate or update PR descriptions |
| `/catalyst-dev:merge_pr` | Safe merge with verification |
| `/catalyst-dev:commit` | Conventional commits with ticket references |

## PR Creation

```
/catalyst-dev:create_pr
```

Automatically generates a PR description from:
- Commit history on the current branch
- Linked research and plan documents
- Ticket references from commit messages

## PR-Linear Sync

The `catalyst-pm` plugin provides `/catalyst-pm:sync_prs` to correlate GitHub PRs with Linear issues:

- Match PRs to issues via branch names, descriptions, and attachments
- Identify orphaned PRs (no Linear issue) and orphaned issues (no PR)
- Flag stale PRs open longer than 14 days
- Generate auto-close commands for merged PRs with open issues

## Worktree Integration

Worktrees created with `/catalyst-dev:create_worktree` automatically set up branches with ticket references:

```bash
/catalyst-dev:create_worktree PROJ-123 feature-name
# Creates branch: PROJ-123-feature-name
```

## Setup

Install the GitHub CLI:

```bash
brew install gh    # macOS
gh auth login      # Authenticate
```

No additional Catalyst configuration needed — `gh` uses its own authentication.
