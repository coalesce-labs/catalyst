#!/usr/bin/env bash
# Test suite for add-finding.sh. CTL-176.
#
# No network, no PATH stubs needed — the script only touches the filesystem and jq.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ADD_SCRIPT="$SCRIPT_DIR/add-finding.sh"

PASS=true
TESTS=0
FAILURES=0

fail() { echo "  FAIL: $1"; PASS=false; FAILURES=$((FAILURES + 1)); }
pass() { echo "  PASS: $1"; }
run_test() { TESTS=$((TESTS + 1)); echo ""; echo "--- Test $TESTS: $1 ---"; }

# ───────────────────────────────────────────────────────────────────────────

run_test "fresh run creates parent dir and writes valid JSON line"
TMPD=$(mktemp -d)
unset CATALYST_FINDINGS_FILE CATALYST_SESSION_ID
(cd "$TMPD" && "$ADD_SCRIPT" --title "First" --body "Body one" --skill oneshot) >/dev/null
LOG="$TMPD/.catalyst/findings/current.jsonl"
[ -f "$LOG" ] && pass "file created" || fail "file missing: $LOG"
LINES=$(wc -l < "$LOG" | tr -d ' ')
[ "$LINES" = "1" ] && pass "one line" || fail "lines=$LINES"
jq -e '.title == "First" and .body == "Body one" and .skill == "oneshot"' "$LOG" >/dev/null \
  && pass "JSON fields correct" || fail "JSON mismatch: $(cat "$LOG")"
rm -rf "$TMPD"

run_test "second call appends (not overwrites)"
TMPD=$(mktemp -d)
unset CATALYST_FINDINGS_FILE CATALYST_SESSION_ID
(cd "$TMPD" && "$ADD_SCRIPT" --title "One" --body "B1") >/dev/null
(cd "$TMPD" && "$ADD_SCRIPT" --title "Two" --body "B2") >/dev/null
LINES=$(wc -l < "$TMPD/.catalyst/findings/current.jsonl" | tr -d ' ')
[ "$LINES" = "2" ] && pass "appended to 2 lines" || fail "lines=$LINES"
T1=$(jq -r 'select(.title == "One") | .title' "$TMPD/.catalyst/findings/current.jsonl")
T2=$(jq -r 'select(.title == "Two") | .title' "$TMPD/.catalyst/findings/current.jsonl")
[ "$T1" = "One" ] && [ "$T2" = "Two" ] && pass "both entries present" || fail "t1=$T1 t2=$T2"
rm -rf "$TMPD"

run_test "multi-line body with quotes round-trips via jq"
TMPD=$(mktemp -d)
unset CATALYST_FINDINGS_FILE CATALYST_SESSION_ID
BODY=$'Line 1\nLine 2 with "quotes" and \'apostrophes\'\nLine 3'
(cd "$TMPD" && "$ADD_SCRIPT" --title "Complex" --body "$BODY") >/dev/null
ROUND=$(jq -r '.body' "$TMPD/.catalyst/findings/current.jsonl")
[ "$ROUND" = "$BODY" ] && pass "body preserved" || fail "body mangled"
rm -rf "$TMPD"

run_test "CATALYST_FINDINGS_FILE env override resolves first"
TMPD=$(mktemp -d)
OVERRIDE="$TMPD/custom/path.jsonl"
env -u CATALYST_SESSION_ID CATALYST_FINDINGS_FILE="$OVERRIDE" \
  bash -c "cd '$TMPD' && '$ADD_SCRIPT' --title X --body Y" >/dev/null
[ -f "$OVERRIDE" ] && pass "wrote to override path" || fail "override not honored; override=$OVERRIDE"
[ ! -f "$TMPD/.catalyst/findings/ignored.jsonl" ] && pass "session path not used" || fail "session path also written"
rm -rf "$TMPD"

run_test "CATALYST_SESSION_ID fallback resolves when no override"
TMPD=$(mktemp -d)
env -u CATALYST_FINDINGS_FILE CATALYST_SESSION_ID="sess-test-42" \
  bash -c "cd '$TMPD' && '$ADD_SCRIPT' --title X --body Y" >/dev/null
LOG="$TMPD/.catalyst/findings/sess-test-42.jsonl"
[ -f "$LOG" ] && pass "session path used" || fail "expected $LOG"
rm -rf "$TMPD"

run_test "neither env var set → current.jsonl"
TMPD=$(mktemp -d)
env -u CATALYST_FINDINGS_FILE -u CATALYST_SESSION_ID \
  bash -c "cd '$TMPD' && '$ADD_SCRIPT' --title X --body Y" >/dev/null
[ -f "$TMPD/.catalyst/findings/current.jsonl" ] && pass "current.jsonl used" || fail "fallback missed"
rm -rf "$TMPD"

run_test "--file override wins over env vars"
TMPD=$(mktemp -d)
OVERRIDE="$TMPD/explicit.jsonl"
env CATALYST_FINDINGS_FILE="$TMPD/env.jsonl" CATALYST_SESSION_ID="sess-x" \
  bash -c "cd '$TMPD' && '$ADD_SCRIPT' --title X --body Y --file '$OVERRIDE'" >/dev/null
[ -f "$OVERRIDE" ] && pass "flag path used" || fail "flag ignored"
[ ! -f "$TMPD/env.jsonl" ] && pass "env ignored" || fail "env path also written"
rm -rf "$TMPD"

run_test "missing --title exits 64"
TMPD=$(mktemp -d)
unset CATALYST_FINDINGS_FILE CATALYST_SESSION_ID
(cd "$TMPD" && "$ADD_SCRIPT" --body "Y" 2>/dev/null); RC=$?
[ $RC -eq 64 ] && pass "exit 64" || fail "exit=$RC"
rm -rf "$TMPD"

run_test "missing --body exits 64"
TMPD=$(mktemp -d)
unset CATALYST_FINDINGS_FILE CATALYST_SESSION_ID
(cd "$TMPD" && "$ADD_SCRIPT" --title "X" 2>/dev/null); RC=$?
[ $RC -eq 64 ] && pass "exit 64" || fail "exit=$RC"
rm -rf "$TMPD"

run_test "--dry-run prints JSON and does not write"
TMPD=$(mktemp -d)
unset CATALYST_FINDINGS_FILE CATALYST_SESSION_ID
OUT=$(cd "$TMPD" && "$ADD_SCRIPT" --title "Dry" --body "Z" --dry-run 2>/dev/null)
STATUS=$(echo "$OUT" | jq -r '.title')
[ "$STATUS" = "Dry" ] && pass "JSON printed to stdout" || fail "got: $OUT"
[ ! -f "$TMPD/.catalyst/findings/current.jsonl" ] && pass "no file written" || fail "file created"
rm -rf "$TMPD"

run_test "--severity high lands in JSON"
TMPD=$(mktemp -d)
unset CATALYST_FINDINGS_FILE CATALYST_SESSION_ID
(cd "$TMPD" && "$ADD_SCRIPT" --title "X" --body "Y" --severity high) >/dev/null
SEV=$(jq -r '.severity' "$TMPD/.catalyst/findings/current.jsonl")
[ "$SEV" = "high" ] && pass "severity=high" || fail "sev=$SEV"
rm -rf "$TMPD"

run_test "--tags a,b,c parses to 3-element array"
TMPD=$(mktemp -d)
unset CATALYST_FINDINGS_FILE CATALYST_SESSION_ID
(cd "$TMPD" && "$ADD_SCRIPT" --title "X" --body "Y" --tags "ci,flaky,test") >/dev/null
LEN=$(jq -r '.tags | length' "$TMPD/.catalyst/findings/current.jsonl")
[ "$LEN" = "3" ] && pass "3 tags" || fail "len=$LEN"
FIRST=$(jq -r '.tags[0]' "$TMPD/.catalyst/findings/current.jsonl")
[ "$FIRST" = "ci" ] && pass "first tag correct" || fail "first=$FIRST"
rm -rf "$TMPD"

run_test "second run with same session id keeps appending"
TMPD=$(mktemp -d)
env -u CATALYST_FINDINGS_FILE CATALYST_SESSION_ID="sess-append-test" \
  bash -c "cd '$TMPD' && '$ADD_SCRIPT' --title A --body A" >/dev/null
env -u CATALYST_FINDINGS_FILE CATALYST_SESSION_ID="sess-append-test" \
  bash -c "cd '$TMPD' && '$ADD_SCRIPT' --title B --body B" >/dev/null
LINES=$(wc -l < "$TMPD/.catalyst/findings/sess-append-test.jsonl" | tr -d ' ')
[ "$LINES" = "2" ] && pass "2 lines across invocations" || fail "lines=$LINES"
rm -rf "$TMPD"

# ───────────────────────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo "Tests: $TESTS, Failures: $FAILURES"
if [ "$PASS" = "true" ]; then
  echo "All tests passed."
  exit 0
else
  echo "Some tests failed."
  exit 1
fi
