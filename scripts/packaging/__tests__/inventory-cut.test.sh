#!/usr/bin/env bash
# inventory-cut.test.sh — CTL-1461 Phase 7: the simulated-cut rehearsal.
#
# Run: bash scripts/packaging/__tests__/inventory-cut.test.sh
#
# Rehearses CTL-2218's plugin-deletion cut against a small SYNTHETIC
# multi-plugin scratch repo (never the live worktree): deleting a plugin
# directory together with its release-please-config.json entry must render
# cleanly and sweep the orphaned generated output; deleting only one side of
# that pair must fail loudly with a named, actionable error — never a bare
# TypeError, never a silent skip.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PASSES=0
FAILURES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH:?}"' EXIT

pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	shift
	for l in "$@"; do echo "      $l"; done
}

ROOT="$SCRATCH/repo"
mkdir -p "$ROOT/scripts"
cp -R "$REPO_ROOT/scripts/packaging" "$ROOT/scripts/packaging"
rm -rf "$ROOT/scripts/packaging/dist" "$ROOT/scripts/packaging/__tests__" "$ROOT/scripts/packaging/fixtures"

# build_plugin NAME → a minimal synthetic plugin with one sidecar-bearing skill.
build_plugin() {
	local name="$1"
	local dir="$ROOT/plugins/$name"
	mkdir -p "$dir/.claude-plugin" "$dir/skills/only-skill/agents"
	cat >"$dir/.claude-plugin/plugin.json" <<EOF
{
  "name": "fixture-$name",
  "version": "0.0.1",
  "description": "Synthetic fixture plugin $name.",
  "author": { "name": "Fixture", "email": "fixture@example.com" },
  "homepage": "https://example.com",
  "repository": "https://example.com/fixture.git",
  "keywords": ["fixture"],
  "license": "MIT"
}
EOF
	cat >"$dir/pack.json" <<EOF
{
  "packId": "fixture-$name",
  "identity": {
    "description": "Synthetic fixture plugin $name.",
    "author": { "name": "Fixture", "email": "fixture@example.com" },
    "homepage": "https://example.com",
    "repository": "https://example.com/fixture.git",
    "keywords": ["fixture"],
    "license": "MIT"
  },
  "distribution": {
    "claude": { "enabled": true, "marketplace": { "description": "Fixture $name", "category": "development", "keywords": ["fixture"] } },
    "codex": { "enabled": true },
    "agentsSkills": { "enabled": true }
  }
}
EOF
	cat >"$dir/skills/only-skill/SKILL.md" <<EOF
---
name: only-skill
description: The only skill in fixture plugin $name.
---

# Only Skill

Fixture body for $name.
EOF
	cat >"$dir/skills/only-skill/agents/portability.yaml" <<EOF
effects: []
invocation: auto
exposure: ["catalog"]
EOF
}

build_plugin plugin-a
build_plugin plugin-b
build_plugin plugin-c

write_config() {
	# $@ is the list of plugin names still in release-please-config.json
	{
		echo '{'
		echo '  "packages": {'
		local n=$#
		local i=0
		for name in "$@"; do
			i=$((i + 1))
			comma=","
			[[ $i -eq $n ]] && comma=""
			cat <<EOF
    "plugins/$name": {
      "release-type": "simple",
      "component": "fixture-$name"
    }$comma
EOF
		done
		echo '  }'
		echo '}'
	} >"$ROOT/release-please-config.json"
}

write_config plugin-a plugin-b plugin-c

RENDER_LOG="$SCRATCH/render.log"
render() {
	(cd "$ROOT" && bun scripts/packaging/cli.mjs render --write --allow-losses) >"$RENDER_LOG" 2>&1
}

echo "=== Bootstrap: all three plugins agree with config — render succeeds ==="
if render; then
	pass "bootstrap render succeeds with all three plugins agreeing"
else
	fail "bootstrap render should succeed" "$(cat "$RENDER_LOG")"
fi

git -C "$ROOT" init -q
git -C "$ROOT" config user.name fixture
git -C "$ROOT" config user.email fixture@example.com
echo "scripts/packaging/dist/" >"$ROOT/.gitignore"
git -C "$ROOT" add -A
git -C "$ROOT" commit -qm baseline

STRAY_BUNDLE="$ROOT/.agents/skills/fixture-plugin-b-only-skill"
if [[ -d "$STRAY_BUNDLE" ]]; then
	pass "plugin-b's flat bundle exists before the cut (positive control on the sweep test below)"
else
	fail "plugin-b's flat bundle should exist before the cut" "$(ls "$ROOT/.agents/skills" 2>&1)"
fi

echo ""
echo "=== The agreeing cut: delete plugin-b's directory AND its config entry together — render succeeds and sweeps the orphan ==="
rm -rf "$ROOT/plugins/plugin-b"
write_config plugin-a plugin-c
if render; then
	pass "render succeeds after an agreeing deletion (dir + config entry removed together)"
else
	fail "render should succeed after an agreeing deletion" "$(cat "$RENDER_LOG")"
fi

if [[ ! -d "$STRAY_BUNDLE" ]]; then
	pass "the orphaned .agents/skills/ bundle for the deleted plugin was swept"
else
	fail "the orphaned .agents/skills/ bundle should have been swept"
fi

if [[ ! -d "$ROOT/.codex-plugin" ]] && [[ ! -e "$ROOT/plugins/plugin-b" ]]; then
	pass "plugin-b's own .codex-plugin/ vanished with its directory (nothing to sweep separately)"
else
	fail "plugin-b's directory should be gone entirely"
fi

git -C "$ROOT" add -A
git -C "$ROOT" commit -qm "cut plugin-b"

echo ""
echo "=== A subsequent drift check on the post-cut tree is clean ==="
if render && git -C "$ROOT" diff --exit-code >/dev/null 2>&1 && [[ -z "$(git -C "$ROOT" status --porcelain)" ]]; then
	pass "re-rendering the post-cut tree produces zero drift"
else
	fail "re-rendering the post-cut tree should produce zero drift" "$(git -C "$ROOT" status --porcelain)"
fi

echo ""
echo "=== Disagreement direction 1: config lists a plugin absent from disk — named error, non-zero exit ==="
rm -rf "$ROOT/plugins/plugin-c"
# config still lists plugin-c (write_config plugin-a plugin-c from the commit above)
if ! render && grep -q 'release-please-config.json lists "plugins/plugin-c" but no plugin exists there' "$RENDER_LOG"; then
	pass "config-lists-but-disk-missing produces the named error and a non-zero exit"
else
	fail "config-lists-but-disk-missing should produce the named error" "$(cat "$RENDER_LOG")"
fi
git -C "$ROOT" checkout -q -- .
git -C "$ROOT" clean -qfd

echo ""
echo "=== Disagreement direction 2: a plugin on disk has no config entry — named error, non-zero exit ==="
write_config plugin-a
if ! render && grep -q 'has a pack.json but no release-please-config.json entry' "$RENDER_LOG"; then
	pass "disk-has-plugin-but-config-missing produces the named error and a non-zero exit"
else
	fail "disk-has-plugin-but-config-missing should produce the named error" "$(cat "$RENDER_LOG")"
fi
git -C "$ROOT" checkout -q -- .
git -C "$ROOT" clean -qfd

echo ""
echo "=== Negative control: the restored agreeing state renders cleanly again ==="
if render && git -C "$ROOT" diff --exit-code >/dev/null 2>&1 && [[ -z "$(git -C "$ROOT" status --porcelain)" ]]; then
	pass "the restored, agreeing baseline still renders with zero drift"
else
	fail "the restored, agreeing baseline should render with zero drift" "$(cat "$RENDER_LOG")" "$(git -C "$ROOT" status --porcelain)"
fi

echo ""
echo "=== $PASSES passed, $FAILURES failed ==="
[[ $FAILURES -eq 0 ]]
