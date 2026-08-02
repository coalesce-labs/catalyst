#!/usr/bin/env bash
# Wrapper so run-tests.sh discovers the lib/__tests__ worktree-remove-guard suite (CTL-1417).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "${SCRIPT_DIR}/../lib/__tests__/worktree-remove-guard.test.sh"
