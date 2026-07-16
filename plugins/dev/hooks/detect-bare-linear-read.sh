#!/usr/bin/env bash
# PreToolUse/Bash hook: detect a bare single-ticket Linear `issues read` that
# bypasses the replica — for LITERAL ids AND shell-variable forms ($T, "$T",
# ${T}, $(...)). Flag-order independent. EXEMPT the one sanctioned linearis read the
# replica can't serve: --with-attachments. Comments are fetched via `linearis
# comments list` (structurally outside `issues read`), so no comment exemption is
# needed. Mode: CATALYST_LINEAR_READ_DETECT_MODE (observe|enforce; default observe).
#
# CTL-1420: detection is a TOKEN WALK, not a single anchored regex. The regex form
# had two blind spots that let a session exhaust the shared 2500/hr Linear quota:
#   1. the `linear` ALIAS — the linearis package installs BOTH `linear` and
#      `linearis` symlinks to the same dist/main.js;
#   2. WRAPPER PREFIXES — `direnv exec . linearis …` is a command prefix, not a
#      VAR=val assignment, so the command-word anchor failed. Every Linear call in
#      a direnv-managed repo carries that prefix, so the hook was structurally
#      blind in those repos.
# The walk resolves the real command word past env-assignments and wrappers, so
# both forms are caught. Tests: scripts/__tests__/detect-bare-linear-read.test.sh.
set -uo pipefail
input="$(cat)" # Claude Code pipes the tool call as JSON on stdin
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[[ -n "$cmd" ]] || exit 0
# Collapse shell line-continuations (`\<newline>`) to a space so a wrapped
# `linearis issues \<NL> read CTL-1` (one command to bash) isn't split into two
# non-matching segments below.
cmd="${cmd//$'\\\n'/ }"

# Command words that RUN another command: skip them (and their own operands) to
# reach the real command word. `direnv exec .` is the load-bearing case.
is_wrapper() {
	case "$1" in
	env | command | exec | direnv | nice | nohup | stdbuf | time | timeout | sudo) return 0 ;;
	*) return 1 ;;
	esac
}

# The linearis CLI, by either name the package installs (both symlink main.js).
is_linearis() {
	case "$1" in
	linearis | linear) return 0 ;;
	*) return 1 ;;
	esac
}

# Shell keywords that can PRECEDE a command word inside a compound statement. After
# splitting on `;`, a loop body arrives as `do <cmd> …` — the shape that actually
# burned the quota (`for t in 198 199 200; do direnv exec . linear issues read CTC-$t; done`).
# These are skipped WITHOUT setting saw_wrapper, so the next token is still judged
# strictly as a command word rather than loosening the walk.
is_shell_keyword() {
	case "$1" in
	do | then | else | elif | '{' | '(' | '!') return 0 ;;
	*) return 1 ;;
	esac
}

# True iff SEGMENT invokes `<linearis|linear> [flags] issues [flags] read`.
# On success sets DETECTED_TICKET to the READ TARGET (the positional after `read`),
# or "" when the id is a shell variable.
#
# Matching the command word EXACTLY (after stripping a leading path) is what keeps
# `rg 'linearis issues read'` / `echo '…'` / `mylinearis` / `linearisctl` from
# matching: a quoted or substring occurrence is never a bare token.
#
# A wrapper does NOT license skipping ahead to any later `linear` token — the command
# it runs is whatever lands in command position after its own known operands. Skipping
# arbitrarily would flag `env echo linear issues read X`, which touches no API, and
# under enforce that BLOCKS a legitimate command.
is_bare_issues_read() {
	local seg="$1"
	DETECTED_TICKET=""
	local -a toks
	read -r -a toks <<<"$seg" || return 1
	local n=${#toks[@]} i=0 base
	# Phase 1 — resolve the command word past env-assignments, flags and wrappers.
	while ((i < n)); do
		if [[ ${toks[i]} == [A-Za-z_]*=* ]]; then # VAR=val prefix
			i=$((i + 1))
			continue
		fi
		if [[ ${toks[i]} == -* ]]; then # a wrapper's own flag
			i=$((i + 1))
			continue
		fi
		if is_shell_keyword "${toks[i]}"; then
			i=$((i + 1))
			continue
		fi
		base="${toks[i]##*/}" # strip a path invocation (/opt/homebrew/bin/linear)
		is_linearis "$base" && break
		if is_wrapper "$base"; then
			i=$((i + 1))
			# Consume only the operands this wrapper's grammar puts before the command:
			# `direnv exec <DIR> CMD`, `timeout <DURATION> CMD`, `env -u <NAME> CMD`.
			# Everything else takes the command word next.
			case "$base" in
			direnv)
				[[ ${toks[i]:-} == exec ]] && i=$((i + 1))
				[[ -n ${toks[i]:-} && ${toks[i]} != -* ]] && i=$((i + 1)) # DIR
				;;
			timeout)
				[[ -n ${toks[i]:-} && ${toks[i]} != -* ]] && i=$((i + 1)) # DURATION
				;;
			env)
				while [[ ${toks[i]:-} == -u ]]; do i=$((i + 2)); done # -u NAME pairs
				;;
			esac
			continue
		fi
		return 1 # a real command word that is not linearis → not a linearis invocation
	done
	((i < n)) || return 1 # ran out of tokens — no linearis command word

	# Phase 2 — the verb path: `issues` then `read` as the first two positionals
	# (flags anywhere). Verb `read` excludes list/search/create/update/comments/usage.
	i=$((i + 1))
	local -a rest=()
	while ((i < n)); do
		[[ ${toks[i]} == -* ]] || rest+=("${toks[i]}") # drop flags; keep positionals
		i=$((i + 1))
	done
	[[ ${#rest[@]} -ge 2 && ${rest[0]} == "issues" && ${rest[1]} == "read" ]] || return 1
	# The read target is the positional after `read` — NOT any ticket-shaped token
	# elsewhere in the segment (a wrapper's `direnv exec /tmp/CTC-111` operand would
	# otherwise misname the remedy and misattribute the Loki event).
	DETECTED_TICKET="${rest[2]:-}"
	return 0
}

# Detect per COMMAND SEGMENT, not payload-wide, so a sanctioned `--with-attachments`
# read in the same tool call can't shield a sibling bare read
# (e.g. `linearis issues read A --with-attachments; linear issues read B`). Split on
# shell separators (;, &, |, newline) — sufficient for the payload shapes agents emit.
bare=""
ticket=""
while IFS= read -r seg; do
	is_bare_issues_read "$seg" || continue
	printf '%s' "$seg" | grep -Eq -- '--with-attachments' && continue # sanctioned attachment read — exempt
	bare="$seg"
	ticket="$DETECTED_TICKET"
	break
done < <(printf '%s\n' "$cmd" | tr ';&|' '\n')
[[ -n "$bare" ]] || exit 0

# Literal id of the READ TARGET if present; else variable-form → unknown (still
# counted/blocked). Scoped to the target token, never the whole segment.
id="$(printf '%s' "$ticket" | grep -Eo '[A-Za-z][A-Za-z0-9]*-[0-9]+' | head -1)"
id="${id:-unknown}"

# Resolve the helper's REAL location — used both to emit telemetry and to quote a
# runnable remedy. It must be ABSOLUTE: this hook is global, so it fires in repos
# that have no `plugins/dev/…` path of their own (a direnv-managed repo like
# catalyst-cloud is exactly where the wrapper-prefix blind spot lived), and a
# repo-relative remedy would be un-sourceable precisely where it's needed most.
LIB="$(cd "$(dirname "$0")/../scripts/lib" 2>/dev/null && pwd)/linear-read-replica.sh"

# Count it in Loki (same event as E1; source=raw-cli-hook, reason=no-gate).
# shellcheck source=../scripts/lib/linear-read-replica.sh disable=SC1090,SC1091
[[ -r "$LIB" ]] && { source "$LIB"; _lrr_emit_fallback_event "$id" no-gate raw-cli-hook; }

if [[ "${CATALYST_LINEAR_READ_DETECT_MODE:-observe}" == "enforce" ]]; then
	# The path is SHELL-QUOTED: the agent copy-pastes this, and a plugin root
	# containing spaces would otherwise emit a broken `source /a b/c.sh`.
	echo "Blocked: '$bare' hits the rate-limited Linear API. Use the replica: source '$LIB' && linear_read_ticket ${id/unknown/<ID>} (or gate + sqlite3 the replica). Attachments? add --with-attachments (exempt). See the linearis skill 'Reading Linear'." >&2
	exit 2 # exit 2 = block the tool call, feed stderr to the model
fi
# observe mode: warn + allow (does NOT hard-stop the read — see deploy plan).
echo "note: this bypassed the replica — prefer linear_read_ticket ${id/unknown/<ID>} (linearis skill 'Reading Linear')." >&2
exit 0
