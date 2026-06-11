#!/usr/bin/env bash
# setup-plugin-source.sh — provision a pristine, main-only plugin-source
# checkout and register it as catalyst.orchestration.pluginDirs in the machine
# config (CTL-992).
#
# What this script does:
#   1. Clones (or reuses) a dedicated checkout of the catalyst repo on main,
#      single-branch, at <path> (default ~/catalyst/plugin-source).
#   2. Refuses to use a linked git worktree or a non-main checkout as the
#      source — workers must run from a pristine, standalone, main-only tree.
#   3. ff-only pulls origin/main into the reused checkout to keep it fresh.
#   4. Registers <path>/plugins/dev as catalyst.orchestration.pluginDirs in the
#      machine config (Layer 2), preserving every other key.
#
# Re-running is safe and idempotent: when pluginDirs already points at the
# resolved target, the config write is skipped (the ff-only pull still runs).
# Pass --force to re-register a different checkout path.
#
# The path of the machine config is resolved via lib/plugin-dirs.sh — the same
# single source of truth phase-agent-dispatch and catalyst-stack use, so the
# dir registered here is exactly the dir the dispatcher hands to workers.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Single source of truth for the machine-config path + resolution order.
# shellcheck source=lib/plugin-dirs.sh
if [[ ! -f "${SCRIPT_DIR}/lib/plugin-dirs.sh" ]]; then
	echo "ERROR: missing lib/plugin-dirs.sh next to setup-plugin-source.sh" >&2
	exit 1
fi
# shellcheck disable=SC1091
. "${SCRIPT_DIR}/lib/plugin-dirs.sh"

DEFAULT_PATH="${CATALYST_PLUGIN_SOURCE:-$HOME/catalyst/plugin-source}"
CHECKOUT_PATH=""
REPO_URL=""
FORCE=0

usage() {
	cat <<EOF
Usage: $(basename "$0") [--path DIR] [--repo-url URL] [--force]

Provisions a pristine main-only plugin-source checkout and registers it as
catalyst.orchestration.pluginDirs in the machine config.

Options:
  --path DIR        Checkout location (default: ${DEFAULT_PATH}).
                    Override the default via \$CATALYST_PLUGIN_SOURCE.
  --repo-url URL    Clone source. Defaults to this repo's origin (https).
  --force           Re-register even if pluginDirs is already set to a
                    different path.
  -h|--help         Show this message.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--path)
			if [[ $# -lt 2 || -z "${2:-}" ]]; then
				echo "ERROR: --path requires an argument" >&2
				exit 1
			fi
			CHECKOUT_PATH="$2"; shift 2 ;;
		--repo-url)
			if [[ $# -lt 2 || -z "${2:-}" ]]; then
				echo "ERROR: --repo-url requires an argument" >&2
				exit 1
			fi
			REPO_URL="$2"; shift 2 ;;
		--force) FORCE=1; shift ;;
		-h|--help) usage; exit 0 ;;
		*) echo "Unknown option: $1" >&2; usage; exit 1 ;;
	esac
done

require_cmd() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "ERROR: '$1' is required but not installed" >&2
		exit 1
	fi
}
require_cmd git
require_cmd jq

CHECKOUT_PATH="${CHECKOUT_PATH:-$DEFAULT_PATH}"

# Derive the repo URL from this repo's origin (https) when not supplied.
if [[ -z "$REPO_URL" ]]; then
	REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
	REPO_URL="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
	if [[ -z "$REPO_URL" ]]; then
		REPO_URL="https://github.com/coalesce-labs/catalyst.git"
	fi
fi
# Daemon contexts have no ssh-agent — refuse ssh remotes so the ff-only pull
# stays unattended-fetchable.
case "$REPO_URL" in
	git@*|ssh://*)
		echo "ERROR: repo URL uses ssh ($REPO_URL) — unauthable from daemon contexts; use an https URL" >&2
		exit 1
		;;
esac

# ─── 1. Clone or reuse ──────────────────────────────────────────────────────
if [[ ! -e "${CHECKOUT_PATH}/.git" ]]; then
	echo "Cloning ${REPO_URL} → ${CHECKOUT_PATH} (main, single-branch)…"
	mkdir -p "$(dirname "$CHECKOUT_PATH")"
	GIT_TERMINAL_PROMPT=0 git clone --branch main --single-branch \
		"$REPO_URL" "$CHECKOUT_PATH"
else
	# Refuse a linked worktree: its per-worktree git dir differs from the shared
	# common dir. A pristine plugin source must be a standalone checkout.
	gitdir="$(git -C "$CHECKOUT_PATH" rev-parse --absolute-git-dir 2>/dev/null || true)"
	commondir="$(git -C "$CHECKOUT_PATH" rev-parse --git-common-dir 2>/dev/null || true)"
	if [[ -n "$commondir" && "$commondir" != /* ]]; then
		commondir="$(cd "$CHECKOUT_PATH" && cd "$commondir" 2>/dev/null && pwd -P || true)"
	fi
	if [[ -z "$gitdir" ]]; then
		echo "ERROR: ${CHECKOUT_PATH} is not a git checkout" >&2
		exit 1
	fi
	if [[ -n "$commondir" && "$gitdir" != "$commondir" ]]; then
		echo "ERROR: ${CHECKOUT_PATH} is a linked git worktree, not a standalone checkout — point --path at a dedicated pristine checkout" >&2
		exit 1
	fi

	# Refuse a non-main branch.
	branch="$(git -C "$CHECKOUT_PATH" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
	if [[ "$branch" != "main" ]]; then
		echo "ERROR: ${CHECKOUT_PATH} is on branch '${branch}', not main — the plugin source must be a pristine main checkout" >&2
		exit 1
	fi

	echo "Reusing existing checkout at ${CHECKOUT_PATH} — ff-only pull origin/main…"
	GIT_TERMINAL_PROMPT=0 git -C "$CHECKOUT_PATH" pull --ff-only origin main \
		|| { echo "ERROR: git pull --ff-only failed in ${CHECKOUT_PATH} — resolve manually then retry" >&2; exit 1; }
fi

HEAD_SHA="$(git -C "$CHECKOUT_PATH" rev-parse HEAD)"
TARGET_DIR="${CHECKOUT_PATH}/plugins/dev"

# ─── 2. Register pluginDirs in the machine config ───────────────────────────
MACHINE_CFG="$(plugin_dirs_machine_config_path)"
mkdir -p "$(dirname "$MACHINE_CFG")"
if [[ ! -f "$MACHINE_CFG" ]]; then
	echo "{}" > "$MACHINE_CFG"
fi

CURRENT="$(jq -r '.catalyst.orchestration.pluginDirs // empty' "$MACHINE_CFG" 2>/dev/null || true)"

if [[ "$CURRENT" == "$TARGET_DIR" && $FORCE -eq 0 ]]; then
	echo "pluginDirs already registered as ${TARGET_DIR} in ${MACHINE_CFG} — leaving as-is."
	echo "  checkout: ${CHECKOUT_PATH}"
	echo "  HEAD:     ${HEAD_SHA}"
	exit 0
fi

# Same-directory tmp so the final mv is an atomic same-filesystem rename
# (a default mktemp lands on a different volume on macOS, making mv a
# non-atomic copy+unlink — a crash mid-write would corrupt the config).
tmp="$(mktemp "$(dirname "$MACHINE_CFG")/.config.json.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
jq --arg pd "$TARGET_DIR" '
	.catalyst //= {}
	| .catalyst.orchestration //= {}
	| .catalyst.orchestration.pluginDirs = $pd
' "$MACHINE_CFG" > "$tmp"
mv "$tmp" "$MACHINE_CFG"

echo "Registered pluginDirs in ${MACHINE_CFG}:"
echo "  old: ${CURRENT:-<unset>}"
echo "  new: ${TARGET_DIR}"
echo "  checkout: ${CHECKOUT_PATH}"
echo "  HEAD:     ${HEAD_SHA}"
