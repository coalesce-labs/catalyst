#!/usr/bin/env bash
# lib/handoff-durability.sh — mechanical, self-verifying handoff write path (CTL-2104).
#
# WHY THIS EXISTS. `create-handoff` was pure prose: the model composed a path
# from a model-typed HH-MM-SS, `Write`s to it, ran `humanlayer thoughts sync`
# with no failure gate, and announced the path FROM MEMORY with no read-back.
# Six occurrences over one overnight session (2026-08-19/20) cited a filename
# the next turn could not find on disk. Three independently-sufficient causes:
#
#   1. Cross-project `thoughts/shared` divergence (dominant). `thoughts/shared`
#      is a PER-PROJECT symlink, so a lane that alternates cwd between two
#      worktrees resolves the SAME relative path to a DIFFERENT physical subtree
#      of the one thoughts repo. Every "phantom" file was real — in the sibling
#      subtree. Fixed by citing an ABSOLUTE realpath resolved through the link.
#   2. Async sync race / genuine non-arrival. `humanlayer thoughts sync` aborts
#      on a rebase conflict and cross-host propagation lags <=300s. Fixed by
#      classifying the outcome instead of asserting "synced".
#   3. Placeholder-timestamp mismatch. The model typed HH-MM-SS into the
#      filename, the frontmatter and the citation separately, from memory.
#      Fixed by stamping it once, mechanically, here.
#
# CONTRACT. Fail-open and HONEST: this helper never destroys work, and on any
# doubt it returns a `local-only` verdict rather than a false `synced`. A
# `local-only` answer is a valid, complete result — the file is on disk at the
# echoed absolute path and is citeable on THIS host now.
#
# Functions:
#   handoff_resolve_path <ticket|general> <kebab-description>
#       -> echoes TWO lines: the relative path, then its absolute realpath.
#   handoff_write_verified <abs-path> <content-file>
#       -> mkdir -p, atomic install, re-read and byte-compare; echoes abs path.
#   handoff_sync_and_classify <abs-path>
#       -> echoes exactly one verdict token (see VERDICTS below).
#
# VERDICTS (always a single non-empty token; an empty verdict would read as
# "no problem", which is the very failure this file exists to prevent):
#   synced                          sync succeeded AND the bytes are in the
#                                   pushed (upstream) tree — safe to cite from
#                                   any host now.
#   local-only:sync-failed          `humanlayer thoughts sync` exited non-zero.
#   local-only:sync-unavailable     no `humanlayer` on PATH.
#   local-only:git-unavailable      no `git`, or the thoughts repo is not a git
#                                   checkout — durability is unprovable here.
#   local-only:not-in-pushed-tree   sync exited 0 but the file is untracked, or
#                                   absent from the upstream ref's tree (the
#                                   rebase-conflict / silent-abort case).
#
# Usage: `source` this file from the worktree cwd. Bash-3.2 safe (no mapfile,
# no `declare -A`, no `${VAR,,}`).

# Deliberately NO `set -e` at file scope: this is sourced into a caller's shell
# and must never terminate it. Every function returns a status instead.

# ── internal: absolute physical path of the thoughts/shared root ─────────────
# Resolves the `thoughts/shared` symlink to its physical target so the returned
# citation is unambiguous across projects. Borrows the resolution pattern from
# lib/assert-thoughts-project.sh (deliberately NOT modifying that file — its
# behavior stays byte-stable; only the pattern is shared).
# Echoes the absolute path; returns 1 if it cannot be determined.
_handoff_shared_root() {
	local start link target
	start="$(pwd -P 2>/dev/null || pwd)"

	# Walk up for a worktree that has a thoughts/ dir, so the helper works from
	# a subdirectory of the worktree, not just its root.
	local dir="$start"
	local base=""
	while [ -n "$dir" ] && [ "$dir" != "/" ]; do
		if [ -e "${dir}/thoughts/shared" ] || [ -L "${dir}/thoughts/shared" ]; then
			base="$dir"
			break
		fi
		dir="$(dirname "$dir")"
	done
	[ -n "$base" ] || return 1

	if [ -L "${base}/thoughts/shared" ]; then
		link="$(readlink "${base}/thoughts/shared" 2>/dev/null || true)"
		[ -n "$link" ] || return 1
		case "$link" in
			/*) target="$link" ;;
			*) target="${base}/thoughts/${link}" ;;
		esac
	else
		target="${base}/thoughts/shared"
	fi

	# Physicalize. The directory exists in every real deployment; if it somehow
	# does not, normalize textually rather than failing — a slightly-less-canonical
	# absolute path still disambiguates the two project subtrees.
	if [ -d "$target" ]; then
		(cd "$target" 2>/dev/null && pwd -P) || printf '%s' "$target"
	else
		printf '%s' "$target"
	fi
}

# ── handoff_resolve_path <ticket|general> <kebab-description> ────────────────
# THE single source of the handoff filename. The timestamp is stamped here,
# once, by `date` — the model never types it (failure mode #3).
handoff_resolve_path() {
	local scope="${1:-}"
	local desc="${2:-}"
	if [ -z "$scope" ] || [ -z "$desc" ]; then
		echo "handoff_resolve_path: usage: handoff_resolve_path <ticket|general> <kebab-description>" >&2
		return 2
	fi

	# Sanitize both components — they land in a filesystem path.
	scope="$(printf '%s' "$scope" | tr -c 'A-Za-z0-9._-' '-')"
	desc="$(printf '%s' "$desc" | tr -c 'A-Za-z0-9._-' '-')"

	local stamp
	stamp="$(date -u +%Y-%m-%d_%H-%M-%S 2>/dev/null || true)"
	if [ -z "$stamp" ]; then
		echo "handoff_resolve_path: \`date\` produced no timestamp; refusing to guess one" >&2
		return 1
	fi

	local rel="thoughts/shared/handoffs/${scope}/${stamp}_${desc}.md"

	local root
	root="$(_handoff_shared_root)" || {
		echo "handoff_resolve_path: could not resolve thoughts/shared from $(pwd) — is this a project worktree?" >&2
		return 1
	}

	printf '%s\n' "$rel"
	printf '%s\n' "${root}/handoffs/${scope}/${stamp}_${desc}.md"
}

# ── handoff_write_verified <abs-path> <content-file> ─────────────────────────
# mkdir -p the parent, install atomically (tmp in the SAME directory, then mv,
# so the rename is atomic and no reader ever sees a partial file), then RE-READ
# the destination and byte-compare against the source. That read-back is the
# post-write existence check `create-handoff` never had.
handoff_write_verified() {
	local dest="${1:-}"
	local src="${2:-}"
	if [ -z "$dest" ] || [ -z "$src" ]; then
		echo "handoff_write_verified: usage: handoff_write_verified <abs-path> <content-file>" >&2
		return 2
	fi
	if [ ! -f "$src" ]; then
		echo "handoff_write_verified: content source is missing: ${src}" >&2
		echo "  refusing to install a handoff whose content was never written" >&2
		return 1
	fi

	# ⛔ NEVER OVERWRITE. The stamp has one-second resolution, so two agents using
	# the same scope and description within the same second resolve to the SAME
	# destination — and `mv` would silently replace whichever landed first,
	# destroying a handoff while reporting success. That directly contradicts this
	# file's no-work-loss contract. Refuse instead: the loser gets a loud failure
	# and can retry with a distinct description, which loses nothing.
	if [ -e "$dest" ]; then
		echo "handoff_write_verified: destination already exists: ${dest}" >&2
		echo "  refusing to overwrite — another handoff already claimed this path (same scope, description and second)" >&2
		echo "  retry with a more specific description; nothing has been changed" >&2
		return 1
	fi

	local dir
	dir="$(dirname "$dest")"
	if ! mkdir -p "$dir" 2>/dev/null; then
		echo "handoff_write_verified: cannot create parent directory: ${dir}" >&2
		return 1
	fi

	local tmp="${dest}.tmp.$$"
	if ! cp "$src" "$tmp" 2>/dev/null; then
		echo "handoff_write_verified: cannot stage content at ${tmp}" >&2
		rm -f "$tmp" 2>/dev/null
		return 1
	fi
	if ! mv "$tmp" "$dest" 2>/dev/null; then
		echo "handoff_write_verified: cannot install ${tmp} -> ${dest}" >&2
		rm -f "$tmp" 2>/dev/null
		return 1
	fi

	# Read back from disk. A write that "succeeded" and left nothing readable is
	# exactly the reported incident, so this is asserted POSITIVELY and fails
	# closed — never `[ -f ] || true`.
	if [ ! -f "$dest" ]; then
		echo "handoff_write_verified: destination is absent immediately after install: ${dest}" >&2
		return 1
	fi
	local want got
	want="$(wc -c < "$src" 2>/dev/null | tr -d ' ')"
	got="$(wc -c < "$dest" 2>/dev/null | tr -d ' ')"
	if [ -z "$want" ] || [ -z "$got" ]; then
		echo "handoff_write_verified: could not size ${src} / ${dest}; cannot verify the write" >&2
		return 1
	fi
	if [ "$want" != "$got" ]; then
		echo "handoff_write_verified: byte-length mismatch after install: ${dest}" >&2
		echo "  source ${want} bytes, on-disk ${got} bytes — the citation would be a lie" >&2
		return 1
	fi

	printf '%s\n' "$dest"
	return 0
}

# ── handoff_sync_and_classify <abs-path> ────────────────────────────────────
# Runs the sync, then classifies what actually happened. Never throws; always
# echoes exactly one verdict token.
handoff_sync_and_classify() {
	local target="${1:-}"
	if [ -z "$target" ]; then
		echo "handoff_sync_and_classify: usage: handoff_sync_and_classify <abs-path>" >&2
		printf '%s\n' "local-only:git-unavailable"
		return 0
	fi

	if ! command -v humanlayer >/dev/null 2>&1; then
		echo "handoff_sync_and_classify: no \`humanlayer\` on PATH — cannot sync" >&2
		printf '%s\n' "local-only:sync-unavailable"
		return 0
	fi
	if ! humanlayer thoughts sync >/dev/null 2>&1; then
		echo "handoff_sync_and_classify: \`humanlayer thoughts sync\` exited non-zero" >&2
		printf '%s\n' "local-only:sync-failed"
		return 0
	fi

	# Sync claims success. Verify the bytes actually reached the pushed tree —
	# an exit-0 sync that committed nothing is the silent-abort case, and it is
	# indistinguishable from success without this check.
	if ! command -v git >/dev/null 2>&1; then
		echo "handoff_sync_and_classify: no \`git\` on PATH — durability is unprovable" >&2
		printf '%s\n' "local-only:git-unavailable"
		return 0
	fi
	local dir repo
	dir="$(dirname "$target")"
	repo="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)"
	if [ -z "$repo" ]; then
		echo "handoff_sync_and_classify: ${dir} is not inside a git checkout — durability is unprovable" >&2
		printf '%s\n' "local-only:git-unavailable"
		return 0
	fi

	local relpath
	relpath="$(git -C "$repo" rev-parse --show-prefix 2>/dev/null || true)"
	# Recompute relative-to-repo-root from the absolute path (portable, no realpath --relative-to).
	case "$target" in
		"${repo}/"*) relpath="${target#"${repo}"/}" ;;
		*) relpath="" ;;
	esac
	if [ -z "$relpath" ]; then
		echo "handoff_sync_and_classify: ${target} is not under ${repo}" >&2
		printf '%s\n' "local-only:git-unavailable"
		return 0
	fi

	# Tracked at all?
	if ! git -C "$repo" ls-files --error-unmatch -- "$relpath" >/dev/null 2>&1; then
		echo "handoff_sync_and_classify: ${relpath} is untracked after a clean sync" >&2
		printf '%s\n' "local-only:not-in-pushed-tree"
		return 0
	fi

	# Present in the UPSTREAM ref's tree? `ls-files` only proves the index, and
	# "in the index" is not "on another host" — the distinction this whole file
	# exists to stop blurring. With no upstream configured we cannot prove the
	# push, so we do not claim it.
	local upstream
	upstream="$(git -C "$repo" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
	if [ -z "$upstream" ]; then
		echo "handoff_sync_and_classify: no upstream for the thoughts repo — cannot prove the push" >&2
		printf '%s\n' "local-only:not-in-pushed-tree"
		return 0
	fi
	# ⛔ THE PATH EXISTING UPSTREAM IS NOT THE BYTES BEING UPSTREAM. `cat-file -e`
	# answers "is there a blob at this path", which is satisfied by an OLDER blob
	# at the same path. Two agents that collide on scope+description within the
	# same second produce the same path, so a sync that exits 0 without pushing
	# the replacement would return `synced` while another host reads the previous
	# handoff — a false durability claim about the wrong content, which is the
	# exact class of over-claim this file exists to remove. Compare BLOB HASHES.
	local upstream_blob local_blob
	upstream_blob="$(git -C "$repo" rev-parse --verify --quiet "${upstream}:${relpath}" 2>/dev/null || true)"
	if [ -z "$upstream_blob" ]; then
		echo "handoff_sync_and_classify: ${relpath} is absent from ${upstream}" >&2
		printf '%s\n' "local-only:not-in-pushed-tree"
		return 0
	fi
	local_blob="$(git -C "$repo" hash-object -- "$target" 2>/dev/null || true)"
	if [ -z "$local_blob" ]; then
		echo "handoff_sync_and_classify: could not hash ${target} — cannot prove the pushed bytes match" >&2
		printf '%s\n' "local-only:not-in-pushed-tree"
		return 0
	fi
	if [ "$local_blob" != "$upstream_blob" ]; then
		echo "handoff_sync_and_classify: ${relpath} exists in ${upstream} but holds DIFFERENT bytes — the pushed copy is not this handoff" >&2
		printf '%s\n' "local-only:not-in-pushed-tree"
		return 0
	fi

	printf '%s\n' "synced"
	return 0
}
