#!/bin/bash
# worktree-thoughts-exclude-backfill.sh — CTC-633's reclaim, applied to worktrees that ALREADY
# EXIST. One-shot and idempotent; safe to re-run.
#
# WHY THIS IS NEEDED AT ALL
# -------------------------
# CTC-633 ignores `thoughts/` so the orphan sweeper stops reading it as SALVAGE_DIRTY and can
# reclaim a stale worktree. That fix arrived as a `.gitignore` commit, which only helps a
# worktree whose branch CONTAINS that commit — every worktree cut before the merge still shows
# `?? thoughts/` and stays unreclaimable. `.git/info/exclude` is the per-checkout equivalent and
# is shared by every worktree of a repo (it lives in $GIT_COMMON_DIR), so one write per repo
# covers all of them at once.
#
# ⛔ WHAT THIS CANNOT FIX, MEASURED — read before believing a clean run means "all fixed".
# `info/exclude`, like `.gitignore`, applies ONLY TO UNTRACKED FILES. A worktree whose
# `thoughts/global`, `thoughts/ryan`, `thoughts/shared` are TRACKED symlinks shows them as
# ` M thoughts/...` (modified), and no ignore rule of any kind will silence that. Measured on the
# dev laptop 2026-08-18 00:27 CT: of 9 polluted worktrees, 4 were untracked (this script fixes
# them) and 5 were tracked-modified (it cannot, and it says so per worktree rather than
# reporting a clean sweep). Those need `git update-index --skip-worktree` or a sweeper-side
# rule — a different ticket, not a silent gap in this one.
#
# Usage:
#   bash scripts/worktree-thoughts-exclude-backfill.sh [--dry-run] [REPO ...]
# With no REPO arguments it backfills the repos owning worktrees under $CATALYST_WT_ROOT
# (default ~/catalyst/wt, scanned two levels deep), plus any repo given on the command line.

set -uo pipefail

WT_ROOT="${CATALYST_WT_ROOT:-$HOME/catalyst/wt}"
MARKER="thoughts/"
DRY_RUN=0
REPOS=()

while [[ $# -gt 0 ]]; do
	case "$1" in
	--dry-run)
		DRY_RUN=1
		shift
		;;
	-h | --help)
		sed -n '2,30p' "$0"
		exit 0
		;;
	*)
		REPOS+=("$1")
		shift
		;;
	esac
done

# Discover the distinct git common dirs owning the worktrees under $WT_ROOT. A repo reached by
# several worktrees must be written once, not once per worktree.
COMMON_DIRS=""
add_common_dir() {
	local d="$1" cd_out
	cd_out="$(git -C "$d" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 0
	[ -n "$cd_out" ] || return 0
	case "$COMMON_DIRS" in
	*"|$cd_out|"*) return 0 ;;
	esac
	COMMON_DIRS="$COMMON_DIRS|$cd_out|"
}

for r in ${REPOS[@]+"${REPOS[@]}"}; do add_common_dir "$r"; done

# Scope: repos the Catalyst fleet manages, i.e. those owning a worktree under $WT_ROOT. TWO
# levels, and the second one is the whole point — ~/catalyst/wt/catalyst-cloud is a DIRECTORY
# CONTAINING worktrees, not a worktree itself, so a one-level glob discovered catalyst, Adva and
# slides and missed catalyst-cloud, the only repo with the defect. (Widening instead to every
# checkout on the machine was the other wrong answer: it pulled in unrelated repos including one
# literally named "thoughts", where ignoring thoughts/ would be actively wrong.)
if [ -d "$WT_ROOT" ]; then
	for d in "$WT_ROOT"/*/ "$WT_ROOT"/*/*/; do
		[ -d "$d" ] && add_common_dir "$d"
	done
fi

# ⛔ Discovering nothing must not read as "everything is already fine".
if [ -z "$COMMON_DIRS" ]; then
	echo "backfill: FAIL — found ZERO git repositories to back-fill (WT_ROOT=$WT_ROOT)." >&2
	echo "  A run that touched no repository is not a successful run." >&2
	exit 2
fi

LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
printf '%s' "$COMMON_DIRS" | tr '|' '\n' | grep -v '^$' | sort -u >"$LIST"

# ⛔ Only repos that ACTUALLY HAVE THE DEFECT are touched. Discovery deliberately over-collects
# (every checkout under $REPO_ROOT) because the affected repo was not under $WT_ROOT; writing an
# ignore into all of them would be scope creep on someone's machine — one of the discovered
# repos is literally named "thoughts", where ignoring thoughts/ would be actively wrong.
# The predicate is: at least one worktree of this repo shows an UNTRACKED thoughts/ entry.
repo_has_untracked_thoughts() {
	local gcd="$1" wt
	while IFS= read -r wt; do
		[ -d "$wt" ] || continue
		if git -C "$wt" status --porcelain 2>/dev/null | grep -q '^?? *thoughts/'; then return 0; fi
	done < <(git --git-dir="$gcd" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}')
	return 1
}

echo "== 1. repos with an UNTRACKED thoughts/ in at least one worktree"
CHANGED=0
ALREADY=0
SKIPPED=0
while IFS= read -r gcd; do
	name="$(basename "$(dirname "$gcd")")"
	excl="$gcd/info/exclude"
	# ⛔ Report a repo we ALREADY fixed as "already ignored", not as "nothing to do". Once the
	# exclude works the repo stops matching repo_has_untracked_thoughts, so keying only on that
	# made a re-run print "changed=0 already=0" — a zero an operator cannot tell apart from "did
	# not look". Caught by the idempotence case in the test, not by reading the code.
	if [ -f "$excl" ] && grep -qxF "$MARKER" "$excl" 2>/dev/null; then
		echo "  already ignored: $name"
		ALREADY=$((ALREADY + 1))
		continue
	fi
	if ! repo_has_untracked_thoughts "$gcd"; then
		SKIPPED=$((SKIPPED + 1))
		continue
	fi
	if [ "$DRY_RUN" -eq 1 ]; then
		echo "  [dry-run] would add '$MARKER' to $excl"
		CHANGED=$((CHANGED + 1))
		continue
	fi
	mkdir -p "$gcd/info"
	{
		echo ""
		echo "# CTC-633: the thoughts/ farm is symlinked in per worktree and must never make a"
		echo "# tree read as dirty — an unreclaimable worktree is how the host runs out of disk."
		echo "# Added by scripts/worktree-thoughts-exclude-backfill.sh for worktrees on branches"
		echo "# cut before the .gitignore commit. Shared by every worktree of this repo."
		echo "$MARKER"
	} >>"$excl"
	echo "  ADDED: $name ($excl)"
	CHANGED=$((CHANGED + 1))
done <"$LIST"
echo "  ($SKIPPED repo(s) had no untracked thoughts/ and were left alone)"

echo ""
echo "== 2. per-worktree result (the measurement, not the intent)"
STILL=0
TRACKED=0
while IFS= read -r gcd; do
	while IFS= read -r wt; do
		[ -d "$wt" ] || continue
		st="$(git -C "$wt" status --porcelain 2>/dev/null | grep 'thoughts/')"
		[ -z "$st" ] && continue
		u="$(printf '%s\n' "$st" | grep -c '^?? *thoughts/')"
		t="$(printf '%s\n' "$st" | grep -cE '^ ?[MADRU].*thoughts/')"
		if [ "$u" -gt 0 ]; then
			echo "  ⛔ STILL UNTRACKED ($u): $wt"
			STILL=$((STILL + 1))
		fi
		if [ "$t" -gt 0 ]; then
			echo "  ⚠️  TRACKED-MODIFIED ($t): $wt"
			TRACKED=$((TRACKED + 1))
		fi
	done < <(git --git-dir="$gcd" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}')
done <"$LIST"

echo ""
echo "backfill: repos changed=$CHANGED already=$ALREADY | worktrees still-untracked=$STILL tracked-modified=$TRACKED (dry-run=$DRY_RUN)"
if [ "$TRACKED" -gt 0 ]; then
	echo ""
	echo "⚠️  $TRACKED worktree(s) show TRACKED-MODIFIED thoughts/ paths. No ignore rule of any kind"
	echo "    silences a tracked path, so this backfill cannot fix them and does not pretend to."
	echo "    They need 'git update-index --skip-worktree' or a sweeper-side rule."
fi
# A non-dry run that left untracked cases behind did not do its job.
if [ "$DRY_RUN" -eq 0 ] && [ "$STILL" -gt 0 ]; then exit 1; fi
exit 0
