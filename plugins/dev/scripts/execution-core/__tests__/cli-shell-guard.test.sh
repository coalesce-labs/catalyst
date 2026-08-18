#!/usr/bin/env bash
# cli-shell-guard.test.sh — CTL-1937, the CLASS regression.
#
# CTL-1937's caller-side guard (exec_runtime_module) bounds re-entry for modules reached
# through that one seam. This covers the class: a cli/*.mjs run by a shell by ANY route must
# refuse on its own, name the reason, and spawn NOTHING.
#
# THE MECHANISM, reproduced before the guard was written:
#   cli/*.mjs have no shebang, and their line-1 doc comment carries a runnable
#   "catalyst-execution-core <verb> ..." example in BACKTICKS. `bash cli/drain.mjs` with a
#   stub catalyst-execution-core on PATH executed "drain [--off] [--json]" straight out of
#   that comment. In production the stub is the real CLI, which re-invokes the shell: on
#   2026-08-17 that reached 7,592 nested bash processes and fork() failed machine-wide.
#
# ⚠️ SAFE BY CONSTRUCTION: the stub on PATH here RECORDS and EXITS. It cannot recurse, so
# even a totally broken guard produces exactly one extra process, never a chain. This test
# does not need a watchdog because there is nothing for a watchdog to contain.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$SCRIPT_DIR/../cli"
SUBJECT="$CLI_DIR/drain.mjs" # the module the real incident ran

PASSES=0
FAILURES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH:?}"' EXIT

pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	shift
	for l in "$@"; do echo "      $l"; done
}

# A stub named exactly like the backticked command. It appends to $MARKER and exits — so
# "$MARKER is non-empty" means the doc-comment backtick EXECUTED.
mkdir -p "$SCRATCH/bin"
MARKER="$SCRATCH/marker"
cat >"$SCRATCH/bin/catalyst-execution-core" <<EOF
#!/bin/bash
echo "FIRED: \$*" >>"$MARKER"
exit 0
EOF
chmod +x "$SCRATCH/bin/catalyst-execution-core"

# Run $1 (a .mjs) under shell $2, setting RUN_OUT and RUN_RC.
# NOT a function that echoes its output: calling it as "$(run_under_shell ...)" puts the body
# in a SUBSHELL, so the rc it recorded never reaches the caller (the first cut of this test
# died on exactly that with "RUN_RC: unbound variable").
RUN_OUT=""
RUN_RC=0
run_under_shell() {
	local file="$1" shell="$2"
	: >"$MARKER"
	RUN_OUT="$(cd "$SCRATCH" && PATH="$SCRATCH/bin:/usr/bin:/bin" "$shell" "$file" 2>&1)"
	RUN_RC=$?
}

echo ""
echo "=== a cli/*.mjs run by a SHELL refuses, by name, in every shell ==="
for shell in /bin/bash /bin/zsh /bin/sh; do
	[[ -x "$shell" ]] || {
		echo "  SKIP: $shell not present"
		continue
	}
	run_under_shell "$SUBJECT" "$shell"
	OUT="$RUN_OUT"
	RC=$RUN_RC
	if grep -qF "REFUSING" <<<"$OUT"; then pass "$shell — refuses"; else fail "$shell — refuses" "got: $(head -c 300 <<<"$OUT")"; fi
	if grep -qF "CTL-1937" <<<"$OUT"; then pass "$shell — the refusal names the ticket"; else fail "$shell — the refusal names the ticket" "got: $(head -c 300 <<<"$OUT")"; fi
	if [[ "$RC" -eq 97 ]]; then pass "$shell — exits 97"; else fail "$shell — exits 97" "rc=$RC"; fi
	# THE POINT OF THE WHOLE TICKET: nothing was spawned.
	if [[ -s "$MARKER" ]]; then
		fail "$shell — ZERO children" "the doc-comment backtick EXECUTED: $(cat "$MARKER")"
	else
		pass "$shell — ZERO children (the backtick never ran)"
	fi
done

echo ""
echo "--- ⛔ NEGATIVE CONTROL: the same file WITHOUT the guard must fire the bomb ---"
# Without this, every assertion above would also pass on a drain.mjs that simply has no
# backtick to execute — i.e. against a guard that does nothing.
UNGUARDED="$SCRATCH/unguarded.mjs"
tail -n +2 "$SUBJECT" >"$UNGUARDED" # strip line 1, the guard
run_under_shell "$UNGUARDED" /bin/bash
if [[ -s "$MARKER" ]]; then
	pass "control fired — unguarded, the backtick executed ($(head -1 "$MARKER"))"
else
	fail "control did NOT fire" \
		"Stripping the guard left the bomb inert, so the checks above prove nothing about the guard." \
		"Either line 1 of $SUBJECT is not the guard, or its line-1 doc comment no longer has a backtick."
fi

echo ""
echo "--- ⛔ CONTROL: the guard must not break the real runtime ---"
if command -v bun >/dev/null 2>&1; then
	if bun build "$SUBJECT" --target=node --outfile /dev/null >/dev/null 2>&1; then
		pass "bun still parses the guarded module"
	else
		fail "bun still parses the guarded module" "the guard broke the JS"
	fi
else
	echo "  SKIP: bun not present"
fi

echo ""
echo "=== EVERY cli/*.mjs carries the guard (the class, not one file) ==="
if bash "$SCRIPT_DIR/../../lint-cli-shell-guard.sh" >/dev/null 2>&1; then
	pass "lint-cli-shell-guard reports every cli/*.mjs guarded"
else
	fail "lint-cli-shell-guard reports every cli/*.mjs guarded" \
		"run: bash plugins/dev/scripts/lint-cli-shell-guard.sh"
fi

echo ""
echo "=== ⛔ the lint does NOT descend into a nested checkout (Codex #3516 P2) ==="
# The agent harness parks full scratch checkouts under .claude/worktrees/. A repo-wide `find`
# walked into them, so the lint failed on another agent's branch and `--fix` would have edited
# that agent's files. git ls-files cannot leave the current worktree.
REPO_TOP="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"
if [[ -n "$REPO_TOP" ]]; then
	NESTED="$REPO_TOP/.claude/worktrees/fleet-scope-probe/cli"
	mkdir -p "$NESTED"
	# A nested REPOSITORY, exactly like a parked worktree — and an UNGUARDED module inside it.
	git -C "$REPO_TOP/.claude/worktrees/fleet-scope-probe" init -q 2>/dev/null
	printf '// cli/intruder.mjs — no guard on line 1\n' >"$NESTED/intruder.mjs"

	# ⛔ Positive control FIRST: a plain `find` DOES see it, so the case is real and the check
	# below is not passing because the fixture failed to create anything.
	if find "$REPO_TOP" -type f -path '*/cli/*.mjs' 2>/dev/null | grep -q 'fleet-scope-probe'; then
		pass "control — a repo-wide find DOES reach the nested checkout (the bug was real)"
	else
		fail "control — a repo-wide find reaches the nested checkout" \
			"the fixture did not create a discoverable nested module; the scope check below proves nothing"
	fi

	if bash "$SCRIPT_DIR/../../lint-cli-shell-guard.sh" >/dev/null 2>&1; then
		pass "the lint stays green — it did not descend into the nested checkout"
	else
		fail "the lint stays green with a nested checkout present" \
			"it is still scanning outside the current worktree; --fix would edit another agent's files"
	fi
	rm -rf "$REPO_TOP/.claude/worktrees/fleet-scope-probe"
	rmdir "$REPO_TOP/.claude/worktrees" 2>/dev/null || true
else
	echo "  SKIP: not inside a git worktree"
fi

echo ""
echo "  PASSED: $PASSES   FAILED: $FAILURES"
[[ $FAILURES -eq 0 ]]
