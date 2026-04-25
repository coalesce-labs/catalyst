#!/usr/bin/env bash
# setup-orchestrator.sh — Standalone orchestrator worktree bootstrap
#
# Creates an orch-YYYY-MM-DD[-N] worktree from the main repo, initializes global
# state, and outputs a machine-readable WORKTREE_PATH for automation. Wraps
# create-worktree.sh with orchestrator-specific naming and state init.
#
# Usage:
#   setup-orchestrator.sh [--tickets "ID1 ID2"] [--cycle current] [--project "Name"]
#                         [--auto N] [--quiet] [--launch]
#
# Flags:
#   --tickets "ID1 ID2"   Ticket IDs to pass through to orchestrate command
#   --cycle current       Use cycle mode (passed through to orchestrate)
#   --project "Name"      Use project mode (passed through to orchestrate)
#   --auto N              Auto-pick top N Todo tickets (passed through to orchestrate)
#   --quiet               Suppress all output except WORKTREE_PATH=... line
#   --launch              Exec claude with /catalyst-dev:orchestrate in the new worktree

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors (suppressed in quiet mode)
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# ─── Parse flags ─────────────────────────────────────────────────────────────

TICKETS=""
CYCLE=""
PROJECT=""
AUTO=""
QUIET=false
LAUNCH=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --tickets)  TICKETS="$2"; shift 2 ;;
    --cycle)    CYCLE="$2"; shift 2 ;;
    --project)  PROJECT="$2"; shift 2 ;;
    --auto)     AUTO="$2"; shift 2 ;;
    --quiet)    QUIET=true; shift ;;
    --launch)   LAUNCH=true; shift ;;
    -h|--help)
      echo "Usage: setup-orchestrator.sh [--tickets \"ID1 ID2\"] [--cycle current] [--project \"Name\"]"
      echo "                             [--auto N] [--quiet] [--launch]"
      echo ""
      echo "Flags:"
      echo "  --tickets \"ID1 ID2\"   Ticket IDs for orchestration"
      echo "  --cycle current       Use cycle mode"
      echo "  --project \"Name\"      Use project mode"
      echo "  --auto N              Auto-pick top N Todo tickets (priority asc, createdAt desc)"
      echo "  --quiet               Output only WORKTREE_PATH=... (for automation)"
      echo "  --launch              Create worktree and exec claude with orchestrate command"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown flag: $1${NC}" >&2
      echo "Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

# At least one input mode required
if [[ -z "$TICKETS" && -z "$CYCLE" && -z "$PROJECT" && -z "$AUTO" ]]; then
  echo -e "${RED}Error: Must provide --tickets, --cycle, --project, or --auto${NC}" >&2
  echo "Usage: setup-orchestrator.sh --tickets \"ID1 ID2\"" >&2
  echo "       setup-orchestrator.sh --cycle current" >&2
  echo "       setup-orchestrator.sh --project \"Project Name\"" >&2
  echo "       setup-orchestrator.sh --auto 5" >&2
  exit 1
fi

log() {
  if [[ "$QUIET" != true ]]; then
    echo -e "$@"
  fi
}

# ─── Step 1: Validate — must be in a git repo ────────────────────────────────

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z "$REPO_ROOT" ]]; then
  echo "ERROR: Not in a git repository" >&2
  exit 1
fi

# ─── Step 2: Read config ─────────────────────────────────────────────────────

CONFIG_FILE=""
for CFG in "${REPO_ROOT}/.catalyst/config.json" "${REPO_ROOT}/.claude/config.json"; do
  if [[ -f "$CFG" ]]; then
    CONFIG_FILE="$CFG"
    break
  fi
done

if [[ -z "$CONFIG_FILE" ]]; then
  echo "ERROR: No .catalyst/config.json found." >&2
  exit 1
fi

PROJECT_KEY=$(jq -r '.catalyst.projectKey // empty' "$CONFIG_FILE")
TICKET_PREFIX=$(jq -r '.catalyst.project.ticketPrefix // empty' "$CONFIG_FILE")

if [[ -z "$PROJECT_KEY" ]]; then
  echo "ERROR: catalyst.projectKey not set in $CONFIG_FILE" >&2
  exit 1
fi

log "${YELLOW}Project: ${PROJECT_KEY} (prefix: ${TICKET_PREFIX:-none})${NC}"

# ─── Step 3: Initialize global state and session database ────────────────────

log "Initializing global state..."
"${SCRIPT_DIR}/catalyst-state.sh" init >/dev/null 2>&1

log "Initializing session database..."
"${SCRIPT_DIR}/catalyst-db.sh" init 2>&1 | while read -r line; do log "  $line"; done

# ─── Step 4: Auto-generate worktree name ──────────────────────────────────────

slugify() {
  printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C tr -c '[:alnum:]-' '-' \
    | sed -E 's/-+/-/g; s/^-//; s/-$//' | cut -c1-30
}

TODAY=$(date +%Y-%m-%d)

SLUG=""
if [[ -n "$PROJECT" ]]; then
  SLUG=$(slugify "$PROJECT")
elif [[ -n "$CYCLE" ]]; then
  SLUG="cycle-$(slugify "$CYCLE")"
elif [[ -n "$TICKETS" ]]; then
  # Use first ticket as slug
  FIRST_TICKET="${TICKETS%% *}"
  SLUG=$(slugify "$FIRST_TICKET")
elif [[ -n "$AUTO" ]]; then
  SLUG="auto${AUTO}"
fi

if [[ -n "$SLUG" ]]; then
  ORCH_NAME="orch-${SLUG}-${TODAY}"
else
  ORCH_NAME="orch-${TODAY}"
fi

WT_DIR_CONFIG=$(jq -r '.catalyst.orchestration.worktreeDir // empty' "$CONFIG_FILE" 2>/dev/null)
if [[ -n "$WT_DIR_CONFIG" ]]; then
  WORKTREES_BASE="${WT_DIR_CONFIG/#\~/$HOME}"
else
  WORKTREES_BASE="$HOME/catalyst/wt/${PROJECT_KEY}"
fi

if [[ -d "${WORKTREES_BASE}/${ORCH_NAME}" ]]; then
  N=2
  while [[ -d "${WORKTREES_BASE}/${ORCH_NAME}-${N}" ]]; do
    N=$((N + 1))
  done
  ORCH_NAME="${ORCH_NAME}-${N}"
fi

log "Worktree name: ${ORCH_NAME}"

# ─── Step 5: Create the worktree ──────────────────────────────────────────────

log ""
if [[ "$QUIET" == true ]]; then
  "${SCRIPT_DIR}/create-worktree.sh" "$ORCH_NAME" main --orchestration "$ORCH_NAME" >/dev/null
else
  "${SCRIPT_DIR}/create-worktree.sh" "$ORCH_NAME" main --orchestration "$ORCH_NAME"
fi

WORKTREE_PATH="${WORKTREES_BASE}/${ORCH_NAME}"

# ─── Step 5b: Create per-orchestrator runs/ directory (CTL-59) ────────────────
# State (state.json, DASHBOARD.md, workers/) lives under ~/catalyst/runs/<id>/
# so it is decoupled from the git worktree.

RUN_DIR=$("${SCRIPT_DIR}/catalyst-state.sh" ensure-run-dir "$ORCH_NAME")
log "Run dir: ${RUN_DIR}"

# ─── Step 6: Build ticket args string for commands ────────────────────────────

TICKET_ARGS=""
if [[ -n "$TICKETS" ]]; then
  TICKET_ARGS="$TICKETS"
elif [[ -n "$CYCLE" ]]; then
  TICKET_ARGS="--cycle $CYCLE"
elif [[ -n "$PROJECT" ]]; then
  TICKET_ARGS="--project \"$PROJECT\""
elif [[ -n "$AUTO" ]]; then
  TICKET_ARGS="--auto $AUTO"
fi

# ─── Step 7: Output ──────────────────────────────────────────────────────────

DISPLAY_PATH="${WORKTREE_PATH/#$HOME/~}"
MONITOR_SCRIPT="${SCRIPT_DIR}/orch-monitor/server.ts"
DISPLAY_MONITOR="${MONITOR_SCRIPT/#$HOME/~}"

if [[ "$QUIET" != true && "$LAUNCH" != true ]]; then
  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo " Orchestrator ready: ${DISPLAY_PATH}"
  echo ""
  echo " Dry run (preview wave plan):"
  echo "   cd ${DISPLAY_PATH} && claude \"/catalyst-dev:orchestrate ${TICKET_ARGS} --dry-run\""
  echo ""
  echo " Full run (dispatch workers):"
  echo "   cd ${DISPLAY_PATH} && claude \"/catalyst-dev:orchestrate ${TICKET_ARGS}\""
  echo ""
  echo " Monitor (optional — real-time web + terminal dashboard):"
  echo "   bun run ${DISPLAY_MONITOR}"
  echo "════════════════════════════════════════════════════════════════"
fi

# Machine-readable output (skip in --launch mode — claude would see it flash by)
if [[ "$LAUNCH" != true ]]; then
  echo "WORKTREE_PATH=${WORKTREE_PATH}"
  echo "RUN_DIR=${RUN_DIR}"
  echo "ORCH_ID=${ORCH_NAME}"
fi

# ─── Optional: launch claude in the new worktree ──────────────────────────────

if [[ "$LAUNCH" == true ]]; then
  log ""
  log "${GREEN}Launching claude in ${DISPLAY_PATH}...${NC}"
  cd "$WORKTREE_PATH"
  exec claude "/catalyst-dev:orchestrate ${TICKET_ARGS}"
fi
