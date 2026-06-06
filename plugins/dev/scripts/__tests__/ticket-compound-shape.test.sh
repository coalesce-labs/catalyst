#!/usr/bin/env bash
# ticket-compound-shape.test.sh
# Asserts the Slice-1 compound-engineering surface is wired (CTL-789):
#   - the ticket-compound curator skill (SKILL.md + reference.md) exists, is
#     user-invocable, declares allowed-tools, and harvests the friction log.
#   - the learnings validator exists + is executable, and the seed entry passes it.
#   - all 5 phase-* artifact skills append a timestamped Friction record
#     (the "If I'd known" bullet, the per-ticket friction log path, and a
#     time-bearing %H:%M stamp — date+TIME, never date-only).
#   - the briefing-followup action-compound handler + CONCEPTS.md seed exist.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
fail=0; assert(){ if ! eval "$2"; then echo "FAIL: $1"; fail=1; else echo "ok: $1"; fi; }

# 1. The ticket-compound curator skill.
TC_DIR="$ROOT/plugins/foundry/skills/ticket-compound"
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

# 3. Friction-capture producer block in all 5 artifact phase skills.
#    Each must reference the per-ticket friction log, carry the canonical
#    "If I'd known" bullet, AND timestamp records with date+TIME (%H:%M),
#    not date-only — the cross-phase header contract is date +%Y-%m-%dT%H:%M:%S%z.
PHASES=(research plan implement verify review)
for p in "${PHASES[@]}"; do
  f="$ROOT/plugins/dev/skills/phase-$p/SKILL.md"
  assert "phase-$p SKILL.md exists"                 "test -f '$f'"
  assert "phase-$p friction block writes thoughts/shared/friction/" \
    "grep -q 'thoughts/shared/friction/' '$f'"
  assert "phase-$p friction block has the 'If I'\''d known' bullet" \
    "grep -q \"If I'd known\" '$f'"
  assert "phase-$p friction record is time-bearing (%H:%M, not date-only)" \
    "grep -q '%H:%M' '$f'"
done

# 4. The seed learnings entry exists AND passes the validator (exit 0).
SEED="$ROOT/thoughts/shared/learnings/architecture-patterns/friction-capture-container.md"
assert "seed learnings entry exists" "test -f '$SEED'"
assert "validate-learnings.sh exits 0 on the seed entry" \
  "bash '$VALIDATOR' '$SEED' >/dev/null 2>&1"

# 5. The approval-surface handler + the concepts seed.
assert "briefing-followup action-compound.sh exists" \
  "test -f '$ROOT/plugins/dev/scripts/briefing-followup/action-compound.sh'"
assert "action-compound.sh is executable" \
  "test -x '$ROOT/plugins/dev/scripts/briefing-followup/action-compound.sh'"
assert "thoughts/CONCEPTS.md exists" "test -f '$ROOT/thoughts/CONCEPTS.md'"

exit $fail
