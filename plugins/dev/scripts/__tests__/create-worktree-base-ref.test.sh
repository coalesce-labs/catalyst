#!/usr/bin/env bash
# Tests for CTL-573: create-worktree.sh must root new branches on
# refs/remotes/origin/<BASE> after a pre-flight fetch, so worker worktrees
# do not branch off a stale local <BASE>.
# Run: bash plugins/dev/scripts/__tests__/create-worktree-base-ref.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
CREATE_WT="${REPO_ROOT}/plugins/dev/scripts/create-worktree.sh"

FAILURES=0
PASSES=0
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
}
pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
assert_eq() {
	if [[ $1 == "$2" ]]; then pass "$3"; else fail "$3 — expected '$1', got '$2'"; fi
}
assert_contains() {
	if [[ $1 == *"$2"* ]]; then pass "$3"; else fail "$3 — '$2' not in output"; fi
}

# Build a scratch layout:
#   SCRATCH/origin.git        bare repo, ref serves as "origin"
#   SCRATCH/src               working clone with stale local main
#   SCRATCH/wt                worktree base
#   SCRATCH/bin/humanlayer    stub (no-op)
build_scratch() {
	SCRATCH="$(mktemp -d -t cwt-ctl573-XXXXXX)"
	ORIGIN="$SCRATCH/origin.git"
	SRC="$SCRATCH/src"
	WT="$SCRATCH/wt"
	BIN="$SCRATCH/bin"
	FAKEHOME="$SCRATCH/home"
	mkdir -p "$WT" "$BIN" "$FAKEHOME"
	git init -q --bare "$ORIGIN"

	# Seed origin/main with two commits.
	local SEED="$SCRATCH/seed"
	git clone -q "$ORIGIN" "$SEED"
	git -C "$SEED" config user.email t@t.t
	git -C "$SEED" config user.name t
	git -C "$SEED" checkout -q -b main 2>/dev/null || git -C "$SEED" checkout -q main
	git -C "$SEED" commit -q --allow-empty -m c1
	git -C "$SEED" push -q -u origin main
	git -C "$SEED" commit -q --allow-empty -m c2-on-origin
	git -C "$SEED" push -q

	# Clone, then rewind local main to c1 to simulate the CTL-573 stale state.
	git clone -q "$ORIGIN" "$SRC"
	git -C "$SRC" config user.email t@t.t
	git -C "$SRC" config user.name t
	git -C "$SRC" checkout -q main
	ORIGIN_TIP="$(git -C "$SRC" rev-parse origin/main)"
	C1="$(git -C "$SRC" rev-parse origin/main~1)"
	git -C "$SRC" reset -q --hard "$C1"

	mkdir -p "$SRC/.catalyst"
	printf '{"catalyst":{"projectKey":"t"}}\n' >"$SRC/.catalyst/config.json"

	# Hermetic humanlayer.json under the fake HOME so the CTL-845 vendored
	# thoughts-init (scripts/worktree-thoughts-init.sh) resolves a thoughtsRepo
	# INSIDE the scratch and succeeds. On CI (no `humanlayer` binary installed)
	# create-worktree skips thoughts-init entirely and this file is never read;
	# on a dev box that HAS humanlayer, without it the vendored init exits 1
	# (no $HOME/.config/humanlayer/humanlayer.json) and rolls the worktree back
	# before any assertion — so the whole suite is un-runnable locally. Keeps
	# the fixture fully hermetic in both environments.
	mkdir -p "$FAKEHOME/.config/humanlayer"
	printf '{"thoughts":{"user":"tester","thoughtsRepo":"%s/thoughts-repo","reposDir":"repos","globalDir":"global","defaultProfile":"testprofile"}}\n' \
		"$SCRATCH" >"$FAKEHOME/.config/humanlayer/humanlayer.json"

	cat >"$BIN/humanlayer" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
  "thoughts status") echo "Profile: testprofile" ;;
  "thoughts init") mkdir -p thoughts/shared && echo x > thoughts/shared/.keep ;;
  *) exit 0 ;;
esac
STUB
	chmod +x "$BIN/humanlayer"
}

# push_remote_ticket_branch <name> <n_commits> — CTL-1640: create <name> off
# origin/main with <n_commits> extra commits and push it to origin, using a
# throwaway clone so $SRC keeps NO local ref (mirrors a surviving host that has
# never seen the ticket branch, only origin/<ticket> from a pushed draft PR).
push_remote_ticket_branch() {
	local NAME="$1" N="$2" i
	local PUSH="$SCRATCH/pusher-$NAME"
	git clone -q "$ORIGIN" "$PUSH"
	git -C "$PUSH" config user.email t@t.t
	git -C "$PUSH" config user.name t
	git -C "$PUSH" checkout -q -b "$NAME" origin/main
	for ((i = 1; i <= N; i++)); do git -C "$PUSH" commit -q --allow-empty -m "$NAME-c$i"; done
	git -C "$PUSH" push -q -u origin "$NAME"
	REMOTE_TICKET_TIP="$(git -C "$PUSH" rev-parse "$NAME")"
}

run_create() { # $1 worktree name; $@ extra args
	local NAME="$1"
	shift
	OUTPUT="$(cd "$SRC" && PATH="$BIN:$PATH" HOME="$FAKEHOME" \
		bash "$CREATE_WT" "$NAME" main --worktree-dir "$WT" "$@" 2>&1)"
	EXIT=$?
	WT_PATH="$WT/$NAME"
}

# Case 1 — default: fetch runs, new branch is rooted on origin/main, not stale local main.
echo "Test 1: new branch is rooted on origin/main when fetch succeeds"
build_scratch
run_create wt-default
assert_eq "0" "$EXIT" "exits 0 on default path"
HEAD_SHA="$(git -C "$WT_PATH" rev-parse HEAD 2>/dev/null || echo NA)"
assert_eq "$ORIGIN_TIP" "$HEAD_SHA" "worktree HEAD matches origin/main, not stale local main"
rm -rf "$SCRATCH"

# Case 2 — fetch failure (no origin): warn + fall back to local, exit 0.
echo "Test 2: fetch failure falls back to local base ref with a warning"
build_scratch
git -C "$SRC" remote remove origin # break origin to force fetch failure
LOCAL_TIP="$(git -C "$SRC" rev-parse main)"
run_create wt-no-origin
assert_eq "0" "$EXIT" "exits 0 when origin is unreachable"
assert_contains "$OUTPUT" "fetch" "warning mentions fetch"
HEAD_SHA="$(git -C "$WT_PATH" rev-parse HEAD 2>/dev/null || echo NA)"
assert_eq "$LOCAL_TIP" "$HEAD_SHA" "worktree HEAD falls back to local base ref"
rm -rf "$SCRATCH"

# Case 3 — --reuse-existing on an already-present dir: no fetch, no change.
echo "Test 3: --reuse-existing short-circuits before fetch"
build_scratch
mkdir -p "$WT/wt-reuse/thoughts" # pre-create the path
# Pre-seed a HEALTHY thoughts/shared symlink so the CTL-1497 reuse-path repair
# is skipped (it only fires on an unhealthy link, and on a dev box with
# humanlayer installed the repair of this empty non-git dir cannot resolve a
# repo and fails). On CI (no humanlayer) the repair block is skipped anyway;
# this keeps the fixture hermetic in both environments.
mkdir -p "$SCRATCH/reuse-shared"
ln -sfn "$SCRATCH/reuse-shared" "$WT/wt-reuse/thoughts/shared"
run_create wt-reuse --reuse-existing
assert_eq "0" "$EXIT" "exits 0 on reuse"
assert_contains "$OUTPUT" "Reusing existing worktree" "reuse path taken"
rm -rf "$SCRATCH"

# Case 4 — --skip-fetch: no fetch attempted, new branch rooted on local main.
echo "Test 4: --skip-fetch suppresses the fetch and uses local base ref"
build_scratch
LOCAL_TIP="$(git -C "$SRC" rev-parse main)"
run_create wt-skip --skip-fetch
assert_eq "0" "$EXIT" "exits 0 with --skip-fetch"
# Output must NOT contain the fetch-success banner.
if [[ $OUTPUT != *"Fetched origin/"* ]]; then
	pass "no 'Fetched origin/' banner when --skip-fetch is set"
else
	fail "fetch ran despite --skip-fetch"
fi
HEAD_SHA="$(git -C "$WT_PATH" rev-parse HEAD 2>/dev/null || echo NA)"
assert_eq "$LOCAL_TIP" "$HEAD_SHA" "worktree HEAD matches local main when fetch is skipped"
rm -rf "$SCRATCH"

# Case 5 — resume from an origin-only ticket branch (CTL-1640 Scenario 1).
echo "Test 5: resume from origin-only ticket branch (no local ref)"
build_scratch
push_remote_ticket_branch wt-remote-only 3
# precondition: SRC must have NO local ref for the ticket branch
if git -C "$SRC" show-ref --verify --quiet refs/heads/wt-remote-only; then
	fail "precondition: SRC must NOT have a local wt-remote-only ref"
else
	pass "precondition: no local wt-remote-only ref in SRC"
fi
run_create wt-remote-only
assert_eq "0" "$EXIT" "exits 0 resuming from origin ticket branch"
HEAD_SHA="$(git -C "$WT_PATH" rev-parse HEAD 2>/dev/null || echo NA)"
assert_eq "$REMOTE_TICKET_TIP" "$HEAD_SHA" "worktree HEAD matches the pushed ticket tip (commits resumed)"
if [[ $HEAD_SHA != "$ORIGIN_TIP" ]]; then
	pass "worktree HEAD is NOT the base tip (not cut from base)"
else
	fail "worktree HEAD equals base tip — remote commits orphaned"
fi
assert_contains "$OUTPUT" "origin/wt-remote-only" "resume banner mentions origin/wt-remote-only"
rm -rf "$SCRATCH"

# Case 6 — no remote ticket branch → fresh-from-base unchanged (CTL-1640 Scenario 3).
echo "Test 6: no remote ticket branch falls through to fresh-from-base"
build_scratch
run_create wt-fresh-none
assert_eq "0" "$EXIT" "exits 0 with no remote ticket branch"
HEAD_SHA="$(git -C "$WT_PATH" rev-parse HEAD 2>/dev/null || echo NA)"
assert_eq "$ORIGIN_TIP" "$HEAD_SHA" "worktree HEAD matches origin/main base tip"
if [[ $OUTPUT != *"Resuming from origin/"* ]]; then
	pass "no resume banner when no remote ticket branch exists"
else
	fail "resume banner printed with no remote ticket branch"
fi
rm -rf "$SCRATCH"

# Case 7 — --no-from-remote escape hatch overrides an existing remote branch.
echo "Test 7: --no-from-remote ignores an existing remote ticket branch"
build_scratch
push_remote_ticket_branch wt-optout 2
run_create wt-optout --no-from-remote
assert_eq "0" "$EXIT" "exits 0 with --no-from-remote"
HEAD_SHA="$(git -C "$WT_PATH" rev-parse HEAD 2>/dev/null || echo NA)"
assert_eq "$ORIGIN_TIP" "$HEAD_SHA" "worktree HEAD is base tip, not the remote ticket tip"
rm -rf "$SCRATCH"

# Case 8 — reclaim's own argv (<ticket> main --reuse-existing, dir absent) seeds
# from origin/<ticket> (CTL-1640 Scenario 2 — cross-host reclaim round-trip).
echo "Test 8: reclaim argv (--reuse-existing, dir absent) resumes pushed commits"
build_scratch
push_remote_ticket_branch wt-reclaim 2
run_create wt-reclaim --reuse-existing # dir does NOT exist → falls through to branch block
assert_eq "0" "$EXIT" "reclaim argv exits 0"
HEAD_SHA="$(git -C "$WT_PATH" rev-parse HEAD 2>/dev/null || echo NA)"
assert_eq "$REMOTE_TICKET_TIP" "$HEAD_SHA" "reclaim rebuild contains the dead host's pushed commits"
rm -rf "$SCRATCH"

echo ""
echo "Passed: $PASSES  Failed: $FAILURES"
[[ $FAILURES -eq 0 ]] || exit 1
