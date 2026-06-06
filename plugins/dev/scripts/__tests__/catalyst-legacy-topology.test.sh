#!/usr/bin/env bash
# catalyst-legacy-topology.test.sh
# Asserts the post-reorg plugin topology (supersedes the CTL-726 redirect-stub model):
#   - The 4 wave-orchestration skills live ONLY in catalyst-legacy (no dev stub).
#   - iterate-plan + briefing-followup are full skills back in catalyst-dev
#     (general workflow skills, not wave-orchestration; their redirect stubs are gone).
#   - The orchestrate dispatch default still targets the legacy oneshot.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
fail=0; assert(){ if ! eval "$2"; then echo "FAIL: $1"; fail=1; else echo "ok: $1"; fi; }

# 1. Wave skills live only in legacy — present there, absent from dev (no stub).
LEGACY_ONLY=(oneshot orchestrate god setup-orchestrate)
for s in "${LEGACY_ONLY[@]}"; do
  assert "$s present in legacy"      "test -f '$ROOT/plugins/legacy/skills/$s/SKILL.md'"
  assert "$s absent from dev"        "! test -e '$ROOT/plugins/dev/skills/$s'"
done

# 2. iterate-plan + briefing-followup are full skills back in dev, absent from legacy.
DEV_BACK=(iterate-plan briefing-followup)
for s in "${DEV_BACK[@]}"; do
  f="$ROOT/plugins/dev/skills/$s/SKILL.md"
  assert "$s present in dev"         "test -f '$f'"
  assert "$s absent from legacy"     "! test -e '$ROOT/plugins/legacy/skills/$s'"
  assert "$s is a full skill (>60 lines, not a redirect stub)" "[ \$(wc -l < '$f') -gt 60 ]"
  assert "$s is not a [MOVED] stub"  "! grep -q '\\[MOVED\\]' '$f'"
  # Back in dev, they resolve scripts in-plugin — not via the cross-plugin cache shim.
  assert "$s does not use CATALYST_DEV_SCRIPTS cache shim" "! grep -q 'CATALYST_DEV_SCRIPTS' '$f'"
done

# 3. Dispatch default still points at the legacy oneshot.
assert "dispatch default repointed to legacy oneshot" \
  "grep -q 'WORKER_COMMAND=\"/catalyst-legacy:oneshot\"' '$ROOT/plugins/dev/scripts/orchestrate-dispatch-next'"

exit $fail
