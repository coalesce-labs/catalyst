#!/usr/bin/env bash
# catalyst-legacy-plugin.test.sh — scaffold + marketplace registration (CTL-726)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
fail=0
assert() { if ! eval "$2"; then echo "FAIL: $1"; fail=1; else echo "ok: $1"; fi; }

assert "plugin.json exists"        "test -f '$ROOT/plugins/legacy/.claude-plugin/plugin.json'"
assert "name is catalyst-legacy"   "jq -e '.name==\"catalyst-legacy\"' '$ROOT/plugins/legacy/.claude-plugin/plugin.json' >/dev/null"
assert "version 1.0.0"             "jq -e '.version==\"1.0.0\"' '$ROOT/plugins/legacy/.claude-plugin/plugin.json' >/dev/null"
assert "version.txt = 1.0.0"       "grep -qx '1.0.0' '$ROOT/plugins/legacy/version.txt'"
assert "README exists"             "test -f '$ROOT/plugins/legacy/README.md'"
assert "CHANGELOG exists"          "test -f '$ROOT/plugins/legacy/CHANGELOG.md'"
assert "registered in marketplace" "jq -e '[.plugins[].name]|index(\"catalyst-legacy\")' '$ROOT/.claude-plugin/marketplace.json' >/dev/null"
assert "marketplace source path"   "jq -e '.plugins[]|select(.name==\"catalyst-legacy\")|.source==\"./plugins/legacy\"' '$ROOT/.claude-plugin/marketplace.json' >/dev/null"
assert "check-plugin-version knows legacy" "grep -qE 'PLUGINS=\([^)]*\"legacy\"' '$ROOT/scripts/check-plugin-version.sh'"
exit $fail
