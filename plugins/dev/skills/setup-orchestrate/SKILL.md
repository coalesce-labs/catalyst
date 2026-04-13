---
name: setup-orchestrate
description:
  "Bootstrap an orchestrator worktree and print a ready-to-run command. Use when the user wants to
  start an orchestration run — creates the worktree, initializes global state, and outputs a single
  copy-paste command to launch the orchestrator in a new terminal."
disable-model-invocation: true
allowed-tools: Bash, Read
version: 1.1.0
---

# Setup Orchestrate

Create an orchestrator worktree and output a single copy-paste command to launch the orchestration
run. No questions — parse the input, create the worktree, print the command.

## Input Format

```
/catalyst-dev:setup-orchestrate <ticket-ids...>
/catalyst-dev:setup-orchestrate --cycle current
/catalyst-dev:setup-orchestrate --project "Project Name"
```

The input MUST be one of:
- **Ticket IDs**: space-separated (e.g., `ADV-214 ADV-215 ADV-208`)
- **Cycle flag**: `--cycle current`
- **Project flag**: `--project "Project Name"`

If no input is provided, stop and tell the user:
```
Usage: /catalyst-dev:setup-orchestrate <ticket-ids...>
       /catalyst-dev:setup-orchestrate --cycle current
       /catalyst-dev:setup-orchestrate --project "Project Name"
```

**Do NOT** analyze tickets, suggest sequencing, research ticket details, or do any work beyond
creating the worktree. Wave planning and dependency analysis is the orchestrate skill's job.

## Process

Execute all steps without asking questions. No confirmations, no menus, no options.

### Step 1: Validate — Must Be Main Repo

You MUST be in the main repo root, not a worktree. Check and **hard stop** if wrong:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null)
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)

if [ -z "$REPO_ROOT" ]; then
  echo "ERROR: Not in a git repository"; exit 1
fi

if [ "$COMMON_DIR" != "$GIT_DIR" ]; then
  MAIN_REPO=$(git -C "$(git rev-parse --git-common-dir)" rev-parse --show-toplevel 2>/dev/null)
  echo "ERROR: You are inside a git worktree, not the main repo."
  echo "Run this from: ${MAIN_REPO:-the main repo root}"
  exit 1
fi
```

If the check fails, print the error and **stop**. Do not offer to continue from the worktree.

### Step 2: Read Config

```bash
CONFIG_FILE=""
for CFG in "${REPO_ROOT}/.catalyst/config.json" "${REPO_ROOT}/.claude/config.json"; do
  if [ -f "$CFG" ]; then CONFIG_FILE="$CFG"; break; fi
done

if [ -z "$CONFIG_FILE" ]; then
  echo "ERROR: No .catalyst/config.json found. See /catalyst-dev:linearis for setup."
  exit 1
fi

PROJECT_KEY=$(jq -r '.catalyst.projectKey // empty' "$CONFIG_FILE")
TICKET_PREFIX=$(jq -r '.catalyst.project.ticketPrefix // empty' "$CONFIG_FILE")
```

### Step 3: Initialize Global State

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/catalyst-state.sh" init
```

Idempotent — safe to run every time.

### Step 4: Create Orchestrator Worktree

Auto-generate the name from today's date: `orch-YYYY-MM-DD`. If that already exists, append
`-2`, `-3`, etc.

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/create-worktree.sh" "<orch-name>" main
```

Do not ask for a custom name. The auto-generated name is always used.

### Step 5: Build and Print Launch Command

Construct the ticket arguments from the user's input exactly as provided (ticket IDs, --cycle, or
--project). Always append `--dry-run` to the first suggested command.

Print this block:

```
════════════════════════════════════════════════════════════════
 Orchestrator ready: ~/catalyst/wt/<projectKey>/<orch-name>

 Dry run (preview wave plan):
   cd ~/catalyst/wt/<projectKey>/<orch-name> && claude "/catalyst-dev:orchestrate <ticket-args> --dry-run"

 Full run (dispatch workers):
   cd ~/catalyst/wt/<projectKey>/<orch-name> && claude "/catalyst-dev:orchestrate <ticket-args>"

 Monitor (optional — real-time web + terminal dashboard):
   bun run ${CLAUDE_PLUGIN_ROOT}/scripts/orch-monitor/server.ts
   Open http://<tailscale-ip>:7400 on any device
════════════════════════════════════════════════════════════════
```

## Rules

- **No questions.** Parse input, execute, print command. The entire skill should complete in one
  turn with zero user interaction.
- **No ticket analysis.** Do not fetch ticket details, suggest sequencing, or build wave plans.
  That is Phase 1 of the orchestrate skill.
- **No worktree option.** Always refuse if not on main repo. Do not offer alternatives.
- **No custom names.** Always auto-generate `orch-YYYY-MM-DD[-N]`.
- **Always show both commands** — dry run first, full run second.
- **Do NOT run the orchestrate skill** — the user runs it from the new worktree in a new terminal.
