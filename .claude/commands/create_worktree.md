---
description: Create a git worktree for parallel work and optionally launch implementation session
category: version-control-git
---

## Configuration Note

This command uses ticket references like `PROJ-123`. Replace `PROJ` with your Linear team's ticket prefix:

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

2. **Confirm with user**:
   Present the worktree details and get confirmation before creating.

3. **Create the worktree**:
   Use the create-worktree.sh script:

   ```bash
   ./hack/create-worktree.sh <worktree_name> [base_branch]
   ```

   Or if the script is not available in the current project:

   ```bash
   git worktree add ~/wt/<repo>/<worktree_name> -b <worktree_name> [base_branch]
   ```

4. **Initialize thoughts** (if applicable):

   ```bash
   cd ~/wt/<repo>/<worktree_name>
   humanlayer thoughts init --directory <repo_name>
   humanlayer thoughts sync
   ```

5. **Optional: Launch implementation session**:
   If a plan file path was provided, ask if the user wants to launch Claude in the worktree:
   ```bash
   humanlayer launch --model opus -w ~/wt/<repo>/<worktree_name> \
     "/implement_plan <plan_path> and when done: create commit, create PR, update Linear ticket"
   ```

## Important Notes

- **Worktree location**: Default is `~/wt/<repo_name>/<worktree_name>`
- **Environment variable**: Can override with `RYAN_WORKTREE_BASE`
- **Thoughts**: Automatically synced if humanlayer CLI is available
- **Dependencies**: The worktree script handles dependency installation

## Example Interaction

```
User: /create_worktree PROJ-123
```
