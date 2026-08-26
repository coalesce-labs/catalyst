#!/usr/bin/env bash
# drift-gate.test.sh — CTL-1461 Phase 3: the regenerate-and-diff drift gate.
#
# Run: bash scripts/packaging/__tests__/drift-gate.test.sh
#
# Exercises the drift gate's actual CI mechanism — `render --write
# --allow-losses` then `git diff --exit-code` AND a separate `git status
# --porcelain` emptiness check — against a TEMPORARY COPY of the relevant
# trees, never the live worktree: this test commits, hand-edits, and plants
# stray files, none of which may leak into the real repo.
#
# The mutation control at the bottom is the reason the gate needs BOTH
# checks, not one: `git diff --exit-code` only compares tracked file
# contents, so it is blind to a brand-new UNTRACKED generated file. A
# diff-only gate would pass silently on a render that emits a new file that
# nobody committed — exactly the "success and failure byte-identical to the
# caller" shape this repo has shipped before.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

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

# --- build a scratch copy of exactly what the pipeline reads, then let the ---
# --- pipeline itself GENERATE the output trees (never copy already-generated
# --- files from the real repo — that would let a stale real-repo file mask a
# --- real bug in this test).
ROOT="$SCRATCH/repo"
mkdir -p "$ROOT"
cp -R "$REPO_ROOT/plugins" "$ROOT/plugins"
mkdir -p "$ROOT/scripts"
cp -R "$REPO_ROOT/scripts/packaging" "$ROOT/scripts/packaging"
rm -rf "$ROOT/scripts/packaging/dist" "$ROOT/scripts/packaging/__tests__"
cp "$REPO_ROOT/release-please-config.json" "$ROOT/release-please-config.json"

RENDER_LOG="$SCRATCH/render.log"
regenerate() {
	(cd "$ROOT" && bun scripts/packaging/cli.mjs render --write --allow-losses) >"$RENDER_LOG" 2>&1
}

if ! regenerate; then
	fail "bootstrap regenerate must succeed on the scratch copy" "$(cat "$RENDER_LOG")"
	echo ""
	echo "=== $PASSES passed, $FAILURES failed ==="
	exit 1
fi

# scripts/packaging/dist/ carries a renderedAt timestamp that legitimately
# changes on every render — gitignored in the real repo (.gitignore:105) for
# exactly that reason, so it must be gitignored here too or every regenerate
# would trip a false "drift".
echo "scripts/packaging/dist/" >"$ROOT/.gitignore"

git -C "$ROOT" init -q
git -C "$ROOT" config user.name fixture
git -C "$ROOT" config user.email fixture@example.com
git -C "$ROOT" add -A
git -C "$ROOT" commit -qm baseline

echo "=== Baseline: regenerating a second time against the same source is a no-op ==="
if regenerate && git -C "$ROOT" diff --exit-code >/dev/null 2>&1 && [[ -z "$(git -C "$ROOT" status --porcelain)" ]]; then
	pass "re-running render --write on an unchanged source produces zero drift"
else
	fail "re-running render --write on an unchanged source should be a no-op" "$(git -C "$ROOT" status --porcelain)"
fi

echo ""
echo "=== A hand-edited generated file, committed as though it shipped in a PR, is caught by git diff --exit-code ==="
MARKETPLACE="$ROOT/.claude-plugin/marketplace.json"
sed -i.bak 's/"catalyst"/"catalyst-EDITED"/' "$MARKETPLACE"
rm -f "$MARKETPLACE.bak"
git -C "$ROOT" commit -qam "simulate a hand-edited generated file shipped in a PR"
regenerate
DIFF_STAT="$(git -C "$ROOT" diff --stat)"
if ! git -C "$ROOT" diff --exit-code >/dev/null 2>&1 && echo "$DIFF_STAT" | grep -q 'marketplace.json'; then
	pass "regenerate-then-diff catches the stale hand-edit and names the file"
else
	fail "regenerate-then-diff should catch the stale hand-edit and name the file" "$DIFF_STAT"
fi
git -C "$ROOT" reset -q --hard HEAD~1
git -C "$ROOT" clean -qfd

echo ""
echo "=== Fixed: after reverting to the baseline commit, the tree is drift-free again ==="
regenerate
if git -C "$ROOT" diff --exit-code >/dev/null 2>&1 && [[ -z "$(git -C "$ROOT" status --porcelain)" ]]; then
	pass "reverting the hand-edit restores a clean gate"
else
	fail "reverting the hand-edit should restore a clean gate" "$(git -C "$ROOT" status --porcelain)"
fi

echo ""
echo "=== Mutation control: a brand-new UNTRACKED generated file is missed by git diff but caught by git status ==="
STRAY_DIR="$ROOT/.agents/skills/catalyst-stray-test"
mkdir -p "$STRAY_DIR"
printf -- '---\nname: stray\ndescription: planted by the drift-gate test\n---\nstray body\n' >"$STRAY_DIR/SKILL.md"

if git -C "$ROOT" diff --exit-code >/dev/null 2>&1; then
	pass "git diff --exit-code alone is blind to the new untracked file — the defect the status check exists to catch"
else
	fail "git diff --exit-code should NOT, by itself, see a brand-new untracked file"
fi

STATUS_OUT="$(git -C "$ROOT" status --porcelain)"
if [[ -n "$STATUS_OUT" ]] && echo "$STATUS_OUT" | grep -q 'catalyst-stray-test'; then
	pass "git status --porcelain DOES catch the new untracked file, naming it — proving the two checks are not redundant"
else
	fail "git status --porcelain should catch the new untracked file" "$STATUS_OUT"
fi
rm -rf "$STRAY_DIR"
git -C "$ROOT" clean -qfd

echo ""
echo "=== $PASSES passed, $FAILURES failed ==="
[[ $FAILURES -eq 0 ]]
