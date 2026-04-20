#!/usr/bin/env bash
# Register this Catalyst checkout as a local-path plugin marketplace so Claude Code loads
# plugins directly from your working tree. Useful for dogfooding changes on `main` between
# daily releases — run `git pull` in this checkout and restart Claude Code sessions to pick up
# new code.
#
# See docs/releases.md "Intraday consumption" for context.
#
# Usage:
#   bash scripts/install-dev-marketplace.sh [--scope user|project|local]
#
# Default scope is `user` (applies to all your Claude Code sessions).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SCOPE="user"
if [[ "${1:-}" == "--scope" && -n "${2:-}" ]]; then
  SCOPE="$2"
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "error: 'claude' CLI not found on PATH" >&2
  exit 1
fi

if [[ ! -f "${REPO_ROOT}/.claude-plugin/marketplace.json" ]]; then
  echo "error: ${REPO_ROOT}/.claude-plugin/marketplace.json not found — is this a Catalyst checkout?" >&2
  exit 1
fi

echo "Registering ${REPO_ROOT} as a local Catalyst marketplace (scope=${SCOPE})"
claude plugin marketplace add "${REPO_ROOT}" --scope "${SCOPE}"

cat <<EOF

Dev marketplace registered.

Next steps:
  1. Restart any running Claude Code sessions to pick up the local marketplace.
  2. To update, run \`git pull\` in ${REPO_ROOT} and restart Claude Code sessions.
  3. To revert to the published marketplace, remove this entry via
     \`claude plugin marketplace remove\` and re-add the public one.

Note: Claude Code caches plugins by the version field in each plugin.json. If a
git pull brings code changes but no version bump (normal between daily cuts), a
session restart is usually enough to pick them up; if not, toggle the plugin
off/on via \`/plugin\` or run \`claude --plugin-dir ${REPO_ROOT}/plugins/dev\`
(and similar for other plugins) for a fully uncached load.
EOF
