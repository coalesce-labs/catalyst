#!/usr/bin/env bash
# catalyst-legacy-redirects.test.sh (CTL-726)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SKILLS=(oneshot orchestrate god setup-orchestrate briefing-followup iterate-plan)
fail=0; assert(){ if ! eval "$2"; then echo "FAIL: $1"; fail=1; else echo "ok: $1"; fi; }

for s in "${SKILLS[@]}"; do
  f="$ROOT/plugins/dev/skills/$s/SKILL.md"
  assert "$s stub exists"                "test -f '$f'"
  assert "$s stub disables model invoke" "grep -q 'disable-model-invocation: true' '$f'"
  assert "$s stub points to legacy"      "grep -q '/catalyst-legacy:$s' '$f'"
  assert "$s stub is thin (<60 lines)"   "[ \$(wc -l < '$f') -lt 60 ]"
done

assert "dispatch default repointed" "grep -q 'WORKER_COMMAND=\"/catalyst-legacy:oneshot\"' '$ROOT/plugins/dev/scripts/orchestrate-dispatch-next'"
exit $fail
