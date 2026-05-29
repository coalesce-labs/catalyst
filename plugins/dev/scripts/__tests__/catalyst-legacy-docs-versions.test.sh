#!/usr/bin/env bash
# catalyst-legacy-docs-versions.test.sh (CTL-726)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
fail=0; assert(){ if ! eval "$2"; then echo "FAIL: $1"; fail=1; else echo "ok: $1"; fi; }

assert "dev bumped to 11.0.0"      "grep -qx '11.0.0' '$ROOT/plugins/dev/version.txt'"
assert "dev plugin.json 11.0.0"    "jq -e '.version==\"11.0.0\"' '$ROOT/plugins/dev/.claude-plugin/plugin.json' >/dev/null"
assert "dev README drops oneshot"  "! grep -qE '^\|?[[:space:]]*\[?oneshot' '$ROOT/plugins/dev/README.md' || grep -qi 'moved\|legacy' '$ROOT/plugins/dev/README.md'"
assert "legacy README lists skills" "grep -q 'orchestrate' '$ROOT/plugins/legacy/README.md'"
exit $fail
