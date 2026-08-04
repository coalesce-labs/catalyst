#!/bin/bash
# create-worktree.sh - Create a git worktree for isolated development
# Usage: ./create-worktree.sh [worktree_name] [base_branch] [--worktree-dir <path>] [--hooks-json <json>] [--orchestration <name>] [--reuse-existing] [--skip-fetch]
#
# Options:
#   --worktree-dir <path>       Override worktree base directory (used by orchestrator)
#   --hooks-json <json>         JSON array of setup hook commands to run after creation
#   --orchestration <name>      Set orchestration run name in workflow context
#   --reuse-existing            If the worktree already exists, skip creation/setup
#                               and succeed. Makes the script idempotent for tab-config
#                               launchers that re-open a long-lived worktree (e.g. "pm").
#   --skip-fetch                Do not fetch the base branch from origin before
#                               creating the worktree. Use for offline or
#                               test-isolated invocations; the new branch will
#                               be rooted on the local <base_branch> tip.

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Parse flags (collect positional args separately)
POSITIONAL=()
OVERRIDE_WORKTREE_DIR=""
HOOKS_JSON=""
ORCHESTRATION_NAME=""
REUSE_EXISTING=false
SKIP_FETCH=false
EXPECTED_BRANCH=""

while [[ $# -gt 0 ]]; do
	case $1 in
		--worktree-dir) OVERRIDE_WORKTREE_DIR="$2"; shift 2 ;;
		--hooks-json) HOOKS_JSON="$2"; shift 2 ;;
		--orchestration) ORCHESTRATION_NAME="$2"; shift 2 ;;
		--reuse-existing) REUSE_EXISTING=true; shift ;;
		--skip-fetch) SKIP_FETCH=true; shift ;;
		# CTL-615: when --reuse-existing returns an existing worktree dir,
		# assert its HEAD is on this branch. Mismatch → exit 64 with a
		# clear diagnostic. The daemon's revive path passes the ticket name
		# so a project-key collision (~/catalyst/wt/CTL/CTL-T3 checked out
		# to ADV-1129) is caught before the bg worker spawns into the wrong
		# tree.
		--expected-branch) EXPECTED_BRANCH="$2"; shift 2 ;;
		*) POSITIONAL+=("$1"); shift ;;
	esac
done

# Get worktree name from positional args
if [ ${#POSITIONAL[@]} -eq 0 ]; then
	echo -e "${RED}Error: Worktree name is required${NC}"
	echo "Usage: ./create-worktree.sh <worktree_name> [base_branch] [--worktree-dir <path>] [--hooks-json <json>]"
	echo ""
	echo "Examples:"
	echo "  ./create-worktree.sh ENG-123"
	echo "  ./create-worktree.sh feature-auth main"
	echo "  ./create-worktree.sh orch-1-ENG-123 main --worktree-dir ~/catalyst/my-app"
	exit 1
fi

WORKTREE_NAME="${POSITIONAL[0]}"
BASE_BRANCH="${POSITIONAL[1]:-$(git branch --show-current)}"

# Get repository information
REPO_ROOT=$(git rev-parse --show-toplevel)
REPO_NAME=$(basename "$REPO_ROOT")

# Try to detect GitHub org from remote URL
GIT_REMOTE=$(git config --get remote.origin.url 2>/dev/null || echo "")
if [[ $GIT_REMOTE =~ github.com[:/]([^/]+)/([^/.]+) ]]; then
	GITHUB_ORG="${BASH_REMATCH[1]}"
	GITHUB_REPO="${BASH_REMATCH[2]}"
else
	GITHUB_ORG=""
	GITHUB_REPO="$REPO_NAME"
fi

# Resolve Catalyst config file (.catalyst/ first, then .claude/)
CONFIG_FILE=""
for CFG in "${REPO_ROOT}/.catalyst/config.json" "${REPO_ROOT}/.claude/config.json"; do
	if [ -f "$CFG" ]; then
		CONFIG_FILE="$CFG"
		break
	fi
done

PROJECT_KEY=""
WT_DIR_CONFIG=""
if [ -n "$CONFIG_FILE" ]; then
	PROJECT_KEY=$(jq -r '.catalyst.projectKey // empty' "$CONFIG_FILE" 2>/dev/null)
	WT_DIR_CONFIG=$(jq -r '.catalyst.orchestration.worktreeDir // empty' "$CONFIG_FILE" 2>/dev/null)
fi

# Determine worktree base path (priority order):
# 1. --worktree-dir flag (explicit override, used by orchestrator)
# 2. catalyst.orchestration.worktreeDir from config
# 3. ~/catalyst/wt/<projectKey>/ (default — read projectKey from config)
# 4. ~/catalyst/wt/<repo>/ (fallback if no config)
if [ -n "$OVERRIDE_WORKTREE_DIR" ]; then
	WORKTREES_BASE="${OVERRIDE_WORKTREE_DIR/#\~/$HOME}"
elif [ -n "$WT_DIR_CONFIG" ]; then
	WORKTREES_BASE="${WT_DIR_CONFIG/#\~/$HOME}"
elif [ -n "$PROJECT_KEY" ]; then
	WORKTREES_BASE="$HOME/catalyst/wt/${PROJECT_KEY}"
else
	WORKTREES_BASE="$HOME/catalyst/wt/${REPO_NAME}"
fi

WORKTREE_PATH="${WORKTREES_BASE}/${WORKTREE_NAME}"

echo -e "${YELLOW}🌳 Creating worktree: ${WORKTREE_NAME}${NC}"
echo "📁 Location: ${WORKTREE_PATH}"
echo "🔀 Base branch: ${BASE_BRANCH}"
echo ""

# Check if worktrees base directory exists
if [ ! -d "$WORKTREES_BASE" ]; then
	echo "Creating worktree base directory: $WORKTREES_BASE"
	mkdir -p "$WORKTREES_BASE"
fi

# Check if worktree already exists
if [ -d "$WORKTREE_PATH" ]; then
	if [ "$REUSE_EXISTING" = true ]; then
		# CTL-615: when the caller declared which branch this path MUST be
		# on, verify HEAD before short-circuiting. A mismatch is the
		# wrong-cwd ADV-1134 signature — fail loud rather than land a
		# revive in a stranger's worktree.
		if [ -n "$EXPECTED_BRANCH" ]; then
			CUR_BRANCH="$(git -C "$WORKTREE_PATH" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
			if [ "$CUR_BRANCH" != "$EXPECTED_BRANCH" ]; then
				echo -e "${RED}❌ create-worktree: expected-branch mismatch — path ${WORKTREE_PATH} is on '${CUR_BRANCH}', expected '${EXPECTED_BRANCH}' (CTL-615)${NC}" >&2
				exit 64
			fi
		fi
		# CTL-1497: the reuse path short-circuits BEFORE the setup block below, so a worktree first
		# created with a broken thoughts/shared — a plain directory, OR a dangling symlink whose target is
		# gone — is never repaired on later dispatches, and thoughts written there strand and never sync.
		# A HEALTHY thoughts/shared is a symlink that resolves to a directory (-L AND -d).
		if [ ! -L "$WORKTREE_PATH/thoughts/shared" ] || [ ! -d "$WORKTREE_PATH/thoughts/shared" ]; then
			# ...but only when this project actually USES shared thoughts. An unconfigured project (no
			# thoughts profile in config, no HumanLayer) legitimately has no thoughts/shared and must still
			# reuse — never block phases 2-9 for those. Resolve the profile exactly as the setup block does.
			_CW_THOUGHTS_PROFILE=""
			[ -n "$CONFIG_FILE" ] && _CW_THOUGHTS_PROFILE=$(jq -r '.catalyst.thoughts.profile // empty' "$CONFIG_FILE" 2>/dev/null)
			if [ -z "$_CW_THOUGHTS_PROFILE" ] && command -v humanlayer >/dev/null 2>&1; then
				_CW_THOUGHTS_PROFILE=$(humanlayer thoughts status 2>/dev/null | grep -i "Profile:" | head -1 | awk '{print $2}')
			fi
			if [ -n "$_CW_THOUGHTS_PROFILE" ]; then
				_CW_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
				echo -e "${YELLOW}  ⚠️  thoughts/shared is not a healthy symlink — repairing (CTL-1497)${NC}"
				# init-or-repair refuses to clobber an existing plain-dir/dangling thoughts/ (it will not
				# risk data loss), so move it aside first — stranded content is preserved under .orphaned-*
				# — then rebuild. If repair does not leave a healthy symlink, FAIL LOUD (exit 65): never
				# report a successful reuse of a worktree that would still strand thoughts.
				if [ -e "$WORKTREE_PATH/thoughts" ] || [ -L "$WORKTREE_PATH/thoughts" ]; then
					mv "$WORKTREE_PATH/thoughts" "$WORKTREE_PATH/thoughts.orphaned-$(date +%Y%m%d-%H%M%S)" \
						|| { echo -e "${RED}❌ create-worktree: could not move aside broken thoughts/ in ${WORKTREE_PATH} (CTL-1497)${NC}" >&2; exit 65; }
				fi
				if ! ( cd "$WORKTREE_PATH" && bash "${_CW_SCRIPT_DIR}/catalyst-thoughts.sh" init-or-repair ) \
					|| [ ! -L "$WORKTREE_PATH/thoughts/shared" ] || [ ! -d "$WORKTREE_PATH/thoughts/shared" ]; then
					echo -e "${RED}❌ create-worktree: thoughts repair FAILED on reuse path — ${WORKTREE_PATH} would strand thoughts; refusing to report success (CTL-1497)${NC}" >&2
					exit 65
				fi
				echo -e "${GREEN}  ✅ thoughts/shared repaired${NC}"
			fi
		fi
		echo -e "${GREEN}♻️  Reusing existing worktree: $WORKTREE_PATH${NC}"
		echo "WORKTREE_PATH=${WORKTREE_PATH}"
		exit 0
	fi
	echo -e "${RED}❌ Error: Worktree directory already exists: $WORKTREE_PATH${NC}"
	exit 1
fi

# Create worktree
# CREATED_BRANCH (Codex #2948): tracks whether THIS run created
# WORKTREE_NAME as a new branch, vs. checking out one the user already
# owned. The rollback helpers below only `git branch -D` when this is
# true — force-deleting a pre-existing branch on a failed setup could
# silently lose the user's unpushed commits. Default false (fail-safe:
# never delete unless we're sure we created it).
CREATED_BRANCH=false
if git show-ref --verify --quiet "refs/heads/${WORKTREE_NAME}"; then
	echo "📋 Using existing branch: ${WORKTREE_NAME}"
	git worktree add "$WORKTREE_PATH" "$WORKTREE_NAME"
else
	echo "🆕 Creating new branch: ${WORKTREE_NAME}"
	CREATED_BRANCH=true
	START_POINT="$BASE_BRANCH"
	if [ "$SKIP_FETCH" = false ]; then
		if git fetch --quiet origin "$BASE_BRANCH" 2>/dev/null; then
			START_POINT="refs/remotes/origin/${BASE_BRANCH}"
			echo "🔄 Fetched origin/${BASE_BRANCH}; rooting on remote tip"
		else
			echo -e "${YELLOW}⚠️  Could not fetch origin/${BASE_BRANCH}; falling back to local ${BASE_BRANCH} (worker may branch off stale ref)${NC}" >&2
		fi
	fi
	git worktree add -b "$WORKTREE_NAME" "$WORKTREE_PATH" "$START_POINT"
fi

# Copy .claude directory if it exists (Claude Code native config)
if [ -d ".claude" ]; then
	echo "📋 Copying .claude directory..."
	cp -R .claude "$WORKTREE_PATH/"
fi

# Copy .catalyst directory if it exists (Catalyst workflow config)
if [ -d ".catalyst" ]; then
	echo "📋 Copying .catalyst directory..."
	cp -R .catalyst "$WORKTREE_PATH/"
fi

# CTL-990: the cp -R above copies the MAIN checkout's working-tree versions of
# git-TRACKED files (e.g. a locally-modified .claude/config.json) over the
# freshly-checked-out branch versions — every new worktree then starts with
# dirty tracked config, and the dispatch-time rebase refuses to start
# ("you have unstaged changes"), which looped ADV-1326/ADV-1308. Restore
# tracked paths to the branch state; untracked machine-local files
# (settings.local.json, …) survive untouched.
for CFG_DIR in .claude .catalyst; do
	if [ -d "$WORKTREE_PATH/$CFG_DIR" ]; then
		git -C "$WORKTREE_PATH" checkout --quiet -- "$CFG_DIR" 2>/dev/null || true
	fi
done

# Pre-trust worktree in Claude Code so no trust dialog appears on first launch
CLAUDE_JSON="$HOME/.claude.json"
if [ -f "$CLAUDE_JSON" ]; then
	if jq -e --arg path "$WORKTREE_PATH" '.projects[$path]' "$CLAUDE_JSON" > /dev/null 2>&1; then
		TMPFILE="$(mktemp "$CLAUDE_JSON.XXXXXX")"
		jq --arg path "$WORKTREE_PATH" \
			'.projects[$path].hasTrustDialogAccepted = true' \
			"$CLAUDE_JSON" > "$TMPFILE" && mv "$TMPFILE" "$CLAUDE_JSON"
	else
		TMPFILE="$(mktemp "$CLAUDE_JSON.XXXXXX")"
		jq --arg path "$WORKTREE_PATH" \
			'.projects[$path] = {
				"allowedTools": [],
				"mcpContextUris": [],
				"mcpServers": {},
				"enabledMcpjsonServers": [],
				"disabledMcpjsonServers": [],
				"hasTrustDialogAccepted": true,
				"projectOnboardingSeenCount": 0,
				"hasClaudeMdExternalIncludesApproved": false,
				"hasClaudeMdExternalIncludesWarningShown": false,
				"hasCompletedProjectOnboarding": false
			}' \
			"$CLAUDE_JSON" > "$TMPFILE" && mv "$TMPFILE" "$CLAUDE_JSON"
	fi
	echo "🔒 Worktree pre-trusted in Claude Code"
fi

# Initialize workflow context with ticket from worktree name (before setup runs)
# This ensures .catalyst/.workflow-context.json exists with currentTicket set
# so that direnv's use_otel_context can read it when someone enters the directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# CTL-1417: self-protection guard for the rollback --force removals below.
# shellcheck source=lib/worktree-remove-guard.sh
[ -r "${SCRIPT_DIR}/lib/worktree-remove-guard.sh" ] && source "${SCRIPT_DIR}/lib/worktree-remove-guard.sh"

# _removal_guard_ok <path> — the SINGLE fail-closed predicate the rollback
# `git worktree remove --force` sites gate on (CTL-1417). Returns 0 (safe to
# force-remove) ONLY when the guard function loaded AND cleared the path.
# Guard-ABSENCE (lib missing/unreadable at source-time → function undefined) is a
# REFUSAL, not a bypass — a stripped/broken checkout can never reopen the
# data-loss path. Reason on stderr.
_removal_guard_ok() {
	local _wt="${1:-}"
	if ! command -v assert_worktree_removal_safe >/dev/null 2>&1; then
		echo "worktree-remove-guard: unavailable — refusing forced removal of ${_wt}" >&2
		return 1
	fi
	assert_worktree_removal_safe "$_wt"
}

# _worktree_rollback_remove — CTL-1628 post-merge (Codex #2948): the guarded
# presweep+remove sequence shared by every rollback site (failed install,
# missing thoughts/shared). Deletes the branch only when THIS run created it
# (CREATED_BRANCH) — a pre-existing branch the user already owned must
# survive a failed setup rather than being force-deleted, which could lose
# unpushed commits. The worktree itself is always removed either way.
_worktree_rollback_remove() {
	cd - >/dev/null
	# CTL-649: defensive presweep — in a failure-before-dispatch rollback
	# no bg session should exist yet, but the helper is a cheap no-op
	# in that case and prevents any future race that lands a session
	# between create-worktree and rollback from leaking.
	[ -x "$SCRIPT_DIR/lib/worktree-presweep.sh" ] &&
		"$SCRIPT_DIR/lib/worktree-presweep.sh" --force "$WORKTREE_PATH" 2>/dev/null || true
	# CTL-1417: skip the force-remove if the tree is in use / is our cwd
	# OR the guard is unavailable (fail-closed), leaving it for the reaper
	# rather than deleting an in-use worktree.
	if _removal_guard_ok "$WORKTREE_PATH"; then
		git worktree remove --force "$WORKTREE_PATH"
		if [ "$CREATED_BRANCH" = true ]; then
			git branch -D "$WORKTREE_NAME" 2>/dev/null || true
		fi
	else
		echo "create-worktree: guard refused/unavailable for ${WORKTREE_PATH}; leaving for reaper" >&2
	fi
}

# _worktree_install_rollback — the guarded rollback a failed dependency
# install (`make setup`, `bun install`, `npm install`) runs through, so a
# failure anywhere in step 1 cleans up the half-built worktree instead of
# `set -e` aborting the script and leaving it on disk.
_worktree_install_rollback() {
	echo -e "${RED}❌ Setup failed. Cleaning up worktree...${NC}"
	_worktree_rollback_remove
	exit 1
}
if [ -f "${SCRIPT_DIR}/workflow-context.sh" ]; then
	# Remove stale workflow-context.json if copied from main repo
	rm -f "${WORKTREE_PATH}/.catalyst/.workflow-context.json"
	mkdir -p "${WORKTREE_PATH}/.catalyst"

	# Extract ticket from worktree name, anchored to end to avoid false matches
	# on date fragments in orchestrator prefixes (e.g., "import-2026" in
	# "orch-data-import-2026-04-13-ADV-220" — we want ADV-220, not IMPORT-2026)
	WT_TICKET=""
	if [[ "$WORKTREE_NAME" =~ ([A-Za-z]+-[0-9]+)$ ]]; then
		WT_TICKET=$(echo "${BASH_REMATCH[1]}" | tr '[:lower:]' '[:upper:]')
	fi

	(cd "$WORKTREE_PATH" && bash "${SCRIPT_DIR}/workflow-context.sh" init)
	if [ -n "$WT_TICKET" ]; then
		(cd "$WORKTREE_PATH" && bash "${SCRIPT_DIR}/workflow-context.sh" set-ticket "$WT_TICKET")
		echo "📋 Workflow context initialized with ticket: ${WT_TICKET}"
	else
		echo "📋 Workflow context initialized (no ticket in worktree name)"
	fi

	if [ -n "$ORCHESTRATION_NAME" ]; then
		(cd "$WORKTREE_PATH" && bash "${SCRIPT_DIR}/workflow-context.sh" set-orchestration "$ORCHESTRATION_NAME")
		echo "📋 Orchestration context set: ${ORCHESTRATION_NAME}"
	fi
fi

# Generate .envrc for OTEL context (source_up inherits parent profiles)
# Note: direnv allow runs AFTER setup hooks to avoid re-blocking if hooks modify .envrc
OTEL_PROJECT="${PROJECT_KEY:-$REPO_NAME}"
if command -v direnv >/dev/null 2>&1 && [ ! -f "${WORKTREE_PATH}/.envrc" ]; then
	cat > "${WORKTREE_PATH}/.envrc" <<EOF
source_up
use_otel_context "${OTEL_PROJECT}"
EOF
	echo "📡 OTEL context configured (.envrc created)"
fi

# Change to worktree directory
cd "$WORKTREE_PATH"

# ============================================================
# WORKTREE SETUP
#
# Setup commands are read from catalyst.worktree.setup in config.
# If configured, ONLY those commands run (full control to the project).
# If not configured, falls back to auto-detected setup for backwards compat.
#
# Available variables in setup commands:
#   ${WORKTREE_PATH}  — absolute path to the new worktree
#   ${BRANCH_NAME}    — git branch name
#   ${TICKET_ID}      — same as branch name (useful for orchestrator-prefixed names)
#   ${REPO_NAME}      — repository name
#   ${DIRECTORY}       — thoughts directory name (defaults to repo name)
#   ${PROFILE}         — thoughts profile (auto-detected or from config)
# ============================================================

# Read thoughts config for variable substitution
THOUGHTS_PROFILE=""
THOUGHTS_DIRECTORY="$REPO_NAME"
if [ -n "$CONFIG_FILE" ]; then
	THOUGHTS_PROFILE=$(jq -r '.catalyst.thoughts.profile // empty' "$CONFIG_FILE" 2>/dev/null)
	THOUGHTS_DIR_CFG=$(jq -r '.catalyst.thoughts.directory // empty' "$CONFIG_FILE" 2>/dev/null)
	if [ -n "$THOUGHTS_DIR_CFG" ]; then
		THOUGHTS_DIRECTORY="$THOUGHTS_DIR_CFG"
	fi
fi

# Auto-detect profile from parent if not in config
if [ -z "$THOUGHTS_PROFILE" ] && command -v humanlayer >/dev/null 2>&1; then
	THOUGHTS_PROFILE=$(humanlayer thoughts status 2>/dev/null | grep -i "Profile:" | head -1 | awk '{print $2}')
fi

# Helper: substitute variables in a command string
substitute_vars() {
	local CMD="$1"
	CMD="${CMD//\$\{WORKTREE_PATH\}/$WORKTREE_PATH}"
	CMD="${CMD//\$\{BRANCH_NAME\}/$WORKTREE_NAME}"
	CMD="${CMD//\$\{TICKET_ID\}/$WORKTREE_NAME}"
	CMD="${CMD//\$\{REPO_NAME\}/$REPO_NAME}"
	CMD="${CMD//\$\{DIRECTORY\}/$THOUGHTS_DIRECTORY}"
	CMD="${CMD//\$\{PROFILE\}/$THOUGHTS_PROFILE}"
	echo "$CMD"
}

# Helper: run an array of commands from JSON with variable substitution
run_hook_array() {
	local JSON_ARRAY="$1"
	local LABEL="$2"
	local HOOK_COUNT
	HOOK_COUNT=$(echo "$JSON_ARRAY" | jq -r 'length' 2>/dev/null || echo 0)

	for i in $(seq 0 $((HOOK_COUNT - 1))); do
		local HOOK_CMD
		HOOK_CMD=$(echo "$JSON_ARRAY" | jq -r ".[$i]" 2>/dev/null)
		if [ -n "$HOOK_CMD" ] && [ "$HOOK_CMD" != "null" ]; then
			HOOK_CMD=$(substitute_vars "$HOOK_CMD")
			echo "  [$LABEL] Running: $HOOK_CMD"
			if ! eval "$HOOK_CMD"; then
				echo -e "${YELLOW}⚠️  $LABEL hook failed: $HOOK_CMD${NC}"
			fi
		fi
	done
}

# Read setup commands from config
SETUP_COMMANDS=""
if [ -n "$CONFIG_FILE" ]; then
	SETUP_COMMANDS=$(jq -c '.catalyst.worktree.setup // empty' "$CONFIG_FILE" 2>/dev/null)
fi

# CTL-513: track whether `humanlayer thoughts init` is attempted by any setup
# path, so the post-setup sanity check below fires only when thoughts/ is
# genuinely expected (no false positives for projects that don't use thoughts).
THOUGHTS_INIT_EXPECTED=false

if [ -n "$SETUP_COMMANDS" ] && [ "$SETUP_COMMANDS" != "null" ] && [ "$SETUP_COMMANDS" != "[]" ]; then
	# ── Config-driven setup ──
	echo -e "${YELLOW}🔧 Running project setup from config...${NC}"
	if [[ "$SETUP_COMMANDS" == *"thoughts init"* ]]; then
		THOUGHTS_INIT_EXPECTED=true
	fi
	run_hook_array "$SETUP_COMMANDS" "setup"
else
	# ── Auto-detected setup (backwards compatibility) ──
	echo -e "${YELLOW}🔧 Running auto-detected setup (no catalyst.worktree.setup in config)${NC}"

	# 1. Install dependencies
	if [ -f "Makefile" ] && grep -q "^setup:" Makefile; then
		echo "  Running: make setup"
		make setup || _worktree_install_rollback
	elif [ -f "package.json" ]; then
		# CTL-1628 post-merge (Codex #2948 round 4): BUN EVIDENCE alone (a
		# bun.lock/bun.lockb, or "packageManager" naming bun) selects the bun
		# path — independent of whether package.json also declares
		# "workspaces". Round 3 required "workspaces" AND bun evidence, which
		# meant a single-package bun project (bun.lock, no "workspaces" key —
		# most bun apps aren't monorepos) fell through to npm and wrote
		# package-lock.json debris into a bun-managed tree. "workspaces" is
		# package-manager-neutral either way (an npm/yarn/pnpm monorepo
		# declares it too), so it was never the right signal to gate on; only
		# bun evidence is. The bun-absent warn+skip below applies identically
		# to a workspace root and a single-package project — no need to
		# distinguish the two once bun evidence itself is the sole gate.
		HAS_BUN_LOCK=false
		[ -f "bun.lock" ] || [ -f "bun.lockb" ] && HAS_BUN_LOCK=true
		# CTL-1628 post-merge (Codex #2948 round 5): jq is not guaranteed present
		# on every host this script runs on (a documented-minimal host can lack
		# it) — a bare `jq -r ...` command substitution under this script's
		# top-level `set -e` would exit 127 right here, AFTER `git worktree add`
		# already created the worktree/branch but BEFORE any rollback is armed,
		# stranding both with no error message and no attempt at npm. Guard on
		# `command -v jq` first; without it, fall back to a plain grep sniff of
		# the "packageManager" field — imprecise (matches inside any string
		# value, ignores JSON structure) but adequate for the boolean bun@
		# prefix check this needs, and it degrades to the same lock-file-only
		# detection (HAS_BUN_LOCK, no jq involved) in the worst case rather than
		# ever crashing the script.
		#
		# CTL-1628 post-merge (Codex #2948, round 6): the fallback grep was
		# line-oriented, so valid JSON that splits "packageManager", the colon,
		# or "bun@..." across lines (pretty-printed with one token per line,
		# multi-line formatting from some generators, etc.) missed a genuine
		# bun-only project and fell through to npm. `tr -d '[:space:]'` collapses
		# all whitespace — including newlines — before the substring match, so
		# formatting no longer matters. Still dependency-free (tr is as
		# universal as grep). But normalized-text matching has two REMAINING
		# imprecisions of its own, both fixed by the tiered fallback below
		# (round 7): it can match a "packageManager":"bun@ substring sitting
		# inside some unrelated string VALUE (any whitespace-normalized JSON
		# is just text to grep), and it is not ROOT-scoped — a NESTED
		# {"toolConfig":{"packageManager":"bun@1.3.5"}} matches even when the
		# actual root-level project uses npm.
		#
		# CTL-1628 post-merge (Codex #2948, round 7): prefer a REAL JSON
		# parser whenever one happens to be on PATH, so the two imprecisions
		# above only apply on a truly minimal host with none available:
		#   1. jq, if present — authoritative, unchanged from round 5.
		#   2. else bun, if present — bun ships a JSON parser and its
		#      presence is exactly what this sniff's outcome selects between
		#      (bun path vs npm path), so using it here is both free and
		#      trustworthy: if bun can't run this one-liner, it can't run
		#      the install either. `-e` evaluates the given script directly.
		#   3. else node, if present — same idea, most commonly-installed
		#      JS runtime.
		#   4. else (no jq/bun/node at all) — the round-6 normalized-grep
		#      last resort, imprecisions documented above and accepted only
		#      at this tier. Note npm itself is a node script (`#!/usr/bin/env
		#      node`) and could not run on this host anyway, so a false
		#      positive here only steers the user toward installing bun
		#      instead of an npm install that would have failed regardless.
		# Every tier's command substitution falls back to an explicit empty
		# string on ANY non-zero exit (`|| PACKAGE_MANAGER_FIELD=""`) rather
		# than trusting the sub-command to always exit 0 under this script's
		# `set -e` — confirmed empirically that `node -e` (unlike `bun -e`)
		# DOES exit non-zero on malformed JSON, which would otherwise abort
		# the whole script exactly like the round-5 bare-jq bug.
		#
		# CTL-1628 post-merge (Codex #2966, round 8): `bun -e` was run with
		# the PROJECT itself as cwd, so bun loaded the project's own
		# bunfig.toml (default config path is $cwd/bunfig.toml — confirmed
		# via `bun --help`) BEFORE evaluating the one-liner, including any
		# `preload` array — arbitrary project-controlled code would run
		# during worktree CREATION, before any trust decision. Confirmed
		# empirically: a bunfig.toml `preload` script wrote a marker file
		# under a plain `bun -e` run; `bun --config <path>` did NOT suppress
		# it (bun's `-e` preload discovery ignores an explicit --config
		# override); `bun --cwd <dir outside the project> -e` DID suppress
		# it, and bun does not walk up the directory tree from --cwd looking
		# for a config file, so any directory outside the project's own tree
		# is sufficient isolation. Read package.json via an ABSOLUTE path
		# passed through an env var — not interpolated into the JS source
		# string, so no shell-to-JS quoting/escaping is needed for paths
		# with unusual characters. node has no equivalent project-scoped
		# auto-preload mechanism (no bunfig.toml analogue, and `node -e`'s
		# cwd doesn't influence what code node executes), so it needs no cwd
		# isolation — only switched to the same env-var-based absolute path
		# for a single shared PM_SNIFF template.
		#
		# CTL-1628 post-merge (Codex #2967, round 9): round 8 pointed --cwd
		# at /tmp — but /tmp is world-writable, so an attacker who can plant
		# /tmp/bunfig.toml poisons the sniff exactly the same way the
		# project's own bunfig.toml did (confirmed empirically: a
		# /tmp/bunfig.toml preload DOES get loaded by `bun --cwd /tmp -e`).
		# Use `mktemp -d` instead — a freshly-created, private (0700, owned
		# by us) directory an attacker cannot have pre-planted a config
		# into. Trap-cleaned on EXIT so an interrupted sniff doesn't leak
		# the scratch dir; the trap is cleared right after we clean up
		# normally so it doesn't linger for the rest of the script.
		#
		# CTL-1628 post-merge (Codex #2967 post-merge, round 10): two
		# follow-ups on round 9's mktemp:
		#   1. A bare `mktemp -d` resolves under $TMPDIR (/tmp on
		#      macOS/most Linux) — a shared, multi-user directory. Threat
		#      model: without the sticky bit (not guaranteed by mktemp
		#      itself, only that the CREATED dir is 0700), another local
		#      user could race a rename-and-replace against it. Prefer a
		#      scratch dir under $HOME instead — single-user by
		#      construction — falling back to the previous /tmp-based
		#      mktemp only if $HOME/.cache can't be created/used.
		#   2. mktemp failure used to give up on the sniff entirely rather
		#      than trying the remaining tiers. Restructured the whole
		#      jq/bun/node/grep chain from an if/elif (mutually exclusive by
		#      construction) into a cascade gated on SNIFF_DONE, so "bun is
		#      on PATH but mktemp failed" now falls through to node (if
		#      present) and then the text sniff, instead of a dead end.
		PM_SNIFF='console.log(JSON.parse(require("fs").readFileSync(process.env.CW_PACKAGE_JSON,"utf8")).packageManager??"")'
		PACKAGE_JSON_ABS="$(pwd)/package.json"
		PACKAGE_MANAGER_FIELD=""
		SNIFF_DONE=false
		if command -v jq >/dev/null 2>&1; then
			PACKAGE_MANAGER_FIELD=$(jq -r '.packageManager // empty' package.json 2>/dev/null) || PACKAGE_MANAGER_FIELD=""
			SNIFF_DONE=true
		fi
		# CTL-1628 post-merge (Codex #2967 post-merge, round 11): three more
		# follow-ups, verified directly on this host (macOS/BSD userland):
		#   1. `mktemp -d -p <dir>` (no explicit template) DID work correctly
		#      here (BSD mktemp's synopsis on this machine documents -p), but
		#      -p support isn't guaranteed across every mktemp this script
		#      might run under fleet-wide (older BSD variants, minimal
		#      containers). The explicit-template form `mktemp -d
		#      "<dir>/prefix.XXXXXXXX"` is unambiguously portable across both
		#      GNU and BSD mktemp — verified working identically to -p on
		#      this host — so use it everywhere instead of relying on -p.
		#   2. The `mkdir -p "$CATALYST_SNIFF_CACHE"` was a bare statement
		#      under this script's top-level `set -e` — confirmed directly
		#      that a failing `mkdir -p` (read-only/unwritable parent) trips
		#      set -e and aborts the WHOLE worktree creation. A
		#      sniff-infrastructure failure must never do that; `|| true`
		#      makes the failure a no-op that the writability check below
		#      catches instead.
		#   3. The $HOME/.cache preference (round 10) only checked
		#      existence+writability, which a group-writable or symlinked
		#      ~/.cache would still pass. Threat model: this is a dev tool,
		#      not a setuid binary, so a full TOCTOU-proof design is
		#      overkill — but a cheap, few-line check (not a symlink, owned
		#      by us, no group/other write bit) rejects the specific
		#      "attacker-controlled ~/.cache" shape the finding describes,
		#      falling back to the TMPDIR-based mktemp (same portable
		#      template form) if any check fails.
		if [ "$SNIFF_DONE" = false ] && command -v bun >/dev/null 2>&1; then
			CATALYST_SNIFF_CACHE="$HOME/.cache"
			mkdir -p "$CATALYST_SNIFF_CACHE" 2>/dev/null || true
			CACHE_SAFE=false
			if [ -d "$CATALYST_SNIFF_CACHE" ] && [ ! -L "$CATALYST_SNIFF_CACHE" ] && [ -w "$CATALYST_SNIFF_CACHE" ]; then
				# CTL-1628 post-merge (Codex #2972 post-merge, round 12): the
				# prior `stat -f ... || stat -c ...` was a SINGLE command
				# substitution wrapping both probes, so on GNU stat (where -f
				# means "show FILESYSTEM status", a completely different flag
				# than BSD's -f FORMAT) the first probe's own stdout — a
				# multi-line filesystem-status report, not a clean UID —
				# stayed captured even when its nonzero exit triggered the ||
				# fallback, and the second probe's output landed appended
				# after it. _stat_probe validates the CAPTURED value itself
				# (must be a pure digit string / octal digit string) — the
				# validation gate is what makes probe order irrelevant and
				# neutralizes either variant's noise, not exit-code-based ||
				# chaining alone. Its own `stat` call is guarded with
				# `|| out=""` so a probe's nonzero exit (expected and normal
				# for the "wrong" stat dialect) can never trip this script's
				# top-level set -e on its own, the same class of bug this
				# whole isolation effort has repeatedly had to fix elsewhere.
				_stat_probe() {
					local flag="$1" fmt="$2" target="$3" pattern="$4" out
					out=$(stat "$flag" "$fmt" "$target" 2>/dev/null) || out=""
					if [[ "$out" =~ $pattern ]]; then
						echo "$out"
						return 0
					fi
					return 1
				}
				CACHE_OWNER=$(_stat_probe -f '%u' "$CATALYST_SNIFF_CACHE" '^[0-9]+$') ||
					CACHE_OWNER=$(_stat_probe -c '%u' "$CATALYST_SNIFF_CACHE" '^[0-9]+$') || CACHE_OWNER=""
				CACHE_PERM=$(_stat_probe -f '%Lp' "$CATALYST_SNIFF_CACHE" '^[0-7]+$') ||
					CACHE_PERM=$(_stat_probe -c '%a' "$CATALYST_SNIFF_CACHE" '^[0-7]+$') || CACHE_PERM=""
				if [ -n "$CACHE_OWNER" ] && [ "$CACHE_OWNER" = "$(id -u)" ] && [ -n "$CACHE_PERM" ]; then
					CACHE_PERM_OCT=$((8#$CACHE_PERM))
					if [ $(( (CACHE_PERM_OCT / 8) % 8 & 2 )) -eq 0 ] && [ $(( CACHE_PERM_OCT % 8 & 2 )) -eq 0 ]; then
						CACHE_SAFE=true
					fi
				fi
			fi
			if [ "$CACHE_SAFE" = true ]; then
				BUN_SNIFF_CWD=$(mktemp -d "${CATALYST_SNIFF_CACHE}/catalyst-sniff.XXXXXXXX" 2>/dev/null) || BUN_SNIFF_CWD=""
			else
				BUN_SNIFF_CWD=$(mktemp -d "${TMPDIR:-/tmp}/catalyst-sniff.XXXXXXXX" 2>/dev/null) || BUN_SNIFF_CWD=""
			fi
			if [ -n "$BUN_SNIFF_CWD" ]; then
				trap 'rm -rf "$BUN_SNIFF_CWD"' EXIT
				PACKAGE_MANAGER_FIELD=$(CW_PACKAGE_JSON="$PACKAGE_JSON_ABS" bun --cwd "$BUN_SNIFF_CWD" -e "$PM_SNIFF" 2>/dev/null) || PACKAGE_MANAGER_FIELD=""
				rm -rf "$BUN_SNIFF_CWD"
				trap - EXIT
				SNIFF_DONE=true
			fi
			# CTL-1628 post-merge (Codex #2967 post-merge, round 11, #4): if
			# BOTH scratch-dir attempts fail (an extremely rare double
			# failure — $HOME/.cache and $TMPDIR are practically never both
			# unwritable on the same host), SNIFF_DONE stays false and this
			# falls through to node / the text sniff below rather than
			# giving up. Considered running bun --cwd against the WORKTREE
			# itself as a still-isolated alternative — rejected: by this
			# point in the script `git worktree add` has already checked
			# out the full project tree (including any committed
			# bunfig.toml) into $WORKTREE_PATH, so that cwd is NOT provably
			# bunfig-free — it is exactly the round-8 vulnerability this
			# whole isolation effort exists to avoid. The imprecise text
			# sniff is the correct, designed last resort here, not a gap.
		fi
		if [ "$SNIFF_DONE" = false ] && command -v node >/dev/null 2>&1; then
			PACKAGE_MANAGER_FIELD=$(CW_PACKAGE_JSON="$PACKAGE_JSON_ABS" node -e "$PM_SNIFF" 2>/dev/null) || PACKAGE_MANAGER_FIELD=""
			SNIFF_DONE=true
		fi
		if [ "$SNIFF_DONE" = false ] && tr -d '[:space:]' <package.json 2>/dev/null | grep -q '"packageManager":"bun@'; then
			PACKAGE_MANAGER_FIELD="bun@detected"
			SNIFF_DONE=true
		fi
		HAS_BUN_EVIDENCE=false
		if [ "$HAS_BUN_LOCK" = true ] || [[ "$PACKAGE_MANAGER_FIELD" == bun@* ]]; then
			HAS_BUN_EVIDENCE=true
		fi
		if [ "$HAS_BUN_EVIDENCE" = true ]; then
			if command -v bun >/dev/null 2>&1; then
				if [ "$HAS_BUN_LOCK" = true ]; then
					# CTL-1628: use --frozen-lockfile so the fresh worktree installs
					# exactly what's committed in bun.lock rather than silently
					# re-resolving and rewriting the lockfile before the worker's
					# first commit (which could otherwise ride unrelated lockfile
					# drift into the ticket's diff).
					echo "  Running: bun install --frozen-lockfile"
					bun install --frozen-lockfile || _worktree_install_rollback
				else
					# No lock committed yet (bun evidence is only the
					# "packageManager" field) — nothing to freeze against, so a
					# plain install is correct here rather than a guaranteed
					# --frozen-lockfile failure.
					echo "  Running: bun install"
					bun install || _worktree_install_rollback
				fi
			else
				echo -e "${YELLOW}⚠️  bun not found on PATH — this is a bun-managed project${NC}"
				echo "  (bun.lock/bun.lockb present, or \"packageManager\" names bun)."
				echo "  Skipping auto-install rather than falling back to npm, which"
				echo "  ignores bun.lock and writes package-lock.json debris into a"
				echo "  bun-managed tree."
				if [ "$HAS_BUN_LOCK" = true ]; then
					echo "  Install bun (https://bun.sh) and run 'bun install --frozen-lockfile'"
				else
					echo "  Install bun (https://bun.sh) and run 'bun install'"
				fi
				echo "  in the worktree manually."
			fi
		else
			echo "  Running: npm install"
			npm install || _worktree_install_rollback
		fi
	fi

	# 2. Initialize thoughts (CTL-845: vendored layout creator, not the crashing CLI)
	if command -v humanlayer >/dev/null 2>&1; then
		THOUGHTS_INIT_EXPECTED=true
		VENDOR_INIT="${SCRIPT_DIR}/../../../scripts/worktree-thoughts-init.sh"
		INIT_ARGS=(--directory "$THOUGHTS_DIRECTORY")
		[ -n "$THOUGHTS_PROFILE" ] && INIT_ARGS+=(--profile "$THOUGHTS_PROFILE")
		echo "  Running: worktree-thoughts-init.sh ${INIT_ARGS[*]}"
		if [ -x "$VENDOR_INIT" ] && bash "$VENDOR_INIT" "${INIT_ARGS[@]}" >/dev/null 2>&1; then
			echo -e "${GREEN}  ✅ Thoughts initialized${NC}"
			humanlayer thoughts sync >/dev/null 2>&1 || echo -e "${YELLOW}  ⚠️  Sync warning: run 'humanlayer thoughts sync' manually${NC}"
			# Verify thoughts/shared/ exists after init+sync
			if [ ! -L "thoughts/shared" ] || [ ! -d "thoughts/shared" ]; then
				echo -e "${RED}❌ Error: thoughts/shared/ is not a healthy symlink (missing or dangling) after init+sync${NC}"
				echo "  Working directory: $(pwd)"
				echo "  Expected path: $(pwd)/thoughts/shared/"
				echo "  This indicates a thoughts initialization failure."
				exit 1
			fi
			if [ -z "$(ls -A thoughts/shared/ 2>/dev/null)" ]; then
				echo -e "${YELLOW}  ⚠️  thoughts/shared/ exists but is empty — sync may not have pulled content yet${NC}"
			fi
		else
			echo -e "${YELLOW}  ⚠️  Could not initialize thoughts${NC}"
		fi
	else
		echo -e "${YELLOW}  ⚠️  HumanLayer CLI not found — skipping thoughts init${NC}"
	fi
fi

# Run additional orchestration hooks if provided via --hooks-json
# These run AFTER the base setup (config-driven or auto-detected)
if [ -n "$HOOKS_JSON" ] && [ "$HOOKS_JSON" != "[]" ]; then
	echo -e "${YELLOW}🔧 Running orchestration hooks...${NC}"
	if [[ "$HOOKS_JSON" == *"thoughts init"* ]]; then
		THOUGHTS_INIT_EXPECTED=true
	fi
	run_hook_array "$HOOKS_JSON" "orchestration"
fi

# CTL-513: Fail loudly if thoughts init was attempted but produced no thoughts/
# symlinks. A failed `humanlayer thoughts init` only emits a ⚠️ warning via
# run_hook_array (or the auto-detected else-branch) and is otherwise silent;
# the missing thoughts/shared then surfaces ~30 min later as a phase-plan
# `prior_artifact_missing` failure. Catch it here, at creation time, instead.
if [ "$THOUGHTS_INIT_EXPECTED" = true ] && { [ ! -L "thoughts/shared" ] || [ ! -d "thoughts/shared" ]; }; then
	echo -e "${RED}❌ Error: thoughts/shared/ missing after setup hooks${NC}"
	echo "  Working directory: $(pwd)"
	echo "  Expected path: $(pwd)/thoughts/shared/"
	echo "  'humanlayer thoughts init' was attempted but did not create the"
	echo "  thoughts/ symlinks. Likely cause: a corrupted"
	echo "  ~/.config/humanlayer/humanlayer.json (concurrent 'thoughts init'"
	echo "  write race) dropped init into an interactive prompt that failed."
	echo -e "${RED}  Cleaning up worktree...${NC}"
	_worktree_rollback_remove
	exit 1
fi

# Allow direnv AFTER all setup hooks have run (hooks like setup-env.sh may modify .envrc)
if command -v direnv >/dev/null 2>&1 && [ -f "${WORKTREE_PATH}/.envrc" ]; then
	direnv allow "${WORKTREE_PATH}/.envrc" 2>/dev/null || true
	echo "📡 direnv allowed"
fi

# Return to original directory
cd - >/dev/null

echo ""
echo -e "${GREEN}✅ Worktree created successfully!${NC}"
echo "📁 Path: ${WORKTREE_PATH}"
echo "🔀 Branch: ${WORKTREE_NAME}"
echo ""
echo "To work in this worktree:"
echo "  cd ${WORKTREE_PATH}"
echo ""
echo "To remove this worktree later:"
echo "  git worktree remove ${WORKTREE_PATH}"
echo "  git branch -D ${WORKTREE_NAME}"
echo ""

# Machine-readable output for automation (tab configs, launchers)
echo "WORKTREE_PATH=${WORKTREE_PATH}"
