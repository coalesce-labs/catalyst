#!/usr/bin/env bash
# orchestrate-execution-core-route.sh — /orchestrate's execution-core fork
# (CTL-554). In execution-core dispatchMode /orchestrate runs no wave loop and
# no Phase 4 session: it delegates here to enroll (or deregister) the project
# and ensure the machine-level daemon, then exits.
#
#   enroll  — write the enrollment record + ensure the daemon is running
#   stop    — remove the enrollment record (daemon keeps serving other projects)
#
# projectKey/repoRoot are resolved here so the logic is unit-testable:
#   repoRoot   = parent of the git common dir (the canonical main working tree,
#                never a linked worktree)
#   projectKey = .catalyst.project.key, falling back to basename(repoRoot)

set -euo pipefail

# Note: a literal `{enroll|stop}` inside a `${1:?...}` default-error message
# would mis-close the parameter expansion on its first `}`, so validate
# explicitly instead.
ACTION="${1:-}"
if [ -z "$ACTION" ]; then
  echo "usage: orchestrate-execution-core-route.sh {enroll|stop}" >&2
  exit 1
fi

# repoRoot = canonical main working tree. `git rev-parse --git-common-dir`
# returns the main repo's .git even from a linked worktree; its parent is the
# main working tree.
COMMON_DIR=$(git rev-parse --git-common-dir)
case "$COMMON_DIR" in
  /*) ;;
  *) COMMON_DIR="$(pwd)/$COMMON_DIR" ;;
esac
REPO_ROOT=$(cd "$(dirname "$COMMON_DIR")" && pwd)

CONFIG="$REPO_ROOT/.catalyst/config.json"
PROJECT_KEY=$(jq -r '.catalyst.project.key // empty' "$CONFIG" 2>/dev/null || true)
[ -n "$PROJECT_KEY" ] || PROJECT_KEY=$(basename "$REPO_ROOT")

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EC_INDEX="$SCRIPT_DIR/execution-core/index.mjs"
ENSURE_DAEMON="${EXECUTION_CORE_ENSURE_DAEMON:-$SCRIPT_DIR/catalyst-execution-core start}"

case "$ACTION" in
  enroll)
    bun "$EC_INDEX" enroll --project-key "$PROJECT_KEY" --repo-root "$REPO_ROOT"
    $ENSURE_DAEMON
    echo "execution-core: enrolled $PROJECT_KEY ($REPO_ROOT); daemon ensured"
    ;;
  stop)
    bun "$EC_INDEX" unenroll --project-key "$PROJECT_KEY"
    echo "execution-core: deregistered $PROJECT_KEY (daemon keeps serving other projects)"
    ;;
  *)
    echo "unknown action: $ACTION" >&2
    exit 1
    ;;
esac
