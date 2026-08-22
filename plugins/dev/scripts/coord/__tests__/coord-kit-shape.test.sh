#!/usr/bin/env bash
# coord-kit-shape.test.sh — CTL-2145. The coord kit's IaC rule, asserted as a shape:
# every fleet-critical coord artifact lives HERE, version-controlled, and nothing
# fleet-critical resolves through an ephemeral `~/.claude/jobs/<id>/tmp/` dir.
#
# The 2026-08-21 ~75-minute outage was not a logic bug — it was a LOCATION bug. The
# launchers, the manifest and `fleet-account.current` lived under a concierge session's
# job dir; when that record was cleaned up they vanished and the watchdog survived only
# as a blind zombie holding deleted inodes. A shape test is the cheapest guard that
# keeps them in the repo.
#
# Run: bash plugins/dev/scripts/coord/__tests__/coord-kit-shape.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COORD_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${COORD_DIR}/../../../.." && pwd)"

PASSES=0
FAILURES=0
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

assert_exec() { # $1 path, $2 name
	if [[ -f "$1" && -x "$1" ]]; then pass "$2"; else fail "$2 (expected an executable file at $1)"; fi
}
assert_file() {
	if [[ -f "$1" ]]; then pass "$2"; else fail "$2 (expected a file at $1)"; fi
}

echo "Test: the relocated lane-relaunch watchdog is committed under coord/"
assert_exec "${COORD_DIR}/lane-relaunch.sh" "coord/lane-relaunch.sh exists and is executable"

echo "Test: the account-rotation actor is committed under coord/ (Phase 2)"
assert_exec "${COORD_DIR}/account-rotation-watch.sh" "coord/account-rotation-watch.sh exists and is executable"

echo "Test: the shared rolling-window circuit breaker has ONE home"
assert_file "${COORD_DIR}/lib/rotation-window.sh" "coord/lib/rotation-window.sh exists"
# Both kit scripts must SOURCE it rather than carry their own copy. The cap used to be
# inline in lane-relaunch.sh and hand-mirrored in its test ("if you change one, change
# both"); a circuit breaker that exists in three places is one that stops matching the
# thing it breaks.
for _s in lane-relaunch.sh account-rotation-watch.sh; do
	if grep -q 'lib/rotation-window.sh' "${COORD_DIR}/${_s}" 2>/dev/null; then
		pass "${_s} sources the shared rolling-window lib"
	else
		fail "${_s} does not source lib/rotation-window.sh — it is carrying a second copy of the cap"
	fi
done

echo "Test: the materialize primitive is committed under coord/"
assert_exec "${COORD_DIR}/materialize-coord-kit.sh" "coord/materialize-coord-kit.sh exists and is executable"

echo "Test: the templates the materialize primitive renders from are committed"
assert_file "${COORD_DIR}/templates/lanes.manifest.example" "templates/lanes.manifest.example exists"
assert_file "${COORD_DIR}/templates/launch-on-account.sh.template" "templates/launch-on-account.sh.template exists"

echo "Test: the launcher template carries the tokens materialize substitutes"
# OPERATIVE occurrences only. REPLACE_HOME used to be checked here too, but the template no
# longer uses it operatively — the runtime paths are baked from the values the generator
# actually resolved (REPLACE_COORD_RT / REPLACE_ENV_FILE) rather than re-guessed from $HOME
# (CTL-2145). A whole-file grep still found REPLACE_HOME in a COMMENT and passed, which is a
# check that can no longer fail; the generator keeps substituting it for templates that do
# reference it, and the token-set agreement below is what actually holds the two files
# together now.
for token in REPLACE_ACCOUNT REPLACE_COORD_RT REPLACE_ENV_FILE; do
	if grep -vE '^[[:space:]]*#' "${COORD_DIR}/templates/launch-on-account.sh.template" 2>/dev/null | grep -q "$token"; then
		pass "launcher template contains ${token} (operatively, not just in a comment)"
	else
		fail "launcher template is missing ${token} (materialize substitutes it)"
	fi
done

echo "Test: the watchdog was MOVED, not copied — the old repo-root path is gone (D1)"
# Two divergent copies of a fleet-critical watchdog is exactly the duplication
# AGENTS.md -> 'Single source of truth' forbids. Phase 1 Step 0 found no live caller
# of the old path, so the move is clean and no back-compat shim is expected.
if [[ -e "${REPO_ROOT}/scripts/comms/lane-relaunch.sh" ]]; then
	fail "scripts/comms/lane-relaunch.sh still exists — the move left a second copy"
else
	pass "scripts/comms/lane-relaunch.sh is gone (single home under coord/)"
fi

echo "Test: no coord artifact RESOLVES through an ephemeral ~/.claude/jobs path (the incident)"
# COMMENTS ARE EXCLUDED, deliberately. Several coord files narrate the incident and name
# the offending path in prose; what must not exist is an OPERATIVE reference — a path a
# running script actually resolves. Stripping `#` lines is what makes the difference
# between "explains the outage" and "reproduces it".
_operative_jobs_hits() { # $1.. files -> prints matching "file:line" for non-comment hits
	local f
	for f in "$@"; do
		grep -nE '\.claude/jobs' "$f" 2>/dev/null |
			grep -vE '^[0-9]+:[[:space:]]*#' |
			sed "s|^|${f}:|"
	done
}
# Positive control: the probe IS able to find an operative hit — a scan that can only ever
# return zero is not evidence. Prove it fires on a known-present case, and prove it
# correctly ignores the commented form, before trusting its zero below.
PROBE="$(mktemp)"
{
	printf '# a comment mentioning .claude/jobs must NOT count\n'
	printf 'LAUNCHER_DIR="$HOME/.claude/jobs/abc/tmp"\n'
} >"$PROBE"
PROBE_HITS="$(_operative_jobs_hits "$PROBE")"
if [[ "$(printf '%s\n' "$PROBE_HITS" | grep -c 'LAUNCHER_DIR')" == "1" ]]; then
	pass "positive control: the probe finds an operative .claude/jobs reference"
else
	fail "positive control FAILED — the probe cannot detect an operative .claude/jobs path, so its zero means nothing"
fi
if grep -q 'a comment mentioning' <<<"$PROBE_HITS"; then
	fail "the probe counted a COMMENT as an operative reference"
else
	pass "positive control: the probe ignores a commented mention"
fi
rm -f "$PROBE"
# Scan the SHIPPED artifacts only. `__tests__` is excluded deliberately: this very
# file carries the pattern in its own positive control above, so including it would
# make the check fail on itself forever.
COORD_ARTIFACTS=()
while IFS= read -r _f; do COORD_ARTIFACTS+=("$_f"); done < <(
	find "${COORD_DIR}" -type f -not -path '*/__tests__/*' 2>/dev/null
)
if [[ ${#COORD_ARTIFACTS[@]} -eq 0 ]]; then
	fail "found ZERO shipped coord artifacts to scan — an empty input set makes the clean result below meaningless"
else
	HITS="$(_operative_jobs_hits "${COORD_ARTIFACTS[@]}")"
	if [[ -n "$HITS" ]]; then
		fail "a coord artifact RESOLVES through ~/.claude/jobs — the ephemeral path this ticket removes:"
		printf '    %s\n' "$HITS"
	else
		pass "no coord artifact resolves through ~/.claude/jobs (${#COORD_ARTIFACTS[@]} artifacts scanned)"
	fi
fi


# ─── no REPLACE_ token may be a PREFIX of another (CTL-2145) ─────────────────
#
# materialize-coord-kit.sh substitutes every token with one `sed -e … -e …` invocation, and
# sed applies those expressions IN ORDER to the same line. So a token that has another token
# as a prefix is rewritten by the shorter one first, and its own expression then matches
# nothing — silently, leaving a launcher that still parses and still runs.
#
# That is not hypothetical: `REPLACE_ACCOUNTS_ENV` was eaten by `REPLACE_ACCOUNT` and baked
# the literal `acct1S_ENV` as the accounts-file path, so every launch looked for a token
# file that could not exist and burned the relaunch cap doing it. This asserts the PROPERTY
# rather than the one instance, so the next token added here cannot reintroduce it.

echo "Test: no REPLACE_ token in the launcher template is a prefix of another"
# OPERATIVE lines only — a token NAMED in a comment (the template documents the retired
# REPLACE_ACCOUNTS_ENV precisely so this collision stays understood) is not a substitution
# site, and counting it would make the fix's own explanation fail the check. Same
# operative-vs-commented distinction the .claude/jobs probe above already draws.
TOKENS="$(grep -vE '^[[:space:]]*#' "${COORD_DIR}/templates/launch-on-account.sh.template" 2>/dev/null |
	grep -oE 'REPLACE_[A-Z_]+' | sort -u)"
if [ -n "$TOKENS" ]; then
	pass "positive control: the template still carries REPLACE_ tokens to check ($(printf '%s' "$TOKENS" | tr '\n' ' '))"
else
	fail "found no REPLACE_ tokens at all — this check would pass vacuously"
fi
COLLISIONS=""
for a in $TOKENS; do
	for b in $TOKENS; do
		[ "$a" = "$b" ] && continue
		case "$b" in "$a"*) COLLISIONS="${COLLISIONS}${a} is a prefix of ${b}; " ;; esac
	done
done
if [ -z "$COLLISIONS" ]; then
	pass "no token is a prefix of another (substitution order cannot corrupt one)"
else
	fail "prefix collision(s) — the longer token is silently corrupted: ${COLLISIONS}"
fi
# Positive control for the probe itself: the known-bad pair must be detected.
case "REPLACE_ACCOUNTS_ENV" in
	"REPLACE_ACCOUNT"*) pass "positive control: the prefix probe fires on the pair it was written for" ;;
	*) fail "the prefix probe cannot detect the original collision — it proves nothing" ;;
esac

# ─── every substituted token is actually CONSUMED (CTL-2145) ────────────────
#
# The companion assertion: a token the generator never substitutes leaves a literal
# REPLACE_ string in a generated launcher. materialize-coord-kit.test.sh covers generation
# end-to-end; this one keeps the two files' token SETS in agreement at the source level, so
# a token added to the template without a matching -e expression fails here rather than on a
# fleet host.

echo "Test: every REPLACE_ token in the template has a substitution in the generator"
MISSING=""
for tok in $TOKENS; do
	grep -q "s|${tok}|" "${COORD_DIR}/materialize-coord-kit.sh" || MISSING="${MISSING}${tok} "
done
if [ -z "$MISSING" ]; then
	pass "every template token is substituted by materialize-coord-kit.sh"
else
	fail "template token(s) with no substitution — they survive verbatim into the launcher: ${MISSING}"
fi

echo ""
echo "== $PASSES passed, $FAILURES failed =="
[ "$FAILURES" -eq 0 ]
