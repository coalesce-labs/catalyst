#!/usr/bin/env bash
# catalyst-legacy-docs-versions.test.sh (CTL-726)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
fail=0; assert(){ if ! eval "$2"; then echo "FAIL: $1"; fail=1; else echo "ok: $1"; fi; }

# Version numbers are owned by release-please (bumped only in `chore: release main`
# commits), so we assert internal consistency + that the breaking move is recorded,
# rather than pinning an exact future version this branch must not hand-edit.
assert "dev version.txt/plugin.json agree" "[ \"\$(grep -m1 -oE '[0-9]+\\.[0-9]+\\.[0-9]+' '$ROOT/plugins/dev/version.txt')\" = \"\$(jq -r '.version' '$ROOT/plugins/dev/.claude-plugin/plugin.json')\" ]"
assert "breaking skill-move recorded"      "grep -qiE 'wave-based orchestration skills (migrated|removed|moved)' '$ROOT/plugins/legacy/CHANGELOG.md'"
assert "dev README drops oneshot"  "! grep -qE '^\|?[[:space:]]*\[?oneshot' '$ROOT/plugins/dev/README.md' || grep -qi 'moved\|legacy' '$ROOT/plugins/dev/README.md'"
assert "legacy README lists skills" "grep -q 'orchestrate' '$ROOT/plugins/legacy/README.md'"
exit $fail
