---
title: Worktree Development
description: Parallel feature development with git worktrees and shared context.
---

Git worktrees let you work on multiple features simultaneously, each in its own directory with shared context through the thoughts system.

## When to Use Worktrees

**Use worktrees for**:

- Large, long-running features
- Parallel work on multiple tickets
- Keeping the main branch clean during development
- Isolated testing environments

**Skip worktrees for**:

- Small, quick fixes
- Single feature at a time
- Short-lived branches

## Creating a Worktree

```
/create-worktree PROJ-123 feature-name
```

This creates:

- A git worktree at `~/wt/{project}/{PROJ-123-feature-name}/`
- A new branch `PROJ-123-feature-name`
- `.claude/` directory copied over
- Dependencies installed
- `thoughts/` shared via symlink

## Worktree Workflow

```bash
# 1. Create worktree
/create-worktree PROJ-123 feature-name
cd ~/wt/my-project/PROJ-123-feature-name

# 2. Start Claude Code in worktree
claude

# 3. Implement
/implement-plan

# 4. Commit and push
/commit
git push -u origin PROJ-123-feature-name

# 5. Create PR
/create-pr

# 6. Return to main repo
cd /path/to/main/repo

# 7. Clean up after PR merge
git worktree remove ~/wt/my-project/PROJ-123-feature-name
```

## Shared Context

All worktrees share the same thoughts directory via symlink:

```
Main Repo:    ~/projects/api/thoughts/
Worktree 1:   ~/wt/api/PROJ-123/thoughts/
Worktree 2:   ~/wt/api/PROJ-456/thoughts/

# All three point to the same location
```

Plans created in one worktree are visible in all others. Research is shared automatically.

## Parallel Development

Run separate Claude Code sessions in different worktrees:

```bash
# Terminal 1 — Feature A
cd ~/wt/api/PROJ-123-feature-a && claude
/implement-plan

# Terminal 2 — Feature B
cd ~/wt/api/PROJ-456-feature-b && claude
/implement-plan

# Terminal 3 — Research (main repo)
cd ~/projects/api && claude
/research-codebase
```

Each session is isolated with its own context window.

## Managing Worktrees

```bash
# List all worktrees
git worktree list

# Remove a worktree (after merge)
git worktree remove ~/wt/my-project/PROJ-123-feature

# Prune stale worktree references
git worktree prune
```

## Configuration

The worktree location defaults to `~/wt/{repo}` but can be customized with the `GITHUB_SOURCE_ROOT` environment variable:

```
${GITHUB_SOURCE_ROOT}/<org>/<repo>-worktrees/<feature>
```
