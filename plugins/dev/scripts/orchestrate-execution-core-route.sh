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
ACTION="${1-}"
if [ -z "$ACTION" ]; then
	echo "usage: orchestrate-execution-core-route.sh {enroll|stop}" >&2
	exit 1
fi

# repoRoot = canonical main working tree. `git rev-parse --git-common-dir`
# returns the main repo's .git even from a linked worktree; its parent is the
# main working tree. Guard the call: under `set -euo pipefail` an unguarded
# failure aborts with git's raw "fatal: not a git repository" (exit 128) and
# no script-level context about whether enrollment partially happened.
COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null) || {
	echo "error: orchestrate-execution-core-route.sh must run inside a git repository" >&2
	exit 1
}
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
# Daemon-lifecycle helper — a single executable path, never a command string.
# Invoked as `"$EC_DAEMON" <subcommand>` so the path and the subcommand never
# share one word-split-prone string: the old unquoted `$ENSURE_DAEMON`
# expansion broke if SCRIPT_DIR contained a space. Overridable for tests.
EC_DAEMON="${EXECUTION_CORE_ENSURE_DAEMON:-$SCRIPT_DIR/catalyst-execution-core}"

case "$ACTION" in
enroll)
	bun "$EC_INDEX" enroll --project-key "$PROJECT_KEY" --repo-root "$REPO_ROOT"
	# Ensure-and-verify: `start` is best-effort, `probe` is the authoritative
	# check that the daemon is actually serving before we report success. The
	# old code printed "daemon ensured" unconditionally — even when the daemon
	# never came up.
	"$EC_DAEMON" start || true
	if "$EC_DAEMON" probe; then
		echo "execution-core: enrolled $PROJECT_KEY ($REPO_ROOT); daemon running"
	else
		echo "error: execution-core enrolled $PROJECT_KEY but the daemon is not" \
			"running — check the daemon log" >&2
		exit 1
	fi
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
