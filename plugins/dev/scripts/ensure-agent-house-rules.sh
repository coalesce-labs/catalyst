#!/usr/bin/env bash
# ensure-agent-house-rules.sh — seed / update the canonical "Working the Loop"
# agent house-rules block in a Catalyst-managed repo's agent-instructions doc.
#
# WHY: the block teaches EVERY agent (interactive too, not just slash-command
# skills) three default reflexes — subscribe to the event log instead of polling,
# recognize an automated review's 👍 clean-pass reaction, and read single Linear
# tickets from the freshness-gated local replica. `check-project-setup.sh` §9
# only *warns* when it is missing; this script is the *fix* — it makes every
# newly-enrolled (or drifted) repo carry the current canonical block. Idempotent:
# re-running syncs the block to the template, so it doubles as a "keep in sync"
# updater, not just a first-time seeder.
#
# Target-doc rule (the file the DRIVING agent actually loads):
#   - CLAUDE.md is a thin `@AGENTS.md` bridge (line 1) AND AGENTS.md exists → AGENTS.md
#   - else CLAUDE.md exists (monolithic)                                    → CLAUDE.md
#   - else AGENTS.md exists                                                 → AGENTS.md
#   - else (neither doc)  → create AGENTS.md (portable core) + a thin
#                           `@AGENTS.md` CLAUDE.md bridge; seed into AGENTS.md
#
# Usage:
#   ensure-agent-house-rules.sh [--fix] [--repo DIR] [--template FILE] [--quiet]
#     (no --fix) → dry-run: report what WOULD change, exit 0 if already current,
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
	-h | --help)
		sed -n '2,30p' "$0"
		exit 0
		;;
	*)
		echo "ensure-agent-house-rules: unknown arg '$1'" >&2
		exit 2
		;;
	esac
	shift
done

say() { [[ $QUIET -eq 1 ]] || printf '%s\n' "$*"; }

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve the canonical template (repo copy → plugin-cache CLAUDE_PLUGIN_ROOT).
if [[ -z "$TEMPLATE" ]]; then
	for cand in \
		"${SCRIPT_DIR}/../templates/agents-house-rules.md" \
		"${CLAUDE_PLUGIN_ROOT:-}/templates/agents-house-rules.md"; do
		[[ -n "$cand" && -f "$cand" ]] && { TEMPLATE="$cand"; break; }
	done
fi
if [[ ! -f "$TEMPLATE" ]]; then
	if [[ -n "$TEMPLATE" ]]; then
		echo "ensure-agent-house-rules: template not found at '$TEMPLATE'" >&2
	else
		echo "ensure-agent-house-rules: canonical template not found (looked at ${SCRIPT_DIR}/../templates/agents-house-rules.md and \${CLAUDE_PLUGIN_ROOT}/templates/agents-house-rules.md)" >&2
	fi
	exit 3
fi
[[ -d "$REPO" ]] || { echo "ensure-agent-house-rules: --repo '$REPO' is not a directory" >&2; exit 2; }

# BLOCK = template with the leading HTML seeding-comment stripped (that comment is
# instructions for the seeder, not content for the repo). Strip CRLF up front so a
# CRLF-encoded template yields an LF-clean HEADING — otherwise the heading match
# (which normalizes the TARGET but not the template) would never fire and the block
# would be appended without bound.
BLOCK="$(tr -d '\r' <"$TEMPLATE" | awk 'f==0 && /^<!--/{f=1} f==1{ if (/-->/) f=2; next } f==2 && /^[[:space:]]*$/ && seen==0 {seen=1; next} {print}')"
# Guard: the three reflex markers must survive extraction (template integrity).
for marker in 'subscribe to the event log' '👍' 'local replica'; do
	printf '%s' "$BLOCK" | grep -qiF "$marker" || { echo "ensure-agent-house-rules: template missing marker '$marker' after comment strip — refusing" >&2; exit 3; }
done
# Guard: the block body must contain no nested ATX heading. The section boundary
# treats the NEXT heading of any level as the section end, so a nested heading below
# the title would break extraction/replacement (non-convergence + duplication).
if printf '%s\n' "$BLOCK" | tail -n +2 | grep -qE '^#+[[:space:]]'; then
	echo "ensure-agent-house-rules: template block body has a nested heading — the seeder's section boundary can't represent it. Keep the block flat below its title." >&2
	exit 3
fi

BRIDGE_LINE="@AGENTS.md"
CLA="$REPO/CLAUDE.md"
AG="$REPO/AGENTS.md"

# HEADING = the exact canonical heading (first line of the block). Match the FULL
# line, never a prefix — so a hand-written "## Working the Loop Diagram" section is
# not mistaken for the block (which would clobber it) and a "## Working the Loop
# Notes" sibling does not trip the duplicate guard.
HEADING="$(printf '%s\n' "$BLOCK" | head -n1)"

die() { echo "ensure-agent-house-rules: $1" >&2; exit "${2:-5}"; }

is_bridge() { [[ -f "$CLA" ]] && [[ "$(head -n1 "$CLA" | tr -d '\r' | sed 's/[[:space:]]*$//')" == "$BRIDGE_LINE" ]]; }
# CRLF-safe exact-line detection: strip \r before matching so a CRLF checkout is
# still recognized as carrying the block (else we'd append a duplicate).
has_block() { [[ -f "$1" ]] && tr -d '\r' <"$1" | grep -Fxq "$HEADING"; }

create_agents_core() {
	printf '# AGENTS.md\n\nPortable, tool-agnostic guidance for AI coding agents working in this repository.\n' >"$AG" || die "failed to create $AG"
}

CREATED_DOCS=""
if has_block "$AG"; then
	# Block already lives in AGENTS.md → update it there, whatever the bridge style.
	# (Some repos import AGENTS.md from a header line other than line 1, so the line-1
	# is_bridge probe alone would mis-target them — always follow the existing block.)
	TARGET="$AG"
elif has_block "$CLA"; then
	# Block already lives in the (monolithic) CLAUDE.md → update it there.
	TARGET="$CLA"
elif is_bridge; then
	# CLAUDE.md imports AGENTS.md → the block belongs in AGENTS.md. If AGENTS.md does
	# not exist yet, create the portable core so the `@AGENTS.md` import resolves —
	# do NOT seed the block into the thin bridge file.
	TARGET="$AG"
	if [[ ! -f "$AG" ]]; then
		CREATED_DOCS="AGENTS.md (portable core; CLAUDE.md already imports it)"
		[[ $FIX -eq 1 ]] && create_agents_core
	fi
elif [[ -f "$CLA" ]]; then
	TARGET="$CLA"
elif [[ -f "$AG" ]]; then
	TARGET="$AG"
else
	# Neither doc exists → establish the context-framework (AGENTS.md core + bridge).
	TARGET="$AG"
	CREATED_DOCS="AGENTS.md + CLAUDE.md(@AGENTS.md bridge)"
	if [[ $FIX -eq 1 ]]; then
		create_agents_core
		printf '%s\n\n## Bridge\n\nAll portable project guidance lives in `AGENTS.md` (imported above). Add only tool-specific notes here.\n' "$BRIDGE_LINE" >"$CLA" || die "failed to create $CLA"
	fi
fi

TARGET_REL="${TARGET#"$REPO"/}"

# Count exact-heading occurrences (CRLF-stripped). The seeder never creates
# duplicates, so >1 means the doc was hand-edited into an ambiguous state — refuse
# loudly rather than silently half-update only the first (which would never converge).
HEADING_COUNT=0
[[ -f "$TARGET" ]] && HEADING_COUNT="$(tr -d '\r' <"$TARGET" | grep -Fxc "$HEADING")"
[[ -n "$HEADING_COUNT" ]] || HEADING_COUNT=0
if [[ "$HEADING_COUNT" -gt 1 ]]; then
	die "${TARGET_REL} has ${HEADING_COUNT} '${HEADING}' sections — refusing to auto-edit an ambiguous doc. Collapse them to one and re-run." 4
fi

# Extract the existing block: from the exact heading line to the line before the
# NEXT ATX heading of ANY level (or EOF). Ending only at '^## ' would let a
# following H1/H3 heading fall inside the section and get deleted on replace
# (silent data loss). \r is stripped so a CRLF-only diff isn't misreported as
# stale; `$( )` strips trailing newlines for a clean compare against BLOCK.
extract_existing() {
	awk -v heading="$HEADING" '
		{ line = $0; sub(/\r$/, "", line) }
		line == heading && !seen { seen = 1; grab = 1; print line; next }
		grab && line ~ /^#+[[:space:]]/ { grab = 0 }
		grab { print line }
	' "$1"
}

current_block_matches() {
	[[ -f "$TARGET" ]] || return 1
	local existing
	existing="$(extract_existing "$TARGET")"
	[[ -n "$existing" ]] || return 1
	[[ "$existing" == "$BLOCK" ]]
}

if [[ -f "$TARGET" ]] && current_block_matches; then
	say "✓ agent house-rules block already current in ${TARGET_REL}"
	exit 0
fi

# Determine action: replace an existing (stale) section, or append a new one.
HAS_SECTION=0
[[ "$HEADING_COUNT" -eq 1 ]] && HAS_SECTION=1

if [[ $FIX -eq 0 ]]; then
	[[ -n "$CREATED_DOCS" ]] && say "would CREATE ${CREATED_DOCS} in ${REPO} and seed the block"
	if [[ $HAS_SECTION -eq 1 ]]; then
		say "would UPDATE the stale 'Working the Loop' block in ${TARGET_REL}"
	else
		say "would SEED the 'Working the Loop' block into ${TARGET_REL}"
	fi
	say "(dry-run — re-run with --fix to apply)"
	exit 10
fi

TMP="$(mktemp)" || die "mktemp failed"
BLOCKFILE="$(mktemp)" || die "mktemp failed"
trap 'rm -f "$TMP" "$BLOCKFILE"' EXIT
printf '%s\n' "$BLOCK" >"$BLOCKFILE" || die "failed to stage block"

if [[ $HAS_SECTION -eq 1 ]]; then
	# Replace the existing section: exact heading → next ATX heading (any level) or
	# EOF; one blank line before the following heading. The block is read from a file
	# via getline — `awk -v` cannot carry the multi-line value. Matching is
	# \r-tolerant; kept lines are printed verbatim (endings preserved).
	awk -v blockfile="$BLOCKFILE" -v heading="$HEADING" '
		BEGIN { while ((getline l < blockfile) > 0) block = block l "\n" }
		{ line = $0; sub(/\r$/, "", line) }
		line == heading && done == 0 { printf "%s", block; skip = 1; done = 1; next }
		skip == 1 && line ~ /^#+[[:space:]]/ { skip = 0; print ""; print; next }
		skip == 1 { next }
		{ print }
	' "$TARGET" >"$TMP" || die "failed to rewrite ${TARGET_REL}"
	mv "$TMP" "$TARGET" || die "failed to write ${TARGET_REL} (read-only?)"
	say "✓ updated 'Working the Loop' block in ${TARGET_REL}"
else
	# Append via a checked temp-then-mv (never a bare >> redirect that could silently
	# fail on a read-only target). Guarantee a blank-line separator regardless of
	# whether the file already ends in a newline.
	if [[ -f "$TARGET" ]]; then cp "$TARGET" "$TMP" || die "failed to read ${TARGET_REL}"; else : >"$TMP" || die "mktemp write failed"; fi
	if [[ -s "$TMP" ]]; then
		[[ "$(tail -c1 "$TMP")" == "" ]] || printf '\n' >>"$TMP"
		printf '\n' >>"$TMP"
	fi
	printf '%s\n' "$BLOCK" >>"$TMP" || die "failed to stage append"
	mv "$TMP" "$TARGET" || die "failed to write ${TARGET_REL} (read-only?)"
	say "✓ seeded 'Working the Loop' block into ${TARGET_REL}${CREATED_DOCS:+ (created ${CREATED_DOCS})}"
fi
exit 0
