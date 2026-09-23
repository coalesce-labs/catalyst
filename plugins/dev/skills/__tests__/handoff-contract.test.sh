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
RESUME_PROCESS="${SKILLS_DIR}/resume-handoff/references/process.md"
RESUME_SCENARIOS="${SKILLS_DIR}/resume-handoff/references/scenarios.md"
RESUME_DISCOVERY="${SKILLS_DIR}/resume-handoff/references/discovery.md"
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
for f in "$CREATE" "$RESUME" "$RESUME_PROCESS" "$RESUME_SCENARIOS" "$RESUME_DISCOVERY" "$STEWARD_RESUME" "$CONCIERGE_RESUME" "$HELPER"; do
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
# 1. CTL-2306 retired the workflow-context registry and the hook that fed it:
#    the installed file on disk IS the record, and resume-handoff finds it by
#    ticket with a within-run filesystem search. A registration call left behind
#    would name a script that no longer exists.
if grep -Eq 'workflow-context' "$CREATE"; then
  fail "create-handoff registers nothing in workflow context (CTL-2306)" \
       "create-handoff still names workflow-context"
else
  ok "create-handoff registers nothing in workflow context (CTL-2306)"
fi

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

# CTL-2104: every discovered path is existence-guarded before it is read. The
# source is now a within-run filesystem search (CTL-2306), but the guard stays —
# thoughts/shared is a per-project symlink and a path can vanish mid-run.
assert_grep "$RESUME" 'RECENT_HANDOFF' \
  "resume-handoff still resolves RECENT_HANDOFF (subject is present)"
if grep -Eq '\[\[ -f "\$RECENT_HANDOFF" \]\]|-f "\$RECENT_HANDOFF"' "$RESUME"; then
  ok "resume-handoff guards the discovered handoff path with -f"
else
  fail "resume-handoff guards the discovered handoff path with -f" \
       "the discovered handoff path is read without an existence guard"
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

# ── CTC-3128 / CTC-3129: a handoff can be resumed with nobody watching ───────
# An automated context reset resumed from a handoff and then stopped to ask a
# human what to do, because resume-handoff required confirmation twice and the
# handoff recorded no next step or default. These pin both halves.
echo ""
echo "unattended resume (CTC-3128 / CTC-3129)"

# create-handoff: the Resume contract and every one of its fields.
assert_grep "$CREATE" '^## Resume contract' \
  "create-handoff's template carries a Resume contract section"
for field in 'Stopped at:' 'Next step:' 'Re-arm:' 'Open questions:' 'Default if unanswered:' 'Autonomy:'; do
  assert_grep "$CREATE" "\\*\\*${field}\\*\\*" \
    "create-handoff's Resume contract has the '${field}' field"
done
assert_grep "$CREATE" 'Resume contract is required' \
  "create-handoff marks the Resume contract as required"
assert_grep "$CREATE" 'unattended mode the response below is the whole reply' \
  "create-handoff's closing response asks nothing in unattended mode"

# The four unattended triggers, in each file that decides the mode.
for f in "$CREATE" "$RESUME" "$RESUME_PROCESS"; do
  rel="${f#"$SKILLS_DIR"/}"
  assert_grep "$f" '`--unattended`' "${rel}: names the --unattended argument trigger"
  assert_grep "$f" 'CATALYST_UNATTENDED=1' "${rel}: names the CATALYST_UNATTENDED=1 trigger"
  assert_grep "$f" 'CATALYST_TICKET.{0,40}no interactive user' "${rel}: names the pipeline-phase trigger"
  assert_grep "$f" 'prompt says the session is unattended' "${rel}: names the invoking-prompt trigger"
done

# resume-handoff: the unconditional confirmation invariant is gone, and the
# unattended branch replaces each gate rather than deleting interactivity.
if grep -Eq '^- \*\*Get user confirmation\*\*' "$RESUME"; then
  fail "resume-handoff no longer requires confirmation unconditionally" \
       "the unconditional 'Get user confirmation' invariant is back in SKILL.md"
else
  ok "resume-handoff no longer requires confirmation unconditionally"
fi
assert_grep "$RESUME" 'Otherwise, get user confirmation' \
  "resume-handoff keeps confirmation as the interactive default"
assert_grep "$RESUME" 'never end the turn on a question' \
  "resume-handoff's invariant forbids ending an unattended turn on a question"
assert_grep "$RESUME_PROCESS" '^## Unattended mode' \
  "process.md has an Unattended mode section"
assert_grep "$RESUME_PROCESS" 'Unattended: print the same summary' \
  "process.md Step 2 proceeds without confirmation when unattended"
assert_grep "$RESUME_PROCESS" 'Unattended: present it and start' \
  "process.md Step 3 proceeds without confirmation when unattended"
assert_grep "$RESUME_PROCESS" 'Default if unanswered:' \
  "process.md takes the handoff's recorded default"
assert_grep "$RESUME_PROCESS" 'most reversible option' \
  "process.md falls back to the most reversible option"
assert_grep "$RESUME_PROCESS" 'catalyst-dev:ask' \
  "process.md routes a human-only decision through the ask SOP"
assert_grep "$RESUME_PROCESS" 'irreversible outward action' \
  "process.md stops only before an unauthorized irreversible outward action"
assert_grep "$RESUME_PROCESS" 'Never end the turn on a question' \
  "process.md forbids ending the turn on a question"
assert_grep "$RESUME_SCENARIOS" '^## Worked example: unattended' \
  "scenarios.md has an unattended worked example"
assert_grep "$RESUME_DISCOVERY" 'nothing waits for input' \
  "discovery.md's no-path branches do not wait for input when unattended"

echo ""
echo "──────────────────────────────────────────"
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
