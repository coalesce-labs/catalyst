---
name: setup-orchestrate
description:
  "Bootstrap an orchestrator worktree and print a ready-to-run command. Use when the user wants to
  start an orchestration run — creates the worktree, initializes global state, and outputs a single
  copy-paste command to launch the orchestrator in a new terminal."
disable-model-invocation: true
allowed-tools: Bash, Read
version: 1.0.0
---

# Setup Orchestrate

Create an orchestrator worktree and provide the user with a single command to launch the
orchestration run. This skill handles all the bootstrapping so the user never touches shell scripts
directly.

## Process

### Step 1: Validate Environment

Confirm you are in the **main repo root** (not an existing worktree):

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ]; then
  echo "ERROR: Not in a git repository"
  exit 1
fi

# Warn if inside a worktree (not the main working tree)
COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null)
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
if [ "$COMMON_DIR" != "$GIT_DIR" ]; then
  echo "WARNING: You are inside a git worktree, not the main repo."
  echo "Run this from the main repo root instead."
fi
```

### Step 2: Read Config

Read the project config to get `projectKey` and orchestration settings:

```bash
CONFIG_FILE=""
for CFG in "${REPO_ROOT}/.catalyst/config.json" "${REPO_ROOT}/.claude/config.json"; do
  if [ -f "$CFG" ]; then
    CONFIG_FILE="$CFG"
    break
  fi
done

if [ -z "$CONFIG_FILE" ]; then
  echo "ERROR: No .catalyst/config.json or .claude/config.json found."
  echo "Create one from the template: /catalyst-dev:linearis"
  exit 1
fi

PROJECT_KEY=$(jq -r '.catalyst.projectKey // empty' "$CONFIG_FILE")
TICKET_PREFIX=$(jq -r '.catalyst.project.ticketPrefix // empty' "$CONFIG_FILE")
PROJECT_NAME=$(jq -r '.catalyst.project.name // empty' "$CONFIG_FILE")
```

### Step 3: Determine Orchestrator Name

Ask the user what to name this orchestration run. Suggest a sensible default based on the date:

- Default suggestion: `orch-YYYY-MM-DD` (e.g., `orch-2026-04-13`)
- User can provide a custom name (e.g., `auth-sprint`, `api-redesign`)

The name is used for the orchestrator worktree directory and branch name.

### Step 4: Initialize Global State

Ensure `~/catalyst/state.json` exists:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/catalyst-state.sh" init
```

This is idempotent — safe to run if it already exists.

### Step 5: Create Orchestrator Worktree

Run the create-worktree script for the orchestrator:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/create-worktree.sh" "<orchestrator-name>" main
```

This automatically:
- Creates `~/catalyst/wt/<projectKey>/<orchestrator-name>/`
- Copies `.claude/` and `.catalyst/` directories
- Pre-trusts the worktree in Claude Code (no trust dialog)
- Initializes workflow context
- Generates `.envrc` for OTEL
- Runs project setup hooks (`bun install`, etc.)

### Step 6: Determine Ticket Source

Ask the user how they want to select tickets for orchestration. Present these options:

1. **Specific tickets**: `ADV-101 ADV-102 ADV-103`
2. **Current cycle**: `--cycle current` (pulls all in-progress tickets from the current Linear cycle)
3. **Project**: `--project "Project Name"` (pulls tickets from a Linear project)
4. **Dry run first**: Add `--dry-run` to see the wave plan without dispatching workers

### Step 7: Output Launch Command

After the worktree is created and the user has chosen their ticket source, print a single
copy-paste command block:

```
════════════════════════════════════════════════════════
  Orchestrator worktree ready!

  Run this command in a new terminal:

  cd ~/catalyst/wt/<projectKey>/<orchestrator-name> && claude "/catalyst-dev:orchestrate <ticket-args>"
════════════════════════════════════════════════════════
```

Replace `<ticket-args>` with the user's chosen ticket source (e.g., `ADV-101 ADV-102`,
`--cycle current`, `--project "Adva Platform"`).

If the user wants a dry run, append `--dry-run`:

```
cd ~/catalyst/wt/<projectKey>/<orchestrator-name> && claude "/catalyst-dev:orchestrate <ticket-args> --dry-run"
```

## Important

- Do NOT run the orchestrate skill yourself — the user needs to run it from the new worktree in a
  separate Claude session
- The orchestrator must run from its own worktree so it can create worker worktrees as siblings
- Always suggest `--dry-run` first so the user can review the wave plan before committing
