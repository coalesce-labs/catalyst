#!/usr/bin/env bash
# skills-cli-install.test.sh — CTL-2215 Phase 5: install-verification harness
# for the agentsSkills portable pack, against the REAL `skills` CLI.
#
# Run: bash scripts/packaging/__tests__/skills-cli-install.test.sh
#
# Two things this proves that the conformance grader (agentskills-spec.mjs)
# structurally cannot: that the real `skills@1.5.23` CLI actually discovers
# and installs the emitted tree, and that a malformed skill is rejected by
# the CLI itself, not merely by our own grader. It reads the already-
# regenerated `.agents/skills/` tree on disk (this harness runs after the
# conformance step in packaging-gate.yml, which runs after regeneration) and
# never mutates it — every install happens against scratch copies.
#
# ⚠️ NEVER run a project-scope `skills add` with cwd inside this repository.
# Codex/OpenCode's project scope is `.agents/skills/`, which is this
# emitter's own output directory and is policed by the drift gate; a harness
# that installed there would produce a drift failure attributed to the wrong
# cause. Every scratch directory this script creates is asserted (not just
# assumed) to resolve outside the repo before it is used as an install cwd —
# see refuse_if_inside_repo below — so the guard cannot silently rot if
# TMPDIR is ever misconfigured to point inside the checkout.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SKILLS_CLI="skills@1.5.23" # pinned so a CI run's meaning does not change under us

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

resolve_dir() {
	(cd "$1" 2>/dev/null && pwd -P)
}

REPO_ROOT_RESOLVED="$(resolve_dir "$REPO_ROOT")"

refuse_if_inside_repo() {
	local dir="$1" label="$2" resolved
	resolved="$(resolve_dir "$dir")"
	if [[ -z "$resolved" ]]; then
		echo "REFUSING: could not resolve $label ($dir)" >&2
		exit 1
	fi
	case "$resolved" in
	"$REPO_ROOT_RESOLVED" | "$REPO_ROOT_RESOLVED"/*)
		echo "REFUSING: $label ($resolved) resolves inside this repository ($REPO_ROOT_RESOLVED) — a project-scope 'skills add' here would write into .agents/skills/, the emitter's own output, and trip the drift gate." >&2
		exit 1
		;;
	esac
}

refuse_if_inside_repo "$SCRATCH" "the scratch root"

BEFORE_STATUS="$(git -C "$REPO_ROOT" status --porcelain)"

frontmatter_field() {
	local file="$1" field="$2"
	awk -v f="$field" '
    BEGIN { inFm = 0 }
    /^---$/ { inFm++; next }
    inFm == 1 && $0 ~ "^" f ":" {
      sub("^" f ":[ \t]*", "");
      gsub(/^"|"$/, "");
      print;
      exit
    }
  ' "$file"
}

SOURCE_ROOT="$REPO_ROOT/.agents/skills"
if [[ ! -d "$SOURCE_ROOT" ]]; then
	fail "$SOURCE_ROOT must exist — run render --write first" ""
	echo ""
	echo "=== $PASSES passed, $FAILURES failed ==="
	exit 1
fi

# --- expected count comes from the pipeline's own output, never hard-coded ---
CONFORMANCE_LOG="$SCRATCH/conformance-baseline.log"
if ! (cd "$REPO_ROOT" && bun scripts/packaging/cli.mjs conformance --target agentsSkills) >"$CONFORMANCE_LOG" 2>&1; then
	fail "baseline conformance must be clean before running the install harness" "$(cat "$CONFORMANCE_LOG")"
	echo ""
	echo "=== $PASSES passed, $FAILURES failed ==="
	exit 1
fi
EXPECTED_COUNT="$(grep -oE 'checkedCount=[0-9]+' "$CONFORMANCE_LOG" | grep -oE '[0-9]+' || true)"
if [[ -z "$EXPECTED_COUNT" || "$EXPECTED_COUNT" -eq 0 ]]; then
	fail "expected emit count must be a positive integer read from conformance output" "$(cat "$CONFORMANCE_LOG")"
	echo ""
	echo "=== $PASSES passed, $FAILURES failed ==="
	exit 1
fi

# --- build a scratch source repo laid out as skills/<flatName>/ from the ---
# --- already-regenerated .agents/skills/ tree (never mutated) ---
PACK_SRC="$SCRATCH/pack-source"
mkdir -p "$PACK_SRC/skills"
refuse_if_inside_repo "$PACK_SRC" "the scratch pack-source directory"
declare -a EXPECTED_NAMES=()
for dir in "$SOURCE_ROOT"/*/; do
	flatDir="$(basename "$dir")"
	cp -R "$dir" "$PACK_SRC/skills/$flatDir"
	name="$(frontmatter_field "$dir/SKILL.md" name)"
	if [[ -z "$name" ]]; then
		fail "source skill $flatDir must carry a frontmatter name" ""
		continue
	fi
	EXPECTED_NAMES+=("$name")
done

# --- --list finds exactly the emitted count ---
LIST_LOG="$SCRATCH/list.log"
LIST_PROJ="$SCRATCH/list-project"
mkdir -p "$LIST_PROJ"
refuse_if_inside_repo "$LIST_PROJ" "the scratch --list project directory"
if (cd "$LIST_PROJ" && DO_NOT_TRACK=1 npx --yes "$SKILLS_CLI" add "$PACK_SRC" --list) 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' >"$LIST_LOG"; then
	if grep -q "Found ${EXPECTED_COUNT} skills" "$LIST_LOG"; then
		pass "--list finds exactly the emitted count ($EXPECTED_COUNT), read from conformance's own checkedCount"
	else
		fail "--list should report Found ${EXPECTED_COUNT} skills" "$(cat "$LIST_LOG")"
	fi
else
	fail "--list should exit 0 against a conformant pack" "$(cat "$LIST_LOG")"
fi

# --- project-scope install for claude-code, codex, opencode ---
INSTALL_LOG="$SCRATCH/install.log"
INSTALL_PROJ="$SCRATCH/install-project"
mkdir -p "$INSTALL_PROJ"
refuse_if_inside_repo "$INSTALL_PROJ" "the scratch project-scope install directory"
if (cd "$INSTALL_PROJ" && DO_NOT_TRACK=1 npx --yes "$SKILLS_CLI" add "$PACK_SRC" --skill '*' -a claude-code -a codex -a opencode -y) 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' >"$INSTALL_LOG"; then
	pass "project-scope install for claude-code/codex/opencode exits 0"
else
	fail "project-scope install should exit 0" "$(cat "$INSTALL_LOG")"
fi

for name in "${EXPECTED_NAMES[@]}"; do
	installed="$INSTALL_PROJ/.agents/skills/$name/SKILL.md"
	symlink="$INSTALL_PROJ/.claude/skills/$name"
	if [[ -f "$installed" ]]; then
		pass "$name installs to .agents/skills/$name/SKILL.md"
	else
		fail "$name should install to .agents/skills/$name/SKILL.md" "$(cat "$INSTALL_LOG")"
		continue
	fi
	if [[ -L "$symlink" ]]; then
		resolved_symlink="$(resolve_dir "$symlink")"
		resolved_installed="$(resolve_dir "$(dirname "$installed")")"
		if [[ -n "$resolved_symlink" && "$resolved_symlink" == "$resolved_installed" ]]; then
			pass "$name's .claude/skills symlink resolves into .agents/skills/$name"
		else
			fail "$name's .claude/skills symlink should resolve into .agents/skills/$name" "resolved to: $resolved_symlink"
		fi
	else
		fail "$name should have a .claude/skills/$name symlink" "$(cat "$INSTALL_LOG")"
	fi

	# byte fidelity against the original source
	flatDir=""
	for dir in "$SOURCE_ROOT"/*/; do
		candidate="$(basename "$dir")"
		if [[ "$(frontmatter_field "$dir/SKILL.md" name)" == "$name" ]]; then
			flatDir="$candidate"
			break
		fi
	done
	if [[ -n "$flatDir" ]] && diff -q "$SOURCE_ROOT/$flatDir/SKILL.md" "$installed" >/dev/null 2>&1; then
		pass "$name's installed SKILL.md is byte-identical to the source"
	else
		fail "$name's installed SKILL.md should be byte-identical to the source" ""
	fi
done

# --- global scope: lands in ~/.agents/skills/, NOT ~/.codex or ~/.config/opencode ---
GLOBAL_HOME="$SCRATCH/global-home"
GLOBAL_PROJ="$SCRATCH/global-home/proj"
mkdir -p "$GLOBAL_PROJ"
refuse_if_inside_repo "$GLOBAL_HOME" "the scratch global-scope HOME"
GLOBAL_LOG="$SCRATCH/global-install.log"
if (cd "$GLOBAL_PROJ" && DO_NOT_TRACK=1 HOME="$GLOBAL_HOME" npx --yes "$SKILLS_CLI" add "$PACK_SRC" --skill '*' -g -a codex -a opencode -y) 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' >"$GLOBAL_LOG"; then
	pass "global-scope install for codex/opencode exits 0"
else
	fail "global-scope install should exit 0" "$(cat "$GLOBAL_LOG")"
fi
if [[ -d "$GLOBAL_HOME/.agents/skills" ]] && [[ "$(find "$GLOBAL_HOME/.agents/skills" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" -eq "$EXPECTED_COUNT" ]]; then
	pass "global scope lands in ~/.agents/skills/ with all $EXPECTED_COUNT skills"
else
	fail "global scope should populate ~/.agents/skills/ with $EXPECTED_COUNT skills" "$(cat "$GLOBAL_LOG")"
fi
# Recording observed behavior, not asserting a design goal: as of skills@1.5.23,
# getAgentBaseDir short-circuits universal agents to the canonical directory, so
# neither agent-specific global directory is ever created. If a future CLI
# version starts writing them, this assertion fails and tells us the behavior
# changed.
if [[ ! -d "$GLOBAL_HOME/.codex" ]]; then
	pass "global scope does NOT create ~/.codex (observed CLI behavior, not this repo's choice)"
else
	fail "global scope was observed creating ~/.codex — the CLI's behavior has changed, update docs/skill-authoring install guides" ""
fi
if [[ ! -d "$GLOBAL_HOME/.config/opencode" ]]; then
	pass "global scope does NOT create ~/.config/opencode (observed CLI behavior, not this repo's choice)"
else
	fail "global scope was observed creating ~/.config/opencode — the CLI's behavior has changed, update docs/skill-authoring install guides" ""
fi

# --- positive control: a malformed fixture (missing description) must be ---
# --- reported as skipped and must NOT install ---
BAD_SRC="$SCRATCH/bad-pack-source"
mkdir -p "$BAD_SRC/skills/broken-skill"
refuse_if_inside_repo "$BAD_SRC" "the scratch malformed-fixture source"
cat >"$BAD_SRC/skills/broken-skill/SKILL.md" <<'SKILLEOF'
---
name: broken-skill
---

# Broken Skill (deliberately missing description — CTL-2215 Phase 5 positive control)
SKILLEOF
BAD_PROJ="$SCRATCH/bad-project"
mkdir -p "$BAD_PROJ"
refuse_if_inside_repo "$BAD_PROJ" "the scratch malformed-fixture project"
BAD_LOG="$SCRATCH/bad-install.log"
if (cd "$BAD_PROJ" && DO_NOT_TRACK=1 npx --yes "$SKILLS_CLI" add "$BAD_SRC" --skill '*' -a claude-code -y) 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' >"$BAD_LOG"; then
	fail "a malformed skill (missing description) must not install cleanly" "$(cat "$BAD_LOG")"
else
	if grep -qi "missing required frontmatter field" "$BAD_LOG" && [[ ! -e "$BAD_PROJ/.claude/skills/broken-skill" ]]; then
		pass "malformed skill is skipped by the real CLI (missing description) and does not install — positive control holds"
	else
		fail "malformed skill should be skipped with a named reason and no install directory" "$(cat "$BAD_LOG")"
	fi
fi

AFTER_STATUS="$(git -C "$REPO_ROOT" status --porcelain)"
if [[ "$BEFORE_STATUS" == "$AFTER_STATUS" ]]; then
	pass "git status --porcelain unchanged — the harness left the worktree alone"
else
	fail "git status --porcelain changed while the harness ran — it must never touch the real worktree" "before: $BEFORE_STATUS" "after: $AFTER_STATUS"
fi

echo ""
echo "=== $PASSES passed, $FAILURES failed ==="
[[ $FAILURES -eq 0 ]]
