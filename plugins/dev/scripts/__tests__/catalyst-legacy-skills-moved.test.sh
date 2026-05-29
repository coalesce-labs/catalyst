#!/usr/bin/env bash
# catalyst-legacy-skills-moved.test.sh (CTL-726)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SKILLS=(oneshot orchestrate god setup-orchestrate briefing-followup iterate-plan)
fail=0
assert() { if ! eval "$2"; then echo "FAIL: $1"; fail=1; else echo "ok: $1"; fi; }

for s in "${SKILLS[@]}"; do
  assert "$s present in legacy"  "test -f '$ROOT/plugins/legacy/skills/$s/SKILL.md'"
done

# No migrated skill keeps a bare ${CLAUDE_PLUGIN_ROOT}/scripts reference.
for s in "${SKILLS[@]}"; do
  f="$ROOT/plugins/legacy/skills/$s/SKILL.md"
  [[ -f "$f" ]] || continue
  if grep -q 'CLAUDE_PLUGIN_ROOT}/scripts' "$f"; then
    echo "FAIL: $s still references \${CLAUDE_PLUGIN_ROOT}/scripts"; fail=1
  else echo "ok: $s scripts refs repaired"; fi
done

# Migrated skills that use backing scripts carry the resolver.
for s in oneshot orchestrate god setup-orchestrate; do
  assert "$s has CATALYST_DEV_SCRIPTS resolver" "grep -q 'CATALYST_DEV_SCRIPTS' '$ROOT/plugins/legacy/skills/$s/SKILL.md'"
done
exit $fail
