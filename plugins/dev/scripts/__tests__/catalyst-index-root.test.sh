#!/usr/bin/env bash
# catalyst-index-root.test.sh — CTL-1935. The pinned serving root for catalyst-index.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBJECT="$SCRIPT_DIR/../catalyst-index-root"

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

# A stand-in "catalyst-cloud": two commits, and the probe symbol arrives in the SECOND. That
# ordering is the whole point — it lets the two halves of the check disagree, which is the case
# the ticket exists for and which a single-commit fixture cannot produce.
UP="$SCRATCH/upstream"
mkdir -p "$UP/apps/context-engine/src/wiki"
git_q "$UP" init -b main
echo "export const OLD = 1;" >"$UP/apps/context-engine/src/wiki/llm.ts"
git_q "$UP" add -A
git_q "$UP" commit -m old
OLD_SHA="$(git -C "$UP" rev-parse HEAD)"
echo 'export const SKIP_CACHE_HEADER = "cf-aig-skip-cache";' >>"$UP/apps/context-engine/src/wiki/llm.ts"
git_q "$UP" add -A
git_q "$UP" commit -m new
NEW_SHA="$(git -C "$UP" rev-parse HEAD)"

write_pin() { # write_pin <sha>
	cat >"$SCRATCH/pin.json" <<EOF
{ "repo": "$UP", "path": "$SCRATCH/root", "sha": "$1",
  "probe": { "file": "apps/context-engine/src/wiki/llm.ts", "symbol": "SKIP_CACHE_HEADER" } }
EOF
}
run() { CATALYST_INDEX_PIN="$SCRATCH/pin.json" bash "$SUBJECT" "$@" 2>&1; }

echo ""
echo "=== setup provisions the root AT the pin ==="
write_pin "$NEW_SHA"
OUT="$(run setup)"
RC=$?
[ "$RC" -eq 0 ] && pass "setup exits 0" || fail "setup exits 0" "rc=$RC: $OUT"
if [ "$(git -C "$SCRATCH/root" rev-parse HEAD 2>/dev/null)" = "$NEW_SHA" ]; then
	pass "the root is checked out at the pinned sha"
else
	fail "the root is checked out at the pinned sha" "$OUT"
fi
run verify >/dev/null 2>&1 && pass "verify passes on a correctly provisioned root" || fail "verify passes on a correctly provisioned root" "$(run verify)"

echo ""
echo "=== setup is idempotent ==="
OUT2="$(run setup)"
[ $? -eq 0 ] && pass "a second setup exits 0" || fail "a second setup exits 0" "$OUT2"

echo ""
echo "--- ⛔ THE CASE THE TICKET IS ABOUT: a STALE root is caught by ANCESTRY ---"
# Move the root back to the older commit. On the real fleet this is 'the operator's checkout is
# 332 commits behind' — the run looks completely normal while missing the fix.
git_q "$SCRATCH/root" checkout --detach "$OLD_SHA"
OUT3="$(run verify)"
RC3=$?
grep -q "FAIL  pinned-head" <<<"$OUT3" && pass "pinned-head FAILS on a stale root" || fail "pinned-head fails on a stale root" "$OUT3"
[ "$RC3" -ne 0 ] && pass "verify exits non-zero on a stale root" || fail "verify exits non-zero on a stale root" "rc=0"
grep -q "FAIL  content" <<<"$OUT3" && pass "content also FAILS here (the symbol arrived in the newer commit)" || fail "content fails here" "$OUT3"

echo ""
echo "--- ⭐ ...and ANCESTRY catches what CONTENT alone would clear ---"
# Measured on the real laptop checkout: 18 commits behind the pin, ancestry FAILED while content
# PASSED, because SKIP_CACHE_HEADER had merged before that HEAD. Either half alone clears a root
# the other condemns, which is why the ticket demands both. Reproduced here: pin to a sha the
# root does not contain, while the probe symbol IS on disk.
git_q "$SCRATCH/root" checkout --detach "$NEW_SHA"
echo "export const LATER = 2;" >>"$UP/apps/context-engine/src/wiki/llm.ts"
git_q "$UP" add -A
git_q "$UP" commit -m later
LATER_SHA="$(git -C "$UP" rev-parse HEAD)"
write_pin "$LATER_SHA"
git -C "$SCRATCH/root" fetch --quiet origin 2>/dev/null
OUT4="$(run verify)"
grep -q "PASS  content" <<<"$OUT4" && pass "content PASSES (the symbol is on disk)" || fail "content passes" "$OUT4"
grep -q "FAIL  pinned-head" <<<"$OUT4" && pass "pinned-head still FAILS — the half that catches this" || fail "pinned-head fails" "$OUT4"

echo ""
echo "--- ⛔ a locally MODIFIED probe file is caught, though both other halves pass ---"
write_pin "$NEW_SHA"
git_q "$SCRATCH/root" checkout --detach "$NEW_SHA"
run verify >/dev/null 2>&1 && pass "control — clean root verifies before the edit" || fail "control — clean root verifies before the edit"
echo "// a local edit nobody reviewed" >>"$SCRATCH/root/apps/context-engine/src/wiki/llm.ts"
OUT5="$(run verify)"
grep -q "FAIL  clean" <<<"$OUT5" && pass "a dirty probe file FAILS the clean check" || fail "a dirty probe file fails the clean check" "$OUT5"
grep -q "PASS  pinned-head" <<<"$OUT5" && pass "…while pinned-head still passes (so 'clean' is the half that caught it)" || fail "pinned-head still passes" "$OUT5"
git_q "$SCRATCH/root" checkout -- apps/context-engine/src/wiki/llm.ts

echo ""
echo "--- ⛔ 'run' REFUSES from an unverified root ---"
git_q "$SCRATCH/root" checkout --detach "$OLD_SHA"
OUT6="$(run run --some-flag)"
RC6=$?
grep -q "refusing to run" <<<"$OUT6" && pass "run refuses on a stale root" || fail "run refuses on a stale root" "$OUT6"
[ "$RC6" -ne 0 ] && pass "run exits non-zero when it refuses" || fail "run exits non-zero when it refuses" "rc=0"

echo ""
echo "--- ⛔ a LINKED WORKTREE is refused as a serving root ---"
# It shares a common dir with someone's working repo: another agent's checkout moves the code
# the indexer runs.
git_q "$UP" worktree add "$SCRATCH/linked" -b wt1
cat >"$SCRATCH/pin-linked.json" <<EOF
{ "repo": "$UP", "path": "$SCRATCH/linked", "sha": "$NEW_SHA",
  "probe": { "file": "apps/context-engine/src/wiki/llm.ts", "symbol": "SKIP_CACHE_HEADER" } }
EOF
OUT7="$(CATALYST_INDEX_PIN="$SCRATCH/pin-linked.json" bash "$SUBJECT" verify 2>&1)"
grep -q "FAIL  standalone" <<<"$OUT7" && pass "a linked worktree is refused" || fail "a linked worktree is refused" "$OUT7"

echo ""
echo "--- ⛔ an abbreviated or branch-name pin is refused ---"
write_pin "${NEW_SHA:0:9}"
OUT8="$(run verify)"
[ $? -eq 2 ] && pass "an abbreviated sha is refused (rc 2)" || fail "an abbreviated sha is refused (rc 2)" "$OUT8"
write_pin "main"
OUT9="$(run verify)"
[ $? -eq 2 ] && pass "a branch name is refused (rc 2)" || fail "a branch name is refused (rc 2)" "$OUT9"

echo ""
echo "--- ⛔ a missing/unreadable pin file fails closed ---"
OUT10="$(CATALYST_INDEX_PIN="$SCRATCH/does-not-exist.json" bash "$SUBJECT" verify 2>&1)"
[ $? -ne 0 ] && pass "a missing pin file exits non-zero" || fail "a missing pin file exits non-zero" "$OUT10"

echo ""
echo "--- ⛔ a DESCENDANT of the pin is refused, not accepted (Codex #3525 P1) ---"
# The first cut used `merge-base --is-ancestor`, which accepts any later commit — so a root that
# had drifted ahead ran post-pin code while `verify` called it pinned. A pin that only sets a
# floor is not a pin.
write_pin "$NEW_SHA"
git_q "$SCRATCH/root" fetch origin
git_q "$SCRATCH/root" checkout --detach "$LATER_SHA"
OUT_D="$(run verify)"
RC_D=$?
grep -q "is AHEAD of pinned" <<<"$OUT_D" && pass "a descendant is refused, and named as AHEAD" || fail "a descendant is refused" "$OUT_D"
[ "$RC_D" -ne 0 ] && pass "verify exits non-zero on a descendant" || fail "verify exits non-zero on a descendant" "rc=0"
# ⛔ Positive control: the pin itself still passes, so this is not simply refusing everything.
git_q "$SCRATCH/root" checkout --detach "$NEW_SHA"
run verify >/dev/null 2>&1 && pass "control — the exact pin still passes" || fail "control — the exact pin still passes" "$(run verify)"

echo ""
echo "--- ⛔ a modification OUTSIDE the probe file is caught (Codex #3525 P1) ---"
# Scoping cleanliness to the probe file let any edit under apps/index-host — the code the indexer
# actually runs — print "PASS clean" and allowed `run` to proceed.
mkdir -p "$SCRATCH/root/apps/index-host"
echo "// unreviewed local change to the code that actually runs" >"$SCRATCH/root/apps/index-host/cli.ts"
OUT_E="$(run verify)"
grep -q "FAIL  clean" <<<"$OUT_E" && pass "a change outside the probe file fails 'clean'" || fail "a change outside the probe file fails 'clean'" "$OUT_E"
grep -q "PASS  content" <<<"$OUT_E" && pass "…while content still passes, so 'clean' is the half that caught it" || fail "content still passes" "$OUT_E"
rm -rf "$SCRATCH/root/apps/index-host"

echo ""
echo "=== the CLI is installable (Codex #3525 P1) ==="
# The doctor tells the operator to run `catalyst-index-root setup`; install-cli.sh uses an
# explicit allowlist, so an unregistered command is command-not-found on a normal install.
if grep -q '"catalyst-index-root:catalyst-index-root"' "$SCRIPT_DIR/../install-cli.sh"; then
	pass "catalyst-index-root is registered in install-cli.sh's CLI_ENTRIES"
else
	fail "catalyst-index-root is registered in install-cli.sh" "the documented command would be command-not-found"
fi

echo ""
echo "=== the fleet reload APPLIES the pin, not just distributes it (Codex #3525 P1) ==="
# Distributing the config is not applying it: without this, every serving root stays on the
# previous sha until someone runs a command by hand, while the pin file makes it look solved.
SPS="$SCRIPT_DIR/../setup-plugin-source.sh"
if grep -q "catalyst-index-root" "$SPS" && grep -q "INDEX_ROOT_SCRIPT.*setup\|setup\"*$" <<<"$(grep -A2 'INDEX_ROOT_SCRIPT" setup' "$SPS")"; then
	pass "setup-plugin-source.sh invokes catalyst-index-root setup"
else
	grep -q 'bash "$INDEX_ROOT_SCRIPT" setup' "$SPS" &&
		pass "setup-plugin-source.sh invokes catalyst-index-root setup" ||
		fail "setup-plugin-source.sh invokes catalyst-index-root setup" "the reload distributes the pin without applying it"
fi
grep -q "CATALYST_SKIP_INDEX_ROOT" "$SPS" && pass "…with an opt-out for nodes that never index" || fail "an opt-out exists" ""
grep -q "WARNING: catalyst-index serving root could NOT be advanced" "$SPS" && pass "…and a failure is LOUD, not silent" || fail "a failure is loud" ""

echo ""
echo "  PASSED: $PASSES   FAILED: $FAILURES"
[[ $FAILURES -eq 0 ]]
