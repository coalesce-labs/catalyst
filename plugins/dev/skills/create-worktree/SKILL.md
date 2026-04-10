---
name: create-worktree
description:
  "Create a git worktree for parallel work and optionally launch implementation session. **ALWAYS
  use when** the user says 'create a worktree', 'work in parallel', 'start a worktree for', or needs
  to work on multiple features simultaneously without switching branches."
disable-model-invocation: true
allowed-tools: Bash, Read
version: 1.0.0
---

## Configuration Note

This command uses ticket references like `PROJ-123`. Replace `PROJ` with your Linear team's ticket
prefix:

- Read from `.catalyst/config.json` if available
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
   - Reads `catalyst.worktree.setup` from config for project-specific setup
   - Copies `.claude/` and `.catalyst/` directories
   - Falls back to auto-detected setup if no config (dependency install + thoughts init)

4. **Project setup** (handled by script based on config):

   If `catalyst.worktree.setup` is defined in config, those commands run in order.
   Otherwise, the script auto-detects: dependency install (`bun/npm`) + thoughts init.

   Example config for full control:
   ```json
   {
     "catalyst": {
       "worktree": {
         "setup": [
           "humanlayer thoughts init --directory ${DIRECTORY} --profile ${PROFILE}",
           "humanlayer thoughts sync",
           "bun install",
           "~/.claude/scripts/trust-workspace.sh \"$(pwd)\""
         ]
       }
     }
   }
   ```

5. **Optional: Launch implementation session**: If a plan file path was provided, ask if the user
   wants to launch Claude in the worktree:
   ```bash
   humanlayer launch --model opus -w <worktree_path> \
     "/implement_plan <plan_path> and when done: create commit, create PR, update Linear ticket"
   ```

## Worktree Location Convention

Worktree base directory is resolved in this order:

1. `catalyst.orchestration.worktreeDir` from config (explicit override)
2. `~/catalyst/wt/<projectKey>/` (default — reads `catalyst.projectKey` from config)
3. `~/catalyst/wt/<repo>/` (fallback if no config)

**Recommended**: Add `~/catalyst` to Claude Code's `additionalDirectories` in
`~/.claude/settings.json` so all worktrees across projects are automatically trusted.

**Example layout** (for project with `projectKey: "acme"`):

```
~/catalyst/wt/acme/
├── ACME-123-feature/
├── ACME-456-bugfix/
└── ENG-789-oauth/
```

**With orchestration** (multiple named orchestrators):

```
~/catalyst/wt/acme/
├── auth-orch/                       # orchestrator
├── auth-orch-ACME-101/              # worker
├── auth-orch-ACME-102/              # worker
├── dash-orch/                       # another orchestrator
└── dash-orch-ACME-201/              # worker
```

## Example Interaction

```
User: /create-worktree PROJ-123
```
