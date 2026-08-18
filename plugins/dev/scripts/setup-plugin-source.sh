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
#      machine config (Layer 2), preserving every other key. This is the path
#      the daemon / SDK executor / Codex executor / phase-agent-dispatch load
#      catalyst plugins from — it is IN-PLACE from this checkout (never the
#      version-keyed marketplace cache), so it stays. The Agent SDK loads
#      plugins ONLY via an explicit path (it does not auto-load ~/.claude/skills
#      plugins), so pluginDirs is load-bearing for the daemon and is kept.
#   5. Points every session type Claude Code itself resolves plugins for
#      (interactive, `claude --bg`, bg-spare, desktop) at the SAME live checkout
#      via user-scope skills-directory symlinks (~/.claude/skills/<plugin-name>
#      -> <path>/plugins/<dir>), and — in full cutover mode — retires the two
#      legacy load paths those surfaces used: the version-keyed `catalyst`
#      marketplace (the ONE stale path this whole setup exists to kill) and the
#      interactive `claude()` --plugin-dir shell wrapper (now redundant with the
#      symlinks). See the skills-dir-plugin migration handoff.
#
# Re-running is safe and idempotent: when pluginDirs already points at the
# resolved target, the config write is skipped (the ff-only pull still runs);
# the skills-dir symlinks are (re)pointed only when missing/wrong; the wrapper
# and marketplace removals are no-ops once done. Pass --force to re-register a
# different checkout path.
#
# --no-interactive-wrapper (set by the non-interactive install-lifecycle acquire
# step, which runs pre-backup and must not mutate un-backed-up host state) limits
# this to the git-reconstructable work: the pluginDirs config write + the
# reversible skills-dir symlinks. It SKIPS the shell-rc wrapper removal and the
# marketplace/enablement cutover (both stateful, both no-ops on a fresh node);
# the full `bash setup-plugin-source.sh` run (join / manual) performs those.
#
# The path of the machine config is resolved via lib/plugin-dirs.sh — the same
# single source of truth phase-agent-dispatch and catalyst-stack use, so the
# dir registered here is exactly the dir the dispatcher hands to workers.

set -euo pipefail

# claude_config_dir — Claude Code's data directory, honoring CLAUDE_CONFIG_DIR.
#
# CTL (Codex #2664 P1): every new call site hardcoded "${HOME}/.claude". Claude Code
# lets an operator relocate that directory via CLAUDE_CONFIG_DIR, and the variable may
# hold a COLON-SEPARATED list (the first entry is the writable primary) — so a
# relocated install had its skills symlinks written to, and verified in, a directory
# Claude Code never reads. Resolve it in one place instead.
claude_config_dir() {
  if [[ -n "${CLAUDE_CONFIG_DIR:-}" ]]; then
    printf '%s' "${CLAUDE_CONFIG_DIR%%:*}"
  else
    printf '%s' "${HOME}/.claude"
  fi
}


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
# Full cutover = also remove the interactive shell wrapper + retire the
# marketplace/enablement. Disabled by --no-interactive-wrapper (the
# non-interactive install acquire step), which keeps only the git-reconstructable
# pluginDirs write + reversible skills-dir symlinks.
FULL_CUTOVER=1

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
  --no-interactive-wrapper
                    Non-interactive acquire mode: do ONLY the pluginDirs config
                    write + the reversible ~/.claude/skills symlinks. Skip the
                    stateful cutover (shell-rc wrapper removal + marketplace/
                    enablement retirement). Used by the install-lifecycle acquire
                    step, which runs pre-backup and must not mutate un-backed-up
                    host state. (Flag name kept for backward compatibility.)
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
		--no-interactive-wrapper) FULL_CUTOVER=0; shift ;;
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

# rc_files_for_interactive_shell — the interactive-shell rc file(s) to install the
# `claude` wrapper into, picked by the login shell ($SHELL) — mirroring the
# convention setup-catalyst.sh uses for its PATH lines. zsh → ~/.zshrc; bash →
# ~/.bashrc (+ ~/.bash_profile when it already exists, for macOS login shells that
# read it instead of ~/.bashrc); unknown → both zsh and bash so a supported
# interactive shell is always covered. The wrapper body is bash/zsh-portable
# (case/local/arrays), so the same block works in either rc file.
rc_files_for_interactive_shell() {
	case "${SHELL:-}" in
		*zsh) printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc" ;;
		*bash)
			printf '%s\n' "$HOME/.bashrc"
			if [[ -e "$HOME/.bash_profile" ]]; then printf '%s\n' "$HOME/.bash_profile"; fi
			;;
		*) printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.bashrc" ;;
	esac
}

# create_skills_dir_symlinks — point every session type Claude Code resolves
# plugins for (interactive `claude`, `claude --bg`, bg-spare, desktop) at the live
# plugin-source checkout via user-scope skills-directory symlinks. A folder under
# ~/.claude/skills/ that carries a .claude-plugin/plugin.json loads in-place as
# `<name>@skills-dir` for every project/session — no marketplace, no version cache.
# We symlink EVERY plugin in the checkout (mirroring the old wrapper's `for d in
# plugins/*/` behaviour), keyed by the plugin's own manifest `name` (so the symlink
# basename is e.g. `catalyst-dev`, not the dir `dev`).
#
# Idempotent + reversible + safe under --no-interactive-wrapper: a symlink is
# (re)pointed only when missing or pointing elsewhere; an existing non-symlink at
# the path is left untouched with a warning (never clobbered). BEST-EFFORT: never
# aborts the script (the caller invokes us as `… || warn`, which also disables
# `set -e` inside here).
create_skills_dir_symlinks() {
	local checkout="$1"
	local base="${checkout}/plugins"
	local skills_dir="$(claude_config_dir)/skills"
	local d pname target link cur
	if [[ ! -d "$base" ]]; then
		echo "WARN: no plugins directory at ${base} — skipping skills-dir symlinks." >&2
		return 0
	fi
	mkdir -p "$skills_dir" || { echo "WARN: could not create ${skills_dir} — skipping skills-dir symlinks." >&2; return 0; }
	for d in "$base"/*/; do
		[[ -f "${d}.claude-plugin/plugin.json" ]] || continue
		pname="$(jq -r '.name // empty' "${d}.claude-plugin/plugin.json" 2>/dev/null || true)"
		if [[ -z "$pname" ]]; then
			echo "WARN: ${d}.claude-plugin/plugin.json has no \"name\" — skipping." >&2
			continue
		fi
		target="${d%/}"
		link="${skills_dir}/${pname}"
		if [[ -L "$link" ]]; then
			cur="$(readlink "$link")"
			if [[ "$cur" == "$target" ]]; then
				continue
			fi
			ln -sfn "$target" "$link" && echo "Repointed skills-dir symlink: ${link} -> ${target}" \
				|| echo "WARN: could not repoint ${link}." >&2
		elif [[ -e "$link" ]]; then
			echo "WARN: ${link} exists and is not a symlink — leaving as-is (remove it to enable skills-dir loading)." >&2
		else
			ln -s "$target" "$link" && echo "Created skills-dir symlink: ${link} -> ${target}" \
				|| echo "WARN: could not create ${link}." >&2
		fi
	done
}


# remove_skills_dir_symlinks — the inverse of create_skills_dir_symlinks.
#
# CTL (Codex #2664 P1): the cutover created user-scope symlinks but nothing removed
# them, so after uninstalling the plugin source ~/.claude/skills kept dangling entries
# pointing into a deleted checkout — Claude Code then loads (or errors on) plugins the
# operator believes are gone. Uninstall must undo what install did.
#
# Enumerates from the SKILLS DIR, not from catalog_plugin_names(checkout). The whole
# point is the uninstall case, where the checkout is already deleted — a catalog walk
# would then return nothing and remove nothing, i.e. it would no-op in exactly the
# situation it exists for.
#
# SAFETY: only removes a SYMLINK whose target is inside the given checkout. A real
# directory, or a symlink the operator pointed elsewhere, is left untouched and
# reported — a blanket rm would destroy unrelated work.
remove_skills_dir_symlinks() {
	local checkout="$1"
	local skills_dir="$(claude_config_dir)/skills"
	local link tgt co_real
	[[ -d "$skills_dir" ]] || return 0
	co_real="$(cd "$checkout" 2>/dev/null && pwd -P)" || co_real="$checkout"
	for link in "$skills_dir"/*; do
		# Only ever touch a SYMLINK — never a real directory.
		[[ -L "$link" ]] || continue
		# Resolve the target. A DANGLING link (checkout already deleted) resolves to
		# nothing, so fall back to the raw readlink text — otherwise the very case this
		# exists to clean up would be skipped.
		tgt="$(cd "$(dirname "$link")" 2>/dev/null && cd "$(readlink "$link")" 2>/dev/null && pwd -P)" || tgt=""
		[[ -n "$tgt" ]] || tgt="$(readlink "$link")"
		case "$tgt" in
			"$co_real"|"$co_real"/*|"$checkout"|"$checkout"/*)
				rm -f "$link" && echo "Removed skills-dir symlink: ${link}" \
					|| echo "WARN: could not remove ${link}." >&2
				;;
			*)
				echo "Left ${link} alone (points outside ${checkout}: ${tgt:-unresolvable})." >&2
				;;
		esac
	done
}

# remove_managed_claude_wrapper — strip the legacy interactive `claude()`
# --plugin-dir shell wrapper (the managed block this script used to install) from
# the interactive rc file(s). Now redundant: the skills-dir symlinks give an
# interactive `claude` the same live plugins, and leaving both in place risks a
# double-load (wrapper's --plugin-dir + skills-dir). Reuses the same in-place strip
# as the old installer (awk skip-range + `cat >"$rc"` truncate-through-symlink so a
# dotfiles-repo symlink is preserved). Idempotent no-op once the block is gone.
# BEST-EFFORT: warn-and-continue, never abort.
remove_managed_claude_wrapper() {
	local rc tmp
	local start="# >>> catalyst plugin-source (managed) >>>"
	local end="# <<< catalyst plugin-source (managed) <<<"
	while IFS= read -r rc; do
		[[ -z "$rc" ]] && continue
		[[ -f "$rc" ]] || continue
		grep -qF "$start" "$rc" 2>/dev/null || continue
		if [[ ! -w "$rc" ]]; then
			echo "WARN: ${rc} carries the managed \`claude\` wrapper but is not writable — remove the '>>> catalyst plugin-source (managed) >>>' block manually." >&2
			continue
		fi
		tmp="$(mktemp "${TMPDIR:-/tmp}/.catalyst-rc.XXXXXX")" || { echo "WARN: mktemp failed for ${rc}" >&2; continue; }
		if awk -v s="$start" -v e="$end" '$0==s{skip=1} !skip{print} $0==e{skip=0}' "$rc" >"$tmp"; then
			if cat "$tmp" >"$rc"; then
				echo "Removed the legacy interactive \`claude\` wrapper block from ${rc}."
			else
				echo "WARN: could not rewrite ${rc}." >&2
			fi
		fi
		rm -f "$tmp"
	done < <(rc_files_for_interactive_shell)
}

# catalog_plugin_names — every plugin manifest name in the checkout (same enumeration
# create_skills_dir_symlinks uses), one per line. Used to build the full marketplace
# residue list instead of a hand-maintained allowlist (Codex P1: the old two-name
# `catalyst-dev`/`catalyst-pm` list left the other eight marketplace plugins —
# catalyst-meta, catalyst-analytics, catalyst-debugging, etc. — undetected/uninstalled).
catalog_plugin_names() {
	local checkout="$1" base="${1}/plugins" d pname
	[[ -d "$base" ]] || return 0
	for d in "$base"/*/; do
		[[ -f "${d}.claude-plugin/plugin.json" ]] || continue
		pname="$(jq -r '.name // empty' "${d}.claude-plugin/plugin.json" 2>/dev/null || true)"
		[[ -n "$pname" ]] && printf '%s\n' "$pname"
	done
}

# retire_catalyst_marketplace — best-effort cutover away from the version-keyed
# `catalyst` marketplace (the one stale load path). Clears user-scope
# enabledPlugins entries (atomic jq), then best-effort uninstalls the marketplace
# copies + removes the marketplace registration via the CLI. Covers EVERY plugin in
# the marketplace catalog (via catalog_plugin_names), not just catalyst-dev/-pm.
# NON-FATAL by design: a marketplace copy installed at PROJECT scope (anchored to
# some other repo) can only be uninstalled with `--scope project` from that repo,
# which this generic routine can't know — so any residue is left with a loud warning
# and the checkSkillsDirPlugins doctor check flags it for a manual finish. On a fresh
# node (no marketplace) every step is a clean no-op.
retire_catalyst_marketplace() {
	local checkout="$1" settings="$(claude_config_dir)/settings.json" tmp p ids_json
	local -a plugin_ids=()
	while IFS= read -r p; do
		[[ -n "$p" ]] && plugin_ids+=("${p}@catalyst")
	done < <(catalog_plugin_names "$checkout")
	if [[ ${#plugin_ids[@]} -eq 0 ]]; then
		# No manifests discovered (e.g. an incomplete checkout) — fall back to the
		# two plugins every node has always had, so retirement still runs.
		plugin_ids=(catalyst-dev@catalyst catalyst-pm@catalyst)
	fi
	# 1. Clear user-scope enabledPlugins entries (atomic same-dir tmp + mv).
	if [[ -f "$settings" ]] && command -v jq >/dev/null 2>&1; then
		ids_json="$(printf '%s\n' "${plugin_ids[@]}" | jq -R . | jq -s .)"
		if jq -e --argjson ids "$ids_json" \
			'(.enabledPlugins // {}) as $ep | $ids | any(. as $id | $ep | has($id))' "$settings" >/dev/null 2>&1; then
			tmp="$(mktemp "$(dirname "$settings")/.settings.json.XXXXXX")" || tmp=""
			if [[ -n "$tmp" ]]; then
				if jq --argjson ids "$ids_json" \
					'if .enabledPlugins then .enabledPlugins |= (reduce $ids[] as $id (.; del(.[$id]))) else . end' \
					"$settings" >"$tmp"; then
					mv "$tmp" "$settings" && echo "Cleared catalyst-*@catalyst from user-scope enabledPlugins."
				else
					rm -f "$tmp"
					echo "WARN: could not rewrite ${settings} to clear catalyst-*@catalyst enablement." >&2
				fi
			fi
		fi
	fi
	# 2. Best-effort uninstall + marketplace removal (CLI; warns on project-scope block).
	if command -v claude >/dev/null 2>&1; then
		for p in "${plugin_ids[@]}"; do
			if claude plugin list 2>/dev/null | grep -qF "$p"; then
				claude plugin uninstall "$p" -y >/dev/null 2>&1 \
					&& echo "Uninstalled marketplace plugin ${p}." \
					|| echo "WARN: could not uninstall ${p} (likely enabled at project scope in another repo) — finish with 'claude plugin uninstall ${p} --scope project -y' from that repo; doctor will flag it." >&2
			fi
		done
		if claude plugin marketplace list 2>/dev/null | grep -qiE '(^|[^-])catalyst([^-]|$)'; then
			claude plugin marketplace remove catalyst >/dev/null 2>&1 \
				&& echo "Removed the catalyst marketplace registration." \
				|| echo "WARN: could not remove the catalyst marketplace — run 'claude plugin marketplace remove catalyst' manually; doctor will flag it." >&2
		fi
	fi
}

CHECKOUT_PATH="${CHECKOUT_PATH:-$DEFAULT_PATH}"
# Normalize to an absolute path BEFORE it's used as a symlink target (Codex P1):
# `ln -s` writes the target string verbatim, so a relative `--path ./plugin-source`
# would otherwise land in every ~/.claude/skills/<plugin> symlink as a path relative
# to ~/.claude/skills, not to the caller's CWD — a dangling link. Tilde-expand
# (`--path ~/foo` arrives unexpanded when quoted) then prefix a non-absolute path
# with the CWD captured before any `cd` in this script (there is none above this
# point, so $PWD is still the caller's).
case "$CHECKOUT_PATH" in
	"~"|"~/"*) CHECKOUT_PATH="${HOME}${CHECKOUT_PATH#\~}" ;;
esac
if [[ "$CHECKOUT_PATH" != /* ]]; then
	CHECKOUT_PATH="${PWD}/${CHECKOUT_PATH}"
fi
# Collapse a leading "./" (from e.g. `--path ./plugin-source`) left over from the
# prefix above — cosmetic only (the path above is already absolute and resolves
# fine either way), but keeps the registered/printed/symlinked path clean.
CHECKOUT_PATH="${CHECKOUT_PATH/\/.\//\/}"

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

# ─── 1b. Advance the catalyst-index serving root to the pin this checkout now carries ──────
#
# CTL-1935 (Codex #3525 P1). Distributing the pin file is NOT the same as applying it: without
# this hook the config lands and every serving root stays absent or on the PREVIOUS sha until
# someone runs a command by hand — recreating the stale-root behaviour the ticket exists to kill,
# while the pin file makes it look solved.
#
# ⚠️ NON-FATAL BY DESIGN, BUT LOUD. The plugin reload is the more critical operation; failing it
# because an indexer root could not be advanced would trade a stale indexer for a stale fleet.
# A failure prints the consequence in full rather than a bare non-zero.
# Skip with CATALYST_SKIP_INDEX_ROOT=1 on nodes that never index.
INDEX_ROOT_SCRIPT="${CHECKOUT_PATH}/plugins/dev/scripts/catalyst-index-root"
INDEX_ROOT_PIN="${CHECKOUT_PATH}/plugins/dev/config/index-serving-root.json"
if [[ "${CATALYST_SKIP_INDEX_ROOT:-0}" == "1" ]]; then
	echo "catalyst-index serving root: SKIPPED (CATALYST_SKIP_INDEX_ROOT=1)"
elif [[ ! -f "$INDEX_ROOT_SCRIPT" || ! -f "$INDEX_ROOT_PIN" ]]; then
	# An older checkout predates the pin — say so rather than passing silently.
	echo "catalyst-index serving root: no pin in this checkout (predates CTL-1935) — not advanced"
else
	echo "catalyst-index serving root: advancing to the pin in ${INDEX_ROOT_PIN}…"
	if bash "$INDEX_ROOT_SCRIPT" setup; then
		echo "catalyst-index serving root: at the pin"
	else
		echo "WARNING: catalyst-index serving root could NOT be advanced to the pin." >&2
		echo "WARNING: a cold index on this node would run stale or unpinned code (CTL-1935)." >&2
		echo "WARNING: the plugin reload itself succeeded; fix with 'catalyst-index-root setup'." >&2
	fi
fi

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
else
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
fi

# ─── 3. Skills-dir symlinks + legacy-path cutover (best-effort, LAST) ───────
# Runs after the essential pluginDirs config write so a non-fatal failure here can
# never skip it. The skills-dir symlinks always run (reversible, git-reconstructable,
# and the mechanism a fresh node needs to load catalyst for every session type
# Claude Code itself resolves plugins for — outside the daemon's SDK path). The
# stateful cutover — removing the interactive wrapper + retiring the marketplace —
# runs only in full mode; --no-interactive-wrapper (install acquire, pre-backup)
# skips it (both are no-ops on a fresh node anyway). Each `|| warn` disables `set -e`
# inside the callee so a read-only rc / project-scoped marketplace warns, not aborts.
# CTL (Codex #2664 P1): the inverse of the cutover. Install created user-scope
# symlinks and nothing removed them, so an uninstalled checkout left dangling
# ~/.claude/skills entries behind and Claude Code kept trying to load plugins the
# operator believed were gone. `--uninstall` undoes exactly what install did (and
# nothing else — see remove_skills_dir_symlinks's safety note) and exits.
if [[ "${1:-}" == "--uninstall" ]]; then
	remove_skills_dir_symlinks "$CHECKOUT_PATH" \
		|| echo "WARN: skills-dir symlinks not fully removed (non-fatal)." >&2
	exit 0
fi

create_skills_dir_symlinks "$CHECKOUT_PATH" \
	|| echo "WARN: skills-dir symlinks not fully created (non-fatal) — some catalyst plugins may not load outside the daemon until fixed." >&2

if [[ $FULL_CUTOVER -eq 1 ]]; then
	remove_managed_claude_wrapper \
		|| echo "WARN: legacy interactive \`claude\` wrapper not fully removed (non-fatal)." >&2
	retire_catalyst_marketplace "$CHECKOUT_PATH" \
		|| echo "WARN: catalyst marketplace not fully retired (non-fatal) — doctor will flag residue." >&2
fi
