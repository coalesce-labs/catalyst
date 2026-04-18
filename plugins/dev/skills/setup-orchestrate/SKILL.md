---
name: setup-orchestrate
description:
  "Bootstrap an orchestrator worktree and print a ready-to-run command. Use when the user wants to
  start an orchestration run — creates the worktree, initializes global state, and outputs a single
  copy-paste command to launch the orchestrator in a new terminal."
disable-model-invocation: true
allowed-tools: Bash, Read
version: 1.2.0
---

# Setup Orchestrate

Create an orchestrator worktree and output a single copy-paste command to launch the orchestration
run. No questions — parse the input, create the worktree, print the command.

## Input Format

```
/catalyst-dev:setup-orchestrate <ticket-ids...>
/catalyst-dev:setup-orchestrate --cycle current
/catalyst-dev:setup-orchestrate --project "Project Name"
/catalyst-dev:setup-orchestrate --auto N
```

The input MUST be one of:
- **Ticket IDs**: space-separated (e.g., `ADV-214 ADV-215 ADV-208`)
- **Cycle flag**: `--cycle current`
- **Project flag**: `--project "Project Name"`
- **Auto flag**: `--auto N` — orchestrate skill will pick top N Todo tickets

If no input is provided, stop and tell the user:
```
Usage: /catalyst-dev:setup-orchestrate <ticket-ids...>
       /catalyst-dev:setup-orchestrate --cycle current
       /catalyst-dev:setup-orchestrate --project "Project Name"
       /catalyst-dev:setup-orchestrate --auto N
```

**Do NOT** analyze tickets, suggest sequencing, research ticket details, or do any work beyond
creating the worktree. Wave planning and dependency analysis is the orchestrate skill's job.

## Process

Execute all steps without asking questions. No confirmations, no menus, no options.

### Step 1: Parse Input

Determine which mode the user invoked:
- If the input contains `--cycle`, extract the value (e.g., `current`)
- If the input contains `--project`, extract the quoted value (e.g., `"Project Name"`)
- If the input contains `--auto`, extract the integer N that follows (e.g., `5`)
- Otherwise, treat all tokens as space-separated ticket IDs

### Step 2: Call setup-orchestrator.sh

Build the flag string from the parsed input and call the standalone script:

```bash
# For ticket IDs:
"${CLAUDE_PLUGIN_ROOT}/scripts/setup-orchestrator.sh" --tickets "<ticket-ids>"

# For cycle mode:
"${CLAUDE_PLUGIN_ROOT}/scripts/setup-orchestrator.sh" --cycle current

# For project mode:
"${CLAUDE_PLUGIN_ROOT}/scripts/setup-orchestrator.sh" --project "<project-name>"

# For auto mode:
"${CLAUDE_PLUGIN_ROOT}/scripts/setup-orchestrator.sh" --auto <N>
```

The script handles everything: validation, config reading, state init, worktree creation.

### Step 3: Format Output

The script prints a formatted output block with the worktree path and launch commands.
Display the script's output directly — it already includes the ═══ banner with dry-run
and full-run commands, plus the machine-readable `WORKTREE_PATH=...` line.

## Rules

- **No questions.** Parse input, execute, print command. The entire skill should complete in one
  turn with zero user interaction.
- **No ticket analysis.** Do not fetch ticket details, suggest sequencing, or build wave plans.
  That is Phase 1 of the orchestrate skill.
- **No worktree option.** Always refuse if not on main repo. Do not offer alternatives.
- **No custom names.** Always auto-generate `orch-YYYY-MM-DD[-N]`.
- **Always show both commands** — dry run first, full run second.
- **Do NOT run the orchestrate skill** — the user runs it from the new worktree in a new terminal.
