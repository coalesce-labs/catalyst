#!/usr/bin/env bash
# check-plugin-version.test.sh — CTL-2266's monotonicity assertion.
#
# scripts/check-plugin-version.sh's pre-existing gate only asks "did plugin
# files change without a version bump" — a conventional-commit message makes
# THAT gate pass with no bump at all, by design (docs/releases.md). This suite
# covers a different, previously-unguarded failure: two lanes independently
# bumping the SAME plugin to the SAME (or a lower) target version relative to
# the current base. A raw git merge of that case is CLEAN (no conflict marker),
# so nothing before this caught it — and it is exactly the shape the catalyst
# Mergify queue's serial re-run against $BASE_REF is supposed to surface.
#
# Every case below simulates the queue's actual mechanism: BASE_REF is a branch
# that has ADVANCED past the PR's fork point (three-dot diff / merge-base
# semantics), not a same-branch two-tree comparison — a same-branch comparison
# would make the collision case textually indistinguishable from an ordinary
# unbumped PR, which is precisely the trap this guard exists to avoid.
#
# Run: bash scripts/__tests__/check-plugin-version.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBJECT="$SCRIPT_DIR/../check-plugin-version.sh"

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

git_q() { git -C "$1" -c user.email=t@t -c user.name=T "${@:2}" >/dev/null 2>&1; }

# seed_plugin <repo> <plugin-dir> <version> — writes version.txt + both
# plugin.json manifests, all agreeing at <version>, plus one functional file
# so the plugin has real content to diff against later.
seed_plugin() {
	local root="$1" dir="$2" version="$3"
	mkdir -p "$root/$dir/.claude-plugin" "$root/$dir/.codex-plugin" "$root/$dir/scripts"
	printf '%s\n' "$version" >"$root/$dir/version.txt"
	printf '{"name":"fake","version":"%s"}\n' "$version" >"$root/$dir/.claude-plugin/plugin.json"
	printf '{"name":"fake","version":"%s"}\n' "$version" >"$root/$dir/.codex-plugin/plugin.json"
	echo "echo hi" >"$root/$dir/scripts/foo.sh"
}

# make_repo — a fresh repo with one roster plugin (plugins/fake) at 12.66.3,
# committed on main.
make_repo() {
	local root="$1"
	mkdir -p "$root"
	git_q "$root" init -b main
	printf '{"packages":{"plugins/fake":{"component":"fake"}}}\n' >"$root/release-please-config.json"
	seed_plugin "$root" "plugins/fake" "12.66.3"
	git_q "$root" add -A
	git_q "$root" commit -m "chore: seed"
	echo "$root"
}

run_check() {
	local root="$1" base_ref="$2"
	( cd "$root" && BASE_REF="$base_ref" STRICT_VERSION_CHECK=true bash "$SUBJECT" 2>&1 )
}

echo "check-plugin-version monotonicity tests"

# ── (a) strictly greater than base → pass ───────────────────────────────────
R=$(make_repo "$SCRATCH/a")
git_q "$R" checkout -b pr-a
seed_plugin "$R" "plugins/fake" "13.0.0"
echo "changed" >>"$R/plugins/fake/scripts/foo.sh"
git_q "$R" add -A
git_q "$R" commit -m "feat(fake): bump to 13.0.0"
OUT=$(run_check "$R" main)
RC=$?
if [[ "$RC" -eq 0 ]]; then
	pass "(a) strictly-greater bump exits 0"
else
	fail "(a) strictly-greater bump exits 0" "rc=$RC" "$OUT"
fi

# ── (b) equal to (current) base while plugin files changed → fail ──────────
# The real collision: pr-b forks at 12.66.3 and bumps to 13.0.0, but by the
# time this check runs, main has ALREADY advanced to 13.0.0 too (simulating
# "the other lane already merged"). pr-b's own diff (three-dot, against its
# fork point) still shows version.txt changing 12.66.3 -> 13.0.0 — but its
# CURRENT value is no longer greater than $BASE_REF's CURRENT value.
R=$(make_repo "$SCRATCH/b")
git_q "$R" checkout -b pr-b
seed_plugin "$R" "plugins/fake" "13.0.0"
git_q "$R" add -A
git_q "$R" commit -m "feat(fake): bump to 13.0.0"
git_q "$R" checkout main
seed_plugin "$R" "plugins/fake" "13.0.0"
git_q "$R" add -A
git_q "$R" commit -m "feat(fake): bump to 13.0.0 (other lane)"
git_q "$R" checkout pr-b
OUT=$(run_check "$R" main)
RC=$?
if [[ "$RC" -ne 0 ]]; then
	pass "(b) collision (equal to advanced base) fails"
else
	fail "(b) collision (equal to advanced base) fails" "rc=$RC (expected non-zero)" "$OUT"
fi
if printf '%s' "$OUT" | grep -qi "not strictly greater"; then
	pass "(b) failure message names the monotonicity violation"
else
	fail "(b) failure message names the monotonicity violation" "$OUT"
fi

# ── (c) lower than (current) base → fail ────────────────────────────────────
# pr-c forks at 12.66.3 and bumps to 12.67.0 (a real, valid-looking bump from
# ITS OWN base) — but the other lane already pushed main to 13.0.0, so pr-c's
# target is now BEHIND current base, not just equal to it.
R=$(make_repo "$SCRATCH/c")
git_q "$R" checkout -b pr-c
seed_plugin "$R" "plugins/fake" "12.67.0"
git_q "$R" add -A
git_q "$R" commit -m "fix(fake): bump to 12.67.0"
git_q "$R" checkout main
seed_plugin "$R" "plugins/fake" "13.0.0"
git_q "$R" add -A
git_q "$R" commit -m "feat(fake): bump to 13.0.0 (other lane)"
git_q "$R" checkout pr-c
OUT=$(run_check "$R" main)
RC=$?
if [[ "$RC" -ne 0 ]]; then
	pass "(c) lower-than-base bump fails"
else
	fail "(c) lower-than-base bump fails" "rc=$RC (expected non-zero)" "$OUT"
fi

# ── (d) version.txt vs plugin.json disagreement → fail ──────────────────────
# version.txt and .claude-plugin/plugin.json move to 13.0.0; .codex-plugin/
# plugin.json is left behind at 12.66.3. Monotonicity itself is satisfied —
# this must fail on the manifest-agreement check specifically.
R=$(make_repo "$SCRATCH/d")
git_q "$R" checkout -b pr-d
printf '13.0.0\n' >"$R/plugins/fake/version.txt"
printf '{"name":"fake","version":"13.0.0"}\n' >"$R/plugins/fake/.claude-plugin/plugin.json"
# .codex-plugin/plugin.json intentionally left at 12.66.3.
git_q "$R" add -A
git_q "$R" commit -m "feat(fake): bump to 13.0.0 (codex manifest missed)"
OUT=$(run_check "$R" main)
RC=$?
if [[ "$RC" -ne 0 ]]; then
	pass "(d) version.txt/plugin.json disagreement fails"
else
	fail "(d) version.txt/plugin.json disagreement fails" "rc=$RC (expected non-zero)" "$OUT"
fi
if printf '%s' "$OUT" | grep -qi "does not match version.txt"; then
	pass "(d) failure message names the manifest disagreement"
else
	fail "(d) failure message names the manifest disagreement" "$OUT"
fi

# ── (e) no version change at all → existing behaviour unchanged ────────────
# A routine conventional-commit PR that touches the plugin but never touches
# version.txt must keep passing via the pre-existing escape hatch — the new
# guard must not fire just because the plugin changed.
R=$(make_repo "$SCRATCH/e")
git_q "$R" checkout -b pr-e
echo "echo changed" >>"$R/plugins/fake/scripts/foo.sh"
git_q "$R" add -A
git_q "$R" commit -m "fix(fake): unrelated fix, no version bump"
OUT=$(run_check "$R" main)
RC=$?
if [[ "$RC" -eq 0 ]]; then
	pass "(e) no version change: conventional-commit escape hatch still passes"
else
	fail "(e) no version change: conventional-commit escape hatch still passes" "rc=$RC" "$OUT"
fi
if printf '%s' "$OUT" | grep -qi "passing without a version bump"; then
	pass "(e) existing escape-hatch message still prints"
else
	fail "(e) existing escape-hatch message still prints" "$OUT"
fi

# ── (e2) no version change, non-conventional commit → existing STRICT failure unchanged ──
R=$(make_repo "$SCRATCH/e2")
git_q "$R" checkout -b pr-e2
echo "echo changed" >>"$R/plugins/fake/scripts/foo.sh"
git_q "$R" add -A
git_q "$R" commit -m "unrelated fix, no conventional prefix, no version bump"
OUT=$(run_check "$R" main)
RC=$?
if [[ "$RC" -ne 0 ]]; then
	pass "(e2) no version change + non-conventional commit still fails (pre-existing gate)"
else
	fail "(e2) no version change + non-conventional commit still fails (pre-existing gate)" "rc=$RC (expected non-zero)" "$OUT"
fi

# ── (f) a roster plugin dir absent on disk → unchanged (skipped, not errored) ──
R=$(make_repo "$SCRATCH/f")
python3 - "$R/release-please-config.json" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as fh:
	data = json.load(fh)
data["packages"]["plugins/ghost"] = {"component": "ghost"}
with open(path, "w") as fh:
	json.dump(data, fh)
PY
git_q "$R" add -A
git_q "$R" commit -m "chore: add ghost plugin to roster (no directory)"
git_q "$R" checkout -b pr-f
seed_plugin "$R" "plugins/fake" "13.0.0"
git_q "$R" add -A
git_q "$R" commit -m "feat(fake): bump to 13.0.0"
OUT=$(run_check "$R" main)
RC=$?
if [[ "$RC" -eq 0 ]]; then
	pass "(f) roster plugin absent on disk does not error the run"
else
	fail "(f) roster plugin absent on disk does not error the run" "rc=$RC" "$OUT"
fi

# ── (g) base cannot be read (brand-new plugin) → fail closed ────────────────
# plugins/newthing exists ONLY on pr-g, so `git show main:.../version.txt`
# cannot resolve it. "Could not look" must render as a failure, never a pass.
R=$(make_repo "$SCRATCH/g")
git_q "$R" checkout -b pr-g
python3 - "$R/release-please-config.json" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as fh:
	data = json.load(fh)
data["packages"]["plugins/newthing"] = {"component": "newthing"}
with open(path, "w") as fh:
	json.dump(data, fh)
PY
seed_plugin "$R" "plugins/newthing" "1.0.0"
git_q "$R" add -A
git_q "$R" commit -m "feat(newthing): introduce new plugin at 1.0.0"
OUT=$(run_check "$R" main)
RC=$?
if [[ "$RC" -ne 0 ]]; then
	pass "(g) unreadable base version fails closed"
else
	fail "(g) unreadable base version fails closed" "rc=$RC (expected non-zero)" "$OUT"
fi
if printf '%s' "$OUT" | grep -qi "could not read version.txt"; then
	pass "(g) failure message distinguishes 'could not look' from 'no collision'"
else
	fail "(g) failure message distinguishes 'could not look' from 'no collision'" "$OUT"
fi

echo ""
echo "  PASSED: $PASSES   FAILED: $FAILURES"
[[ $FAILURES -eq 0 ]]
