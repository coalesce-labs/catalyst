#!/usr/bin/env bash
# Shape tests for the handoff write-then-cite contract (CTL-2104).
#
# The runtime behavior lives in plugins/dev/scripts/lib/handoff-durability.sh
# and is covered by lib/__tests__/handoff-durability.test.sh. THIS suite guards
# the other half: that the prose skills actually WIRE that helper, and that the
# recovery rule the stewards used to survive the incident is published rather
# than staying practitioner lore. A helper nothing calls fixes nothing.
#
# Run: bash plugins/dev/skills/__tests__/handoff-contract.test.sh
# Discovered locally via run-tests.sh SKILLS_SHELL_TEST_DIR and pinned in CI by
# .github/workflows/skills-gate.yml — BOTH are required, neither is sufficient.
# Bash-3.2 safe.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SKILLS_DIR}/../../.." && pwd)"

CREATE="${SKILLS_DIR}/create-handoff/SKILL.md"
RESUME="${SKILLS_DIR}/resume-handoff/SKILL.md"
STEWARD_RESUME="${SKILLS_DIR}/steward/references/resume.md"
CONCIERGE_RESUME="${SKILLS_DIR}/concierge/references/resume.md"
HELPER="${REPO_ROOT}/plugins/dev/scripts/lib/handoff-durability.sh"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); printf '  PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  FAIL: %s\n    %s\n' "$1" "${2:-}"; }

# Fail CLOSED on a missing subject. A grep over a file that does not exist
# returns zero matches, which reads exactly like "the assertion failed" — but
# a renamed/moved skill is a different problem and must not be reported as a
# content defect.
for f in "$CREATE" "$RESUME" "$STEWARD_RESUME" "$CONCIERGE_RESUME" "$HELPER"; do
  [ -f "$f" ] || { echo "FATAL: subject not found: $f" >&2; exit 1; }
done

# assert_grep <file> <extended-regex> <description>
assert_grep() {
  local file="$1" pat="$2" desc="$3"
  if grep -Eq "$pat" "$file"; then ok "$desc"
  else fail "$desc" "no line in ${file#"$REPO_ROOT"/} matches: $pat"; fi
}

echo "handoff contract shape tests (CTL-2104)"
echo ""

# ── Positive control ────────────────────────────────────────────────────────
# Every assertion below is a grep that returns zero on failure. Prove first that
# this instrument returns NON-zero against a string known to be present, so a
# clean sweep of zeros cannot be silently mistaken for "the files are fine".
echo "Positive control: the grep instrument itself"
assert_grep "$CREATE" 'name: create-handoff' \
  "control: grep finds a string known to be present in create-handoff/SKILL.md"

# ── Phase 2: create-handoff wires the helper + states its guarantee ──────────
echo ""
echo "create-handoff (AC-a: mechanical path; AC-b: explicit durability contract)"

assert_grep "$CREATE" 'lib/handoff-durability\.sh' \
  "create-handoff references lib/handoff-durability.sh (helper is wired)"
assert_grep "$CREATE" 'handoff_resolve_path' \
  "create-handoff calls handoff_resolve_path (the path is computed, not composed)"
assert_grep "$CREATE" 'handoff_write_verified' \
  "create-handoff calls handoff_write_verified (the write is read back)"
assert_grep "$CREATE" 'handoff_sync_and_classify' \
  "create-handoff calls handoff_sync_and_classify (sync has a verdict, not a hope)"

# Failure mode #3: the model typing the stamp/path a second time from memory.
assert_grep "$CREATE" '(do NOT re-type|Do NOT re-type|never re-type)' \
  "create-handoff forbids re-typing the path/timestamp from memory"
assert_grep "$CREATE" 'absolute path' \
  "create-handoff cites the absolute path"

# AC-b: the response must distinguish the two durability states.
assert_grep "$CREATE" 'local-only' \
  "create-handoff's response surfaces the local-only verdict"
# The contract is TWO verdict-keyed response branches — not one phrasing. A
# single template that mentions both words would still let the model announce
# "synced" on a local-only run, which is the bug.
assert_grep "$CREATE" 'When .HANDOFF_VERDICT. is .synced' \
  "create-handoff has a distinct response branch for the synced verdict"
assert_grep "$CREATE" 'When .HANDOFF_VERDICT. is .local-only:not-in-pushed-tree' \
  "create-handoff has a distinct response branch for the async not-in-pushed-tree verdict"
assert_grep "$CREATE" 'When .HANDOFF_VERDICT. is any other .local-only' \
  "create-handoff has a distinct response branch for the NON-async local-only verdicts"
assert_grep "$CREATE" '## Durability contract' \
  "create-handoff has a 'Durability contract' section (AC-b)"

# ── Codex review round 1 on #3931/#3933: three claims that must stay true ─────
# 1. The Bash install path is invisible to the `Track Handoff Documents` hook,
#    which matches tool_name = "Write". Without an explicit registration the next
#    resume-handoff auto-discovers an OLDER handoff, because
#    `workflow-context.sh recent handoffs` only falls back to the filesystem when
#    the context has NO entry for the type.
assert_grep "$CREATE" 'workflow-context\.sh. add handoffs' \
  "create-handoff registers the installed handoff in workflow context (the Write hook cannot see a Bash install)"

# 2. The next-tick promise is true only for the async verdict. A rebase conflict
#    or missing tooling persists until someone fixes it, so promising ≤300 s for
#    every local-only verdict is the same shape of over-claim as the old
#    unconditional "synced".
assert_grep "$CREATE" 'next-tick guarantee applies to .not-in-pushed-tree. only' \
  "create-handoff scopes the next-tick guarantee to not-in-pushed-tree alone"

# 3. The absolute path carries THIS host's root, so a reader elsewhere needs the
#    repo-relative identity too.
assert_grep "$CREATE" 'HANDOFF_REL' \
  "create-handoff also cites the portable repo-relative path for other hosts"

# The old unconditional claim must be GONE — leaving it is the bug.
if grep -Eq 'Handoff created and synced!' "$CREATE"; then
  fail "the unconditional 'created and synced!' claim is removed" \
       "create-handoff still asserts 'synced' regardless of the verdict"
else
  ok "the unconditional 'created and synced!' claim is removed"
fi

# ── Phase 3: resume-handoff read side ───────────────────────────────────────
echo ""
echo "resume-handoff (read side: guard every path source)"

# The env-var source was already guarded; the workflow-context source was not.
assert_grep "$RESUME" 'RECENT_HANDOFF' \
  "resume-handoff still resolves RECENT_HANDOFF (subject is present)"
if grep -Eq '\[\[ -f "\$RECENT_HANDOFF" \]\]|-f "\$RECENT_HANDOFF"' "$RESUME"; then
  ok "resume-handoff guards the discovered handoff path with -f"
else
  fail "resume-handoff guards the discovered handoff path with -f" \
       "the workflow-context source is still read without an existence guard"
fi
assert_grep "$RESUME" '(channel is authoritative|channel.{0,20}authoritative)' \
  "resume-handoff documents the channel-authoritative fallback"

# ── Phase 3: the recovery rule is published, not lore ───────────────────────
echo ""
echo "steward + concierge resume references (publish the fallback rule)"
assert_grep "$STEWARD_RESUME" '(channel is authoritative|channel.{0,20}authoritative)' \
  "steward/references/resume.md publishes the channel-authoritative rule"
assert_grep "$CONCIERGE_RESUME" '(channel is authoritative|channel.{0,20}authoritative)' \
  "concierge/references/resume.md publishes the channel-authoritative rule"

echo ""
echo "──────────────────────────────────────────"
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
