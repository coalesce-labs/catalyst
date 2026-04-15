#!/usr/bin/env bash
# Catalyst Orchestration Monitor — launcher script
# Finds and starts the orch-monitor web UI with proper prereq checks.
#
# Usage:
#   start-monitor.sh [--port PORT] [--terminal]

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITOR_DIR="$SCRIPT_DIR/orch-monitor"

# ─── Prereq checks ─────────────────────────────────────────────────────────

errors=()

if ! command -v bun &>/dev/null; then
    errors+=("bun is required but not found. Install: curl -fsSL https://bun.sh/install | bash")
fi

if [[ ! -d "$MONITOR_DIR" ]]; then
    errors+=("orch-monitor directory not found at $MONITOR_DIR")
fi

if [[ ! -f "$MONITOR_DIR/server.ts" ]]; then
    errors+=("server.ts not found in $MONITOR_DIR")
fi

if ! command -v sqlite3 &>/dev/null; then
    errors+=("sqlite3 is required for session history")
fi

if [[ ! -d "$CATALYST_DIR" ]]; then
    errors+=("Catalyst directory missing: $CATALYST_DIR — run /catalyst-dev:setup-catalyst first")
fi

if [[ ! -d "$CATALYST_DIR/wt" ]]; then
    errors+=("Worktree directory missing: $CATALYST_DIR/wt/ — run /catalyst-dev:setup-catalyst first")
fi

DB_FILE="${CATALYST_DB_FILE:-$CATALYST_DIR/catalyst.db}"
if [[ ! -f "$DB_FILE" ]]; then
    echo -e "${YELLOW}⚠️  Session database not found ($DB_FILE) — session history will be empty${NC}"
    echo -e "${YELLOW}   Run /catalyst-dev:setup-catalyst to initialize${NC}"
    echo ""
fi

if [[ ${#errors[@]} -gt 0 ]]; then
    echo -e "${RED}Cannot start monitor:${NC}"
    for err in "${errors[@]}"; do
        echo -e "  ${RED}•${NC} $err"
    done
    exit 1
fi

# ─── Check for existing instance ───────────────────────────────────────────

PORT="${MONITOR_PORT:-7400}"

# Parse args
EXTRA_ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --port) PORT="$2"; shift 2 ;;
        --terminal|--terminal-only) EXTRA_ARGS+=("$1"); shift ;;
        *) EXTRA_ARGS+=("$1"); shift ;;
    esac
done

if (echo >/dev/tcp/localhost/"$PORT") 2>/dev/null; then
    echo -e "${YELLOW}⚠️  Port $PORT is already in use — monitor may already be running${NC}"
    echo -e "   Check: lsof -i :$PORT"
    echo -e "   Or use: start-monitor.sh --port <other-port>"
    exit 1
fi

# ─── Install dependencies if needed ────────────────────────────────────────

if [[ ! -d "$MONITOR_DIR/node_modules" ]]; then
    echo -e "${YELLOW}Installing orch-monitor dependencies...${NC}"
    (cd "$MONITOR_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)
    echo ""
fi

if [[ ! -d "$MONITOR_DIR/ui/node_modules" ]]; then
    echo -e "${YELLOW}Installing orch-monitor UI dependencies...${NC}"
    (cd "$MONITOR_DIR/ui" && bun install --frozen-lockfile 2>/dev/null || bun install)
    echo ""
fi

# ─── Build frontend if needed ──────────────────────────────────────────────

if [[ ! -d "$MONITOR_DIR/ui/dist" ]]; then
    echo -e "${YELLOW}Building orch-monitor frontend...${NC}"
    (cd "$MONITOR_DIR/ui" && bunx vite build)
    echo ""
fi

# ─── Start ─────────────────────────────────────────────────────────────────

echo -e "${GREEN}Starting Catalyst Orchestration Monitor${NC}"
echo -e "  URL:      http://localhost:$PORT"
echo -e "  Watching: $CATALYST_DIR/wt/"
echo -e "  Database: $DB_FILE"
echo ""

export MONITOR_PORT="$PORT"
export CATALYST_DIR
exec bun run "$MONITOR_DIR/server.ts" "${EXTRA_ARGS[@]}"
