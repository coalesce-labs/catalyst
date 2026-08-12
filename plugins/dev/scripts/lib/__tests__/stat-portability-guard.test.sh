#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
failures=0
command -v rg >/dev/null 2>&1 || {
  echo "FAIL: ripgrep is required by stat-portability-guard" >&2
  exit 1
}
while IFS=: read -r file line text; do
  case "$text" in *'#'*) continue;; esac
  case "$file" in
    plugins/dev/scripts/lib/portable-stat.sh|plugins/dev/scripts/lib/__tests__/helpers/gnu-stat-stub.sh) continue ;;
    plugins/dev/scripts/phase-agent-watch-bg|plugins/dev/scripts/__tests__/catalyst-execution-core.test.sh|plugins/dev/scripts/__tests__/setup-linear-webhook.test.sh) continue ;;
    plugins/dev/scripts/create-worktree.sh|plugins/dev/scripts/orphan-sweep.sh) continue ;;
    plugins/dev/skills/linearis/SKILL.md|plugins/dev/skills/morning-briefing/SKILL.md) continue ;;
  esac
  printf 'unguarded stat dialect probe: %s:%s:%s\n' "$file" "$line" "$text" >&2
  failures=$((failures + 1))
done < <(cd "$ROOT" && rg -n '\bstat\s+-[cf]\b' --glob '!thoughts/**' --glob '!node_modules/**')
[[ "$failures" -eq 0 ]]
echo "stat-portability-guard: PASS"
