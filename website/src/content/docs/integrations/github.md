---
title: GitHub
description: GitHub integration for pull requests, code review, and repository management.
---

Catalyst integrates with GitHub via the `gh` CLI for pull request creation, code review, and repository management.

## Commands

| Command | Description |
|---------|-------------|
| `/create-pr` | Create pull requests with auto-generated descriptions |
| `/describe-pr` | Generate or update PR descriptions |
| `/merge-pr` | Safe merge with verification |
| `/commit` | Conventional commits with ticket references |

## PR Creation

```
/create-pr
```

Automatically generates a PR description from:
- Commit history on the current branch
- Linked research and plan documents
- Ticket references from commit messages

## PR-Linear Sync

The `catalyst-pm` plugin provides `/pm:sync-prs` to correlate GitHub PRs with Linear issues:

- Match PRs to issues via branch names, descriptions, and attachments
- Identify orphaned PRs (no Linear issue) and orphaned issues (no PR)
- Flag stale PRs open longer than 14 days
- Generate auto-close commands for merged PRs with open issues

## Worktree Integration

Worktrees created with `/create-worktree` automatically set up branches with ticket references:

```bash
/create-worktree PROJ-123 feature-name
# Creates branch: PROJ-123-feature-name
```

## Setup

Install the GitHub CLI:

```bash
brew install gh    # macOS
gh auth login      # Authenticate
```

No additional Catalyst configuration needed — `gh` uses its own authentication.
