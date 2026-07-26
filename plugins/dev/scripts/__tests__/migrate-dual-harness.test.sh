#!/usr/bin/env bash
# Tests for migrate-dual-harness.sh — the single-harness -> dual-harness migrator.
# Run: bash plugins/dev/scripts/__tests__/migrate-dual-harness.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SCRIPT="${REPO_ROOT}/plugins/dev/scripts/migrate-dual-harness.sh"

FAILURES=0; PASSES=0
SCRATCH="$(mktemp -d)"; trap 'chmod -R u+rwx "$SCRATCH" 2>/dev/null; rm -rf "$SCRATCH"' EXIT

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [[ -n "${2:-}" ]] && echo "    $2"; }
assert_eq() { [[ "$2" == "$3" ]] && pass "$1" || fail "$1" "expected='$2' actual='$3'"; }
has() { grep -qF "$2" "$3" && pass "$1" || fail "$1" "'$2' not in $3"; }
lacks() { grep -qF "$2" "$3" && fail "$1" "'$2' unexpectedly in $3" || pass "$1"; }
count() { local c; c="$(grep -cF "$2" "$1" 2>/dev/null)"; echo "${c:-0}"; }
run() { bash "$SCRIPT" --quiet --repo "$1" "${@:2}"; }

# Deterministic tree snapshot (type + name + symlink target or file checksum),
# used to assert a dry-run (or a converged --fix) is a byte-level no-op.
tree_snapshot() {
	local dir="$1"
	(cd "$dir" && find . | sort | while IFS= read -r f; do
		if [[ -L "$f" ]]; then
			printf 'L %s -> %s\n' "$f" "$(readlink "$f")"
		elif [[ -d "$f" ]]; then
			printf 'D %s\n' "$f"
		elif [[ -f "$f" ]]; then
			printf 'F %s %s\n' "$f" "$(shasum -a 256 "$f" | awk '{print $1}')"
		fi
	done)
}

# 0. sanity
[[ -x "$SCRIPT" ]] && pass "script is executable" || fail "script is executable"

# 1. dual-ok repo (bridge + AGENTS.md + symlink + pointer) → rc 0, dry-run AND
#    --fix are no-ops (tree unchanged — find|sort + checksums).
R="$SCRATCH/dualok"; mkdir -p "$R/.claude" "$R/.agents/skills/foo"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf 'skill body\n' >"$R/.agents/skills/foo/SKILL.md"
ln -s '../.agents/skills' "$R/.claude/skills"
printf '# AGENTS.md\n\n## What\ny\n\n## Skills\n\nRepository skills live in `.agents/skills/` — Claude Code finds them via the `.claude/skills`\nsymlink; any agent can read the path directly.\n' >"$R/AGENTS.md"
BEFORE="$(tree_snapshot "$R")"
run "$R"; assert_eq "1 dual-ok: dry-run rc=0" 0 "$?"
assert_eq "1 dual-ok: dry-run tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"
run "$R" --fix; assert_eq "1 dual-ok: --fix rc=0" 0 "$?"
assert_eq "1 dual-ok: --fix tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"

# 2. codex-only → dry-run rc 10 writes nothing; --fix creates bridge (line 1
#    @AGENTS.md); rerun rc 0 (idempotent).
R="$SCRATCH/codexonly"; mkdir -p "$R"
printf '# AGENTS.md\n\n## What\nz\n' >"$R/AGENTS.md"
run "$R"; assert_eq "2 codex-only: dry-run rc=10" 10 "$?"
[[ ! -e "$R/CLAUDE.md" ]] && pass "2 codex-only: dry-run wrote nothing" || fail "2 codex-only: dry-run wrote nothing" "CLAUDE.md was created"
run "$R" --fix; assert_eq "2 codex-only: --fix rc=0" 0 "$?"
assert_eq "2 codex-only: bridge line 1 is @AGENTS.md" "@AGENTS.md" "$(head -1 "$R/CLAUDE.md")"
run "$R"; assert_eq "2 codex-only: rerun idempotent (rc=0)" 0 "$?"

# 3. claude-only monolithic, no skills → rc 11 both modes; CLAUDE.md untouched
#    by --fix.
R="$SCRATCH/mono"; mkdir -p "$R"
printf '# CLAUDE.md\n\n## Setup\nrun this\n' >"$R/CLAUDE.md"
BEFORE_CONTENT="$(cat "$R/CLAUDE.md")"
run "$R"; assert_eq "3 mono: dry-run rc=11" 11 "$?"
run "$R" --fix; assert_eq "3 mono: --fix rc=11" 11 "$?"
assert_eq "3 mono: CLAUDE.md untouched by --fix" "$BEFORE_CONTENT" "$(cat "$R/CLAUDE.md")"
[[ ! -e "$R/AGENTS.md" ]] && pass "3 mono: no AGENTS.md fabricated" || fail "3 mono: no AGENTS.md fabricated"

# 4. skills real dir under .claude/skills only (+ bridged docs) → --fix moves
#    to .agents/skills, symlink correct (readlink = ../.agents/skills), file
#    contents preserved byte-for-byte, pointer appended to AGENTS.md once;
#    rerun rc 0 and pointer NOT duplicated.
R="$SCRATCH/skillsmove"; mkdir -p "$R/.claude/skills/foo"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n\n## What\ny\n' >"$R/AGENTS.md"
printf 'skill body one\n' >"$R/.claude/skills/foo/SKILL.md"
run "$R"; assert_eq "4 skillsmove: dry-run rc=10" 10 "$?"
[[ -d "$R/.claude/skills" && ! -L "$R/.claude/skills" ]] && pass "4 skillsmove: dry-run left real dir alone" || fail "4 skillsmove: dry-run left real dir alone"
[[ ! -e "$R/.agents/skills" ]] && pass "4 skillsmove: dry-run created no .agents/skills" || fail "4 skillsmove: dry-run created no .agents/skills"
run "$R" --fix; assert_eq "4 skillsmove: --fix rc=0" 0 "$?"
[[ -L "$R/.claude/skills" ]] && pass "4 skillsmove: .claude/skills now a symlink" || fail "4 skillsmove: .claude/skills now a symlink"
assert_eq "4 skillsmove: symlink target is relative ../.agents/skills" "../.agents/skills" "$(readlink "$R/.claude/skills")"
assert_eq "4 skillsmove: file contents preserved byte-for-byte" "skill body one" "$(cat "$R/.agents/skills/foo/SKILL.md")"
has "4 skillsmove: pointer added to AGENTS.md" ".agents/skills" "$R/AGENTS.md"
assert_eq "4 skillsmove: pointer heading appears once" 1 "$(count "$R/AGENTS.md" '## Skills')"
run "$R"; assert_eq "4 skillsmove: rerun dry-run rc=0" 0 "$?"
run "$R" --fix; assert_eq "4 skillsmove: rerun --fix rc=0" 0 "$?"
assert_eq "4 skillsmove: pointer heading NOT duplicated" 1 "$(count "$R/AGENTS.md" '## Skills')"

# 5. skills only under .agents/skills → --fix creates symlink only.
R="$SCRATCH/skillssymlink"; mkdir -p "$R/.agents/skills/foo"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n\n## What\ny\n' >"$R/AGENTS.md"
printf 'preexisting body\n' >"$R/.agents/skills/foo/SKILL.md"
run "$R"; assert_eq "5 skillssymlink: dry-run rc=10" 10 "$?"
[[ ! -e "$R/.claude/skills" ]] && pass "5 skillssymlink: dry-run created nothing under .claude" || fail "5 skillssymlink: dry-run created nothing under .claude"
run "$R" --fix; assert_eq "5 skillssymlink: --fix rc=0" 0 "$?"
[[ -L "$R/.claude/skills" ]] && pass "5 skillssymlink: .claude/skills symlink created" || fail "5 skillssymlink: .claude/skills symlink created"
assert_eq "5 skillssymlink: symlink target" "../.agents/skills" "$(readlink "$R/.claude/skills")"
assert_eq "5 skillssymlink: .agents/skills content untouched" "preexisting body" "$(cat "$R/.agents/skills/foo/SKILL.md")"

# 6. both dirs identical → --fix collapses to symlink; both differ → rc 4,
#    nothing touched.
R="$SCRATCH/identical"; mkdir -p "$R/.claude/skills/foo" "$R/.agents/skills/foo"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n\n## What\ny\n' >"$R/AGENTS.md"
printf 'same content\n' >"$R/.claude/skills/foo/SKILL.md"
printf 'same content\n' >"$R/.agents/skills/foo/SKILL.md"
run "$R" --fix; assert_eq "6 identical: --fix rc=0" 0 "$?"
[[ -L "$R/.claude/skills" ]] && pass "6 identical: collapsed .claude/skills to a symlink" || fail "6 identical: collapsed .claude/skills to a symlink"
assert_eq "6 identical: symlink target" "../.agents/skills" "$(readlink "$R/.claude/skills")"

R="$SCRATCH/differ"; mkdir -p "$R/.claude/skills/foo" "$R/.agents/skills/foo"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n\n## What\ny\n' >"$R/AGENTS.md"
printf 'one\n' >"$R/.claude/skills/foo/SKILL.md"
printf 'two\n' >"$R/.agents/skills/foo/SKILL.md"
BEFORE="$(tree_snapshot "$R")"
run "$R" --fix >/dev/null 2>&1; assert_eq "6 differ: rc=4" 4 "$?"
assert_eq "6 differ: nothing touched" "$BEFORE" "$(tree_snapshot "$R")"

# 7. .claude/skills symlink to a wrong target → rc 4.
R="$SCRATCH/wrongtarget"; mkdir -p "$R/.claude" "$R/somewhere_else"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n\n## What\ny\n' >"$R/AGENTS.md"
ln -s '../somewhere_else' "$R/.claude/skills"
BEFORE="$(tree_snapshot "$R")"
run "$R" --fix >/dev/null 2>&1; assert_eq "7 wrongtarget: rc=4" 4 "$?"
assert_eq "7 wrongtarget: nothing touched" "$BEFORE" "$(tree_snapshot "$R")"

# 8. monolithic CLAUDE.md + skills in .claude/skills → --fix wires skills but
#    exits 11.
R="$SCRATCH/monoskills"; mkdir -p "$R/.claude/skills/foo"
printf '# CLAUDE.md\n\n## Setup\nrun\n' >"$R/CLAUDE.md"
printf 'skillbody\n' >"$R/.claude/skills/foo/SKILL.md"
run "$R"; assert_eq "8 monoskills: dry-run rc=11" 11 "$?"
run "$R" --fix; assert_eq "8 monoskills: --fix rc=11" 11 "$?"
[[ -L "$R/.claude/skills" ]] && pass "8 monoskills: skills wired despite rc=11" || fail "8 monoskills: skills wired despite rc=11"
assert_eq "8 monoskills: symlink target" "../.agents/skills" "$(readlink "$R/.claude/skills")"
assert_eq "8 monoskills: file preserved" "skillbody" "$(cat "$R/.agents/skills/foo/SKILL.md")"
[[ ! -e "$R/AGENTS.md" ]] && pass "8 monoskills: no AGENTS.md fabricated for the pointer" || fail "8 monoskills: no AGENTS.md fabricated for the pointer"
has "8 monoskills: CLAUDE.md content preserved" "## Setup" "$R/CLAUDE.md"

# 9. --repo on non-dir → rc 2; unknown flag → rc 2.
bash "$SCRIPT" --repo "$SCRATCH/no/such/dir" >/dev/null 2>&1; assert_eq "9 bad --repo: rc=2" 2 "$?"
bash "$SCRIPT" --repo "$SCRATCH" --bogus-flag >/dev/null 2>&1; assert_eq "9 unknown flag: rc=2" 2 "$?"

# 10. absolute-path symlink resolving correctly to .agents/skills → treated as
#     OK (rc 0), not recreated.
R="$SCRATCH/abssymlink"; mkdir -p "$R/.claude" "$R/.agents/skills/foo"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf 'body\n' >"$R/.agents/skills/foo/SKILL.md"
printf '# AGENTS.md\n\n## What\ny\n\n## Skills\n\nRepository skills live in `.agents/skills/` — Claude Code finds them via the `.claude/skills`\nsymlink; any agent can read the path directly.\n' >"$R/AGENTS.md"
ln -s "$R/.agents/skills" "$R/.claude/skills"
BEFORE="$(tree_snapshot "$R")"
run "$R"; assert_eq "10 abssymlink: dry-run rc=0" 0 "$?"
run "$R" --fix; assert_eq "10 abssymlink: --fix rc=0" 0 "$?"
assert_eq "10 abssymlink: tree unchanged (not recreated)" "$BEFORE" "$(tree_snapshot "$R")"
assert_eq "10 abssymlink: symlink target left as absolute path" "$R/.agents/skills" "$(readlink "$R/.claude/skills")"

# 11. reverse-wired: real .claude/skills + .agents/skills -> ../.claude/skills
#     (the only copy of the content sits under .claude/skills; .agents/skills
#     symlinks BACK to it) → rc 4 both modes, tree byte-identical after --fix
#     attempt (regression guard: this exact shape used to `diff -r` against
#     itself through the symlink, see "identical", then `rm -rf` the only copy).
R="$SCRATCH/reversewired"; mkdir -p "$R/.claude/skills/foo" "$R/.agents"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n\n## What\ny\n' >"$R/AGENTS.md"
printf 'reverse body\n' >"$R/.claude/skills/foo/SKILL.md"
ln -s '../.claude/skills' "$R/.agents/skills"
BEFORE="$(tree_snapshot "$R")"
run "$R" >/dev/null 2>&1; assert_eq "11 reversewired: dry-run rc=4" 4 "$?"
assert_eq "11 reversewired: dry-run tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"
run "$R" --fix >/dev/null 2>&1; assert_eq "11 reversewired: --fix rc=4" 4 "$?"
assert_eq "11 reversewired: --fix tree byte-identical (no destructive collapse)" "$BEFORE" "$(tree_snapshot "$R")"
assert_eq "11 reversewired: content still readable after --fix attempt" "reverse body" "$(cat "$R/.claude/skills/foo/SKILL.md")"

# 12. dangling .agents/skills symlink → rc 4, nothing touched — both with and
#     without a real .claude/skills dir present.
R="$SCRATCH/dangling-nocs"; mkdir -p "$R/.agents"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n\n## What\ny\n' >"$R/AGENTS.md"
ln -s 'does-not-exist' "$R/.agents/skills"
BEFORE="$(tree_snapshot "$R")"
run "$R" >/dev/null 2>&1; assert_eq "12a dangling AS (no CS): dry-run rc=4" 4 "$?"
assert_eq "12a dangling AS (no CS): dry-run tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"
run "$R" --fix >/dev/null 2>&1; assert_eq "12a dangling AS (no CS): --fix rc=4" 4 "$?"
assert_eq "12a dangling AS (no CS): --fix tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"

R="$SCRATCH/dangling-withcs"; mkdir -p "$R/.claude/skills/foo" "$R/.agents"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n\n## What\ny\n' >"$R/AGENTS.md"
printf 'body\n' >"$R/.claude/skills/foo/SKILL.md"
ln -s 'does-not-exist' "$R/.agents/skills"
BEFORE="$(tree_snapshot "$R")"
run "$R" >/dev/null 2>&1; assert_eq "12b dangling AS (with real CS): dry-run rc=4" 4 "$?"
assert_eq "12b dangling AS (with real CS): dry-run tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"
run "$R" --fix >/dev/null 2>&1; assert_eq "12b dangling AS (with real CS): --fix rc=4" 4 "$?"
assert_eq "12b dangling AS (with real CS): --fix tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"

# 13. empty .agents/skills + correct symlink + bridged docs → rc 0, NO pointer
#     appended (HAS_SKILLS must gate on non-emptiness), no changes at all.
R="$SCRATCH/emptyskills"; mkdir -p "$R/.claude" "$R/.agents/skills"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n\n## What\ny\n' >"$R/AGENTS.md"
ln -s '../.agents/skills' "$R/.claude/skills"
BEFORE="$(tree_snapshot "$R")"
run "$R"; assert_eq "13 emptyskills: dry-run rc=0" 0 "$?"
lacks "13 emptyskills: dry-run: no pointer appended" '## Skills' "$R/AGENTS.md"
assert_eq "13 emptyskills: dry-run tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"
run "$R" --fix; assert_eq "13 emptyskills: --fix rc=0" 0 "$?"
lacks "13 emptyskills: --fix: still no pointer" '## Skills' "$R/AGENTS.md"
assert_eq "13 emptyskills: --fix tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"

# 14. no-harness (neither CLAUDE.md nor AGENTS.md) + real .claude/skills →
#     dry-run rc 10 (skills classification/fix must run even though the docs
#     pair is out of scope); --fix wires skills (move + symlink) and creates
#     NO docs; rerun dry-run must exit 0 once skills are clean — the doc state
#     is STILL no-harness (no AGENTS.md exists to hold a pointer), so a bare
#     "no-harness" classification is not itself a failure once skills are OK.
R="$SCRATCH/noharness-skills"; mkdir -p "$R/.claude/skills/foo"
printf 'no-harness skill body\n' >"$R/.claude/skills/foo/SKILL.md"
run "$R" >/dev/null 2>&1; assert_eq "14 noharness+skills: dry-run rc=10" 10 "$?"
[[ ! -e "$R/CLAUDE.md" && ! -e "$R/AGENTS.md" ]] && pass "14 noharness+skills: dry-run created no docs" || fail "14 noharness+skills: dry-run created no docs"
[[ -d "$R/.claude/skills" && ! -L "$R/.claude/skills" ]] && pass "14 noharness+skills: dry-run left real dir alone" || fail "14 noharness+skills: dry-run left real dir alone"
run "$R" --fix; assert_eq "14 noharness+skills: --fix rc=0" 0 "$?"
[[ -L "$R/.claude/skills" ]] && pass "14 noharness+skills: .claude/skills now a symlink" || fail "14 noharness+skills: .claude/skills now a symlink"
assert_eq "14 noharness+skills: symlink target" "../.agents/skills" "$(readlink "$R/.claude/skills")"
assert_eq "14 noharness+skills: file preserved" "no-harness skill body" "$(cat "$R/.agents/skills/foo/SKILL.md")"
[[ ! -e "$R/CLAUDE.md" && ! -e "$R/AGENTS.md" ]] && pass "14 noharness+skills: --fix created no docs" || fail "14 noharness+skills: --fix created no docs"
run "$R"; assert_eq "14 noharness+skills: rerun dry-run rc=0 (skills clean, docs still n/a)" 0 "$?"

# 15. nested per-entry symlink inside the trees: .agents/skills is a REAL dir
#     whose entries are symlinks back into .claude/skills (the only real copy).
#     diff -r dereferences symlinks so the trees compare "identical" — a collapse
#     would rm -rf the only copy. Must be rc 4, tree byte-identical, both modes.
R="$SCRATCH/nestedlink"; mkdir -p "$R/.claude/skills/foo" "$R/.agents/skills"
printf '@AGENTS.md\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n' >"$R/AGENTS.md"
printf 'only real copy\n' >"$R/.claude/skills/foo/SKILL.md"
ln -s '../../.claude/skills/foo' "$R/.agents/skills/foo"
BEFORE="$(tree_snapshot "$R")"
run "$R" >/dev/null 2>&1; assert_eq "15 nestedlink: dry-run rc=4" 4 "$?"
assert_eq "15 nestedlink: dry-run tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"
run "$R" --fix >/dev/null 2>&1; assert_eq "15 nestedlink: --fix rc=4" 4 "$?"
assert_eq "15 nestedlink: --fix tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"
assert_eq "15 nestedlink: content still readable" "only real copy" "$(cat "$R/.claude/skills/foo/SKILL.md")"

# 16. .claude itself a symlink (non-sibling physical dir): the relative
#     ../.agents/skills link created by move/symlink-only would dangle in the
#     physical target. Must refuse rc 4, nothing touched.
R="$SCRATCH/claudelink"; mkdir -p "$R/nested/real-claude/skills/foo"
printf '@AGENTS.md\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n' >"$R/AGENTS.md"
printf 'ancestor symlink body\n' >"$R/nested/real-claude/skills/foo/SKILL.md"
ln -s 'nested/real-claude' "$R/.claude"
BEFORE="$(tree_snapshot "$R")"
run "$R" >/dev/null 2>&1; assert_eq "16 claudelink: dry-run rc=4" 4 "$?"
run "$R" --fix >/dev/null 2>&1; assert_eq "16 claudelink: --fix rc=4" 4 "$?"
assert_eq "16 claudelink: tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"

echo ""
echo "migrate-dual-harness.test.sh: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]]
