#!/usr/bin/env bash
# skill-dir-isolation.test.sh — CTL-2306 Phase 2: a skill directory runs on its own.
#
# The static checker (skill-self-containment.test.mjs) proves every path a skill
# names exists inside it. This proves the scripts actually RUN from a copy of the
# skill directory alone — the shape `npx skills add` installs and the shape a
# harness without the Claude plugin root sees: no plugins/dev/ next to it, no
# CLAUDE_PLUGIN_ROOT, cwd outside any git checkout.
#
# SKILLS must match SELF_CONTAINED in skill-self-containment.test.mjs (that test
# asserts the two lists agree).
#
# Run: bash scripts/packaging/__tests__/skill-dir-isolation.test.sh
# Bash-3.2 safe.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
SKILLS_ROOT="${REPO_ROOT}/plugins/dev/skills"

SKILLS="create-plan implement-plan iterate-plan remediate-plan research-codebase scan-reward-hacking validate-plan validate-type-safety"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); printf '  PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  FAIL: %s\n    %s\n' "$1" "${2:-}"; }

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
if git -C "$SCRATCH" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "FATAL: scratch dir $SCRATCH is inside a git checkout — the isolation would be fake" >&2
  exit 1
fi

# run_isolated <label> <skill> <command...> — runs in a copy of the skill dir, with a
# scratch HOME, no CLAUDE_PLUGIN_ROOT, CLAUDE_SKILL_DIR pointing at the copy.
run_isolated() {
  local label="$1" skill="$2"
  shift 2
  local copy="${SCRATCH}/installed/${skill}" out rc
  out="$(cd "$SCRATCH/cwd" && env -u CLAUDE_PLUGIN_ROOT -u CATALYST_DEV_SCRIPTS HOME="$SCRATCH/home" \
    CLAUDE_SKILL_DIR="$copy" CATALYST_DIR="$SCRATCH/home/catalyst" bash -c "$*" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "$label" "exit $rc: ${out:0:400}"
  elif printf '%s' "$out" | grep -qiE 'no such file|not found|cannot open'; then
    fail "$label" "a missing file was reported: ${out:0:400}"
  else
    ok "$label"
  fi
}

mkdir -p "$SCRATCH/installed" "$SCRATCH/cwd" "$SCRATCH/home"
for skill in $SKILLS; do
  [ -f "${SKILLS_ROOT}/${skill}/SKILL.md" ] || { fail "${skill}: exists" "no SKILL.md"; continue; }
  cp -R "${SKILLS_ROOT}/${skill}" "$SCRATCH/installed/${skill}"
done

echo "skill directories run on their own (CTL-2306)"

# ── every shell script parses, every module compiles ─────────────────────────
checked=0
for skill in $SKILLS; do
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    checked=$((checked+1))
    case "$f" in
      *.sh) bash -n "$f" 2>/dev/null && ok "${f#"$SCRATCH"/installed/}: bash -n" || fail "${f#"$SCRATCH"/installed/}: bash -n" ;;
      *.mjs) node --check "$f" 2>/dev/null && ok "${f#"$SCRATCH"/installed/}: node --check" || fail "${f#"$SCRATCH"/installed/}: node --check" ;;
    esac
  done <<EOF
$(find "$SCRATCH/installed/$skill" -type f \( -name '*.sh' -o -name '*.mjs' \) 2>/dev/null | sort)
EOF
done
[ "$checked" -gt 0 ] || fail "at least one script was checked" "zero scripts found across ${SKILLS} — the isolation proves nothing"

# ── entrypoints the skills call, run from the isolated copy ──────────────────
run_isolated "implement-plan: draft-pr helper sources and defines its functions" implement-plan \
  'source "$CLAUDE_SKILL_DIR/scripts/lib/draft-pr.sh" && declare -F draft_pr_enabled >/dev/null && declare -F draft_pr_push >/dev/null'
run_isolated "implement-plan: add-finding --help" implement-plan \
  '"$CLAUDE_SKILL_DIR/scripts/add-finding.sh" --help >/dev/null'
run_isolated "implement-plan: feedback-consent --help" implement-plan \
  '"$CLAUDE_SKILL_DIR/scripts/feedback-consent.sh" --help >/dev/null'
run_isolated "implement-plan: file-feedback --help (sources its Linear read helper)" implement-plan \
  '"$CLAUDE_SKILL_DIR/scripts/file-feedback.sh" --help >/dev/null'

for agent in codebase-locator codebase-analyzer codebase-pattern-finder thoughts-locator thoughts-analyzer external-research; do
  for skill in research-codebase create-plan; do
    run_isolated "${skill}: carries the ${agent} subagent prompt" "$skill" "test -s \"\$CLAUDE_SKILL_DIR/assets/agents/${agent}.md\""
  done
done
for agent in codebase-locator codebase-analyzer codebase-pattern-finder; do
  run_isolated "iterate-plan: carries the ${agent} subagent prompt" iterate-plan "test -s \"\$CLAUDE_SKILL_DIR/assets/agents/${agent}.md\""
done

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
