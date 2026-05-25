#!/usr/bin/env bash
# linear-pr-skip — emit Linear "skip <ID>" guard lines for every foreign ticket
# token found in branch or body text, so Linear's GitHub integration does NOT
# auto-link sibling tickets and drag their workflow status.
# CTL-623 introduced the helper; CTL-633 split it into two scope-bounded modes
# to stop body-mode prose ("Released 2026-05-25", "fixes UTF-8 handling",
# "OAUTH-2 cleanup", "abc123 commit") from fabricating fake foreign tokens.
#
# Two-mode design:
#   linear_foreign_tokens_from_branch <branch> [<branch> …]
#     Keeps the original awk segmenter: walks the slug char-by-char and
#     recovers same-prefix sibling numbers under the most-recent team prefix
#     (the orchestrator-built `o-adv-1155-1156-1157-ADV-1155` shape produced
#     by setup-orchestrator.sh::build_orch_name). This is the ONLY legitimate
#     bare-number-recovery source in the repo. Output piped through the
#     team-key allowlist filter for defense in depth.
#
#   linear_foreign_tokens_from_body <body> [<body> …]
#     Canonical-only extraction via `grep -oE '\b[A-Z]+-[0-9]+\b'`. NO prefix
#     recovery, NO mixed-alpha emission. Prose, dates (2026-05-25), SHAs
#     (075e1ff5), lowercase pseudo-tokens (oauth2/utf8/abc123/api-v2), and
#     dashed-date prose cannot fabricate. Canonical body tokens (`see ENG-50`)
#     are still captured and ALSO filtered through the team-key allowlist —
#     the allowlist is fail-open on missing/empty cache so fresh installs
#     behave like today.
#
# Wrappers emit the HTML-comment guard + `skip <TOKEN>` block per mode:
#   linear_sibling_skip_block_from_branch <own> <branch>
#   linear_sibling_skip_block_from_body   <own> <body>
#
# Back-compat: linear_sibling_skip_block / linear_foreign_tokens default to
# branch mode (the original primary use case — orchestrator slug recovery).
#
# Direct exec stays branch-mode (`linear-pr-skip.sh <own> <branch>` works).
#
# Team-key allowlist: see linear-team-keys.sh (sibling lib in this dir).

# Source the team-key allowlist helper. Fail-open if the file is missing
# (defensive — both helpers ship together via CTL-633).
_pr_skip_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[[ -r "$_pr_skip_dir/linear-team-keys.sh" ]] \
	&& source "$_pr_skip_dir/linear-team-keys.sh"

# Pipe stdin through linear_team_keys_filter if it's defined; passthrough
# otherwise (handles the "team-keys helper not sourced" edge case).
_pr_skip_filter() {
	if declare -F linear_team_keys_filter >/dev/null 2>&1; then
		linear_team_keys_filter
	else
		cat
	fi
}

# Extract canonical UPPER-cased TEAM-NNN tokens from a branch slug, recovering
# bare sibling numbers under the most-recent prefix. Prints one token per line,
# de-duplicated and sorted. Network-free, deterministic.
linear_foreign_tokens_from_branch() {
	printf '%s\n' "$@" |
		awk '
			{
				# Walk the string char-by-char, accumulating runs of alphanumerics
				# into segments and remembering the single separator char that
				# preceded each segment. A pure-alpha segment sets the running team
				# prefix; a bare number inherits that prefix ONLY when joined to the
				# prior segment by a single "-" (the same-prefix orch-slug shape
				# "adv-1155-1156-1157" — never across whitespace or "#", so prose
				# like "PR #890" cannot fabricate a token). CTL-633: mixed
				# alpha+num segments ("oauth2", "utf8") used to split into
				# "OAUTH-2" / "UTF-8" — that was the documented fabrication site.
				# Now we drop both the emit and the prefix update for mixed-alpha
				# tokens; legitimate orch slugs (build_orch_name) always hyphenate
				# alpha and digit, so this loses no real signal.
				line = $0
				prefix = ""
				seg = ""
				seg_sep = ""
				next_sep = ""
				L = length(line)
				for (i = 1; i <= L + 1; i++) {
					c = (i <= L) ? substr(line, i, 1) : ""
					if (c ~ /[A-Za-z0-9]/) {
						if (seg == "") seg_sep = next_sep
						seg = seg c
						continue
					}
					if (seg != "") {
						if (seg ~ /^[A-Za-z]+$/) {
							prefix = toupper(seg)
						} else if (seg ~ /^[0-9]+$/) {
							if (prefix != "" && seg_sep == "-") print prefix "-" seg
						}
						# Mixed alpha+num (oauth2, utf8, abc123) is intentionally
						# ignored: it was the CTL-623 fabrication site that
						# CTL-633 closes.
						seg = ""
						next_sep = ""
					}
					next_sep = c
				}
			}
		' |
		grep -E '^[A-Z]+-[0-9]+$' |
		sort -u |
		_pr_skip_filter
}

# Extract canonical UPPER-cased TEAM-NNN tokens from PR body prose. No prefix
# recovery, no mixed-alpha emission. \b[A-Z]+-[0-9]+\b requires an UPPER-case
# alpha prefix glued by exactly one hyphen to a pure-digit tail at word
# boundaries — dates, lowercase prose, SHAs, abc123-style pseudo-tokens, and
# API-v2-style mixed-case collisions can never match. Output also filtered
# through the team-key allowlist (fail-open).
linear_foreign_tokens_from_body() {
	printf '%s\n' "$@" |
		grep -oE '\b[A-Z]+-[0-9]+\b' |
		sort -u |
		_pr_skip_filter
}

# Private: render the HTML-comment guard + `skip <TOKEN>` block for a list of
# tokens (one per line on stdin). Drops the own ticket (case-insensitive).
_pr_skip_emit_block() {
	local own_uc="$1"
	local tokens
	tokens=$(grep -vxF "$own_uc" || true)
	[[ -z "$tokens" ]] && return 0
	printf '<!-- Linear automation guard (CTL-623/CTL-633): unlink sibling tickets so this PR does not drag their workflow status. -->\n'
	while IFS= read -r t; do printf 'skip %s\n' "$t"; done <<<"$tokens"
}

linear_sibling_skip_block_from_branch() {
	local own="${1:?own ticket required}"
	shift
	local own_uc
	own_uc="$(printf '%s' "$own" | tr '[:lower:]' '[:upper:]')"
	linear_foreign_tokens_from_branch "$@" | _pr_skip_emit_block "$own_uc"
}

linear_sibling_skip_block_from_body() {
	local own="${1:?own ticket required}"
	shift
	local own_uc
	own_uc="$(printf '%s' "$own" | tr '[:lower:]' '[:upper:]')"
	linear_foreign_tokens_from_body "$@" | _pr_skip_emit_block "$own_uc"
}

# Back-compat alias — defaults to branch mode (the original primary use case).
# Any existing caller (e.g. third-party scripts that sourced the helper before
# CTL-633's split) keeps its current semantics for branch-shaped inputs. The
# producers (create-pr, describe-pr, ci-describe-pr) call the mode-specific
# wrappers explicitly so body-mode inputs go through canonical-only extraction.
linear_sibling_skip_block() {
	linear_sibling_skip_block_from_branch "$@"
}

# Back-compat alias for any external sourcer that called the old extractor.
linear_foreign_tokens() {
	linear_foreign_tokens_from_branch "$@"
}

# Direct-execution entrypoint — preserves branch-mode behavior.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
	linear_sibling_skip_block "$@"
fi
