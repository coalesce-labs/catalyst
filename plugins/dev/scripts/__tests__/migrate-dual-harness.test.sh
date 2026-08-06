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

# 10. absolute-path symlink resolving correctly to .agents/skills → no longer
#     "ok" — it's a mechanical fix: dry-run rc 10 (would REWRITE) with the
#     tree left untouched; --fix rewrites it to the canonical relative
#     ../.agents/skills (rm the symlink only, never rm -rf — it's a symlink —
#     then re-link); content stays reachable; rerun is rc 0 (idempotent).
R="$SCRATCH/abssymlink"; mkdir -p "$R/.claude" "$R/.agents/skills/foo"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf 'body\n' >"$R/.agents/skills/foo/SKILL.md"
printf '# AGENTS.md\n\n## What\ny\n\n## Skills\n\nRepository skills live in `.agents/skills/` — Claude Code finds them via the `.claude/skills`\nsymlink; any agent can read the path directly.\n' >"$R/AGENTS.md"
ln -s "$R/.agents/skills" "$R/.claude/skills"
BEFORE="$(tree_snapshot "$R")"
run "$R"; assert_eq "10 abssymlink: dry-run rc=10 (would REWRITE, not ok)" 10 "$?"
assert_eq "10 abssymlink: dry-run tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"
run "$R" --fix; assert_eq "10 abssymlink: --fix rc=0" 0 "$?"
[[ -L "$R/.claude/skills" ]] && pass "10 abssymlink: .claude/skills still a symlink after --fix" || fail "10 abssymlink: .claude/skills still a symlink after --fix"
assert_eq "10 abssymlink: symlink rewritten to relative ../.agents/skills" "../.agents/skills" "$(readlink "$R/.claude/skills")"
assert_eq "10 abssymlink: content still reachable through the rewritten link" "body" "$(cat "$R/.claude/skills/foo/SKILL.md")"
run "$R"; assert_eq "10 abssymlink: rerun dry-run rc=0 (idempotent)" 0 "$?"

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

# 13. empty .agents/skills + correct symlink + bridged docs → rc 4 (round-4
#     review pJJ: git cannot record the empty target, so the committed link
#     dangles on fresh clones — refused loudly, and certainly no pointer),
#     no changes at all.
R="$SCRATCH/emptyskills"; mkdir -p "$R/.claude" "$R/.agents/skills"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n\n## What\ny\n' >"$R/AGENTS.md"
ln -s '../.agents/skills' "$R/.claude/skills"
BEFORE="$(tree_snapshot "$R")"
run "$R" >/dev/null 2>&1; assert_eq "13 emptyskills: dry-run rc=4" 4 "$?"
lacks "13 emptyskills: dry-run: no pointer appended" '## Skills' "$R/AGENTS.md"
assert_eq "13 emptyskills: dry-run tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"
run "$R" --fix >/dev/null 2>&1; assert_eq "13 emptyskills: --fix rc=4" 4 "$?"
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

# 17. CLAUDE.md a dangling symlink pointing OUTSIDE the repo → rc 4 both modes;
#     the outside target must NOT be created (regression guard: --fix's
#     `>"$CLA"` open-for-write used to follow the symlink and create/overwrite
#     the outside file).
R="$SCRATCH/danglingclaude"; mkdir -p "$R"
printf '# AGENTS.md\n\n## What\ny\n' >"$R/AGENTS.md"
ln -s '../outside.md' "$R/CLAUDE.md"
OUTSIDE_TARGET="$SCRATCH/outside.md"
BEFORE="$(tree_snapshot "$R")"
run "$R" >/dev/null 2>&1; assert_eq "17 dangling CLAUDE.md: dry-run rc=4" 4 "$?"
[[ ! -e "$OUTSIDE_TARGET" ]] && pass "17 dangling CLAUDE.md: dry-run created no outside target" || fail "17 dangling CLAUDE.md: dry-run created no outside target"
assert_eq "17 dangling CLAUDE.md: dry-run tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"
run "$R" --fix >/dev/null 2>&1; assert_eq "17 dangling CLAUDE.md: --fix rc=4" 4 "$?"
[[ ! -e "$OUTSIDE_TARGET" ]] && pass "17 dangling CLAUDE.md: --fix created no outside target" || fail "17 dangling CLAUDE.md: --fix created no outside target"
assert_eq "17 dangling CLAUDE.md: --fix tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"

# 18. AGENTS.md a symlink (non-dangling, resolves to a real file) → rc 4 both
#     modes, nothing touched.
R="$SCRATCH/agentslink"; mkdir -p "$R"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf 'real agents content\n' >"$R/real-agents.md"
ln -s 'real-agents.md' "$R/AGENTS.md"
BEFORE="$(tree_snapshot "$R")"
run "$R" >/dev/null 2>&1; assert_eq "18 AGENTS.md symlink: dry-run rc=4" 4 "$?"
assert_eq "18 AGENTS.md symlink: dry-run tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"
run "$R" --fix >/dev/null 2>&1; assert_eq "18 AGENTS.md symlink: --fix rc=4" 4 "$?"
assert_eq "18 AGENTS.md symlink: --fix tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"

# 19. collapse candidates are byte-identical (diff -r sees no difference) but
#     the executable bit differs on one file → rc 4, tree untouched, and the
#     original exec bit survives the refusal (tree_snapshot hashes content
#     only, so the -x check below is load-bearing, not redundant).
R="$SCRATCH/modemismatch"; mkdir -p "$R/.claude/skills/foo" "$R/.agents/skills/foo"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n\n## What\ny\n' >"$R/AGENTS.md"
printf 'same content\n' >"$R/.claude/skills/foo/run.sh"
printf 'same content\n' >"$R/.agents/skills/foo/run.sh"
chmod +x "$R/.claude/skills/foo/run.sh"
chmod -x "$R/.agents/skills/foo/run.sh"
BEFORE="$(tree_snapshot "$R")"
run "$R" >/dev/null 2>&1; assert_eq "19 modemismatch: dry-run rc=4" 4 "$?"
assert_eq "19 modemismatch: dry-run tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"
run "$R" --fix >/dev/null 2>&1; assert_eq "19 modemismatch: --fix rc=4" 4 "$?"
assert_eq "19 modemismatch: --fix tree byte-identical (no destructive collapse)" "$BEFORE" "$(tree_snapshot "$R")"
[[ -x "$R/.claude/skills/foo/run.sh" ]] && pass "19 modemismatch: .claude copy still executable after refusal" || fail "19 modemismatch: .claude copy still executable after refusal"
[[ ! -x "$R/.agents/skills/foo/run.sh" ]] && pass "19 modemismatch: .agents copy still non-executable after refusal" || fail "19 modemismatch: .agents copy still non-executable after refusal"

# 20. git repo with a stale '.agents/' line in .git/info/exclude, skills need
#     a move → rc 4 both modes, message mentions the exclude file; the SAME
#     fixture with .git removed (non-git) proceeds normally (skips the check).
R="$SCRATCH/gitignored"; mkdir -p "$R/.claude/skills/foo"
(cd "$R" && git init -q)
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n\n## What\ny\n' >"$R/AGENTS.md"
printf 'skill body\n' >"$R/.claude/skills/foo/SKILL.md"
printf '.agents/\n' >"$R/.git/info/exclude"
BEFORE="$(tree_snapshot "$R")"
# NOT via run() (which forces --quiet, suppressing the say()'d message) — call
# the script directly so the ambiguous-state message is actually captured.
OUT_DRY="$(bash "$SCRIPT" --repo "$R" 2>&1)"; RC_DRY=$?
assert_eq "20 gitignored: dry-run rc=4" 4 "$RC_DRY"
echo "$OUT_DRY" | grep -qF ".git/info/exclude" && pass "20 gitignored: message mentions the exclude" || fail "20 gitignored: message mentions the exclude" "$OUT_DRY"
assert_eq "20 gitignored: dry-run tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"
OUT_FIX="$(bash "$SCRIPT" --repo "$R" --fix 2>&1)"; RC_FIX=$?
assert_eq "20 gitignored: --fix rc=4" 4 "$RC_FIX"
echo "$OUT_FIX" | grep -qF ".git/info/exclude" && pass "20 gitignored: --fix message mentions the exclude" || fail "20 gitignored: --fix message mentions the exclude" "$OUT_FIX"
assert_eq "20 gitignored: --fix tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"
rm -rf "$R/.git"
run "$R" >/dev/null 2>&1; assert_eq "20 gitignored (non-git after rm -rf .git): dry-run proceeds normally rc=10" 10 "$?"
run "$R" --fix; assert_eq "20 gitignored (non-git after rm -rf .git): --fix proceeds normally rc=0" 0 "$?"
[[ -L "$R/.claude/skills" ]] && pass "20 gitignored (non-git): .claude/skills now a symlink" || fail "20 gitignored (non-git): .claude/skills now a symlink"
assert_eq "20 gitignored (non-git): symlink target" "../.agents/skills" "$(readlink "$R/.claude/skills")"

# 21. AGENTS.md whose ONLY '.agents/skills' mention is inside a fenced code
#     block, skills non-empty and already correctly wired (so the ONLY
#     outstanding fix is the pointer) → pointer IS appended (rc 10 dry-run,
#     fenced mention does not suppress it); after --fix a rerun is rc 0 with
#     exactly one '## Skills' heading (not duplicated).
R="$SCRATCH/fencedpointer"; mkdir -p "$R/.claude" "$R/.agents/skills/foo"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf 'body\n' >"$R/.agents/skills/foo/SKILL.md"
ln -s '../.agents/skills' "$R/.claude/skills"
printf '# AGENTS.md\n\n## What\ny\n\n```\nDo not reference .agents/skills directly in prose\n```\n' >"$R/AGENTS.md"
run "$R"; assert_eq "21 fencedpointer: dry-run rc=10 (fenced-only mention does not suppress the pointer)" 10 "$?"
lacks "21 fencedpointer: dry-run appended nothing" '## Skills' "$R/AGENTS.md"
run "$R" --fix; assert_eq "21 fencedpointer: --fix rc=0" 0 "$?"
has "21 fencedpointer: pointer appended after --fix" '## Skills' "$R/AGENTS.md"
assert_eq "21 fencedpointer: pointer heading appears exactly once" 1 "$(count "$R/AGENTS.md" '## Skills')"
run "$R"; assert_eq "21 fencedpointer: rerun dry-run rc=0" 0 "$?"
assert_eq "21 fencedpointer: rerun pointer heading still exactly once (not duplicated)" 1 "$(count "$R/AGENTS.md" '## Skills')"

# 22. already-migrated ("ok"-wired) git repo whose .agents/skills is git-ignored
#     (stale '.agents/' exclude left by a pre-guard migration or the Codex
#     runner) → rc 4 both modes: the fresh-clone dangling-link failure must be
#     surfaced retroactively, not only when a move is in flight.
R="$SCRATCH/okignored"; mkdir -p "$R/.claude" "$R/.agents/skills/foo"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf 'ok-wired body\n' >"$R/.agents/skills/foo/SKILL.md"
ln -s '../.agents/skills' "$R/.claude/skills"
printf '# AGENTS.md\n\n## Skills\n\nRepository skills live in `.agents/skills/` — Claude Code finds them via the `.claude/skills`\nsymlink; any agent can read the path directly.\n' >"$R/AGENTS.md"
git -C "$R" init -q
printf '.agents/\n' >"$R/.git/info/exclude"
run "$R" >/dev/null 2>&1; assert_eq "22 okignored: dry-run rc=4" 4 "$?"
run "$R" --fix >/dev/null 2>&1; assert_eq "22 okignored: --fix rc=4" 4 "$?"
rm -f "$R/.git/info/exclude"
run "$R"; assert_eq "22 okignored: rc=0 once the exclude is gone" 0 "$?"

# 23. AGENTS.md whose ONLY mention is the unrelated token '.agents/skills-old'
#     in prose (outside any fence) → must NOT suppress the pointer (the match is
#     token-bounded, not a bare substring).
R="$SCRATCH/tokenbound"; mkdir -p "$R/.claude" "$R/.agents/skills/foo"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf 'body\n' >"$R/.agents/skills/foo/SKILL.md"
ln -s '../.agents/skills' "$R/.claude/skills"
printf '# AGENTS.md\n\n## What\nDo not use .agents/skills-old for anything.\n' >"$R/AGENTS.md"
run "$R"; assert_eq "23 tokenbound: dry-run rc=10 (.agents/skills-old does not count as the pointer)" 10 "$?"
run "$R" --fix; assert_eq "23 tokenbound: --fix rc=0" 0 "$?"
assert_eq "23 tokenbound: pointer heading appended exactly once" 1 "$(count "$R/AGENTS.md" '## Skills')"
run "$R"; assert_eq "23 tokenbound: rerun dry-run rc=0 (real pointer now recognized)" 0 "$?"

# 24. descendant-only ignore rule ('.agents/skills/**') catches the pending
#     move's destination FILES even though it does NOT match the bare
#     .agents/skills directory path itself — exactly the gap where checking
#     only the directory (not the files that will land under it) reported a
#     move as trackable when `git add -A` would have silently omitted every
#     file under it. rc 4 both modes, tree untouched; removing the rule lets
#     the move proceed normally.
R="$SCRATCH/descendantignore"; mkdir -p "$R/.claude/skills/foo"
(cd "$R" && git init -q)
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n\n## What\ny\n' >"$R/AGENTS.md"
printf 'skill body\n' >"$R/.claude/skills/foo/SKILL.md"
printf '.agents/skills/**\n' >"$R/.git/info/exclude"
BEFORE="$(tree_snapshot "$R")"
run "$R" >/dev/null 2>&1; assert_eq "24 descendantignore: dry-run rc=4 (descendant-only rule)" 4 "$?"
assert_eq "24 descendantignore: dry-run tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"
run "$R" --fix >/dev/null 2>&1; assert_eq "24 descendantignore: --fix rc=4" 4 "$?"
assert_eq "24 descendantignore: --fix tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"
rm -f "$R/.git/info/exclude"
run "$R" >/dev/null 2>&1; assert_eq "24 descendantignore: dry-run rc=10 once the rule is removed" 10 "$?"
run "$R" --fix; assert_eq "24 descendantignore: --fix rc=0 once the rule is removed" 0 "$?"
[[ -L "$R/.claude/skills" ]] && pass "24 descendantignore: .claude/skills now a symlink" || fail "24 descendantignore: .claude/skills now a symlink"
assert_eq "24 descendantignore: file preserved" "skill body" "$(cat "$R/.agents/skills/foo/SKILL.md")"

# 25. global '*.md' ignore rule catches every skill file (SKILL.md) by
#     basename, without matching the bare .agents/skills directory path
#     (CLAUDE.md/AGENTS.md are explicitly un-ignored at repo root so this
#     fixture isolates the SKILLS destination check from the docs-ignore
#     preflight in test 26) → rc 4.
R="$SCRATCH/globalmdignore"; mkdir -p "$R/.claude/skills/foo"
(cd "$R" && git init -q)
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n\n## What\ny\n' >"$R/AGENTS.md"
printf 'skill body\n' >"$R/.claude/skills/foo/SKILL.md"
printf '*.md\n!/CLAUDE.md\n!/AGENTS.md\n' >"$R/.git/info/exclude"
BEFORE="$(tree_snapshot "$R")"
run "$R" >/dev/null 2>&1; assert_eq "25 globalmdignore: dry-run rc=4 (*.md catches SKILL.md)" 4 "$?"
assert_eq "25 globalmdignore: dry-run tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"
run "$R" --fix >/dev/null 2>&1; assert_eq "25 globalmdignore: --fix rc=4" 4 "$?"
assert_eq "25 globalmdignore: --fix tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"

# 26. AGENTS.md itself is git-ignored → rc 4 before any classification runs
#     (never create a bridge that imports an uncommittable file).
R="$SCRATCH/agentsignoreddoc"; mkdir -p "$R"
(cd "$R" && git init -q)
printf '# AGENTS.md\n\n## What\ny\n' >"$R/AGENTS.md"
printf 'AGENTS.md\n' >"$R/.git/info/exclude"
BEFORE="$(tree_snapshot "$R")"
OUT_DRY="$(bash "$SCRIPT" --repo "$R" 2>&1)"; RC_DRY=$?
assert_eq "26 agentsignoreddoc: dry-run rc=4" 4 "$RC_DRY"
echo "$OUT_DRY" | grep -qF "AGENTS.md is git-ignored" && pass "26 agentsignoreddoc: message names AGENTS.md" || fail "26 agentsignoreddoc: message names AGENTS.md" "$OUT_DRY"
assert_eq "26 agentsignoreddoc: dry-run tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"
OUT_FIX="$(bash "$SCRIPT" --repo "$R" --fix 2>&1)"; RC_FIX=$?
assert_eq "26 agentsignoreddoc: --fix rc=4" 4 "$RC_FIX"
assert_eq "26 agentsignoreddoc: --fix tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"

# 27. .claude/skills contains a symlink whose resolved target lies OUTSIDE the
#     tree → the move would change the link's effective base, so rc 4 both
#     modes, nothing touched.
R="$SCRATCH/escapinglink"; mkdir -p "$R/.claude/skills" "$R/outside-dir"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n\n## What\ny\n' >"$R/AGENTS.md"
printf 'outside body\n' >"$R/outside-dir/thing.txt"
ln -s '../../outside-dir/thing.txt' "$R/.claude/skills/escape-link"
BEFORE="$(tree_snapshot "$R")"
run "$R" >/dev/null 2>&1; assert_eq "27 escapinglink: dry-run rc=4" 4 "$?"
assert_eq "27 escapinglink: dry-run tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"
run "$R" --fix >/dev/null 2>&1; assert_eq "27 escapinglink: --fix rc=4" 4 "$?"
assert_eq "27 escapinglink: --fix tree unchanged" "$BEFORE" "$(tree_snapshot "$R")"
assert_eq "27 escapinglink: outside content untouched" "outside body" "$(cat "$R/outside-dir/thing.txt")"

# 28. .claude/skills contains a symlink whose resolved target lies INSIDE the
#     tree → fine, it moves together with the tree; --fix succeeds and the
#     link still resolves (now under .agents/skills).
R="$SCRATCH/internallink"; mkdir -p "$R/.claude/skills/foo" "$R/.claude/skills/bar"
printf '@AGENTS.md\n\n## Claude notes\nx\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n\n## What\ny\n' >"$R/AGENTS.md"
printf 'real body\n' >"$R/.claude/skills/foo/SKILL.md"
ln -s '../foo/SKILL.md' "$R/.claude/skills/bar/link-to-foo"
run "$R"; assert_eq "28 internallink: dry-run rc=10" 10 "$?"
run "$R" --fix; assert_eq "28 internallink: --fix rc=0" 0 "$?"
[[ -L "$R/.agents/skills/bar/link-to-foo" ]] && pass "28 internallink: link moved with the tree" || fail "28 internallink: link moved with the tree"
assert_eq "28 internallink: link still resolves after the move" "real body" "$(cat "$R/.agents/skills/bar/link-to-foo")"

# 29. --repo as the final argument (no value follows) → documented rc 2 usage
#     error, not bash's raw parameter-expansion failure (rc 1).
bash "$SCRIPT" --repo >/dev/null 2>&1; assert_eq "29 --repo as final arg: rc=2" 2 "$?"

# 30. noncanonical RELATIVE .claude/skills link that resolves correctly through
#     the checkout name → rewrite (rc 10 dry-run; --fix rewrites to the literal
#     ../.agents/skills), NOT ok — renaming/cloning the checkout would dangle it.
R="$SCRATCH/relnoncanon"; mkdir -p "$R/.claude" "$R/.agents/skills/foo"
printf '@AGENTS.md\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n\n## Skills\n\nsee `.agents/skills/`\n' >"$R/AGENTS.md"
printf 'body\n' >"$R/.agents/skills/foo/SKILL.md"
ln -s "../../$(basename "$R")/.agents/skills" "$R/.claude/skills"
run "$R"; assert_eq "30 relnoncanon: dry-run rc=10 (rewrite needed)" 10 "$?"
run "$R" --fix; assert_eq "30 relnoncanon: --fix rc=0" 0 "$?"
assert_eq "30 relnoncanon: link rewritten to canonical relative" "../.agents/skills" "$(readlink "$R/.claude/skills")"
run "$R"; assert_eq "30 relnoncanon: rerun rc=0" 0 "$?"

# 31. empty .agents/skills + no .claude/skills → NO symlink scheduled (git can't
#     track an empty dir; a committed link would dangle on fresh clones).
R="$SCRATCH/emptyas"; mkdir -p "$R/.agents/skills"
printf '@AGENTS.md\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n' >"$R/AGENTS.md"
run "$R"; assert_eq "31 emptyas: dry-run rc=0 (nothing to wire)" 0 "$?"
run "$R" --fix; assert_eq "31 emptyas: --fix rc=0" 0 "$?"
[[ ! -e "$R/.claude/skills" && ! -L "$R/.claude/skills" ]] && pass "31 emptyas: no symlink created" || fail "31 emptyas: no symlink created"

# 32. already-wired "ok" layout whose .agents is a symlink to an outside dir →
#     rc 4 (canonical tree lives outside the repo; false green on fresh clones).
R="$SCRATCH/okoutside"; mkdir -p "$R/.claude" "$SCRATCH/okoutside-real/skills/foo"
printf '@AGENTS.md\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n' >"$R/AGENTS.md"
printf 'external body\n' >"$SCRATCH/okoutside-real/skills/foo/SKILL.md"
ln -s "$SCRATCH/okoutside-real" "$R/.agents"
ln -s '../.agents/skills' "$R/.claude/skills"
run "$R" >/dev/null 2>&1; assert_eq "32 okoutside: dry-run rc=4" 4 "$?"
run "$R" --fix >/dev/null 2>&1; assert_eq "32 okoutside: --fix rc=4" 4 "$?"

# 33. byte-identical trees with a NON-executable-bit mode difference (0644 vs
#     0600) → rc 4 (mode comparison uses recorded bits, not [[ -x ]] access).
R="$SCRATCH/modebits"; mkdir -p "$R/.claude/skills/foo" "$R/.agents/skills/foo"
printf '@AGENTS.md\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n' >"$R/AGENTS.md"
printf 'same content\n' >"$R/.claude/skills/foo/data.txt"
printf 'same content\n' >"$R/.agents/skills/foo/data.txt"
chmod 644 "$R/.claude/skills/foo/data.txt"; chmod 600 "$R/.agents/skills/foo/data.txt"
run "$R" --fix >/dev/null 2>&1; assert_eq "33 modebits: --fix rc=4 (0644 vs 0600)" 4 "$?"
[[ -d "$R/.claude/skills" && ! -L "$R/.claude/skills" ]] && pass "33 modebits: nothing collapsed" || fail "33 modebits: nothing collapsed"

# 34. CLAUDE.md is a FIFO → rc 4 both modes (never redirect into a FIFO).
R="$SCRATCH/fifodoc"; mkdir -p "$R"
printf '# AGENTS.md\n' >"$R/AGENTS.md"
mkfifo "$R/CLAUDE.md"
run "$R" >/dev/null 2>&1; assert_eq "34 fifodoc: dry-run rc=4" 4 "$?"
run "$R" --fix >/dev/null 2>&1; assert_eq "34 fifodoc: --fix rc=4" 4 "$?"
[[ -p "$R/CLAUDE.md" ]] && pass "34 fifodoc: FIFO untouched" || fail "34 fifodoc: FIFO untouched"

# 35. git repo ignoring `.claude/` with skills pending symlink-only wiring →
#     rc 4 (the compatibility link itself would be committed nowhere; fresh
#     clones would give Claude no skills while the migrator reports success).
R="$SCRATCH/claudeignored"; mkdir -p "$R/.agents/skills/foo"
printf '@AGENTS.md\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n\nsee \x60.agents/skills/\x60\n' >"$R/AGENTS.md"
printf 'body\n' >"$R/.agents/skills/foo/SKILL.md"
git -C "$R" init -q
printf '.claude/\n' >"$R/.git/info/exclude"
run "$R" >/dev/null 2>&1; assert_eq "35 claudeignored: dry-run rc=4" 4 "$?"
run "$R" --fix >/dev/null 2>&1; assert_eq "35 claudeignored: --fix rc=4" 4 "$?"
[[ ! -e "$R/.claude/skills" ]] && pass "35 claudeignored: no ignored symlink created" || fail "35 claudeignored: no ignored symlink created"

# 36. byte-identical trees but a DIRECTORY mode differs (0755 vs 0700) → rc 4.
R="$SCRATCH/dirmode"; mkdir -p "$R/.claude/skills/foo" "$R/.agents/skills/foo"
printf '@AGENTS.md\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n' >"$R/AGENTS.md"
printf 'same content\n' >"$R/.claude/skills/foo/SKILL.md"
printf 'same content\n' >"$R/.agents/skills/foo/SKILL.md"
chmod 755 "$R/.claude/skills/foo"; chmod 700 "$R/.agents/skills/foo"
run "$R" --fix >/dev/null 2>&1; assert_eq "36 dirmode: --fix rc=4 (0755 vs 0700 dir)" 4 "$?"
[[ -d "$R/.claude/skills" && ! -L "$R/.claude/skills" ]] && pass "36 dirmode: nothing collapsed" || fail "36 dirmode: nothing collapsed"

# 37. correctly-spelled link onto an EMPTY .agents/skills → rc 4 (git cannot
#     record the empty target; the committed link dangles on fresh clones).
R="$SCRATCH/oklinkempty"; mkdir -p "$R/.claude" "$R/.agents/skills"
printf '@AGENTS.md\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n' >"$R/AGENTS.md"
ln -s '../.agents/skills' "$R/.claude/skills"
run "$R" >/dev/null 2>&1; assert_eq "37 oklinkempty: dry-run rc=4" 4 "$?"
run "$R" --fix >/dev/null 2>&1; assert_eq "37 oklinkempty: --fix rc=4" 4 "$?"

# 38. EMPTY .claude/skills real dir, .agents/skills absent → nothing to migrate
#     (rc 0, no move, no symlink — an empty target would be untrackable and the
#     wired result would be refused rc 4 by the next run anyway).
R="$SCRATCH/emptycs"; mkdir -p "$R/.claude/skills"
printf '@AGENTS.md\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n' >"$R/AGENTS.md"
run "$R"; assert_eq "38 emptycs: dry-run rc=0" 0 "$?"
run "$R" --fix; assert_eq "38 emptycs: --fix rc=0" 0 "$?"
[[ -d "$R/.claude/skills" && ! -L "$R/.claude/skills" && ! -e "$R/.agents" ]] && pass "38 emptycs: nothing moved or linked" || fail "38 emptycs: nothing moved or linked"

# 39. .claude/skills contains a nested .gitignore → rc 4 (its rules travel with
#     the tree; the destination probe cannot audit them in advance).
R="$SCRATCH/nestedignore"; mkdir -p "$R/.claude/skills/foo"
printf '@AGENTS.md\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n' >"$R/AGENTS.md"
printf 'body\n' >"$R/.claude/skills/foo/SKILL.md"
printf 'foo/SKILL.md\n' >"$R/.claude/skills/.gitignore"
run "$R" >/dev/null 2>&1; assert_eq "39 nestedignore: dry-run rc=4" 4 "$?"
run "$R" --fix >/dev/null 2>&1; assert_eq "39 nestedignore: --fix rc=4" 4 "$?"
[[ -d "$R/.claude/skills" && ! -L "$R/.claude/skills" ]] && pass "39 nestedignore: nothing moved" || fail "39 nestedignore: nothing moved"

# 40. .claude/skills is a git submodule / nested repo (has .git) → rc 4.
R="$SCRATCH/submodule"; mkdir -p "$R/.claude/skills/foo"
printf '@AGENTS.md\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n' >"$R/AGENTS.md"
printf 'body\n' >"$R/.claude/skills/foo/SKILL.md"
printf 'gitdir: ../../.git/modules/skills\n' >"$R/.claude/skills/.git"
run "$R" >/dev/null 2>&1; assert_eq "40 submodule: dry-run rc=4" 4 "$?"
run "$R" --fix >/dev/null 2>&1; assert_eq "40 submodule: --fix rc=4" 4 "$?"
[[ -d "$R/.claude/skills" && ! -L "$R/.claude/skills" ]] && pass "40 submodule: nothing moved" || fail "40 submodule: nothing moved"

# 41. ABSOLUTE nested symlink that resolves INSIDE the moving tree → rc 4 (its
#     text names this checkout's path; it would dangle after clone/rename even
#     though the move itself would succeed).
R="$SCRATCH/absinside"; mkdir -p "$R/.claude/skills/foo"
printf '@AGENTS.md\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n' >"$R/AGENTS.md"
printf 'body\n' >"$R/.claude/skills/foo/SKILL.md"
ln -s "$R/.claude/skills/foo" "$R/.claude/skills/alias"
run "$R" >/dev/null 2>&1; assert_eq "41 absinside: dry-run rc=4" 4 "$?"
run "$R" --fix >/dev/null 2>&1; assert_eq "41 absinside: --fix rc=4" 4 "$?"
[[ -d "$R/.claude/skills" && ! -L "$R/.claude/skills" ]] && pass "41 absinside: nothing moved" || fail "41 absinside: nothing moved"

# 42. sparse-checkout active (core.sparseCheckout=true) with a pending move →
#     rc 4; disabling it → proceeds.
R="$SCRATCH/sparse"; mkdir -p "$R/.claude/skills/foo"
printf '@AGENTS.md\n' >"$R/CLAUDE.md"
printf '# AGENTS.md\n' >"$R/AGENTS.md"
printf 'body\n' >"$R/.claude/skills/foo/SKILL.md"
git -C "$R" init -q
git -C "$R" config core.sparseCheckout true
run "$R" >/dev/null 2>&1; assert_eq "42 sparse: dry-run rc=4" 4 "$?"
git -C "$R" config core.sparseCheckout false
run "$R"; assert_eq "42 sparse: rc=10 once sparse mode is off" 10 "$?"

# 43. unreadable (traversable but unlistable) .claude/skills → rc 5 I/O error,
#     never silently classified as empty/none. (Skipped as root — permission
#     bits don't bind root.)
if [[ "$(id -u)" -ne 0 ]]; then
	R="$SCRATCH/unreadable"; mkdir -p "$R/.claude/skills/foo"
	printf '@AGENTS.md\n' >"$R/CLAUDE.md"
	printf '# AGENTS.md\n' >"$R/AGENTS.md"
	printf 'body\n' >"$R/.claude/skills/foo/SKILL.md"
	chmod 111 "$R/.claude/skills"
	run "$R" >/dev/null 2>&1; rc=$?
	chmod 755 "$R/.claude/skills"
	assert_eq "43 unreadable: rc=5 (I/O), not a silent none" 5 "$rc"
fi

echo ""
echo "migrate-dual-harness.test.sh: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]]
