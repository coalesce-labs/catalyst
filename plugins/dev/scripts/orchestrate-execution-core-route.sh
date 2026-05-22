#!/usr/bin/env bash
# orchestrate-execution-core-route.sh — /orchestrate's execution-core fork
# (CTL-554, CTL-582). In execution-core dispatchMode /orchestrate runs no wave
# loop and no Phase 4 session.
#
# CTL-582 (D4) made the central registry ~/catalyst/execution-core/registry.json
# the single source of enrolled projects, maintained by setup tooling
# (setup-execution-core-states.sh). There is nothing for /orchestrate to enroll
# or deregister — this helper only ensures the machine-level daemon is running.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Daemon-lifecycle helper — a single executable path, never a command string,
# so the path and the subcommand never share one word-split-prone string.
# Overridable for tests.
EC_DAEMON="${EXECUTION_CORE_ENSURE_DAEMON:-$SCRIPT_DIR/catalyst-execution-core}"

# Ensure-and-verify: `start` is best-effort, `probe` is the authoritative check
# that the daemon is actually serving before we report success.
"$EC_DAEMON" start || true
if "$EC_DAEMON" probe; then
	echo "execution-core: daemon running — enrolled projects are the central" \
		"registry (~/catalyst/execution-core/registry.json)"
else
	echo "error: the execution-core daemon is not running — check the daemon log" >&2
	exit 1
fi
