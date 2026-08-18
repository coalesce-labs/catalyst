#!/bin/bash
# lint-cli-shell-guard.sh — CTL-1937. Every cli/*.mjs must carry the shell guard as line 1.
#
# THE CLASS THIS EXISTS FOR (measured 2026-08-17 22:42-23:08 CT)
# --------------------------------------------------------------
# cli/*.mjs have no shebang, and the house doc-comment style puts a runnable
# "catalyst-execution-core <verb> ..." example in BACKTICKS on line 1. When a shell is
# mis-resolved as the JS runtime, `bash cli/drain.mjs` command-substitutes that backtick
# and re-invokes the CLI, which re-invokes the shell, which... On 2026-08-17 that reached
# 7,592 nested bash processes (87% of kern.maxprocperuid) and fork() failed for every agent
# on the machine for ~25 minutes.
#
# CTL-1937's caller-side guard (exec_runtime_module in catalyst-execution-core) bounds the
# depth for modules reached THROUGH that seam. This lint covers the class: a cli/*.mjs run
# by a shell by ANY route refuses on its own, before line 2 is ever parsed.
#
# Reproduced first-hand before this guard was written: `bash cli/drain.mjs` with a stub
# `catalyst-execution-core` on PATH executed "catalyst-execution-core drain [--off] [--json]"
# straight out of the line-1 doc comment. A copy of the same file with no backtick on line 1
# executed nothing — so it is the backtick, not merely running the file.
#
# Usage: bash plugins/dev/scripts/lint-cli-shell-guard.sh [--fix]

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# ── THE CANONICAL GUARD ─────────────────────────────────────────────────────────────────
# One line, and it must be line 1. To a JS runtime it is a "//" line comment. To sh/bash/zsh
# it is a command list that prints the refusal and exits 97 BEFORE the shell parses line 2 —
# which is where the backtick lives. Verified in bash, zsh and sh (refusal + rc 97, zero
# children) and under node and bun (module runs normally).
#
# "//bin/true" is not a real path on macOS ("//" is implementation-defined and does not
# resolve), so it always fails — that is fine, it is only there because the line has to START
# with "//" to be a JS comment. "2>/dev/null" suppresses the shell's diagnostic so the ONLY
# thing an operator sees is the named refusal.
GUARD_LINE='//bin/true 2>/dev/null; exec 1>&2; echo "REFUSING: a SHELL is executing this JavaScript module — see CTL-1937."; exit 97'

FIX=0
[[ "${1:-}" == "--fix" ]] && FIX=1

# ⛔ Codex #3516 P2: this used a repo-wide `find`, which descends into the full scratch checkouts
# the agent harness parks under .claude/worktrees/ (create-worktree.sh:346-354). In a primary
# checkout that means the lint FAILS because some other agent's branch lacks the guard, and
# `--fix` EDITS FILES BELONGING TO ANOTHER AGENT. `git ls-files` is scoped to the current
# worktree by construction and does not descend into nested checkouts; --others picks up a
# brand-new module before it is committed, --exclude-standard keeps ignored files out.
#
# NOT `mapfile`: macOS ships /bin/bash 3.2, which does not have it. A lint that dies on the
# operator's own shell is a lint nobody runs.
FILES=()
while IFS= read -r f; do
	[ -n "$f" ] && FILES+=("$REPO_ROOT/$f")
done < <(git -C "$REPO_ROOT" ls-files --cached --others --exclude-standard -- '*/cli/*.mjs' 'cli/*.mjs' 2>/dev/null | sort -u)

# ⛔ A lint whose glob matches nothing reports a clean pass. Refuse instead: if the tree ever
# moves, this must go red rather than quietly stop guarding anything.
if [[ "${#FILES[@]}" -eq 0 ]]; then
	echo "lint-cli-shell-guard: FAIL — matched ZERO cli/*.mjs files under $REPO_ROOT." >&2
	echo "  Either the tree moved, the glob is wrong, or this is not a git worktree." >&2
	echo "  A lint that checks nothing is not a pass." >&2
	exit 2
fi

MISSING=()
for f in ${FILES[@]+"${FILES[@]}"}; do
	if [[ "$(head -n 1 "$f")" != "$GUARD_LINE" ]]; then
		MISSING+=("$f")
	fi
done

if [[ "${#MISSING[@]}" -eq 0 ]]; then
	echo "lint-cli-shell-guard: OK — all ${#FILES[@]} cli/*.mjs carry the CTL-1937 shell guard on line 1."
	exit 0
fi

if [[ "$FIX" -eq 1 ]]; then
	for f in ${MISSING[@]+"${MISSING[@]}"}; do
		tmp="$f.guard.tmp"
		{ printf '%s\n' "$GUARD_LINE"; cat "$f"; } >"$tmp" && mv "$tmp" "$f"
		echo "  fixed: ${f#"$REPO_ROOT"/}"
	done
	echo "lint-cli-shell-guard: added the guard to ${#MISSING[@]} file(s); re-run without --fix to verify."
	exit 0
fi

echo "lint-cli-shell-guard: FAIL — ${#MISSING[@]} of ${#FILES[@]} cli/*.mjs are MISSING the CTL-1937 shell guard:" >&2
for f in ${MISSING[@]+"${MISSING[@]}"}; do echo "  ${f#"$REPO_ROOT"/}" >&2; done
cat >&2 <<EOF

Every cli/*.mjs must begin with EXACTLY this line:

$GUARD_LINE

Why: these modules have no shebang and their line-1 doc comment contains a backticked,
runnable command. Run by a shell instead of a JS runtime, that backtick executes and
re-invokes the CLI — CTL-1937's 7,592-process fork chain.

Fix: bash plugins/dev/scripts/lint-cli-shell-guard.sh --fix
EOF
exit 1
