#!/usr/bin/env bash
# review-skills.test.sh — CTL-2309: the two platform review skills run on every harness.
#
# WHY: the validate ladder's steps 3 and 4 named Claude Code's built-in `/code-review` and
# `/security-review`. Codex records both UNAVAILABLE and OpenCode refuses the phase, so a
# validate on those harnesses is a weaker validate, not a cheaper one (CTC-1775 census: the
# review step finds most REAL defects). `review-code` and `review-security` are the platform
# replacements: one session, no sub-agents, no slash commands, a runner-computed scope, and a
# verdict the ladder can record.
#
# Two halves:
#   1. Shape: each SKILL.md has name/description frontmatter, names the verdict vocabulary,
#      links its references, and uses nothing only Claude Code has.
#   2. Behaviour: each skill's `scripts/review-scope.sh` is RUN against a scratch repository —
#      the planted base ref, an explicit sha, the runner's file list as a bound, an empty diff,
#      a docs-only diff, and a base that does not resolve.
#
# Run: bash plugins/dev/skills/__tests__/review-skills.test.sh
# Bash-3.2 safe.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); printf '  PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  FAIL: %s\n    %s\n' "$1" "${2:-}"; }

SKILLS="review-code review-security"
for skill in $SKILLS; do
  [ -f "${SKILLS_DIR}/${skill}/SKILL.md" ] || { echo "FATAL: subject not found: ${skill}/SKILL.md" >&2; exit 1; }
  [ -f "${SKILLS_DIR}/${skill}/scripts/review-scope.sh" ] || { echo "FATAL: subject not found: ${skill}/scripts/review-scope.sh" >&2; exit 1; }
done

echo "platform review skills (CTL-2309)"

# ── 1. Shape ─────────────────────────────────────────────────────────────────
echo ""
echo "Shape"
for skill in $SKILLS; do
  md="${SKILLS_DIR}/${skill}/SKILL.md"
  if [ "$(sed -n '2p' "$md")" = "name: ${skill}" ]; then ok "${skill}: frontmatter name matches the directory"; else fail "${skill}: frontmatter name matches the directory" "line 2: $(sed -n '2p' "$md")"; fi
  if grep -qE '^description:' "$md"; then ok "${skill}: has a description"; else fail "${skill}: has a description"; fi
  if grep -qF 'PASS | FAIL | SKIPPED | UNAVAILABLE' "$md"; then ok "${skill}: names the ladder verdict vocabulary"; else fail "${skill}: names the ladder verdict vocabulary"; fi
  if grep -qF 'refs/catalyst/validate-base' "$md"; then ok "${skill}: names the runner's base ref"; else fail "${skill}: names the runner's base ref"; fi
  if grep -qF 'skill_dir_unresolved' "$md"; then ok "${skill}: tells another harness how to set CLAUDE_SKILL_DIR"; else fail "${skill}: tells another harness how to set CLAUDE_SKILL_DIR"; fi
  # Harness neutrality: nothing only Claude Code has. The positive control is the shape check
  # on a skill that legitimately fans out (research-codebase spawns subagents).
  for needle in '/code-review' '/security-review' 'gh pr comment' 'haiku' 'sonnet' 'subagent' 'sub-agent' 'CLAUDE_PLUGIN_ROOT'; do
    if grep -rqiF -- "$needle" "${SKILLS_DIR}/${skill}"; then
      fail "${skill}: never names '${needle}' (Claude-only or a PR side effect)" "$(grep -rniF -- "$needle" "${SKILLS_DIR}/${skill}" | head -1)"
    else
      ok "${skill}: never names '${needle}'"
    fi
  done
  if grep -qE '^allowed-tools:.*\bTask\b' "$md"; then fail "${skill}: allowed-tools has no Task tool"; else ok "${skill}: allowed-tools has no Task tool"; fi
done
if grep -qiF 'subagent' "${SKILLS_DIR}/research-codebase/SKILL.md"; then ok "control: the neutrality probe finds 'subagent' in a skill that fans out"; else fail "control: the neutrality probe finds 'subagent' in a skill that fans out" "the instrument cannot see the tree"; fi
if cmp -s "${SKILLS_DIR}/review-code/scripts/review-scope.sh" "${SKILLS_DIR}/review-security/scripts/review-scope.sh"; then ok "both skills carry the same review-scope.sh (no drift)"; else fail "both skills carry the same review-scope.sh (no drift)"; fi
if grep -qF 'anthropics/claude-code-security-review' "${SKILLS_DIR}/review-security/SKILL.md" && grep -rqF 'MIT' "${SKILLS_DIR}/review-security"; then ok "review-security attributes its source and license"; else fail "review-security attributes its source and license"; fi

# ── 2. Behaviour ─────────────────────────────────────────────────────────────
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
if git -C "$SCRATCH" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "FATAL: scratch dir $SCRATCH is inside a git checkout" >&2; exit 1
fi

REPO="$SCRATCH/repo"
git init -q "$REPO" && cd "$REPO" || exit 1
git config user.email t@example.com; git config user.name t; git config commit.gpgsign false
mkdir -p src docs
printf 'export const a = 1;\n' > src/a.ts
printf '# readme\n' > README.md
printf 'x\n' > docs/guide.md
git add -A && git commit -qm base
BASE="$(git rev-parse HEAD)"
git checkout -qb feature
printf 'export const a = 2;\n' > src/a.ts
printf 'export const b = 1;\n' > src/b.ts
printf '# readme changed\n' > README.md
git add -A && git commit -qm change
git update-ref refs/catalyst/validate-base "$BASE"

for skill in $SKILLS; do
  SCOPE="${SKILLS_DIR}/${skill}/scripts/review-scope.sh"
  echo ""
  echo "Behaviour: ${skill}/scripts/review-scope.sh"

  out="$(bash "$SCOPE" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q '^status: review$'; then ok "planted ref: status review, rc 0"; else fail "planted ref: status review, rc 0" "rc=$rc: ${out:0:300}"; fi
  if printf '%s' "$out" | grep -q "^base: ${BASE}$"; then ok "planted ref: resolves to the base sha"; else fail "planted ref: resolves to the base sha" "${out:0:300}"; fi
  if printf '%s' "$out" | grep -q '^ancestry: proven$'; then ok "planted ref: ancestry proven"; else fail "planted ref: ancestry proven" "${out:0:300}"; fi
  if printf '%s' "$out" | grep -q '^  M src/a.ts$' && printf '%s' "$out" | grep -q '^  A src/b.ts$'; then ok "planted ref: lists both code files with status"; else fail "planted ref: lists both code files with status" "${out:0:300}"; fi
  if printf '%s' "$out" | grep -q '^  M README.md$' && printf '%s' "$out" | grep -q '^code: 2$'; then ok "planted ref: README is listed as non-code and not counted"; else fail "planted ref: README is listed as non-code and not counted" "${out:0:300}"; fi
  if printf '%s' "$out" | grep -q "^diff_command: git -c core.quotePath=false diff ${BASE} HEAD -- "; then ok "planted ref: names the two-dot diff command"; else fail "planted ref: names the two-dot diff command" "${out:0:300}"; fi

  out="$(bash "$SCOPE" "$BASE" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "^base: ${BASE}$"; then ok "explicit sha: same scope"; else fail "explicit sha: same scope" "rc=$rc: ${out:0:300}"; fi
  out="$(bash "$SCOPE" --base "$BASE" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then ok "explicit --base: accepted"; else fail "explicit --base: accepted" "rc=$rc: ${out:0:300}"; fi
  # zsh does not word-split an unquoted parameter, so a SKILL.md that passes "$SKILL_ARGS" hands
  # the whole argument text over as one word; the script must re-split it.
  out="$(bash "$SCOPE" "--base $BASE" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "^base: ${BASE}$"; then ok "one unsplit argument word is re-split"; else fail "one unsplit argument word is re-split" "rc=$rc: ${out:0:300}"; fi
  # A branch name resolves to the fork point, never to the branch tip (a two-dot diff against a
  # moved main would review main's own commits).
  out="$(bash "$SCOPE" --base master 2>&1 || bash "$SCOPE" --base main 2>&1)"
  if printf '%s' "$out" | grep -q "^base: ${BASE}$"; then ok "branch name: resolves to the merge-base"; else fail "branch name: resolves to the merge-base" "${out:0:300}"; fi
  # Claude Code substitutes $ARGUMENTS; another harness leaves it literal — a literal is no base.
  out="$(bash "$SCOPE" '$ARGUMENTS' 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "^base: ${BASE}$"; then ok "a literal \$ARGUMENTS token is treated as no argument"; else fail "a literal \$ARGUMENTS token is treated as no argument" "rc=$rc: ${out:0:300}"; fi

  printf 'src/a.ts\nsrc/never-changed.ts\n' > "$SCRATCH/list.txt"
  out="$(bash "$SCOPE" --files "$SCRATCH/list.txt" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q '^  M src/a.ts$' && ! printf '%s' "$out" | grep -q 'src/b.ts'; then ok "--files: the diff is bounded to the runner's list"; else fail "--files: the diff is bounded to the runner's list" "rc=$rc: ${out:0:300}"; fi
  if printf '%s' "$out" | grep -q '^not_in_diff: 1$'; then ok "--files: a listed file the diff never touched is counted, not reviewed"; else fail "--files: a listed file the diff never touched is counted, not reviewed" "${out:0:300}"; fi

  out="$(bash "$SCOPE" --base HEAD 2>&1)"; rc=$?
  if [ "$rc" -eq 3 ] && printf '%s' "$out" | grep -q '^status: skipped$' && printf '%s' "$out" | grep -qi 'empty'; then ok "empty diff: status skipped, rc 3, reason names the empty diff"; else fail "empty diff: status skipped, rc 3, reason names the empty diff" "rc=$rc: ${out:0:300}"; fi

  printf 'README.md\n' > "$SCRATCH/docs-only.txt"
  out="$(bash "$SCOPE" --files "$SCRATCH/docs-only.txt" 2>&1)"; rc=$?
  if [ "$rc" -eq 3 ] && printf '%s' "$out" | grep -q '^status: skipped$' && printf '%s' "$out" | grep -qi 'non-code'; then ok "docs-only diff: status skipped, rc 3, reason names non-code"; else fail "docs-only diff: status skipped, rc 3, reason names non-code" "rc=$rc: ${out:0:300}"; fi

  out="$(bash "$SCOPE" --base refs/catalyst/no-such-ref 2>&1)"; rc=$?
  if [ "$rc" -eq 4 ] && printf '%s' "$out" | grep -q '^status: unavailable$' && printf '%s' "$out" | grep -q 'refs/catalyst/no-such-ref'; then ok "unresolvable base: status unavailable, rc 4, names the ref"; else fail "unresolvable base: status unavailable, rc 4, names the ref" "rc=$rc: ${out:0:300}"; fi
  git update-ref -d refs/catalyst/validate-base
  out="$(bash "$SCOPE" 2>&1)"; rc=$?
  if [ "$rc" -eq 4 ] && printf '%s' "$out" | grep -q '^status: unavailable$'; then ok "no planted ref and no argument: status unavailable (never a guessed base)"; else fail "no planted ref and no argument: status unavailable (never a guessed base)" "rc=$rc: ${out:0:300}"; fi
  git update-ref refs/catalyst/validate-base "$BASE"

  out="$(cd "$SCRATCH" && bash "$SCOPE" 2>&1)"; rc=$?
  if [ "$rc" -eq 4 ] && printf '%s' "$out" | grep -q '^status: unavailable$'; then ok "outside a repository: status unavailable, rc 4"; else fail "outside a repository: status unavailable, rc 4" "rc=$rc: ${out:0:300}"; fi

  out="$(bash "$SCOPE" --help 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qi 'usage'; then ok "--help prints usage, rc 0"; else fail "--help prints usage, rc 0" "rc=$rc: ${out:0:300}"; fi
done

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
