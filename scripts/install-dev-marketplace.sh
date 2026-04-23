#!/usr/bin/env bash
# Register this Catalyst checkout as a local-path plugin marketplace so Claude Code loads
# plugins directly from your working tree. Useful for dogfooding changes on `main` between
# daily releases — run `git pull` in this checkout and restart Claude Code sessions to pick up
# new code.
#
# See docs/releases.md "Intraday consumption" for context.
#
# Usage:
#   bash scripts/install-dev-marketplace.sh [--scope user|project|local] [--allow-worktree] [--help]
#
# Default scope is `user` (applies to all your Claude Code sessions).
#
# Refuses to run from a linked git worktree unless `--allow-worktree` is passed — registering a
# worktree freezes the installed plugin at that worktree's branch HEAD (CTL-120).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SCOPE="user"
ALLOW_WORKTREE=0

usage() {
  cat <<'EOF'
Usage:
  bash scripts/install-dev-marketplace.sh [--scope user|project|local] [--allow-worktree] [--help]

Options:
  --scope <user|project|local>   Plugin marketplace scope (default: user).
  --allow-worktree               Allow registration from a linked git worktree.
                                 DANGEROUS: freezes the installed plugin at that
                                 worktree branch's HEAD.
  --help, -h                     Print this message and exit.
EOF
}

while (( $# )); do
  case "$1" in
    --scope)
      if [[ -z "${2:-}" ]]; then
        echo "error: --scope requires a value" >&2
        usage >&2
        exit 1
      fi
      SCOPE="$2"
      shift 2
      ;;
    --allow-worktree)
      ALLOW_WORKTREE=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

CLAUDE_CMD="${CATALYST_CLAUDE_CMD:-claude}"

if ! command -v "${CLAUDE_CMD%% *}" >/dev/null 2>&1; then
  echo "error: '${CLAUDE_CMD}' CLI not found on PATH" >&2
  exit 1
fi

if [[ ! -f "${REPO_ROOT}/.claude-plugin/marketplace.json" ]]; then
  echo "error: ${REPO_ROOT}/.claude-plugin/marketplace.json not found — is this a Catalyst checkout?" >&2
  exit 1
fi

# Worktree guard (CTL-120): detect linked worktrees and refuse to register unless opted in.
MAIN_WT=""
BRANCH="<unknown>"
if git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  MAIN_WT="$(git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')"
  BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '<unknown>')"
fi

# Normalize both paths through physical pwd so /var vs /private/var symlinks on macOS
# (and any other symlinked prefixes) don't cause the main-worktree path compare to false-fire.
canonicalize_path() { (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"; }
REPO_ROOT_CANON="$(canonicalize_path "$REPO_ROOT")"
MAIN_WT_CANON=""
if [[ -n "$MAIN_WT" ]]; then
  MAIN_WT_CANON="$(canonicalize_path "$MAIN_WT")"
fi

if [[ -n "$MAIN_WT_CANON" && "$REPO_ROOT_CANON" != "$MAIN_WT_CANON" ]]; then
  if [[ "$ALLOW_WORKTREE" != "1" ]]; then
    cat >&2 <<EOF
error: refusing to register a linked git worktree as a plugin marketplace

  worktree path:   ${REPO_ROOT}
  worktree branch: ${BRANCH}
  main worktree:   ${MAIN_WT}

Registering a linked worktree freezes the installed plugin at this worktree's
HEAD. Re-run this script from the main checkout:

  bash ${MAIN_WT}/scripts/install-dev-marketplace.sh --scope ${SCOPE}

Or pass --allow-worktree if you really mean to register this path.
EOF
    exit 1
  fi
  cat >&2 <<EOF
warning: registering a linked git worktree as a plugin marketplace

  worktree path:   ${REPO_ROOT}
  worktree branch: ${BRANCH}
  main worktree:   ${MAIN_WT}

The installed plugin will be frozen at this worktree's HEAD until re-registered.
EOF
fi

echo "Registering ${REPO_ROOT} as a local Catalyst marketplace (scope=${SCOPE}, branch=${BRANCH})"
"$CLAUDE_CMD" plugin marketplace add "${REPO_ROOT}" --scope "${SCOPE}"

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
