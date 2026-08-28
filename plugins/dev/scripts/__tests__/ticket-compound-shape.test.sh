#!/usr/bin/env bash
# ticket-compound-shape.test.sh
# Asserts the Slice-1 compound-engineering surface is wired (CTL-789):
#   - the ticket-compound curator skill (SKILL.md + reference.md) exists, is
#     user-invocable, declares allowed-tools, and harvests the friction log.
#   - the learnings validator exists + is executable, and the seed entry passes it.
#   - the briefing-followup action-compound handler + CONCEPTS.md seed exist.
# CTL-2239: the "all 5 phase-* artifact skills append a timestamped Friction
# record" assertions this file used to carry were removed along with those
# skills (B2 of the CTL-2218 cleanup plan).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
fail=0; assert(){ if ! eval "$2"; then echo "FAIL: $1"; fail=1; else echo "ok: $1"; fi; }

# 1. The ticket-compound curator skill.
TC_DIR="$ROOT/plugins/dev/skills/ticket-compound"
assert "ticket-compound SKILL.md exists"   "test -f '$TC_DIR/SKILL.md'"
assert "ticket-compound reference.md exists" "test -f '$TC_DIR/reference.md'"
assert "SKILL.md frontmatter is user-invocable" "grep -q '^user-invocable: true' '$TC_DIR/SKILL.md'"
assert "SKILL.md frontmatter declares allowed-tools" "grep -q '^allowed-tools:' '$TC_DIR/SKILL.md'"
assert "Step 1 harvest mentions thoughts/shared/friction/" \
  "grep -q 'thoughts/shared/friction/' '$TC_DIR/SKILL.md'"

# 2. The learnings validator (backing script lives in dev/scripts/compound).
VALIDATOR="$ROOT/plugins/dev/scripts/compound/validate-learnings.sh"
assert "validate-learnings.sh exists"     "test -f '$VALIDATOR'"
assert "validate-learnings.sh is executable" "test -x '$VALIDATOR'"

# 3. Seed thoughts artifacts (gitignored + humanlayer-synced — only present where the
#    thoughts store is seeded). Guarded so this stays a pure repo-structure test that also
#    passes in a bare checkout / CI; skips-with-note otherwise. CONCEPTS.md is the vocabulary
#    seed, now in the synced shared store (thoughts/shared/CONCEPTS.md).
SEED="$ROOT/thoughts/shared/learnings/architecture-patterns/friction-capture-container.md"
if [ -d "$ROOT/thoughts/shared/learnings" ]; then
  assert "seed learnings entry exists" "test -f '$SEED'"
  assert "validate-learnings.sh exits 0 on the seed entry" \
    "bash '$VALIDATOR' '$SEED' >/dev/null 2>&1"
  if [ -f "$ROOT/thoughts/shared/CONCEPTS.md" ]; then
    assert "thoughts/shared/CONCEPTS.md exists" "test -f '$ROOT/thoughts/shared/CONCEPTS.md'"
  else
    echo "skip: thoughts/shared/CONCEPTS.md not seeded in this checkout"
  fi
else
  echo "skip: thoughts store not seeded in this checkout — skipping seed-entry + CONCEPTS assertions"
fi

# 4. The approval-surface handler (repo file, always present).
assert "briefing-followup action-compound.sh exists" \
  "test -f '$ROOT/plugins/dev/scripts/briefing-followup/action-compound.sh'"
assert "action-compound.sh is executable" \
  "test -x '$ROOT/plugins/dev/scripts/briefing-followup/action-compound.sh'"

exit $fail
