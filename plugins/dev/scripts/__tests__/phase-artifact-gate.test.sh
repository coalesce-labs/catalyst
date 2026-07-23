#!/usr/bin/env bash
# Contract tests for lib/phase-artifact-gate.sh (CTL-1081).
#
# Covers:
#  1. match_thoughts_artifact: tail form, slug form (lowercase), slug form (uppercase),
#     cross-ticket lookalike rejection, wrong-ticket rejection, no-match return.
#  2. Spec map: prior_artifact_for_phase, own_thoughts_artifact_dir_for_phase.
#  3. Contract / divergence: dispatch + emit-complete both source the lib;
#     phase-research + phase-plan SKILLs reference match_thoughts_artifact.
#
# Run: bash plugins/dev/scripts/__tests__/phase-artifact-gate.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LIB="${REPO_ROOT}/plugins/dev/scripts/lib/phase-artifact-gate.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t phase-artifact-gate-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

assert_eq() {
	local expected="$1" actual="$2" label="$3"
	if [[ $expected == "$actual" ]]; then
		pass "$label"
	else
		fail "$label — expected '$expected', got '$actual'"
	fi
}

assert_contains() {
	local haystack="$1" needle="$2" label="$3"
	if printf '%s\n' "$haystack" | grep -qF "$needle"; then
		pass "$label"
	else
		fail "$label — output did not contain '$needle'"
	fi
}

assert_not_contains() {
	local haystack="$1" needle="$2" label="$3"
	if printf '%s\n' "$haystack" | grep -qF "$needle"; then
		fail "$label — output unexpectedly contained '$needle'"
	else
		pass "$label"
	fi
}

if [[ ! -f $LIB ]]; then
	echo "FATAL: lib not found — expected at $LIB" >&2
	exit 1
fi

# shellcheck source=../lib/phase-artifact-gate.sh
source "$LIB"

# ─── Build fixture dir ────────────────────────────────────────────────────────

FIXTURES="${SCRATCH}/thoughts/shared/research"
mkdir -p "$FIXTURES"
touch "${FIXTURES}/2026-06-12-ctl-1081.md"                         # tail form
touch "${FIXTURES}/2026-06-12-ctl-1081-per-image-ai-captions.md"   # lowercase slug
touch "${FIXTURES}/2026-06-12-CTL-1081-foo.md"                     # uppercase slug
touch "${FIXTURES}/2026-06-12-ctl-10812-bar.md"                    # cross-ticket lookalike
touch "${FIXTURES}/2026-06-12-ctl-999.md"                          # different ticket

echo "Test 1: match_thoughts_artifact returns 0 and prints the three valid fixtures"
OUT="$(match_thoughts_artifact "$FIXTURES" "CTL-1081")"
RC=$?
assert_eq "0" "$RC" "return code is 0 (at least one match)"
assert_contains "$OUT" "2026-06-12-ctl-1081.md"                       "output includes tail form"
assert_contains "$OUT" "2026-06-12-ctl-1081-per-image-ai-captions.md" "output includes lowercase slug"
assert_contains "$OUT" "2026-06-12-CTL-1081-foo.md"                   "output includes uppercase slug"

echo ""
echo "Test 2: match_thoughts_artifact excludes cross-ticket lookalike and wrong-ticket file"
assert_not_contains "$OUT" "2026-06-12-ctl-10812-bar.md" "cross-ticket lookalike NOT in output"
assert_not_contains "$OUT" "2026-06-12-ctl-999.md"       "wrong-ticket file NOT in output"

echo ""
echo "Test 3: match_thoughts_artifact returns non-zero when no match"
EMPTY_DIR="${SCRATCH}/empty"
mkdir -p "$EMPTY_DIR"
OUT3="$(match_thoughts_artifact "$EMPTY_DIR" "CTL-9999" 2>/dev/null || echo "")"
RC3=0
match_thoughts_artifact "$EMPTY_DIR" "CTL-9999" >/dev/null 2>&1 || RC3=$?
assert_eq "1" "$RC3" "no-match returns non-zero"
assert_eq "" "$OUT3" "no-match output is empty"

echo ""
echo "Test 4: prior_artifact_for_phase spec map"
assert_eq "glob:thoughts/shared/research" "$(prior_artifact_for_phase plan)"      "plan → research dir"
assert_eq "glob:thoughts/shared/plans"    "$(prior_artifact_for_phase implement)" "implement → plans dir"
assert_eq "signal:triage.json"            "$(prior_artifact_for_phase research)"  "research → triage signal"
assert_eq ""                              "$(prior_artifact_for_phase triage)"    "triage → empty (entry point)"

echo ""
echo "Test 5: own_thoughts_artifact_dir_for_phase (pre-CTL-1490 phases)"
assert_eq "thoughts/shared/research"      "$(own_thoughts_artifact_dir_for_phase research)" "research → research dir"
assert_eq "thoughts/shared/plans"         "$(own_thoughts_artifact_dir_for_phase plan)"      "plan → plans dir"
assert_eq "thoughts/shared/phase-verify"  "$(own_thoughts_artifact_dir_for_phase verify)"    "verify → phase-verify dir (CTL-1490)"
assert_eq ""                              "$(own_thoughts_artifact_dir_for_phase implement)"  "implement → empty (not thoughts-producing)"

echo ""
echo "Test 6 (divergence): phase-agent-dispatch sources lib/phase-artifact-gate.sh"
DISPATCH="${REPO_ROOT}/plugins/dev/scripts/phase-agent-dispatch"
if grep -qF 'lib/phase-artifact-gate.sh' "$DISPATCH"; then
	pass "phase-agent-dispatch sources lib/phase-artifact-gate.sh"
else
	fail "phase-agent-dispatch does NOT source lib/phase-artifact-gate.sh"
fi

echo ""
echo "Test 7 (divergence): phase-agent-emit-complete sources lib/phase-artifact-gate.sh"
EMIT="${REPO_ROOT}/plugins/dev/scripts/phase-agent-emit-complete"
if grep -qF 'lib/phase-artifact-gate.sh' "$EMIT"; then
	pass "phase-agent-emit-complete sources lib/phase-artifact-gate.sh"
else
	fail "phase-agent-emit-complete does NOT source lib/phase-artifact-gate.sh"
fi

echo ""
echo "Test 8 (divergence/contract): phase-research SKILL references match_thoughts_artifact"
SKILL_RESEARCH="${REPO_ROOT}/plugins/dev/skills/phase-research/SKILL.md"
if [[ -f $SKILL_RESEARCH ]] && grep -qF 'match_thoughts_artifact' "$SKILL_RESEARCH"; then
	pass "phase-research SKILL references match_thoughts_artifact"
else
	fail "phase-research SKILL does NOT reference match_thoughts_artifact"
fi

echo ""
echo "Test 9 (divergence/contract): phase-plan SKILL references match_thoughts_artifact"
SKILL_PLAN="${REPO_ROOT}/plugins/dev/skills/phase-plan/SKILL.md"
if [[ -f $SKILL_PLAN ]] && grep -qF 'match_thoughts_artifact' "$SKILL_PLAN"; then
	pass "phase-plan SKILL references match_thoughts_artifact"
else
	fail "phase-plan SKILL does NOT reference match_thoughts_artifact"
fi

echo ""
echo "Test 10 (contract): slugged writer name matches the gate"
SLUG_DIR="${SCRATCH}/thoughts/shared/plans"
mkdir -p "$SLUG_DIR"
touch "${SLUG_DIR}/2026-06-12-ctl-1081-phase-artifact-gate-contracts.md"
OUT10="$(match_thoughts_artifact "$SLUG_DIR" "CTL-1081")"
RC10=$?
assert_eq "0" "$RC10" "slugged plan doc satisfies the gate (writer↔gate agreement)"
assert_contains "$OUT10" "phase-artifact-gate-contracts.md" "slugged plan doc found by matcher"

echo ""
echo "─── CTL-1490 Phase 3: new phases + retry helper ─────────────────────────────"

# ── T11: own_thoughts_artifact_dir_for_phase for each new phase ───────────────

echo ""
echo "Test 11: own_thoughts_artifact_dir_for_phase for the six new phases"
assert_eq "thoughts/shared/phase-triage"         "$(own_thoughts_artifact_dir_for_phase triage)"          "triage → phase-triage dir"
assert_eq "thoughts/shared/phase-verify"         "$(own_thoughts_artifact_dir_for_phase verify)"          "verify → phase-verify dir"
assert_eq "thoughts/shared/phase-review"         "$(own_thoughts_artifact_dir_for_phase review)"          "review → phase-review dir"
assert_eq "thoughts/shared/phase-pr"             "$(own_thoughts_artifact_dir_for_phase pr)"              "pr → phase-pr dir"
assert_eq "thoughts/shared/phase-monitor-merge"  "$(own_thoughts_artifact_dir_for_phase monitor-merge)"   "monitor-merge → phase-monitor-merge dir"
assert_eq "thoughts/shared/phase-monitor-deploy" "$(own_thoughts_artifact_dir_for_phase monitor-deploy)"  "monitor-deploy → phase-monitor-deploy dir"

echo ""
echo "Test 12: implement/remediate/teardown still return '' (unchanged)"
assert_eq "" "$(own_thoughts_artifact_dir_for_phase implement)"  "implement → empty (not thoughts-producing)"
assert_eq "" "$(own_thoughts_artifact_dir_for_phase remediate)"  "remediate → empty (not thoughts-producing)"
assert_eq "" "$(own_thoughts_artifact_dir_for_phase teardown)"   "teardown → empty (not thoughts-producing)"

# ── T13: match_thoughts_artifact_with_pull_retry ─────────────────────────────

echo ""
echo "Test 13a: match_thoughts_artifact_with_pull_retry — hit on first try (pull NOT invoked)"
{
	PULL_SENTINEL="${SCRATCH}/pull_called_13a"
	RETRY_DIR="${SCRATCH}/phase-retry-13a"
	mkdir -p "$RETRY_DIR"
	touch "${RETRY_DIR}/2026-06-12-ctl-9999.md"

	fake_pull() { touch "$PULL_SENTINEL"; return 0; }
	RC13a=0
	CATALYST_PULL_SYNC_CMD="/bin/false"
	OUT13a="$(CATALYST_PULL_SYNC_CMD="/bin/false" \
	  match_thoughts_artifact_with_pull_retry "$RETRY_DIR" "CTL-9999" 2>/dev/null)" || RC13a=$?
	assert_eq "0" "$RC13a" "T13a: hit on first try → returns 0"
	if [[ -n "$OUT13a" ]]; then
		pass "T13a: output is non-empty (match found)"
	else
		fail "T13a: output was empty — expected a matching filename"
	fi
	if [[ -f "$PULL_SENTINEL" ]]; then
		fail "T13a: pull gate was invoked on a first-try hit (should not pull)"
	else
		pass "T13a: pull gate NOT invoked on first-try hit"
	fi
}

echo ""
echo "Test 13b: match_thoughts_artifact_with_pull_retry — miss then pull then hit"
{
	RETRY_DIR_B="${SCRATCH}/phase-retry-13b"
	PULL_SENTINEL_B="${SCRATCH}/pull_called_13b"
	mkdir -p "$RETRY_DIR_B"
	# No file yet — first match will miss.

	MISS_THEN_HIT_PULL="${SCRATCH}/bin/miss-then-hit-pull"
	mkdir -p "${SCRATCH}/bin"
	cat > "$MISS_THEN_HIT_PULL" <<PULLSCRIPT
#!/usr/bin/env bash
touch "${PULL_SENTINEL_B}"
# "Simulate" pull by creating the artifact
touch "${RETRY_DIR_B}/2026-06-12-ctl-8888.md"
exit 0
PULLSCRIPT
	chmod +x "$MISS_THEN_HIT_PULL"

	RC13b=0
	OUT13b="$(CATALYST_PULL_SYNC_CMD="$MISS_THEN_HIT_PULL" \
	  match_thoughts_artifact_with_pull_retry "$RETRY_DIR_B" "CTL-8888" 2>/dev/null)" || RC13b=$?
	assert_eq "0" "$RC13b" "T13b: miss then pull then hit → returns 0"
	if [[ -f "$PULL_SENTINEL_B" ]]; then
		pass "T13b: pull gate was invoked on miss"
	else
		fail "T13b: pull gate NOT invoked on miss (should pull once)"
	fi
}

echo ""
echo "Test 13c: match_thoughts_artifact_with_pull_retry — miss then pull then still miss → non-zero"
{
	RETRY_DIR_C="${SCRATCH}/phase-retry-13c"
	mkdir -p "$RETRY_DIR_C"
	# No file; pull also produces nothing.

	ALWAYS_FAIL_PULL="${SCRATCH}/bin/always-fail-pull"
	cat > "$ALWAYS_FAIL_PULL" <<PULLSCRIPT
#!/usr/bin/env bash
exit 0
PULLSCRIPT
	chmod +x "$ALWAYS_FAIL_PULL"

	RC13c=0
	match_thoughts_artifact_with_pull_retry "$RETRY_DIR_C" "CTL-7777" \
	  >/dev/null 2>&1 || RC13c=$?
	if [[ "$RC13c" -ne 0 ]]; then
		pass "T13c: miss then pull then still miss → returns non-zero"
	else
		fail "T13c: miss then still miss: expected non-zero, got 0"
	fi
}

echo ""
echo "── CTL-1490 Phase 3: six-phase extension tests ─────────────────────────────"

# ── T11: own_thoughts_artifact_dir_for_phase for the six new phases ──────────

echo ""
echo "Test 11: own_thoughts_artifact_dir_for_phase — six new phases"
assert_eq "thoughts/shared/phase-triage"         "$(own_thoughts_artifact_dir_for_phase triage)"         "triage → thoughts/shared/phase-triage"
assert_eq "thoughts/shared/phase-verify"         "$(own_thoughts_artifact_dir_for_phase verify)"         "verify → thoughts/shared/phase-verify"
assert_eq "thoughts/shared/phase-review"         "$(own_thoughts_artifact_dir_for_phase review)"         "review → thoughts/shared/phase-review"
assert_eq "thoughts/shared/phase-pr"             "$(own_thoughts_artifact_dir_for_phase pr)"             "pr → thoughts/shared/phase-pr"
assert_eq "thoughts/shared/phase-monitor-merge"  "$(own_thoughts_artifact_dir_for_phase monitor-merge)"  "monitor-merge → thoughts/shared/phase-monitor-merge"
assert_eq "thoughts/shared/phase-monitor-deploy" "$(own_thoughts_artifact_dir_for_phase monitor-deploy)" "monitor-deploy → thoughts/shared/phase-monitor-deploy"

# ── T12: implement/remediate/teardown still return "" (unchanged) ─────────────

echo ""
echo "Test 12: implement/remediate/teardown unchanged — still return empty"
assert_eq "" "$(own_thoughts_artifact_dir_for_phase implement)"  "implement → empty (unchanged)"
assert_eq "" "$(own_thoughts_artifact_dir_for_phase remediate)"  "remediate → empty (unchanged)"
assert_eq "" "$(own_thoughts_artifact_dir_for_phase teardown)"   "teardown → empty (unchanged)"

# ── T13: match_thoughts_artifact_with_pull_retry ─────────────────────────────
#
# Requires a pull-gate injectable via CATALYST_PULL_SYNC_CMD (just like the
# pull-gate tests: a script that touches a sentinel and exits with a given code).
# The retry helper sources the pull-gate via PULL_GATE_PATH (injectable) or
# falls back to the real thoughts-pull-sync-gate.sh.

echo ""
echo "Test 13a: match_thoughts_artifact_with_pull_retry — hit on first try (pull NOT invoked)"
{
  PULL_SENTINEL="${SCRATCH}/pull_called_13a"
  FAKE_PULL="${SCRATCH}/fake-pull-13a.sh"
  printf '#!/usr/bin/env bash\ntouch "%s"\nexit 0\n' "$PULL_SENTINEL" > "$FAKE_PULL"
  chmod +x "$FAKE_PULL"

  RETRY_DIR="${SCRATCH}/thoughts/shared/phase-triage"
  mkdir -p "$RETRY_DIR"
  touch "${RETRY_DIR}/2026-07-01-ctl-1081.md"

  RC13a=0
  OUT13a="$(CATALYST_PULL_SYNC_CMD="$FAKE_PULL" \
    match_thoughts_artifact_with_pull_retry "$RETRY_DIR" "CTL-1081" 2>/dev/null)" || RC13a=$?
  if [[ "$RC13a" -ne 0 ]]; then
    fail "T13a: hit on first try: returned non-zero ($RC13a)"
  elif [[ -f "$PULL_SENTINEL" ]]; then
    fail "T13a: hit on first try: pull gate was invoked (sentinel present)"
  else
    pass "T13a: hit on first try → returns 0, pull gate NOT invoked"
  fi
}

echo ""
echo "Test 13b: match_thoughts_artifact_with_pull_retry — miss → pull → hit (pull invoked once)"
{
  PULL_SENTINEL="${SCRATCH}/pull_called_13b"
  RETRY_DIR_B="${SCRATCH}/thoughts/shared/phase-verify-retry"
  mkdir -p "$RETRY_DIR_B"
  # Pull script creates the artifact (simulates sync pulling a remote doc)
  FAKE_PULL_B="${SCRATCH}/fake-pull-13b.sh"
  cat > "$FAKE_PULL_B" <<EOF
#!/usr/bin/env bash
touch "${PULL_SENTINEL}"
touch "${RETRY_DIR_B}/2026-07-01-ctl-1081.md"
exit 0
EOF
  chmod +x "$FAKE_PULL_B"

  RC13b=0
  OUT13b="$(CATALYST_PULL_SYNC_CMD="$FAKE_PULL_B" \
    match_thoughts_artifact_with_pull_retry "$RETRY_DIR_B" "CTL-1081" 2>/dev/null)" || RC13b=$?
  if [[ "$RC13b" -ne 0 ]]; then
    fail "T13b: miss→pull→hit: returned non-zero ($RC13b)"
  elif [[ ! -f "$PULL_SENTINEL" ]]; then
    fail "T13b: miss→pull→hit: pull gate was NOT invoked"
  else
    pass "T13b: miss → pull → hit → returns 0, pull gate invoked once"
  fi
}

echo ""
echo "Test 13c: match_thoughts_artifact_with_pull_retry — miss → pull → still miss → returns 1"
{
  PULL_SENTINEL="${SCRATCH}/pull_called_13c"
  RETRY_DIR_C="${SCRATCH}/thoughts/shared/phase-review-retry"
  mkdir -p "$RETRY_DIR_C"
  # Pull script touches sentinel but does NOT create the artifact
  FAKE_PULL_C="${SCRATCH}/fake-pull-13c.sh"
  printf '#!/usr/bin/env bash\ntouch "%s"\nexit 0\n' "$PULL_SENTINEL" > "$FAKE_PULL_C"
  chmod +x "$FAKE_PULL_C"

  RC13c=0
  CATALYST_PULL_SYNC_CMD="$FAKE_PULL_C" \
    match_thoughts_artifact_with_pull_retry "$RETRY_DIR_C" "CTL-1081" >/dev/null 2>&1 || RC13c=$?
  if [[ "$RC13c" -eq 0 ]]; then
    fail "T13c: miss→pull→miss: returned 0, expected 1"
  elif [[ ! -f "$PULL_SENTINEL" ]]; then
    fail "T13c: miss→pull→miss: pull gate was NOT invoked"
  else
    pass "T13c: miss → pull → still miss → returns 1"
  fi
}

echo ""
echo "─────────────────────────────────────────────"
echo "phase-artifact-gate: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
	exit 1
fi
exit 0
