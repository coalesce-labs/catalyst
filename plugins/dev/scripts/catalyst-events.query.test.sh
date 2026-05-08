#!/usr/bin/env bash
# catalyst-events.query.test.sh — integration tests for the `query` subcommand.
#
# Tests use --dsl (Groq-bypass) so they never hit the network. They override
# CATALYST_EVENTS_FILE to a temp fixture, exercise the predicate compilation
# and output paths end-to-end, and assert exit codes match the documented
# contract.
#
# Run: bash plugins/dev/scripts/catalyst-events.query.test.sh
# Exits 0 on success, 1 on first failure.

set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVENTS_BIN="$SCRIPT_DIR/catalyst-events"

if [[ ! -x "$EVENTS_BIN" ]]; then
  echo "FAIL: $EVENTS_BIN not executable" >&2
  exit 1
fi

# Disable broker daemon side effects from any inherited env.
unset CATALYST_DIR
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FIXTURE="$TMP/events.jsonl"
export CATALYST_EVENTS_FILE="$FIXTURE"

PASS=0
FAIL=0
FAILURES=()

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    PASS=$((PASS + 1))
    echo "  ok: $name"
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$name: expected='$expected' actual='$actual'")
    echo "  FAIL: $name"
    echo "    expected: $expected"
    echo "    actual:   $actual"
  fi
}

assert_contains() {
  local name="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    PASS=$((PASS + 1))
    echo "  ok: $name"
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$name: missing needle='$needle' in '$haystack'")
    echo "  FAIL: $name"
    echo "    needle:   $needle"
    echo "    haystack: $haystack"
  fi
}

# ─── Fixture setup ────────────────────────────────────────────────────────────

cat > "$FIXTURE" <<'JSONL'
{"ts":"2026-05-08T14:00:00Z","severityText":"INFO","severityNumber":9,"traceId":null,"spanId":null,"resource":{"service.name":"catalyst.github"},"attributes":{"event.name":"github.pr.merged","vcs.pr.number":342,"vcs.repository.name":"coalesce-labs/catalyst","catalyst.worker.ticket":"CTL-313"},"body":{"message":"PR #342 merged","payload":{}}}
{"ts":"2026-05-08T13:00:00Z","severityText":"ERROR","severityNumber":17,"traceId":null,"spanId":null,"resource":{"service.name":"catalyst.github"},"attributes":{"event.name":"github.workflow_run.completed","vcs.pr.number":343,"cicd.pipeline.run.conclusion":"failure"},"body":{"message":"CI failed","payload":{}}}
{"ts":"2026-05-08T12:00:00Z","severityText":"INFO","severityNumber":9,"traceId":null,"spanId":null,"resource":{"service.name":"catalyst.linear"},"attributes":{"event.name":"linear.issue.state_changed","linear.issue.identifier":"ADV-292"},"body":{"message":"Issue moved","payload":{}}}
{"ts":"2026-05-08T11:00:00Z","severityText":"INFO","severityNumber":9,"traceId":null,"spanId":null,"resource":{"service.name":"catalyst.session"},"attributes":{"event.name":"session.phase","catalyst.session.id":"sess_abc","catalyst.phase":3},"body":{"message":"implementing","payload":{}}}
JSONL

# ─── 1. --explain prints DSL + compiled jq ────────────────────────────────────

echo "test: --explain prints compiled jq"
EXPLAIN_DSL=$(cat <<'EOF'
{"filter":{"field":"attributes.\"event.name\"","eq":"github.pr.merged"}}
EOF
)
out=$("$EVENTS_BIN" query --explain --dsl "$EXPLAIN_DSL" 2>&1)
rc=$?
assert_eq "explain exit code" "0" "$rc"
assert_contains "explain output contains jqPredicate" "jqPredicate" "$out"
assert_contains "explain output contains compiled selector" 'github.pr.merged' "$out"

# ─── 2. --dsl no-Groq round-trip filters the fixture ──────────────────────────

echo "test: --dsl filters fixture (severity ERROR → 1 line)"
out=$("$EVENTS_BIN" query --dsl '{"filter":{"field":"severityText","eq":"ERROR"}}')
rc=$?
assert_eq "filter exit code" "0" "$rc"
line_count=$(printf '%s\n' "$out" | grep -c '^{')
assert_eq "filter line count" "1" "$line_count"
assert_contains "filter output contains the ERROR row" "github.workflow_run.completed" "$out"

# ─── 3. zero matches returns exit 0, no output ────────────────────────────────

echo "test: zero matches → exit 0, empty stdout"
out=$("$EVENTS_BIN" query --dsl '{"filter":{"field":"severityText","eq":"NEVER"}}' 2>&1)
rc=$?
assert_eq "no-match exit code" "0" "$rc"
assert_eq "no-match output empty" "" "$out"

# ─── 4. unknown field → exit 4, error on stderr ───────────────────────────────

echo "test: unknown field → exit 4"
out=$("$EVENTS_BIN" query --dsl '{"filter":{"field":"bogus.field","eq":1}}' 2>&1)
rc=$?
assert_eq "unknown-field exit code" "4" "$rc"
assert_contains "unknown-field error names the bad path" "bogus.field" "$out"

# ─── 5. invalid DSL → exit 3 (Groq-response style error) ──────────────────────

echo "test: malformed DSL JSON → exit 3"
out=$("$EVENTS_BIN" query --dsl 'not valid json' 2>&1)
rc=$?
assert_eq "malformed-json exit code" "3" "$rc"

# ─── 6. missing args → exit 2 ─────────────────────────────────────────────────

echo "test: no query and no --dsl → exit 2"
out=$("$EVENTS_BIN" query 2>&1)
rc=$?
assert_eq "no-args exit code" "2" "$rc"

# ─── 7. unknown flag → exit 2 ─────────────────────────────────────────────────

echo "test: unknown flag → exit 2"
out=$("$EVENTS_BIN" query --bogus 2>&1)
rc=$?
assert_eq "unknown-flag exit code" "2" "$rc"

# ─── 8. sort + limit operate over the slurped match set ───────────────────────

echo "test: sort desc + limit 1 returns the most recent fixture event"
out=$("$EVENTS_BIN" query --dsl '{"filter":{},"sort":{"field":"ts","order":"desc"},"limit":1}')
rc=$?
assert_eq "sort+limit exit code" "0" "$rc"
line_count=$(printf '%s\n' "$out" | grep -c '^{')
assert_eq "sort+limit line count" "1" "$line_count"
assert_contains "sort+limit picked the most-recent ts" '"2026-05-08T14:00:00Z"' "$out"

# ─── 9. --since pre-trims by ts ───────────────────────────────────────────────

echo "test: --since 1s cuts off all fixture events"
# Fixture events have fixed past timestamps (≤ 2026-05-08T14:00:00Z). --since 1s
# means cutoff = now - 1s, which is in the future relative to the fixture, so
# the cutoff is later than every event → 0 results.
out=$("$EVENTS_BIN" query --dsl '{"filter":{}}' --since 1s)
rc=$?
assert_eq "--since exit code" "0" "$rc"
line_count=$(printf '%s\n' "$out" | grep -c '^{')
assert_eq "--since 1s cuts all old events" "0" "$line_count"

echo "test: --since 365d keeps all fixture events"
out=$("$EVENTS_BIN" query --dsl '{"filter":{}}' --since 365d)
rc=$?
assert_eq "--since 365d exit code" "0" "$rc"
line_count=$(printf '%s\n' "$out" | grep -c '^{')
assert_eq "--since 365d keeps all fixture events" "4" "$line_count"

# ─── 10. complex AND filter on attribute path ─────────────────────────────────

echo "test: AND of event.name + ticket"
DSL=$(cat <<'EOF'
{"filter":{"and":[{"field":"attributes.\"event.name\"","startsWith":"github.pr."},{"field":"attributes.\"catalyst.worker.ticket\"","eq":"CTL-313"}]}}
EOF
)
out=$("$EVENTS_BIN" query --dsl "$DSL")
rc=$?
assert_eq "and-filter exit code" "0" "$rc"
line_count=$(printf '%s\n' "$out" | grep -c '^{')
assert_eq "and-filter matches one row" "1" "$line_count"

# ─── Summary ─────────────────────────────────────────────────────────────────

echo
echo "Pass: $PASS"
echo "Fail: $FAIL"

if [[ $FAIL -gt 0 ]]; then
  echo
  echo "Failures:"
  for f in "${FAILURES[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
exit 0
