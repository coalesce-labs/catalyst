#!/usr/bin/env bash
# Smoke test for the aggregate test runner run-tests.sh (CTL-528).
# Run: bash plugins/dev/scripts/__tests__/run-tests.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
RUNNER="${REPO_ROOT}/plugins/dev/scripts/run-tests.sh"

FAILURES=0
PASSES=0
pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	[ $# -ge 2 ] && echo "    $2"
}

# Build a fixture __tests__ dir; args are "name:exitcode[:stderr-line]" specs.
make_fixture() {
	local dir
	dir="$(mktemp -d)"
	local spec name code line
	for spec in "$@"; do
		name="${spec%%:*}"
		spec="${spec#*:}"
		code="${spec%%:*}"
		line="${spec#*:}"
		[[ $line == "$code" ]] && line=""
		{
			echo '#!/usr/bin/env bash'
			[[ -n $line ]] && echo "echo '${line}' >&2"
			echo "exit ${code}"
		} >"${dir}/${name}.test.sh"
	done
	echo "$dir"
}

# Test 1: runner exists and is executable
if [[ -x $RUNNER ]]; then
	pass "run-tests.sh exists and is executable"
else fail "run-tests.sh missing or not executable" "$RUNNER"; fi

# CTL-1993: run-tests.sh ALSO globs SKILLS_SHELL_TEST_DIR
# (plugins/dev/skills/__tests__/*.test.sh). Same hazard, same fix — every case
# below pins it to the shared EMPTY dir. Left at its real default it globs in the
# REAL skills suites alongside each fixture, and EVERY exact-count assertion in
# tests 2-6 goes wrong at once. That is exactly what happened when the glob was
# added without this line: 17 passed / 0 failed became 11 passed / 6 failed.
# ⭐ Third occurrence of this shape (round 7 below, round 9, now this) — so if you
# add a FOURTH test directory to run-tests.sh, pin it here IN THE SAME COMMIT.
#
# CTL-1612 round 7: run-tests.sh now ALSO globs LIB_SHELL_TEST_DIR
# (lib/__tests__/*.test.sh) in addition to SHELL_TEST_DIR. Every fixture case
# below must pin LIB_SHELL_TEST_DIR to this shared EMPTY directory too — left
# at its real default, the runner would glob in all of the REAL
# lib/__tests__ suites alongside each fixture's 2 fake tests, breaking every
# exact-count assertion in tests 2-6 (e.g. "shell 1 passed / 0 failed / 1
# skipped" would instead count 1 + N real suites).
EMPTY_LIB_DIR="$(mktemp -d)"

# Test 2: all-pass fixture exits 0
FIX="$(make_fixture "aaa:0" "bbb:0")"
trap 'rm -rf "$FIX" "$FIX2" "$FIX3" "$FIX4" "$FIX5" "$EMPTY_LIB_DIR"' EXIT
if SHELL_TEST_DIR="$FIX" LIB_SHELL_TEST_DIR="$EMPTY_LIB_DIR" SKILLS_SHELL_TEST_DIR="$EMPTY_LIB_DIR" COORD_SHELL_TEST_DIR="$EMPTY_LIB_DIR" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" >/dev/null 2>&1; then
	pass "all-pass fixture exits 0"
else fail "all-pass fixture should exit 0"; fi

# Test 3: a failing test (exit 1) makes the runner exit non-zero
FIX2="$(make_fixture "ok:0" "bad:1")"
if SHELL_TEST_DIR="$FIX2" LIB_SHELL_TEST_DIR="$EMPTY_LIB_DIR" SKILLS_SHELL_TEST_DIR="$EMPTY_LIB_DIR" COORD_SHELL_TEST_DIR="$EMPTY_LIB_DIR" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" >/dev/null 2>&1; then
	fail "fixture with a failing test should exit non-zero"
else pass "failing test makes runner exit non-zero"; fi

# Test 4: exit-with-count pattern (exit 3) is treated as failure, not pass
FIX3="$(make_fixture "ok:0" "counted:3")"
if SHELL_TEST_DIR="$FIX3" LIB_SHELL_TEST_DIR="$EMPTY_LIB_DIR" SKILLS_SHELL_TEST_DIR="$EMPTY_LIB_DIR" COORD_SHELL_TEST_DIR="$EMPTY_LIB_DIR" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" >/dev/null 2>&1; then
	fail "exit-code 3 should count as failure"
else pass "any rc>0 (exit 3) counts as failure"; fi

# Test 5: a column-0 'SKIP:' (exit 0) is counted as a skip — not a pass, not a
# failure. The exact-count assertion is load-bearing: the summary template
# always contains the word "skipped", so a bare substring grep would pass even
# if SKIP detection were broken and the suite miscounted as a pass.
FIX4="$(make_fixture "ok:0" "skipme:0:SKIP: dependency absent")"
OUT="$(SHELL_TEST_DIR="$FIX4" LIB_SHELL_TEST_DIR="$EMPTY_LIB_DIR" SKILLS_SHELL_TEST_DIR="$EMPTY_LIB_DIR" COORD_SHELL_TEST_DIR="$EMPTY_LIB_DIR" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" 2>&1)"
RC=$?
if [[ $RC -eq 0 ]]; then
	pass "SKIP test does not fail the runner"
else fail "SKIP test should not fail the runner" "rc=$RC"; fi
if grep -qE '^  SKIP .*skipme\.test\.sh' <<<"$OUT"; then
	pass "skip fixture classified SKIP on its own line (not PASS)"
else fail "skip fixture not classified SKIP" "$OUT"; fi
if grep -q 'shell 1 passed / 0 failed / 1 skipped' <<<"$OUT"; then
	pass "summary counts exactly 1 passed / 0 failed / 1 skipped"
else fail "summary skip/pass/fail count wrong" "$OUT"; fi

# Test 6: SKIP detection is anchored to '^SKIP:'. A passing suite that merely
# mentions SKIP mid-line (indented, or with leading text) must stay PASS.
FIX5="$(make_fixture "ok:0" "mentions:0:  note: SKIP: handling exercised")"
OUT="$(SHELL_TEST_DIR="$FIX5" LIB_SHELL_TEST_DIR="$EMPTY_LIB_DIR" SKILLS_SHELL_TEST_DIR="$EMPTY_LIB_DIR" COORD_SHELL_TEST_DIR="$EMPTY_LIB_DIR" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" 2>&1)"
if grep -q 'shell 2 passed / 0 failed / 0 skipped' <<<"$OUT"; then
	pass "indented 'SKIP:' does not trigger skip classification (^SKIP: anchored)"
else fail "non-column-0 'SKIP:' wrongly classified" "$OUT"; fi

# Test 7b (CTL-1993): SKILLS_SHELL_TEST_DIR is genuinely wired, not merely
# accepted and ignored. Without this, pinning it empty above would silence the
# glob and the suite would pass whether or not the skills dir is ever discovered
# — which is the "a cap is never silent" failure the skills gate itself is about.
FIX6B="$(make_fixture "skills_fixture:0")"
OUT="$(SHELL_TEST_DIR="$EMPTY_LIB_DIR" LIB_SHELL_TEST_DIR="$EMPTY_LIB_DIR" SKILLS_SHELL_TEST_DIR="$FIX6B" COORD_SHELL_TEST_DIR="$EMPTY_LIB_DIR" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" 2>&1)"
if grep -q "skills_fixture" <<<"$OUT"; then
	pass "SKILLS_SHELL_TEST_DIR fixture is discovered and run"
else fail "SKILLS_SHELL_TEST_DIR override was not wired into the shell suite" "$OUT"; fi
rm -rf "$FIX6B"

# Test 7c (CTL-2145): COORD_SHELL_TEST_DIR is genuinely wired, not merely declared —
# the same proof 7b makes for the skills dir. A fourth test directory that is globbed
# by nothing is this repo's recurring defect; asserting the override actually reaches
# the shell loop is what makes the runner line real rather than decorative.
FIX6C="$(make_fixture "coord_fixture:0")"
OUT="$(SHELL_TEST_DIR="$EMPTY_LIB_DIR" LIB_SHELL_TEST_DIR="$EMPTY_LIB_DIR" SKILLS_SHELL_TEST_DIR="$EMPTY_LIB_DIR" COORD_SHELL_TEST_DIR="$FIX6C" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" 2>&1)"
if grep -q 'coord_fixture.test.sh' <<<"$OUT"; then
	pass "COORD_SHELL_TEST_DIR fixture is discovered and run"
else fail "COORD_SHELL_TEST_DIR override was not wired into the shell suite" "$OUT"; fi

# Test 7 (CTL-1612 round 7): LIB_SHELL_TEST_DIR is genuinely wired, not just
# harmlessly ignored — a fixture placed there is discovered and run, proving
# it is not a dead override.
FIX6="$(make_fixture "libok:0")"
trap 'rm -rf "$FIX" "$FIX2" "$FIX3" "$FIX4" "$FIX5" "$FIX6" "$FIX7" "$FIX7_LIB" "$EMPTY_LIB_DIR"' EXIT
OUT="$(SHELL_TEST_DIR="$EMPTY_LIB_DIR" LIB_SHELL_TEST_DIR="$FIX6" SKILLS_SHELL_TEST_DIR="$EMPTY_LIB_DIR" COORD_SHELL_TEST_DIR="$EMPTY_LIB_DIR" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" 2>&1)"
if grep -q 'shell 1 passed / 0 failed / 0 skipped' <<<"$OUT"; then
	pass "LIB_SHELL_TEST_DIR fixture is discovered and run"
else fail "LIB_SHELL_TEST_DIR override was not wired into the shell suite" "$OUT"; fi

# Test 8 (CTL-1612 round 9, Codex P2 follow-up): a real wrapped basename must
# be counted EXACTLY ONCE even when a file with that same basename exists in
# BOTH SHELL_TEST_DIR and LIB_SHELL_TEST_DIR — the real-world shape of
# __tests__/secrets-hygiene.test.sh (a wrapper) coexisting with
# lib/__tests__/secrets-hygiene.test.sh (the wrapped suite). Uses the REAL
# wrapped basename "secrets-hygiene.test.sh" (not an arbitrary fixture name)
# so this test breaks LOUDLY — not silently — if the derived wrapped set
# (CTL-1612 round 13) ever stops recognizing a real wrapper shape. Counts
# occurrences of the suite's own PASS marker line directly in the runner's
# combined output — the property this test exists to pin.
# CTL-1612 round 12 (Codex P2 follow-up): the wrapped-exclusion is now gated
# on the wrapper file actually being discovered under the active
# SHELL_TEST_DIR (_lib_suite_wrapper_present), which greps each file there
# for the literal exec-target reference every real wrapper contains (see
# __tests__/secrets-hygiene.test.sh). This fixture's SHELL_TEST_DIR entry
# must carry that same reference or it stops being recognized as a genuine
# wrapper and this test's "runs exactly once" assertion would break for the
# wrong reason (double-run, not a fixed detection gap).
#
# CTL-1612 round 15 (Codex P2 follow-up): the reference line must be shaped
# like a REAL invocation (`bash`/`exec bash` as the line's first token), not
# a comment — detection is now anchored to that shape (see run-tests.sh), so
# a `#`-prefixed mention no longer counts.
#
# CTL-1612 post-merge #2978 (Codex P2 follow-up): the reference line must
# ALSO be REACHABLE — placed before any top-level `exit` (see run-tests.sh's
# awk truncation) — or it stops counting as a wrapper too. `if false; then …
# fi` keeps it syntactically present (and textually before the trailing
# `exit 0`, so detection still finds it) while never actually executing at
# runtime — this fixture's whole point is to prove "a real-shaped, reachable
# reference counts" without this test file genuinely re-invoking anything.
FIX7="$(mktemp -d)"
cat >"${FIX7}/secrets-hygiene.test.sh" <<'FIX7EOF'
#!/usr/bin/env bash
if false; then
	exec bash "${SCRIPT_DIR}/../lib/__tests__/secrets-hygiene.test.sh"
fi
exit 0
FIX7EOF
FIX7_LIB="$(mktemp -d)"
cp "${FIX7}/secrets-hygiene.test.sh" "${FIX7_LIB}/secrets-hygiene.test.sh"
OUT="$(SHELL_TEST_DIR="$FIX7" LIB_SHELL_TEST_DIR="$FIX7_LIB" SKILLS_SHELL_TEST_DIR="$EMPTY_LIB_DIR" COORD_SHELL_TEST_DIR="$EMPTY_LIB_DIR" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" 2>&1)"
MARKER_COUNT="$(grep -c 'PASS .*secrets-hygiene\.test\.sh' <<<"$OUT")"
if [[ "$MARKER_COUNT" -eq 1 ]]; then
	pass "wrapped basename (secrets-hygiene.test.sh) runs exactly once, present under both SHELL_TEST_DIR and LIB_SHELL_TEST_DIR"
else fail "wrapped basename ran $MARKER_COUNT time(s), expected exactly 1" "$OUT"; fi
if grep -q 'shell 1 passed / 0 failed / 0 skipped' <<<"$OUT"; then
	pass "aggregate summary counts exactly 1 (not 2) for the wrapped-basename fixture"
else fail "aggregate summary miscounted the wrapped-basename fixture" "$OUT"; fi

# Test 9 (CTL-1612 round 12, Codex P2 follow-up): a targeted run whose
# SHELL_TEST_DIR override has NO wrapper for a real wrapped basename must
# still execute that lib suite directly — the pre-fix skip dropped it
# silently (0 tests run, reported PASS) whenever no wrapper was actually
# present this run. Uses the real wrapped basename "secrets-hygiene.test.sh"
# so this is exactly the scenario the finding described: a targeted/fixture
# run pointing LIB_SHELL_TEST_DIR at one wrapped suite in isolation, with an
# empty/overridden SHELL_TEST_DIR.
FIX9_SHELL="$(mktemp -d)"
FIX9_LIB="$(make_fixture "secrets-hygiene:0")"
trap 'rm -rf "$FIX" "$FIX2" "$FIX3" "$FIX4" "$FIX5" "$FIX6" "$FIX7" "$FIX7_LIB" "$FIX9_SHELL" "$FIX9_LIB" "$FIX10_SHELL" "$FIX10_LIB" "$EMPTY_LIB_DIR"' EXIT
OUT="$(SHELL_TEST_DIR="$FIX9_SHELL" LIB_SHELL_TEST_DIR="$FIX9_LIB" SKILLS_SHELL_TEST_DIR="$EMPTY_LIB_DIR" COORD_SHELL_TEST_DIR="$EMPTY_LIB_DIR" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" 2>&1)"
if grep -q 'shell 1 passed / 0 failed / 0 skipped' <<<"$OUT"; then
	pass "wrapped-basename lib suite runs directly when no wrapper is present under the active SHELL_TEST_DIR"
else fail "wrapped-basename lib suite was wrongly skipped with no active wrapper (0 tests, silent PASS)" "$OUT"; fi

# Test 10 (CTL-1612 round 13, Codex P1 follow-up): the wrapped set is now
# DERIVED from wrapper files rather than a hardcoded table, so it must
# correctly dedupe an ARBITRARY basename that was never a member of any
# prior hardcoded list — this is the exact self-registration property the
# finding asked for ("a new wrapper is self-registering"). Uses a basename
# ("brand-new-lib-suite.test.sh") that has never appeared in any round's
# static list; a pre-round-13 implementation (hardcoded table, however
# up to date) would double-run this fixture since it isn't a recognized
# member, while the derived-set implementation recognizes it purely from the
# wrapper file's own exec-target reference.
# CTL-1612 round 15 + post-merge #2978: real-invocation shape, reachable
# before the trailing `exit 0` — see the note on the equivalent FIX7 fixture
# above.
FIX10_SHELL="$(mktemp -d)"
cat >"${FIX10_SHELL}/brand-new-lib-suite.test.sh" <<'FIX10EOF'
#!/usr/bin/env bash
if false; then
	exec bash "${SCRIPT_DIR}/../lib/__tests__/brand-new-lib-suite.test.sh"
fi
exit 0
FIX10EOF
FIX10_LIB="$(mktemp -d)"
cp "${FIX10_SHELL}/brand-new-lib-suite.test.sh" "${FIX10_LIB}/brand-new-lib-suite.test.sh"
OUT="$(SHELL_TEST_DIR="$FIX10_SHELL" LIB_SHELL_TEST_DIR="$FIX10_LIB" SKILLS_SHELL_TEST_DIR="$EMPTY_LIB_DIR" COORD_SHELL_TEST_DIR="$EMPTY_LIB_DIR" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" 2>&1)"
MARKER_COUNT="$(grep -c 'PASS .*brand-new-lib-suite\.test\.sh' <<<"$OUT")"
if [[ "$MARKER_COUNT" -eq 1 ]]; then
	pass "a brand-new wrapper/basename never in any hardcoded list is self-registering and dedupes correctly"
else fail "brand-new wrapper/basename ran $MARKER_COUNT time(s), expected exactly 1 (derivation is not self-registering)" "$OUT"; fi

# Test 11 (CTL-1612 round 15, Codex P2 follow-up): a file that merely
# MENTIONS a lib/__tests__/<basename> reference — in a comment, a doc
# string, or a fixture-building `echo` line, exactly the shape of this test
# file's OWN Test 10 setup above — must NOT be treated as a real wrapper.
# Codex's concrete reproduction was this file itself: before this round's
# fix, __tests__/run-tests.test.sh's Test 10 `echo` line (which just BUILDS
# a fixture string, never executes anything) was textually indistinguishable
# from a genuine `exec bash ".../lib/__tests__/..."` wrapper line to the
# round-13 grep, so a real "brand-new-lib-suite.test.sh" lib suite would have
# been silently skipped forever. Fixture: a SHELL_TEST_DIR file that only
# comments about a lib suite (never invokes it) coexisting with a
# LIB_SHELL_TEST_DIR entry of that same basename — both must run and be
# counted, proving the mention alone doesn't suppress the real suite.
FIX11_SHELL="$(mktemp -d)"
trap 'rm -rf "$FIX" "$FIX2" "$FIX3" "$FIX4" "$FIX5" "$FIX6" "$FIX7" "$FIX7_LIB" "$FIX9_SHELL" "$FIX9_LIB" "$FIX10_SHELL" "$FIX10_LIB" "$FIX11_SHELL" "$FIX11_LIB" "$EMPTY_LIB_DIR"' EXIT
cat >"${FIX11_SHELL}/commentmention.test.sh" <<'FIX11EOF'
#!/usr/bin/env bash
# see lib/__tests__/totally-fake-suite.test.sh" for background — NOT an
# invocation, just a comment that happens to textually match the pattern.
exit 0
FIX11EOF
FIX11_LIB="$(make_fixture "totally-fake-suite:0")"
OUT="$(SHELL_TEST_DIR="$FIX11_SHELL" LIB_SHELL_TEST_DIR="$FIX11_LIB" SKILLS_SHELL_TEST_DIR="$EMPTY_LIB_DIR" COORD_SHELL_TEST_DIR="$EMPTY_LIB_DIR" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" 2>&1)"
if grep -q 'PASS .*totally-fake-suite\.test\.sh' <<<"$OUT"; then
	pass "a comment-only mention of a lib/__tests__ path does not suppress the real lib suite"
else fail "comment-only mention wrongly suppressed the lib suite (0 tests, silently skipped)" "$OUT"; fi
if grep -q 'shell 2 passed / 0 failed / 0 skipped' <<<"$OUT"; then
	pass "both the commenting shell suite and the mentioned lib suite are counted independently (no dedup)"
else fail "aggregate summary miscounted the comment-only-mention fixture" "$OUT"; fi

# Test 12 (CTL-1612 post-merge #2978, Codex P2 follow-up): an invocation-
# shaped reference that is UNREACHABLE — dead code after a top-level `exit`
# — must NOT be treated as a real wrapper either. Codex's concrete
# reproduction was round 15's OWN FIX7/FIX10 fixtures (fixed above in this
# same file): `exit 0` followed by an apparent `exec bash
# ".../lib/__tests__/x.test.sh"` line the runner never actually reaches.
# This fixture reproduces that exact pre-fix shape on purpose, paired with a
# LIB_SHELL_TEST_DIR suite that FAILS — if the runner still (wrongly) treats
# the dead exec line as a genuine wrapper, the failing lib suite gets
# silently skipped and the aggregate reports a clean PASS despite real,
# never-executed failing coverage; post-fix it must run directly and surface
# the failure.
FIX12_SHELL="$(mktemp -d)"
trap 'rm -rf "$FIX" "$FIX2" "$FIX3" "$FIX4" "$FIX5" "$FIX6" "$FIX7" "$FIX7_LIB" "$FIX9_SHELL" "$FIX9_LIB" "$FIX10_SHELL" "$FIX10_LIB" "$FIX11_SHELL" "$FIX11_LIB" "$FIX12_SHELL" "$FIX12_LIB" "$EMPTY_LIB_DIR"' EXIT
cat >"${FIX12_SHELL}/dead-code-wrapper.test.sh" <<'FIX12EOF'
#!/usr/bin/env bash
exit 0
exec bash "${SCRIPT_DIR}/../lib/__tests__/dead-code-wrapper.test.sh"
FIX12EOF
FIX12_LIB="$(make_fixture "dead-code-wrapper:1")"
OUT="$(SHELL_TEST_DIR="$FIX12_SHELL" LIB_SHELL_TEST_DIR="$FIX12_LIB" SKILLS_SHELL_TEST_DIR="$EMPTY_LIB_DIR" COORD_SHELL_TEST_DIR="$EMPTY_LIB_DIR" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" 2>&1)"
RC=$?
if grep -q 'FAIL .*dead-code-wrapper\.test\.sh' <<<"$OUT"; then
	pass "an unreachable (post-exit) invocation-shaped reference does not suppress the real lib suite"
else fail "unreachable reference wrongly suppressed the failing lib suite (0 tests, silently skipped)" "$OUT"; fi
if [[ $RC -ne 0 ]]; then
	pass "the failing lib suite's failure propagates to the aggregate exit code (not masked as PASS)"
else fail "aggregate exited 0 despite a real, never-suppressed lib-suite failure" "$OUT"; fi

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
[ "$FAILURES" -eq 0 ]
