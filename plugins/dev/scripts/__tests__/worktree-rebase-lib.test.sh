#!/usr/bin/env bash
# Wrapper so run-tests.sh discovers the lib/__tests__ worktree-rebase suite (CTL-1076).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "${SCRIPT_DIR}/../lib/__tests__/worktree-rebase.test.sh"
