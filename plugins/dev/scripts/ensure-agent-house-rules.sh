#!/usr/bin/env bash
# ensure-agent-house-rules.sh — seed / update the canonical "Working the Loop"
# agent house-rules block in a Catalyst-managed repo's agent-instructions doc.
#
# WHY: the block teaches EVERY agent (interactive too, not just slash-command
# skills) three default reflexes — subscribe to the event log instead of polling,
# recognize an automated review's clean-pass reaction, and read single Linear
# tickets from the freshness-gated local replica. `check-project-setup.sh` §9
# only *warns* when it is missing; this script is the *fix* — it makes every
# newly-enrolled (or drifted) repo carry the current canonical block. Idempotent:
# re-running syncs the block to the template, so it doubles as a "keep in sync"
# updater, not just a first-time seeder.
#
# The seeded block is wrapped in HTML-comment SENTINELS (catalyst-house-rules:
# begin/end). Detection, counting and replacement all key on those stable
# sentinels — so the heading/prose can be reworded without duplicating the block
# fleet-wide, a fenced code sample that shows the block is not mistaken for it,
# and trailing/setext content after the block is never swept away. Legacy blocks
# seeded before sentinels existed are detected by their exact heading (fence-aware)
# and upgraded in place.
#
# Target-doc rule (the file the DRIVING agent actually LOADS):
#   - CLAUDE.md imports AGENTS.md (a `@AGENTS.md` line) → AGENTS.md (create the
#     portable core if it is missing so the import resolves)
#   - CLAUDE.md is monolithic (no import)               → CLAUDE.md
#   - only AGENTS.md exists                              → AGENTS.md
#   - neither doc                                        → create AGENTS.md core +
#                                                          a thin `@AGENTS.md` bridge
# An existing managed/legacy block in the NON-loaded doc is left in place and
# reported as an orphan (never silently followed into a doc the agent won't read).
#
# Usage:
#   ensure-agent-house-rules.sh [--fix] [--repo DIR] [--template FILE] [--quiet]
#     (no --fix) → dry-run: report what WOULD change; exit 0 if already current,
#                  exit 10 if a change is needed (so callers can branch).
#     --fix      → write the change in place.
set -uo pipefail

FIX=0 REPO="." TEMPLATE="" QUIET=0
while [[ $# -gt 0 ]]; do
	case "$1" in
	--fix) FIX=1 ;;
	--repo) REPO="${2:?--repo needs a dir}"; shift ;;
	--template) TEMPLATE="${2:?--template needs a file}"; shift ;;
	--quiet) QUIET=1 ;;
	-h | --help) sed -n '2,40p' "$0"; exit 0 ;;
	*) echo "ensure-agent-house-rules: unknown arg '$1'" >&2; exit 2 ;;
	esac
	shift
done

say() { [[ $QUIET -eq 1 ]] || printf '%s\n' "$*"; }
die() { echo "ensure-agent-house-rules: $1" >&2; exit "${2:-5}"; }

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BEGIN_MARK='<!-- catalyst-house-rules:begin -->'
END_MARK='<!-- catalyst-house-rules:end -->'
BRIDGE_LINE='@AGENTS.md'

# Resolve the canonical template (repo copy → plugin-cache CLAUDE_PLUGIN_ROOT).
if [[ -z "$TEMPLATE" ]]; then
	for cand in \
		"${SCRIPT_DIR}/../templates/agents-house-rules.md" \
		"${CLAUDE_PLUGIN_ROOT:-}/templates/agents-house-rules.md"; do
		[[ -n "$cand" && -f "$cand" ]] && { TEMPLATE="$cand"; break; }
	done
fi
if [[ ! -f "$TEMPLATE" ]]; then
	[[ -n "$TEMPLATE" ]] && die "template not found at '$TEMPLATE'" 3
	die "canonical template not found (looked at ${SCRIPT_DIR}/../templates/agents-house-rules.md and \${CLAUDE_PLUGIN_ROOT}/templates/agents-house-rules.md)" 3
fi
[[ -d "$REPO" ]] || die "--repo '$REPO' is not a directory" 2

# BLOCK = template with the leading HTML seeding-comment stripped (that comment is
# maintainer instructions, not content for the repo). CRLF stripped up front so
# HEADING is LF-clean. The comment open/close are matched as WHOLE LINES so an
# inline `<!-- ... -->` inside a backtick code span in the comment body does not
# terminate the strip early (that leaked the maintainer prose into every block).
BLOCK="$(tr -d '\r' <"$TEMPLATE" | awk '
	f==0 && /^[[:space:]]*<!--/ { f=1; next }
	f==1 { if (/^[[:space:]]*-->[[:space:]]*$/) f=2; next }
	f==2 && /^[[:space:]]*$/ && seen==0 { seen=1; next }
	{ print }')"
HEADING="$(printf '%s\n' "$BLOCK" | head -n1)"

# Template integrity guards. The 👍 emoji is guarded too (not just the ASCII
# phrase) so a reword can't silently drop the concrete clean-pass detection signal.
for marker in 'subscribe to the event log' 'reaction, not a review object' '👍' 'local replica'; do
	printf '%s' "$BLOCK" | grep -qiF "$marker" || die "template missing marker '$marker' after comment strip — refusing" 3
done
# Defense-in-depth: any residual HTML-comment marker means the strip went wrong
# (or the template embeds a stray comment) — refuse rather than ship a corrupt block.
printf '%s\n' "$BLOCK" | grep -qE '<!--|-->' && die "template block still contains an HTML-comment marker after strip — refusing (the comment open/close must each be on their own line)" 3
printf '%s\n' "$BLOCK" | grep -qF 'catalyst-house-rules:' && die "template block contains a sentinel token — refusing (sentinels are added by the seeder, not the template)" 3
if printf '%s\n' "$BLOCK" | tail -n +2 | grep -qE '^#+[[:space:]]'; then
	die "template block body has a nested heading — keep the block flat below its title" 3
fi

# WRAPPED = the sentineled block that actually lands in a repo.
WRAPPED="$(printf '%s\n%s\n%s' "$BEGIN_MARK" "$BLOCK" "$END_MARK")"

CLA="$REPO/CLAUDE.md"
AG="$REPO/AGENTS.md"

# --- helpers -----------------------------------------------------------------
# print a file with fenced code regions blanked (and, with mode "1", HTML-comment
# regions too), CRLF + trailing whitespace stripped — for heading / import / marker
# detection that must ignore anything inside ``` / ~~~ fences (and comments). Fence
# tracking is CommonMark-ish: an opener is ≥3 of ` or ~ (≤3-space indent) and only a
# closer of the SAME char and ≥ the opener length closes it, so a 3-backtick line
# inside a 4-backtick fence does not mis-toggle. The rstrip is done here in awk
# (byte-safe) rather than a downstream `sed`, which on BSD/macOS mangles multibyte
# UTF-8 (e.g. the em-dash in the heading), causing a silent detection miss.
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
# Detection captures defenced output into a here-string before grepping, so a
# match never closes the pipe early and SIGPIPEs awk under `set -o pipefail`
# (which would flip the result to a false negative on a large doc). Sentinels are
# matched as WHOLE LINES (`grep -Fxq`), not substrings — an inline `<!-- ... -->`
# mention in prose is not a live sentinel. The heading match is ≤3-space-indent
# tolerant (CommonMark) via ls3, done in awk so the leading-strip doesn't corrupt
# other lines.
_line_eq_indent() { awk -v want="$2" 'function ls3(s){for(k=0;k<3;k++){if(substr(s,1,1)==" ")s=substr(s,2);else break}return s} ls3($0)==want{f=1} END{exit(f?0:1)}'; }
has_managed() { [[ -f "$1" ]] || return 1; grep -Fxq "$BEGIN_MARK" <<<"$(defenced "$1")"; }
has_legacy()  { [[ -f "$1" ]] || return 1; _line_eq_indent x "$HEADING" <<<"$(defenced "$1" 1)"; }
has_block()   { has_managed "$1" || has_legacy "$1"; }
claude_imports_agents() { [[ -f "$CLA" ]] || return 1; grep -Fxq "$BRIDGE_LINE" <<<"$(defenced "$CLA" 1)"; }

readlink_f() { readlink -f "$1" 2>/dev/null || realpath "$1" 2>/dev/null || python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$1" 2>/dev/null || echo "$1"; }

# Write CONTENT-FILE into DEST. Regular file → atomic temp-in-same-dir + rename,
# preserving the destination's mode (so a mid-write I/O failure can't truncate the
# doc). Symlink → write through to the resolved target to preserve the link (the one
# non-atomic case; a symlinked instruction doc pointing at shared content is rare and
# the doc is regenerable). New file → plain write.
write_through() {
	local src="$1" dest="$2"
	if [[ -L "$dest" ]]; then
		local real; real="$(readlink_f "$dest")"
		cat "$src" >"$real" || die "failed to write ${dest#"$REPO"/} via symlink (read-only?)"
	elif [[ -f "$dest" ]]; then
		local mode tmp; mode="$(stat -c '%a' "$dest" 2>/dev/null || stat -f '%Lp' "$dest" 2>/dev/null || echo '')"
		tmp="$(mktemp "$(dirname "$dest")/.house-rules.XXXXXX" 2>/dev/null)" || die "cannot create temp next to ${dest#"$REPO"/} (read-only dir?)"
		if ! cat "$src" >"$tmp"; then rm -f "$tmp"; die "failed to stage ${dest#"$REPO"/}"; fi
		[[ -n "$mode" ]] && chmod "$mode" "$tmp" 2>/dev/null
		mv "$tmp" "$dest" || { rm -f "$tmp"; die "failed to write ${dest#"$REPO"/} (read-only dir?)"; }
	else
		cat "$src" >"$dest" || die "failed to write ${dest#"$REPO"/}"
	fi
}
create_agents_core() {
	printf '# AGENTS.md\n\nPortable, tool-agnostic guidance for AI coding agents working in this repository.\n' >"$AG" || die "failed to create $AG"
}

# --- resolve the LOADED doc (the target) -------------------------------------
CREATED_DOCS=""
if [[ -f "$CLA" ]]; then
	if claude_imports_agents; then
		TARGET="$AG"
		if [[ ! -f "$AG" ]]; then
			CREATED_DOCS="AGENTS.md (portable core; CLAUDE.md already imports it)"
			[[ $FIX -eq 1 ]] && create_agents_core
		fi
	else
		TARGET="$CLA"
	fi
elif [[ -f "$AG" ]]; then
	TARGET="$AG"
else
	TARGET="$AG"
	CREATED_DOCS="AGENTS.md + CLAUDE.md(@AGENTS.md bridge)"
	if [[ $FIX -eq 1 ]]; then
		create_agents_core
		printf '%s\n\n## Bridge\n\nAll portable project guidance lives in `AGENTS.md` (imported above). Add only tool-specific notes here.\n' "$BRIDGE_LINE" >"$CLA" || die "failed to create $CLA"
	fi
fi
TARGET_REL="${TARGET#"$REPO"/}"

# Warn about a block orphaned in the NON-loaded doc (never silently follow it).
OTHER=""
[[ "$TARGET" == "$AG" ]] && OTHER="$CLA" || OTHER="$AG"
if [[ -n "$OTHER" && -f "$OTHER" ]] && has_block "$OTHER"; then
	say "note: a house-rules block also exists in ${OTHER#"$REPO"/}, which the driving agent does not load — leaving it (remove it by hand if stray)."
fi

# --- convergence / duplicate guards ------------------------------------------
# Counts are taken OUTSIDE fenced examples (a doc that documents the sentineled
# block in a code fence must not be mistaken for a live managed block).
MANAGED_BEGIN=0 MANAGED_END=0
if [[ -f "$TARGET" ]]; then
	MANAGED_BEGIN="$(defenced "$TARGET" | grep -Fxc "$BEGIN_MARK")"
	MANAGED_END="$(defenced "$TARGET" | grep -Fxc "$END_MARK")"
fi
[[ -n "$MANAGED_BEGIN" ]] || MANAGED_BEGIN=0
[[ -n "$MANAGED_END" ]] || MANAGED_END=0
if [[ "$MANAGED_BEGIN" -gt 1 || "$MANAGED_END" -gt 1 ]]; then
	die "${TARGET_REL} has ${MANAGED_BEGIN} begin / ${MANAGED_END} end house-rules sentinels — refusing to auto-edit an ambiguous doc. Collapse to one pair and re-run." 4
fi
# An UNPAIRED begin sentinel (begin without a matching end) would make the managed
# replace skip through EOF and delete everything after it — refuse loudly instead.
if [[ "$MANAGED_BEGIN" -ne "$MANAGED_END" ]]; then
	die "${TARGET_REL} has an unpaired house-rules sentinel (${MANAGED_BEGIN} begin, ${MANAGED_END} end) — refusing. Restore a matching begin/end pair (or remove both) and re-run." 4
fi
MANAGED_COUNT="$MANAGED_BEGIN"
# Same guard for LEGACY (un-sentineled) headings: migration only converts the
# first, so >1 would orphan the rest — refuse rather than silently half-migrate.
# Fence- AND comment-aware (a heading shown inside an HTML comment is not live).
if [[ "$MANAGED_COUNT" -eq 0 && -f "$TARGET" ]]; then
	LEGACY_COUNT="$(defenced "$TARGET" 1 | awk -v h="$HEADING" 'function ls3(s){for(k=0;k<3;k++){if(substr(s,1,1)==" ")s=substr(s,2);else break}return s} ls3($0)==h{c++} END{print c+0}')"
	[[ -n "$LEGACY_COUNT" ]] || LEGACY_COUNT=0
	if [[ "$LEGACY_COUNT" -gt 1 ]]; then
		die "${TARGET_REL} has ${LEGACY_COUNT} legacy '${HEADING}' sections — refusing to auto-edit an ambiguous doc. Collapse to one and re-run." 4
	fi
fi

# Extract the current managed region's INNER block (between sentinels), CRLF-safe.
extract_managed() {
	awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
		{ line=$0; sub(/\r$/,"",line) }
		line==b { grab=1; next }
		grab && line==e { grab=0; done=1; next }
		grab { print line }
	' "$1"
}
current_block_matches() {
	[[ -f "$TARGET" ]] && has_managed "$TARGET" || return 1
	[[ "$(extract_managed "$TARGET")" == "$BLOCK" ]]
}

if [[ -f "$TARGET" ]] && current_block_matches; then
	say "✓ agent house-rules block already current in ${TARGET_REL}"
	exit 0
fi

# What action? update a sentineled block, migrate a legacy (heading-only) block,
# or append a fresh sentineled block.
MODE="append"
if has_managed "$TARGET"; then
	MODE="managed"
elif has_legacy "$TARGET"; then
	MODE="legacy"
fi

if [[ $FIX -eq 0 ]]; then
	[[ -n "$CREATED_DOCS" ]] && say "would CREATE ${CREATED_DOCS} in ${REPO} and seed the block"
	case "$MODE" in
	managed) say "would UPDATE the sentineled 'Working the Loop' block in ${TARGET_REL}" ;;
	legacy)  say "would MIGRATE the legacy (un-sentineled) 'Working the Loop' block in ${TARGET_REL} to sentinels" ;;
	append)  say "would SEED the 'Working the Loop' block into ${TARGET_REL}" ;;
	esac
	say "(dry-run — re-run with --fix to apply)"
	exit 10
fi

TMP="$(mktemp)" || die "mktemp failed"
WRAPFILE="$(mktemp)" || die "mktemp failed"
trap 'rm -f "$TMP" "$WRAPFILE"' EXIT
printf '%s\n' "$WRAPPED" >"$WRAPFILE" || die "failed to stage block"

case "$MODE" in
managed)
	# Replace between the sentinels (inclusive).
	awk -v b="$BEGIN_MARK" -v e="$END_MARK" -v wf="$WRAPFILE" '
		BEGIN { while ((getline l < wf) > 0) w = w l "\n" }
		{ line=$0; sub(/\r$/,"",line) }
		line==b && !done { printf "%s", w; skip=1; done=1; next }
		skip && line==e { skip=0; next }
		skip { next }
		{ print }
	' "$TARGET" >"$TMP" || die "failed to rewrite ${TARGET_REL}"
	write_through "$TMP" "$TARGET"
	say "✓ updated 'Working the Loop' block in ${TARGET_REL}"
	;;
legacy)
	# Migrate: replace the legacy section with the sentineled block. Buffered (not
	# streaming) so the section end can be detected with one-line lookahead — it
	# ends at the next ATX heading OR a setext-underlined heading (a non-blank line
	# whose next line is all '=' or '-') OR EOF, all fence-aware. \r- and
	# trailing-whitespace-tolerant; kept lines are emitted verbatim.
	# CAP guards against silent over-deletion: a real house-rules block is ~30 lines,
	# so if no boundary (heading/setext/EOF) appears within CAP lines of the heading
	# the "section" is implausible — refuse (exit 3) rather than delete a huge span of
	# un-headed user prose. The canonical block is heading-bounded in every real repo.
	awk -v heading="$HEADING" -v wf="$WRAPFILE" -v cap=60 '
		function rstrip(s){ sub(/[[:space:]]+$/,"",s); return s }
		function ls3(s){ for(k=0;k<3;k++){ if(substr(s,1,1)==" ") s=substr(s,2); else break } return s }
		{ raw[NR]=$0; l=$0; sub(/\r$/,"",l); norm[NR]=l }
		END {
			n=NR; while ((getline x < wf) > 0) w = w x "\n"
			fence=0; hi=0
			for (i=1;i<=n;i++){ ls=ls3(norm[i]); if (ls ~ /^(```|~~~)/) fence=!fence; else if (!fence && rstrip(ls3(norm[i]))==heading){ hi=i; break } }
			if (hi==0){ for(i=1;i<=n;i++) print raw[i]; exit }   # defensive: heading vanished
			# recompute fence state up to the heading, then find the end boundary.
			# Boundaries (all allow CommonMark ≤3-space indent): next ATX heading, a
			# setext-underlined heading (non-blank line whose next line is all =/-), or EOF.
			fence=0; for (i=1;i<=hi;i++){ ls=ls3(norm[i]); if (ls ~ /^(```|~~~)/) fence=!fence }
			ei=n+1
			for (i=hi+1;i<=n;i++){
				ls=ls3(norm[i])
				if (ls ~ /^(```|~~~)/){ fence=!fence; continue }
				if (fence) continue
				if (ls ~ /^#+[[:space:]]/){ ei=i; break }
				if (i<n && norm[i] ~ /[^[:space:]]/ && ls3(norm[i+1]) ~ /^(=+|-+)[[:space:]]*$/){ ei=i; break }
			}
			if (ei - hi > cap) { for(i=1;i<=n;i++) print raw[i]; exit 3 }   # no clear boundary → refuse
			for (i=1;i<hi;i++) print raw[i]
			printf "%s", w
			if (ei<=n){ print ""; for (i=ei;i<=n;i++) print raw[i] }
		}
	' "$TARGET" >"$TMP"; awk_rc=$?
	if [[ $awk_rc -eq 3 ]]; then
		die "${TARGET_REL}: the legacy 'Working the Loop' section has no clear boundary within 60 lines — refusing to migrate (would risk deleting un-headed user content). Wrap the block in <!-- catalyst-house-rules:begin/end --> sentinels by hand, then re-run." 4
	fi
	[[ $awk_rc -eq 0 ]] || die "failed to migrate ${TARGET_REL}"
	write_through "$TMP" "$TARGET"
	say "✓ migrated legacy 'Working the Loop' block to sentinels in ${TARGET_REL}"
	;;
append)
	# Append with exactly one blank-line separator (collapse any pre-existing
	# trailing blanks), via a checked temp-then-write-through.
	if [[ -f "$TARGET" ]]; then
		awk '{ lines[NR]=$0 } END { last=NR; while (last>0 && lines[last] ~ /^[[:space:]]*$/) last--; for(i=1;i<=last;i++) print lines[i] }' "$TARGET" >"$TMP" || die "failed to read ${TARGET_REL}"
	else
		: >"$TMP"
	fi
	[[ -s "$TMP" ]] && printf '\n' >>"$TMP"
	printf '%s\n' "$WRAPPED" >>"$TMP" || die "failed to stage append"
	write_through "$TMP" "$TARGET"
	say "✓ seeded 'Working the Loop' block into ${TARGET_REL}${CREATED_DOCS:+ (created ${CREATED_DOCS})}"
	;;
esac
exit 0
