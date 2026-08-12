#!/usr/bin/env bash
# catalyst-verify.test.sh — CTL-1801.
#
# The library has its own unit tests (lib/verified-checks.test.mjs). This file
# pins the CLI's EXIT CODES, because those are the contract a bash caller acts
# on — and treating exit 2 ("could not look") as exit 1 ("nothing found") is the
# exact defect this tool exists to remove. An untested exit code is how the
# distinction gets lost at the shell boundary.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY="${SCRIPT_DIR}/../catalyst-verify"
PASSES=0
FAILURES=0

pass() {
	echo "  PASS: $1"
	PASSES=$((PASSES + 1))
}
fail() {
	echo "  FAIL: $1"
	FAILURES=$((FAILURES + 1))
}

# assert_exit <expected> <label> -- <cmd...>
assert_exit() {
	local expected="$1" label="$2"
	shift 3 # expected, label, "--"
	"$@" >/dev/null 2>&1
	local rc=$?
	if [[ "$rc" -eq "$expected" ]]; then
		pass "$label (exit $rc)"
	else
		fail "$label — expected exit $expected, got $rc"
	fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A corpus with one real event and one GitHub event whose BODY merely mentions
# the name — the shape that made a substring grep report events that did not exist.
cat >"${TMP}/events.jsonl" <<'EOF'
{"attributes":{"event.name":"github.push"},"body":{"payload":{"commits":[{"message":"emit phase.advance.applied"}]}}}
{"attributes":{"event.name":"phase.advance.applied.CTL-56"},"body":{"payload":{"evidence":"fabricated"}}}
EOF
: >"${TMP}/empty.jsonl"

echo ""
echo "catalyst-verify: exit-code contract"

assert_exit 0 "events: a real occurrence exits 0" -- \
	node "$VERIFY" events phase.advance.applied --log "${TMP}/events.jsonl"

assert_exit 1 "events: a conclusive ZERO exits 1 (measured, not inconclusive)" -- \
	node "$VERIFY" events phase.nonexistent.event --log "${TMP}/events.jsonl"

# The load-bearing distinction: an unreadable corpus is NOT a clean zero.
assert_exit 2 "events: a missing log is INCONCLUSIVE (exit 2), never a clean 0" -- \
	node "$VERIFY" events phase.advance.applied --log "${TMP}/definitely-absent.jsonl"

assert_exit 2 "events: an EMPTY corpus is INCONCLUSIVE (exit 2), never a clean 0" -- \
	node "$VERIFY" events phase.advance.applied --log "${TMP}/empty.jsonl"

# Ownership: a malformed call must fail loudly (3), never answer falsely (1).
assert_exit 3 "owns: an empty roster is a usage error, not a 'no'" -- \
	node "$VERIFY" owns CTL-1 --host mini --roster ""

assert_exit 3 "owns: a missing --host is a usage error" -- \
	node "$VERIFY" owns CTL-1 --roster mini,mini-2

# Ownership answers, verified against the HRW math directly so the CLI cannot
# drift from the library. Compute the true owner, then assert both directions.
OWNER="$(node -e '
import("'"${SCRIPT_DIR}"'/../lib/verified-checks.mjs").then(m =>
  process.stdout.write(m.hrwOwner("CTL-1790", ["mini","mini-2"])));
')"
if [[ -z "$OWNER" ]]; then
	fail "could not compute an HRW owner — the assertions below would be vacuous"
else
	pass "positive control: HRW owner for CTL-1790 resolves (${OWNER})"
	OTHER="mini"
	[[ "$OWNER" == "mini" ]] && OTHER="mini-2"
	assert_exit 0 "owns: the true owner answers YES" -- \
		node "$VERIFY" owns CTL-1790 --host "$OWNER" --roster mini,mini-2
	assert_exit 1 "owns: a non-owner answers NO" -- \
		node "$VERIFY" owns CTL-1790 --host "$OTHER" --roster mini,mini-2
fi

assert_exit 3 "an unknown subcommand is a usage error" -- node "$VERIFY" bogus-subcommand
assert_exit 0 "--help exits 0" -- node "$VERIFY" --help

echo ""
echo "─────────────────────────────────────────────"
echo "catalyst-verify: ${PASSES} passed, ${FAILURES} failed"
echo "─────────────────────────────────────────────"
[[ $FAILURES -eq 0 ]]
