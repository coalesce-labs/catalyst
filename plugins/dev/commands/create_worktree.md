---
description: Create a git worktree for parallel work and optionally launch implementation session
category: version-control-git
tools: Bash, Read
model: inherit
version: 1.0.0
---

## Configuration Note

This command uses ticket references like `PROJ-123`. Replace `PROJ` with your Linear team's ticket
prefix:

- Read from `.claude/config.json` if available
- Otherwise use a generic format like `TICKET-XXX`
- Examples: `ENG-123`, `FEAT-456`, `BUG-789`

You are tasked with creating a git worktree for parallel development work.

## Process

When this command is invoked:

1. **Gather required information**:
   - Worktree name (e.g., PROJ-123, feature-name)
   - Base branch (default: current branch)
   - Optional: Path to implementation plan

2. **Confirm with user**: Present the worktree details and get confirmation before creating.

3. **Create the worktree**: Use the create-worktree.sh script:

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/create-worktree.sh" <worktree_name> [base_branch]
   ```

   The script automatically:
   - Detects GitHub org/repo from git remote
   - Uses `GITHUB_SOURCE_ROOT` environment variable if set
   - Creates worktrees in a clean, organized structure

4. **Initialize thoughts** (REQUIRED - handled automatically by script):

   The create-worktree.sh script automatically initializes thoughts and syncs with the shared
   repository, giving the worktree access to:
   - Shared research documents
   - Implementation plans
   - Handoff documents
   - Team knowledge base

5. **Optional: Launch implementation session**: If a plan file path was provided, ask if the user
   wants to launch Claude in the worktree:
   ```bash
   humanlayer launch --model opus -w <worktree_path> \
     "/implement_plan <plan_path> and when done: create commit, create PR, update Linear ticket"
   ```

## Worktree Location Convention

**Recommended Setup**: Set `GITHUB_SOURCE_ROOT` environment variable for clean organization:

```bash
# In ~/.zshrc or ~/.bashrc
export GITHUB_SOURCE_ROOT="$HOME/code-repos/github"
```

**Convention**:

- **Main repository**: `${GITHUB_SOURCE_ROOT}/<org>/<repo>`
  - Example: `~/code-repos/github/coalesce-labs/catalyst`
- **Worktrees**: `${GITHUB_SOURCE_ROOT}/<org>/<repo>-worktrees/<feature>`
  - Example: `~/code-repos/github/coalesce-labs/catalyst-worktrees/PROJ-123`

**Fallback behavior** (if `GITHUB_SOURCE_ROOT` not set):

- Defaults to `~/wt/<repo_name>/<worktree_name>`

**Why this convention?**

- ✅ Main branches and worktrees are organized together by org/repo
- ✅ Easy to find: all worktrees for a project in one place
- ✅ Clean separation: `<repo>` vs `<repo>-worktrees`
- ✅ Configurable per-developer via environment variable
- ✅ No hardcoded paths in scripts or documentation

**Example with GITHUB_SOURCE_ROOT**:

```
~/code-repos/github/
├── coalesce-labs/
│   ├── catalyst/                    # Main branch
│   └── catalyst-worktrees/          # All worktrees
│       ├── PROJ-123-feature/
│       └── PROJ-456-bugfix/
└── acme/
    ├── api/                          # Main branch
    └── api-worktrees/                # All worktrees
        └── ENG-789-oauth/
```

## Example Interaction

```
User: /catalyst-dev:create_worktree PROJ-123
```
