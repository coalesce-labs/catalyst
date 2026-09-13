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

SKILLS="agent-browser ask briefing-followup commit concierge create-handoff create-plan create-pr describe-pr fix-typescript gherkin-ticket implement-plan iterate-plan linear linearis merge-pr morning-briefing project-orchestrator remediate-plan research-codebase resume-handoff review-comments scan-reward-hacking steward triage-aging-prs validate-plan validate-type-safety"

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

# run_isolated_expect <label> <skill> <expected output substring> <command...> — for an entry
# point whose no-argument run exits non-zero by design (a usage error, a refusal): it passes
# when the expected text appears and no module or file failed to load. Static ES imports load
# before any argument handling, so a usage message proves the import graph resolved.
run_isolated_expect() {
  local label="$1" skill="$2" expected="$3"
  shift 3
  local copy="${SCRATCH}/installed/${skill}" out
  out="$(cd "$SCRATCH/cwd" && env -u CLAUDE_PLUGIN_ROOT -u CATALYST_DEV_SCRIPTS HOME="$SCRATCH/home" \
    CLAUDE_SKILL_DIR="$copy" CATALYST_DIR="$SCRATCH/home/catalyst" bash -c "$*" 2>&1)"
  if printf '%s' "$out" | grep -qE 'ERR_MODULE_NOT_FOUND|Cannot find module|[Nn]o such file'; then
    fail "$label" "a module or file failed to load: ${out:0:400}"
  elif ! printf '%s' "$out" | grep -qF -- "$expected"; then
    fail "$label" "expected output containing '${expected}': ${out:0:400}"
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
run_isolated "implement-plan: feedback-consent check (read-only)" implement-plan \
  '"$CLAUDE_SKILL_DIR/scripts/feedback-consent.sh" check >/dev/null'
run_isolated "implement-plan: file-feedback --help (sources its Linear read helper)" implement-plan \
  '"$CLAUDE_SKILL_DIR/scripts/file-feedback.sh" --help >/dev/null'

# Cluster 2 — PR/merge.
run_isolated "create-pr: draft-pr helper sources and defines draft_pr_ensure" create-pr \
  'source "$CLAUDE_SKILL_DIR/scripts/lib/draft-pr.sh" && declare -F draft_pr_ensure >/dev/null'
for skill in create-pr describe-pr; do
  run_isolated "${skill}: sibling-skip helper sources its team-keys lib" "$skill" \
    'source "$CLAUDE_SKILL_DIR/scripts/lib/linear-pr-skip.sh" && declare -F linear_sibling_skip_block_from_branch >/dev/null && declare -F linear_team_keys_filter >/dev/null'
done
run_isolated "describe-pr: replica read helper sources" describe-pr \
  'source "$CLAUDE_SKILL_DIR/scripts/lib/linear-read-replica.sh" && declare -F linear_read_ticket >/dev/null'
run_isolated "merge-pr: linear-transition --help (sources its replica helper)" merge-pr \
  '"$CLAUDE_SKILL_DIR/scripts/linear-transition.sh" --help 2>/dev/null; test $? -eq 0'
# pull-primary-worktree runs inside the repository it merges in; a scratch repo is its real shape.
run_isolated "merge-pr: pull-primary-worktree from the primary checkout of a scratch repo exits 0" merge-pr \
  'git init -q "$HOME/repo" && cd "$HOME/repo" && "$CLAUDE_SKILL_DIR/scripts/pull-primary-worktree.sh" --branch main'
for skill in create-pr merge-pr; do
  run_isolated "${skill}: carries merge-blocker-diagnosis" "$skill" 'test -s "$CLAUDE_SKILL_DIR/assets/references/merge-blocker-diagnosis.md"'
done
for skill in create-pr merge-pr review-comments; do
  run_isolated "${skill}: carries review-thread-resolution" "$skill" 'test -s "$CLAUDE_SKILL_DIR/assets/references/review-thread-resolution.md"'
done
# The Catalyst Bash tool runs zsh, where ${BASH_SOURCE[0]} is unset: the sibling-skip helper
# must still find its team-keys lib from a lone copy with no CLAUDE_PLUGIN_ROOT (CTL-633 shape).
if command -v zsh >/dev/null 2>&1; then
  out="$(cd "$SCRATCH/cwd" && env -u CLAUDE_PLUGIN_ROOT zsh -f -c "source '$SCRATCH/installed/create-pr/scripts/lib/linear-pr-skip.sh'; whence -w linear_team_keys_filter" 2>&1)"
  case "$out" in
    *function*) ok "create-pr (zsh): sibling-skip helper resolves its team-keys lib without CLAUDE_PLUGIN_ROOT" ;;
    *) fail "create-pr (zsh): sibling-skip helper resolves its team-keys lib without CLAUDE_PLUGIN_ROOT" "got: ${out:0:300}" ;;
  esac
else
  echo "  SKIP: zsh not installed — the zsh self-location case did not run"
fi

# Cluster 3 — Linear skills. identity-report is the setup check these skills run first (CTL-2300).
for skill in ask linear linearis; do
  run_isolated_expect "${skill}: identity-report runs and names the tenant slot" "$skill" "tenant" \
    'node "$CLAUDE_SKILL_DIR/scripts/identity-report.mjs"'
done
for skill in ask gherkin-ticket linear linearis; do
  run_isolated "${skill}: replica read helper sources" "$skill" \
    'source "$CLAUDE_SKILL_DIR/scripts/lib/linear-read-replica.sh" && declare -F linear_read_ticket >/dev/null'
done
for skill in linear linearis; do
  run_isolated "${skill}: cloud-detection marker helper sources" "$skill" \
    'source "$CLAUDE_SKILL_DIR/scripts/lib/plugin-dirs.sh" && declare -F plugin_dirs_repo_config_path >/dev/null'
done
run_isolated "linearis: linear-transition --help (sources its replica helper)" linearis \
  '"$CLAUDE_SKILL_DIR/scripts/linear-transition.sh" --help 2>/dev/null'
for skill in ask linearis; do
  run_isolated_expect "${skill}: linear-reply loads its import graph (usage error, no missing module)" "$skill" "usage: linear-reply.mjs" \
    'node "$CLAUDE_SKILL_DIR/scripts/linear-reply.mjs"'
done
run_isolated_expect "ask: ask.mjs loads its import graph (usage, no missing module)" ask "Usage:" \
  'node "$CLAUDE_SKILL_DIR/scripts/ask.mjs" --help'
run_isolated_expect "ask: linear-ack loads its import graph" ask "linear-ack" \
  'node "$CLAUDE_SKILL_DIR/scripts/linear-ack.mjs"'
run_isolated "ask: board vocabulary resolves the ask label names" ask \
  'node --input-type=module -e "const m = await import(process.env.CLAUDE_SKILL_DIR + \"/scripts/lib/board-vocabulary.mjs\"); if (!m.resolveAskLabelNames().names.length) process.exit(1)"'
for script in ask-triage.sh human-blocked.sh; do
  run_isolated "ask: ${script} parses and sources its replica helper" ask "bash -n \"\$CLAUDE_SKILL_DIR/scripts/${script}\" && test -s \"\$CLAUDE_SKILL_DIR/scripts/lib/linear-read-replica.sh\""
done

# Cluster 4a — coordination.
for skill in concierge steward; do
  run_isolated_expect "${skill}: identity-report runs and names the tenant slot" "$skill" "tenant" \
    'node "$CLAUDE_SKILL_DIR/scripts/identity-report.mjs"'
done
# Codex review on #4136 (P1): concierge follows the same cloud-detection reference, so it must
# carry the reference AND the helpers its commands source from concierge's own directory.
for skill in steward concierge; do
  run_isolated "${skill}: carries the cloud-detection reference" "$skill" 'test -s "$CLAUDE_SKILL_DIR/assets/references/cloud-detection.md"'
done
run_isolated "concierge: cloud-detection helpers source (replica + marker)" concierge \
  'source "$CLAUDE_SKILL_DIR/scripts/lib/linear-read-replica.sh" && source "$CLAUDE_SKILL_DIR/scripts/lib/plugin-dirs.sh" && declare -F replica_fresh >/dev/null && declare -F plugin_dirs_repo_config_path >/dev/null'
run_isolated "steward: cloud-detection helpers source (replica + marker)" steward \
  'source "$CLAUDE_SKILL_DIR/scripts/lib/linear-read-replica.sh" && source "$CLAUDE_SKILL_DIR/scripts/lib/plugin-dirs.sh" && declare -F replica_fresh >/dev/null && declare -F plugin_dirs_repo_config_path >/dev/null'
run_isolated "create-handoff: handoff-durability helper sources and defines its three steps" create-handoff \
  'source "$CLAUDE_SKILL_DIR/scripts/lib/handoff-durability.sh" && declare -F handoff_resolve_path >/dev/null && declare -F handoff_write_verified >/dev/null && declare -F handoff_sync_and_classify >/dev/null'

# Cluster 4b — briefings.
run_isolated_expect "morning-briefing: validate-frontmatter finds its schema from a lone copy" morning-briefing "no frontmatter block found" \
  'printf "no frontmatter here\n" > "$HOME/briefing.md"; bash "$CLAUDE_SKILL_DIR/scripts/morning-briefing/validate-frontmatter.sh" "$HOME/briefing.md"'
run_isolated "morning-briefing: output-path resolves a dry-run path" morning-briefing \
  'bash "$CLAUDE_SKILL_DIR/scripts/morning-briefing/output-path.sh" --dry-run --date 2026-01-02 | grep -q 2026-01-02'
run_isolated "morning-briefing: linear-transition --help (suggest-dispatch state names)" morning-briefing \
  '"$CLAUDE_SKILL_DIR/scripts/linear-transition.sh" --help 2>/dev/null'
run_isolated "briefing-followup: writeback's frontmatter lib and event lib are carried" briefing-followup \
  'test -s "$CLAUDE_SKILL_DIR/scripts/briefing-frontmatter-lib.sh" && test -s "$CLAUDE_SKILL_DIR/scripts/lib/canonical-event.sh" && test -s "$CLAUDE_SKILL_DIR/scripts/lib/task-type.sh"'
run_isolated_expect "briefing-followup: parse-briefing prints its usage" briefing-followup "sage" \
  'bash "$CLAUDE_SKILL_DIR/scripts/briefing-followup/parse-briefing.sh"'

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
