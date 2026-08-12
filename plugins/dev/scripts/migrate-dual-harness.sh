#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/portable-stat.sh"
# migrate-dual-harness.sh — migrate a single-harness repo (Claude-only monolithic
# CLAUDE.md, or Codex-only AGENTS.md-with-no-bridge) to the dual-harness layout so
# BOTH Claude Code and Codex load the same instructions and the same skills.
#
# WHY: `ensure-agent-house-rules.sh` seeds one canonical block into whichever doc a
# repo already has; it does not establish the AGENTS.md/CLAUDE.md pair itself, and it
# never touches skills. A Claude-only repo (monolithic CLAUDE.md, skills only under
# `.claude/skills/`) or a Codex-only repo (AGENTS.md, no CLAUDE.md bridge) stays
# single-harness forever. This script is the mechanical migrator for that gap.
#
# Target layout (validated in catalyst-otel, OTL-58 / PR #115):
#   - AGENTS.md       — portable, tool-agnostic instructions (canonical)
#   - CLAUDE.md       — thin bridge: `@AGENTS.md` line 1 + only Claude-specific notes
#   - .agents/skills/ — canonical skills dir (must be a REAL directory, or absent)
#   - .claude/skills  — committed RELATIVE symlink -> ../.agents/skills
#   - AGENTS.md carries a `## Skills` pointer section when skills exist (non-empty)
#   - no .codex/ dir needed — Codex reads AGENTS.md and .agents/skills/ natively
#
# Classification (computed every run, independent of the skills state below):
#   dual-ok                - CLAUDE.md imports @AGENTS.md; AGENTS.md exists
#   codex-only              - AGENTS.md exists, no CLAUDE.md
#   claude-only-monolithic  - CLAUDE.md exists, does NOT import @AGENTS.md (even if
#                             an unreferenced AGENTS.md also exists — the split must
#                             reconcile them; this script never does that split)
#   no-harness              - neither doc exists. Out of scope for the docs pair
#                             (note points at `ensure-agent-house-rules.sh --fix`,
#                             which creates it) — but skills classification and the
#                             mechanical skills fix STILL run in this case; only the
#                             pointer step is n/a (there is no AGENTS.md to hold it).
#
# Skills state machine (independent of docs state; `.claude/skills` vs `.agents/skills`).
# `.agents/skills` must be the canonical REAL directory (or absent) — so the very
# first check below is `[[ -L "$AS" ]]`, BEFORE any -e/-d probe of $AS, in every
# branch. A repo can be wired in reverse (`.claude/skills` real, `.agents/skills` a
# symlink back to it, e.g. `../.claude/skills`) or `.agents/skills` can be a plain
# dangling symlink — both must stop at rc 4, never fall through to "none"/"move"/
# "collapse". Without this guard a reverse-wired repo's `diff -r` compares the real
# tree against itself through the symlink ("identical" => collapse), and the
# collapse's `rm -rf .claude/skills` then destroys the only copy of the content:
#   absent / absent                          -> nothing to do
#   symlink -> ../.agents/skills / dir       -> OK, canonical
#   symlink -> an absolute path resolving
#     to .agents/skills / dir                -> mechanical fix: rewrite the link
#                                               to the relative ../.agents/skills
#                                               (an absolute link resolves fine
#                                               here but breaks on clone/relocate)
#   symlink -> anything else / any           -> rc 4, ambiguous, touch nothing
#   real dir / absent                        -> move .claude/skills -> .agents/skills,
#                                               symlink .claude/skills back (refused
#                                               as rc 4 instead if any symlink inside
#                                               .claude/skills resolves outside the
#                                               tree, or is dangling — its base would
#                                               change after the move)
#   absent / real dir                        -> symlink .claude/skills -> ../.agents/skills
#   real dir / real dir, `diff -r` identical -> collapse .claude/skills to a symlink
#     (belt-and-braces: refused as rc 4 instead if the two paths resolve to the
#     same physical directory — a collapse must never be a same-dir no-op)
#   real dir / real dir, differ              -> rc 4, ambiguous, touch nothing
#   any / .agents/skills is itself a symlink -> rc 4, ambiguous, touch nothing
#     (reverse-wired OR dangling — regardless of whether .claude/skills exists)
#
# Usage:
#   migrate-dual-harness.sh [--repo DIR] [--fix] [--quiet] [-h|--help]
#     (no --fix) -> dry-run: report what WOULD change; writes NOTHING, ever.
#     --fix      -> apply the mechanical fixes in place.
#
# Exit codes:
#   0  - dual-ok (dry-run) or all needed mechanical fixes applied and now dual-ok
#        (--fix); also no-harness once skills are also clean/none (see above).
#   10 - dry-run: mechanical changes needed (bridge / skills wiring / skills
#        pointer / absolute-symlink rewrite), and no monolithic-split problem.
#        Also used for no-harness dry-run when skills wiring is needed.
#   11 - monolithic CLAUDE.md needs the intelligent split (with or without --fix;
#        under --fix the mechanical parts — skills wiring, pointer if AGENTS.md
#        exists — are still applied first). Run the
#        catalyst-foundry:migrate-dual-harness skill to split CLAUDE.md.
#   2  - bad usage.
#   4  - ambiguous skills state (including a .claude/skills move whose tree
#        contains a symlink that would escape it or dangle after relocation),
#        or a symlinked/git-ignored instruction document, or a git-ignored
#        skills destination path (message names the exact conflict via
#        `git check-ignore -v`); touches nothing.
#   5  - I/O failure.
set -uo pipefail

FIX=0 REPO="." QUIET=0
while [[ $# -gt 0 ]]; do
	case "$1" in
	--fix) FIX=1 ;;
	--repo)
		if [[ $# -lt 2 ]]; then
			echo "migrate-dual-harness: --repo needs a dir" >&2
			exit 2
		fi
		REPO="$2"
		shift
		;;
	--quiet) QUIET=1 ;;
	-h | --help) sed -n '2,84p' "$0"; exit 0 ;;
	*) echo "migrate-dual-harness: unknown arg '$1'" >&2; exit 2 ;;
	esac
	shift
done

say() { [[ $QUIET -eq 1 ]] || printf '%s\n' "$*"; }
die() { echo "migrate-dual-harness: $1" >&2; exit "${2:-5}"; }

[[ -d "$REPO" ]] || die "--repo '$REPO' is not a directory" 2

BRIDGE_LINE='@AGENTS.md'
CLA="$REPO/CLAUDE.md"
AG="$REPO/AGENTS.md"
CS="$REPO/.claude/skills"
AS="$REPO/.agents/skills"

# --- reject symlinked instruction documents ------------------------------------
# CLAUDE.md / AGENTS.md must be regular files, never symlinks — dangling or not.
# A dangling `CLAUDE.md -> ../outside.md` fails the `-f "$CLA"` probe below
# (dangling symlinks are not -f), so doc classification would treat the bridge
# as absent (e.g. "codex-only") — but `--fix`'s `>"$CLA"` open-for-write
# follows the symlink and creates/overwrites `outside.md` OUTSIDE --repo,
# reporting success while the repo's own CLAUDE.md stays a dangling symlink.
# Refuse before any classification runs.
for doc_path in "$CLA" "$AG"; do
	[[ -L "$doc_path" ]] && die "${doc_path#"$REPO"/} is a symlink — instruction documents must be regular files, not symlinks (dangling or not); replace it with a real file and re-run" 4
	# Any other non-regular entry (FIFO, socket, directory, device) is just as
	# unusable: classification would treat it as absent (-f is false) and a
	# --fix redirect into a FIFO blocks forever. Refuse before classification.
	[[ -e "$doc_path" && ! -f "$doc_path" ]] && die "${doc_path#"$REPO"/} exists but is not a regular file — instruction documents must be regular files; replace it and re-run" 4
done

# --- reject git-ignored instruction documents ----------------------------------
# A thin CLAUDE.md bridge that imports an AGENTS.md the repo's own git-ignore
# rules exclude (or vice versa) can never be committed correctly: `git add -A`
# stages one half of the pair and silently omits the other, so a fresh clone
# gets a bridge importing a file that doesn't exist there. Refuse before any
# classification or fix runs. Only meaningful inside a git repo; a non-git
# directory has no ignore rules to violate.
if git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
	for doc_path in "$AG" "$CLA"; do
		doc_rel="${doc_path#"$REPO"/}"
		if git -C "$REPO" check-ignore -q -- "$doc_rel" 2>/dev/null; then
			doc_ignore_detail="$(git -C "$REPO" check-ignore -v -- "$doc_rel" 2>/dev/null)"
			die "${doc_rel} is git-ignored (${doc_ignore_detail}) — an ignored instruction document can never be committed; delete that exclude rule and re-run" 4
		fi
	done
fi

# --- verbatim from ensure-agent-house-rules.sh (deliberate duplication — that
# script is intentionally self-contained; do not refactor either copy to share
# this code). Only the fence/comment-aware defenced() helper and the
# claude_imports_agents() detection are copied; everything below this block is new.
defenced() {
	awk -v sc="${2:-0}" '
		function ls3(s){ for(k=0;k<3;k++){ if(substr(s,1,1)==" ") s=substr(s,2); else break } return s }
		{ line=$0; sub(/\r$/,"",line); sub(/[[:space:]]+$/,"",line); ls=ls3(line)
			if (sc=="1") {
				if (incomment) { if (line ~ /-->/) incomment=0; print ""; next }
				if (ls ~ /^<!--/) { if (line !~ /-->/) incomment=1; print ""; next }
			}
			if (!infence) {
				if (match(ls, /^(`+|~+)/)) { d=substr(ls,RSTART,RLENGTH)
					if (length(d) >= 3) { infence=1; fchar=substr(d,1,1); flen=length(d); print ""; next } }
			} else {
				if (match(ls, /^(`+|~+)/) && ls ~ /^[`~]+[[:space:]]*$/) { d=substr(ls,RSTART,RLENGTH)
					if (substr(d,1,1)==fchar && length(d) >= flen) { infence=0; print ""; next } }
				print ""; next
			}
			print line }' "$1"
}
# Anywhere-in-file, not line-1-only: matches the seeder's established
# claude_imports_agents() semantics (verbatim copy) and the validated reference
# repo (catalyst-otel has intro prose before its @AGENTS.md import, OTL-58).
# Requiring line 1 would misclassify that reference repo as monolithic.
# Residual risk (accepted deliberately): a genuinely monolithic CLAUDE.md with
# a stray standalone `@AGENTS.md` line anywhere in its body reads as an
# already-migrated bridge even though portable content is still stranded in
# CLAUDE.md.
claude_imports_agents() { [[ -f "$CLA" ]] || return 1; grep -Fxq "$BRIDGE_LINE" <<<"$(defenced "$CLA" 1)"; }
# --- end verbatim block ------------------------------------------------------

# Real (symlink-resolved) path of a directory, or empty if it doesn't resolve.
realdir() { ( cd -P "$1" 2>/dev/null && pwd ) || true; }

# Resolve a symlink's immediate target directory to a physical (symlink-free)
# path via cd -P — no readlink -f / realpath on macOS bash 3.2. Empty output
# means some hop doesn't exist; caller treats that as unresolvable/dangling.
resolve_symlink_target_dir() {
	local link="$1" link_dir target target_dir
	link_dir="$(cd -P "$(dirname "$link")" 2>/dev/null && pwd)" || return 1
	target="$(readlink "$link")" || return 1
	case "$target" in
	/*) target_dir="$(dirname "$target")" ;;
	*) target_dir="${link_dir}/$(dirname "$target")" ;;
	esac
	(cd -P "$target_dir" 2>/dev/null && pwd)
}

REPO_REL_CLA="${CLA#"$REPO"/}"
REPO_REL_AG="${AG#"$REPO"/}"

# --- classify docs state ------------------------------------------------------
if [[ -f "$CLA" ]]; then
	if claude_imports_agents; then
		if [[ -f "$AG" ]]; then
			DOC_STATE="dual-ok"
		else
			DOC_STATE="bridge-no-agents"
		fi
	else
		DOC_STATE="claude-only-monolithic"
	fi
elif [[ -f "$AG" ]]; then
	DOC_STATE="codex-only"
else
	DOC_STATE="no-harness"
fi

if [[ "$DOC_STATE" == "no-harness" ]]; then
	say "no AGENTS.md or CLAUDE.md found in ${REPO} — the docs pair is out of scope for migrate-dual-harness.sh. Run \`ensure-agent-house-rules.sh --fix\` first (it creates the doc pair). Still checking skills wiring below."
fi

# --- classify skills state (independent of docs state) -----------------------
# .agents/skills must be the canonical REAL directory (or absent) — so `-L "$AS"`
# is checked FIRST, before any -e/-d probe of $AS, in every branch. See the
# skills-state-machine note in the header for why: a reverse-wired repo
# (.claude/skills real, .agents/skills -> ../.claude/skills) or a dangling
# .agents/skills symlink must both stop here at rc 4, never reach "collapse"
# (which would `diff -r` the real tree against itself through the symlink, see
# it as "identical", then `rm -rf` the only copy) or "none"/"move".
# An unreadable (but traversable) tree must be a loud I/O error, not silently
# classified: every empty-vs-nonempty probe below uses `ls -A`, whose failure
# would read as "empty" and skip a repo's real skills with rc 0.
for skills_dir in "$CS" "$AS"; do
	if [[ -d "$skills_dir" && ! -L "$skills_dir" && ! -r "$skills_dir" ]]; then
		die "cannot read ${skills_dir#"$REPO"/} (permission denied) — fix permissions and re-run" 5
	fi
done

SKILLS_ACTION="none"
SKILLS_MSG=""
if [[ -L "$AS" ]]; then
	SKILLS_ACTION="ambiguous"
	if [[ -e "$AS" ]]; then
		SKILLS_MSG=".agents/skills is a symlink (-> '$(readlink "$AS")') — it must be the canonical real directory, not a symlink"
	else
		SKILLS_MSG=".agents/skills is a dangling symlink (-> '$(readlink "$AS")')"
	fi
elif [[ -L "$CS" ]]; then
	if [[ -d "$AS" ]] && [[ -n "$(realdir "$CS")" ]] && [[ "$(realdir "$CS")" == "$(realdir "$AS")" ]]; then
		# Resolves correctly — but ONLY the literal portable spelling
		# `../.agents/skills` is a terminal "ok". An absolute link breaks on
		# clone/relocate; so does a noncanonical relative one that routes
		# through the checkout name (e.g. `../../reponame/.agents/skills`).
		# Both are mechanical fixes (rewrite to the canonical relative form).
		# And an EMPTY canonical tree behind a committed link is refused: git
		# cannot record the empty directory, so every fresh clone would get a
		# dangling .claude/skills while checkup reads green.
		if [[ -z "$(ls -A "$AS" 2>/dev/null)" ]]; then
			SKILLS_ACTION="ambiguous"
			SKILLS_MSG=".claude/skills points at an EMPTY .agents/skills — git cannot track an empty directory, so the committed link dangles on fresh clones; add content or remove the link"
		elif [[ "$(readlink "$CS")" == "../.agents/skills" ]]; then
			SKILLS_ACTION="ok"
		else
			SKILLS_ACTION="rewrite"
		fi
	else
		SKILLS_ACTION="ambiguous"
		SKILLS_MSG=".claude/skills is a symlink to '$(readlink "$CS")', which does not resolve to .agents/skills"
	fi
elif [[ -d "$CS" ]]; then
	if [[ -e "$AS" ]]; then
		if [[ -d "$AS" ]]; then
			CS_REAL="$(realdir "$CS")"
			AS_REAL="$(realdir "$AS")"
			if [[ -n "$CS_REAL" ]] && [[ "$CS_REAL" == "$AS_REAL" ]]; then
				# Belt-and-braces: neither path is a symlink itself, but they
				# resolve to the same physical directory (e.g. a symlinked
				# ancestor). A collapse must never be a same-dir no-op — refuse.
				SKILLS_ACTION="ambiguous"
				SKILLS_MSG=".claude/skills and .agents/skills resolve to the same physical directory"
			elif [[ -n "$(find "$CS" "$AS" -type l -print 2>/dev/null | head -n 1)" ]]; then
				# Refuse nested symlinks BEFORE diff -r: implementations that
				# dereference links would otherwise traverse arbitrarily large
				# external checkouts / recursive mounts during a dry-run or
				# checkup, only to have the state rejected as ambiguous anyway
				# (the same guard used to run post-diff; order matters).
				SKILLS_ACTION="ambiguous"
				SKILLS_MSG="a symlink exists inside .claude/skills or .agents/skills — cannot prove the trees are independent copies (diff -r follows symlinks), refusing to collapse"
			elif diff -r "$CS" "$AS" >/dev/null 2>&1; then
				SKILLS_ACTION="collapse"
				# diff -r proves byte-identical CONTENT but never compares the
				# executable bit — a collapse keeps ONLY the .agents/skills copy
				# (rm -rf .claude/skills + symlink), so a mode mismatch on a
				# runnable helper (e.g. a skill's run.sh) would silently
				# downgrade it from 0755 to 0644. Compare every counterpart
				# pair's -x bit before trusting the collapse.
				# Compare the recorded permission bits, not [[ -x ]] (effective
				# access): as root, -x is true whenever ANY execute bit is set,
				# so 0100-vs-0001 mode pairs would wrongly compare equal.
				# GNU `stat -c %a` first, BSD `stat -f %Lp` fallback (macOS).
				# Directories too (not just files): a collapse keeps only the
				# .agents/skills copy, so a 0755-vs-0700 directory pair would
				# silently drop group access / setgid semantics. The tree
				# roots themselves are compared first (-mindepth 1 skips them
				# in the loop, where the rel-path arithmetic needs a child).
				cs_mode="$(portable_stat_mode "$CS")"
				as_mode="$(portable_stat_mode "$AS")"
				if [[ "$cs_mode" != "$as_mode" ]]; then
					SKILLS_ACTION="ambiguous"
					SKILLS_MSG="byte-identical but the tree roots' modes differ: .claude/skills is mode ${cs_mode:-unreadable} but .agents/skills is ${as_mode:-unreadable}"
				fi
				[[ "$SKILLS_ACTION" == "collapse" ]] && while IFS= read -r cs_file; do
					rel_path="${cs_file#"$CS"/}"
					as_file="$AS/$rel_path"
					cs_mode="$(portable_stat_mode "$cs_file")"
					as_mode="$(portable_stat_mode "$as_file")"
					if [[ "$cs_mode" != "$as_mode" ]]; then
						SKILLS_ACTION="ambiguous"
						SKILLS_MSG="byte-identical but modes differ: '${rel_path}' is mode ${cs_mode:-unreadable} under .claude/skills but ${as_mode:-unreadable} under .agents/skills"
						break
					fi
				done < <(find "$CS" -mindepth 1 \( -type f -o -type d \))
			else
				SKILLS_ACTION="ambiguous"
				SKILLS_MSG=".claude/skills and .agents/skills both exist as real directories and differ"
			fi
		else
			SKILLS_ACTION="ambiguous"
			SKILLS_MSG=".agents/skills exists but is not a directory"
		fi
	elif [[ -e "$CS/.git" ]]; then
		# A checked-out git submodule (or nested repo): moving it stages a
		# gitlink at the new path while .gitmodules still names the old one —
		# fresh clones can't init it. Refuse; migrating submodule metadata is
		# a human decision.
		SKILLS_ACTION="ambiguous"
		SKILLS_MSG=".claude/skills is a git submodule / nested git repo — moving it would break its .gitmodules path mapping; migrate the submodule by hand"
	elif [[ -z "$(ls -A "$CS" 2>/dev/null)" ]]; then
		# Empty legacy tree: nothing to wire. Moving it would create an empty
		# .agents/skills (untrackable by git) plus a symlink that dangles on
		# every fresh clone — and the next run would refuse it as rc 4 anyway.
		SKILLS_ACTION="none"
		say "note: .claude/skills exists but is empty — nothing to migrate (git cannot track an empty directory)"
	elif [[ -n "$(find "$CS" -name .gitignore -print 2>/dev/null | head -n 1)" ]]; then
		# A .gitignore INSIDE the moving tree travels with it, so its rules
		# apply at the NEW base after the move — the destination-path ignore
		# probe below (which asks git about the CURRENT rules) cannot see
		# them. A rule matching a moved file would silently drop that skill
		# from the commit. Refuse; the operator decides what the nested
		# ignore file should mean at the new location.
		SKILLS_ACTION="ambiguous"
		SKILLS_MSG=".claude/skills contains a .gitignore that would move with the tree — its rules at the new .agents/skills base cannot be audited in advance; resolve it by hand"
	else
		SKILLS_ACTION="move"
	fi
elif [[ -e "$CS" ]]; then
	SKILLS_ACTION="ambiguous"
	SKILLS_MSG=".claude/skills exists but is neither a symlink nor a directory"
else
	if [[ -d "$AS" ]]; then
		if [[ -n "$(ls -A "$AS" 2>/dev/null)" ]]; then
			SKILLS_ACTION="symlink-only"
		else
			# Git cannot record an empty directory, so a compatibility symlink
			# onto an empty .agents/skills would commit as a dangling link on
			# every fresh clone. Nothing to wire until the dir has content.
			SKILLS_ACTION="none"
			say "note: .agents/skills exists but is empty — skipping the .claude/skills symlink (git cannot track an empty directory; a committed link would dangle on fresh clones)"
		fi
	elif [[ -e "$AS" ]]; then
		SKILLS_ACTION="ambiguous"
		SKILLS_MSG=".agents/skills exists but is not a directory"
	else
		SKILLS_ACTION="none"
	fi
fi

# (The nested-symlink collapse refusal now runs INSIDE the classification,
# BEFORE diff -r — see the both-real-dirs branch — so a dereferencing diff can
# never traverse external checkouts / recursive mounts first.)

# A move relocates .claude/skills's PARENT directory to .agents/skills, so any
# symlink inside it whose resolved target lies OUTSIDE that tree would answer
# to a different base afterward (a relative target is reinterpreted from the
# new .agents/skills location; an absolute target is untouched but the link
# itself moved away from it). A dangling link can't be proven safe either, so
# it is treated the same as an escape. Links resolving INSIDE the tree are
# fine — they move together with it.
if [[ "$SKILLS_ACTION" == "move" ]]; then
	CS_REAL_BASE="$(realdir "$CS")"
	while IFS= read -r link_path; do
		rel_link="${link_path#"$CS"/}"
		if [[ ! -e "$link_path" ]]; then
			SKILLS_ACTION="ambiguous"
			SKILLS_MSG=".claude/skills contains a dangling symlink ('${rel_link}') — cannot prove its target stays inside the tree after the move"
			break
		fi
		# An ABSOLUTE link is unportable even when it currently resolves
		# inside the tree: its text names this checkout's path, so it dangles
		# after a clone/rename even though the move itself succeeds.
		case "$(readlink "$link_path")" in
		/*)
			SKILLS_ACTION="ambiguous"
			SKILLS_MSG=".claude/skills contains an ABSOLUTE symlink ('${rel_link}') — its text names this checkout's path and would dangle after clone/rename; make it relative and re-run"
			break
			;;
		esac
		target_dir_real="$(resolve_symlink_target_dir "$link_path")"
		if [[ -z "$target_dir_real" ]]; then
			SKILLS_ACTION="ambiguous"
			SKILLS_MSG=".claude/skills contains a symlink ('${rel_link}') whose target could not be resolved — cannot prove it stays inside the tree after the move"
			break
		fi
		case "$target_dir_real" in
		"$CS_REAL_BASE" | "$CS_REAL_BASE"/*) : ;;
		*)
			SKILLS_ACTION="ambiguous"
			SKILLS_MSG=".claude/skills contains a symlink ('${rel_link}') resolving outside the tree — its base would change after the move"
			break
			;;
		esac
	done < <(find "$CS" -type l 2>/dev/null)
fi

# The fixes below create/move entries under .claude/ and .agents/ assuming both
# are real directories directly under the repo root — a symlinked .claude or
# .agents ancestor would make the relative ../.agents/skills link land (and
# dangle) in the physical target instead. Refuse rather than wire a broken link.
# "ok" is included too: an already-wired layout that only resolves through a
# symlinked ancestor (e.g. `.agents -> /tmp/outside`) has its canonical tree
# OUTSIDE the repo — it would be missing on any other machine or fresh clone,
# so reporting it healthy would be a false green.
case "$SKILLS_ACTION" in
move | symlink-only | collapse | rewrite | ok)
	if [[ -L "$REPO/.claude" || -L "$REPO/.agents" ]]; then
		SKILLS_ACTION="ambiguous"
		SKILLS_MSG=".claude or .agents is itself a symlink — the canonical skills tree would live (or the relative link would dangle) outside the repo's physical tree"
	fi
	;;
esac

# The migrated canonical skills tree must be trackable by git — otherwise a
# plain `git add -A` after the fix silently omits .agents/skills (e.g. a stale
# `.agents/` line in .git/info/exclude left behind by, say, the Codex runner's
# gitExcludeAgents), staging the .claude/skills deletion + new symlink but NOT
# the moved content — fresh clones then get a dangling link and no project
# skills. Only applies inside a git repo; `git check-ignore -v`'s own output
# names the exact source file:line so the fix is copy-pasteable.
# "ok" is included: a repo already migrated while the exclusion was in place has
# the same fresh-clone failure latent — surface it retroactively, not just when
# a move is in flight.
case "$SKILLS_ACTION" in
move | symlink-only | collapse | ok | rewrite)
	if git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
		# Sparse-checkout: check-ignore reports no hit for a path outside the
		# cone, yet a plain `git add -A` refuses to stage new files there — the
		# moved skills would silently drop from the commit. Refuse when sparse
		# mode is active; the operator widens the cone (or uses git add
		# --sparse deliberately) and re-runs.
		if [[ "$(git -C "$REPO" config --get core.sparseCheckout 2>/dev/null)" == "true" ]]; then
			SKILLS_ACTION="ambiguous"
			SKILLS_MSG="the repo has an active sparse-checkout (core.sparseCheckout=true) — a plain 'git add -A' may refuse paths outside the cone, silently dropping migrated skills from the commit; widen the cone to include .agents/ and .claude/ and re-run"
		fi
		# Check the actual DESTINATION pathnames that will exist under
		# .agents/skills, not just the directory itself — an ignore rule that
		# matches only descendants (`.agents/skills/**`, or a global `*.md`)
		# is invisible to `check-ignore .agents/skills` alone: the directory
		# itself isn't ignored, only its future contents are, so the old
		# single-path probe reported the move as trackable while a later
		# `git add -A` would have silently omitted every file under it. For a
		# pending move the destinations are computed from .claude/skills (the
		# content hasn't moved yet); for collapse/ok/symlink-only/rewrite the
		# content already lives at .agents/skills. The bare directory path is
		# always included too (covers an empty tree). `check-ignore --stdin`
		# (with -v) prints one line per MATCHED path and exits 0 if any
		# matched, 1 if none did — so branch on captured output, not on the
		# pipeline's own exit status (set -o pipefail would otherwise fold a
		# clean "nothing ignored" rc=1 into a surrounding pipeline).
		# The Claude compatibility link is audited too: a repo ignoring
		# `.claude/` (or `.claude/skills`) would commit the canonical tree but
		# omit the symlink, leaving Claude Code with no skills on a fresh clone.
		DEST_PATHS=".agents/skills"$'\n'".claude/skills"$'\n'
		case "$SKILLS_ACTION" in
		move)
			while IFS= read -r cs_file; do
				DEST_PATHS="${DEST_PATHS}.agents/skills/${cs_file#"$CS"/}"$'\n'
			done < <(find "$CS" \( -type f -o -type l \) 2>/dev/null)
			;;
		collapse | ok | symlink-only | rewrite)
			while IFS= read -r as_file; do
				DEST_PATHS="${DEST_PATHS}.agents/skills/${as_file#"$AS"/}"$'\n'
			done < <(find "$AS" \( -type f -o -type l \) 2>/dev/null)
			;;
		esac
		# Decide with the NON-verbose form: it prints only genuinely-ignored
		# paths. `-v` would also print paths matched by NEGATION patterns
		# (`!.agents/skills`), which are explicitly NOT ignored — deciding on
		# -v output would falsely refuse a repo that un-ignores the tree.
		GIT_IGNORE_HITS="$(printf '%s' "$DEST_PATHS" | git -C "$REPO" check-ignore --stdin 2>/dev/null)"
		if [[ -n "$GIT_IGNORE_HITS" ]]; then
			GIT_IGNORE_HIT_PATH="$(printf '%s\n' "$GIT_IGNORE_HITS" | head -n 1)"
			GIT_IGNORE_FIRST="$(git -C "$REPO" check-ignore -v -- "$GIT_IGNORE_HIT_PATH" 2>/dev/null | head -n 1)"
			SKILLS_ACTION="ambiguous"
			SKILLS_MSG="${GIT_IGNORE_HIT_PATH} is git-ignored (${GIT_IGNORE_FIRST}) — delete that exclude line and re-run"
		fi
	fi
	;;
esac

if [[ "$SKILLS_ACTION" == "ambiguous" ]]; then
	die "ambiguous skills state: ${SKILLS_MSG} — refusing to touch either directory. Resolve by hand and re-run." 4
fi

# HAS_SKILLS reflects the canonical tree's non-emptiness, checked BEFORE any
# mechanical fix below runs — so "move" (pre-move) inspects .claude/skills, the
# location that still holds the content at this point, and every other action
# inspects .agents/skills. An empty skills tree must never earn an AGENTS.md
# pointer (there would be nothing at the path the pointer describes).
HAS_SKILLS=0
case "$SKILLS_ACTION" in
move) [[ -n "$(ls -A "$CS" 2>/dev/null)" ]] && HAS_SKILLS=1 ;;
ok | symlink-only | collapse | rewrite) [[ -n "$(ls -A "$AS" 2>/dev/null)" ]] && HAS_SKILLS=1 ;;
none) : ;;
esac

NEED_FIX=0

# --- docs mechanical fix (never applies to claude-only-monolithic — that split
# needs LLM judgment and is out of scope for this script; also never applies to
# no-harness — establishing the doc pair itself is ensure-agent-house-rules.sh's
# job, not this script's) ------------------------------------------------------
case "$DOC_STATE" in
codex-only)
	NEED_FIX=1
	if [[ $FIX -eq 1 ]]; then
		printf '%s\n\n## Bridge\n\nAll portable project guidance lives in `AGENTS.md` (imported above). Add only tool-specific notes here.\n' "$BRIDGE_LINE" >"$CLA" || die "failed to create $CLA"
		say "✓ fixed: created ${REPO_REL_CLA} (@AGENTS.md bridge)"
	else
		say "would CREATE ${REPO_REL_CLA} as a thin @AGENTS.md bridge"
	fi
	;;
bridge-no-agents)
	NEED_FIX=1
	if [[ $FIX -eq 1 ]]; then
		printf '# AGENTS.md\n\nPortable, tool-agnostic guidance for AI coding agents working in this repository.\n' >"$AG" || die "failed to create $AG"
		say "✓ fixed: created ${REPO_REL_AG} (portable core; CLAUDE.md already imports it)"
	else
		say "would CREATE ${REPO_REL_AG} (portable core; CLAUDE.md already imports it)"
	fi
	;;
dual-ok | claude-only-monolithic | no-harness) : ;;
esac

# --- skills mechanical fix -----------------------------------------------------
case "$SKILLS_ACTION" in
move)
	NEED_FIX=1
	if [[ $FIX -eq 1 ]]; then
		mkdir -p "$REPO/.agents" || die "failed to mkdir ${REPO}/.agents"
		mv "$CS" "$AS" || die "failed to move .claude/skills to .agents/skills"
		ln -s '../.agents/skills' "$CS" || die "failed to symlink .claude/skills"
		say "✓ fixed: moved .claude/skills to .agents/skills and symlinked .claude/skills -> ../.agents/skills"
	else
		say "would MOVE .claude/skills to .agents/skills and symlink .claude/skills -> ../.agents/skills"
	fi
	;;
rewrite)
	NEED_FIX=1
	if [[ $FIX -eq 1 ]]; then
		rm "$CS" || die "failed to remove .claude/skills symlink"
		ln -s '../.agents/skills' "$CS" || die "failed to symlink .claude/skills"
		say "✓ fixed: rewrote .claude/skills symlink to relative ../.agents/skills"
	else
		say "would REWRITE .claude/skills symlink to relative ../.agents/skills"
	fi
	;;
symlink-only)
	NEED_FIX=1
	if [[ $FIX -eq 1 ]]; then
		mkdir -p "$REPO/.claude" || die "failed to mkdir ${REPO}/.claude"
		ln -s '../.agents/skills' "$CS" || die "failed to symlink .claude/skills"
		say "✓ fixed: symlinked .claude/skills -> ../.agents/skills"
	else
		say "would SYMLINK .claude/skills -> ../.agents/skills"
	fi
	;;
collapse)
	NEED_FIX=1
	if [[ $FIX -eq 1 ]]; then
		rm -rf "$CS" || die "failed to remove duplicate .claude/skills"
		ln -s '../.agents/skills' "$CS" || die "failed to symlink .claude/skills"
		say "✓ fixed: collapsed identical .claude/skills into a symlink -> ../.agents/skills"
	else
		say "would COLLAPSE identical .claude/skills into a symlink -> ../.agents/skills"
	fi
	;;
ok | none) : ;;
esac

# --- AGENTS.md skills pointer --------------------------------------------------
NEED_POINTER=0
if [[ $HAS_SKILLS -eq 1 ]]; then
	if [[ -f "$AG" ]]; then
		# defenced() blanks fenced-code and HTML-comment lines, so a mention
		# inside a ```code block``` or <!-- comment --> doesn't suppress the
		# fix (it isn't a real pointer). The match is token-bounded so unrelated
		# names like `.agents/skills-old` don't count either. A genuine prose
		# mention outside a fence still counts — conservative, never risks
		# duplicating the pointer section.
		grep -Eq '(^|[^.[:alnum:]_-])\.agents/skills([^[:alnum:]_-]|$)' <<<"$(defenced "$AG" 1)" || NEED_POINTER=1
	elif [[ "$DOC_STATE" != "claude-only-monolithic" ]] && [[ "$DOC_STATE" != "no-harness" ]]; then
		# AGENTS.md doesn't exist yet but will (bridge-no-agents fix above) — the
		# freshly created file obviously lacks the pointer.
		NEED_POINTER=1
	fi
	# claude-only-monolithic with no AGENTS.md at all: never fabricate AGENTS.md
	# just to hold a pointer — that split is out of scope for this script.
	# no-harness: same reasoning — the docs pair itself is out of scope here.
fi

if [[ $NEED_POINTER -eq 1 ]]; then
	if [[ $FIX -eq 1 ]]; then
		[[ -f "$AG" ]] || die "internal error: ${REPO_REL_AG} missing when adding skills pointer"
		if [[ -s "$AG" ]] && [[ -n "$(tail -c1 "$AG")" ]]; then
			printf '\n' >>"$AG" || die "failed to append to ${REPO_REL_AG}"
		fi
		printf '\n## Skills\n\nRepository skills live in `.agents/skills/` — Claude Code finds them via the `.claude/skills`\nsymlink; any agent can read the path directly.\n' >>"$AG" || die "failed to append skills pointer to ${REPO_REL_AG}"
		say "✓ fixed: added '## Skills' pointer to ${REPO_REL_AG}"
	else
		say "would ADD a '## Skills' pointer section to ${REPO_REL_AG}"
	fi
fi

# --- final classification / exit ----------------------------------------------
if [[ "$DOC_STATE" == "claude-only-monolithic" ]]; then
	say "${REPO_REL_CLA} is monolithic (does not import @AGENTS.md) — needs the intelligent split. Run the catalyst-foundry:migrate-dual-harness skill to split CLAUDE.md."
	exit 11
fi

if [[ $FIX -eq 1 ]]; then
	if [[ "$DOC_STATE" == "no-harness" ]]; then
		say "✓ skills wiring OK in ${REPO} (docs pair still out of scope for migrate-dual-harness.sh)"
	else
		say "✓ dual-harness layout OK in ${REPO}"
	fi
	exit 0
fi

if [[ $NEED_FIX -eq 1 || $NEED_POINTER -eq 1 ]]; then
	say "(dry-run — re-run with --fix to apply)"
	exit 10
fi

if [[ "$DOC_STATE" == "no-harness" ]]; then
	say "✓ skills wiring already OK in ${REPO} (docs pair still out of scope for migrate-dual-harness.sh)"
else
	say "✓ dual-harness layout already OK in ${REPO}"
fi
exit 0
