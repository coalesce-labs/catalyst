#!/usr/bin/env bash
# Tests for coord/ai.coalesce.catalyst-account-rotation.plist (CTL-2145).
#
# Static template assertions only — no launchd, no substitution, no platform gate, so
# this suite runs everywhere including the ubuntu CI runner (unlike the installer
# suites, which need a Darwin-shaped environment).
#
# The ABSENCES here are the point. The 2026-08-21 outage's surviving artifact was a
# blind zombie: a long-lived loop that could not act and could not be told from a
# healthy one. This agent is a StartInterval one-shot precisely so that shape is not
# constructible, and `KeepAlive` is the single key that would reintroduce it.
#
# Run: bash plugins/dev/scripts/__tests__/account-rotation-plist.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
PLIST="${REPO_ROOT}/plugins/dev/scripts/coord/ai.coalesce.catalyst-account-rotation.plist"

PASSES=0
FAILURES=0
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

if [[ ! -f "$PLIST" ]]; then
	fail "plist template missing at ${PLIST}"
	echo ""
	echo "== ${PASSES} passed, ${FAILURES} failed =="
	exit 1
fi

has() { # $1 name, $2 ERE
	if grep -qE "$2" "$PLIST" 2>/dev/null; then pass "$1"; else fail "$1 (pattern '$2' not found)"; fi
}
hasnt() { # $1 name, $2 ERE
	if grep -qE "$2" "$PLIST" 2>/dev/null; then fail "$1 (pattern '$2' unexpectedly present)"; else pass "$1"; fi
}

echo "Test: required keys"
has "Label is ai.coalesce.catalyst-account-rotation" '<string>ai\.coalesce\.catalyst-account-rotation</string>'
has "ProgramArguments runs the actor via /bin/bash" '<string>/bin/bash</string>'
has "ProgramArguments points at coord/account-rotation-watch.sh" 'REPLACE_WITH_ABSOLUTE/coord/account-rotation-watch\.sh'
has "StartInterval is an <integer>" '<key>StartInterval</key>'
has "StartInterval carries the substitution token" '<integer>REPLACE_START_INTERVAL</integer>'
has "RunAtLoad is false" '<key>RunAtLoad</key>'
has "logs to REPLACE_HOME/catalyst/account-rotation.log" 'REPLACE_HOME/catalyst/account-rotation\.log'
has "EnvironmentVariables carries the rollout knob" '<key>CATALYST_ACCOUNT_ROTATION</key>'
has "the knob's value is a substitution token" '<string>REPLACE_ROTATION_MODE</string>'
# launchd gives a job only its built-in /usr/bin:/bin:/usr/sbin:/sbin unless PATH is
# declared here, and the actor's default switch verb (catalyst-stack) is NOT on that
# list — so a plist without this key can never rotate in enforce, and fails in a way
# that reads like a working circuit breaker. No assertion covered this before, which
# is why it shipped green.
has "EnvironmentVariables declares PATH (the enforce path depends on it)" '<key>PATH</key>'
has "PATH's value is a substitution token" '<string>REPLACE_PATH</string>'
# launchd does not inherit the installing shell's env: a nondefault CATALYST_DIR must
# be persisted here or the agent watches the wrong latch/marker dir forever.
has "EnvironmentVariables persists CATALYST_DIR" '<key>CATALYST_DIR</key>'
has "CATALYST_DIR's value is a substitution token" '<string>REPLACE_CATALYST_DIR</string>'

echo "Test: the load-bearing ABSENCES (D2 — this agent must not be able to zombie)"
hasnt "no KeepAlive — launchd must not respawn a long-lived process" '<key>KeepAlive</key>'
hasnt "no AbandonProcessGroup — the actor spawns nothing that outlives it" '<key>AbandonProcessGroup</key>'
# Positive control: these two probes must be capable of firing. A `hasnt` that can
# never match is not evidence of absence — it is a check that cannot fail, which is
# the exact shape AGENTS.md forbids reporting as clean.
PROBE="$(mktemp)"
printf '<key>KeepAlive</key>\n<key>AbandonProcessGroup</key>\n' >"$PROBE"
if grep -qE '<key>KeepAlive</key>' "$PROBE" && grep -qE '<key>AbandonProcessGroup</key>' "$PROBE"; then
	pass "positive control: both absence probes match when the keys ARE present"
else
	fail "positive control FAILED — the absence probes cannot match, so the two passes above mean nothing"
fi
rm -f "$PROBE"

echo "Test: RunAtLoad is false, not true"
# `<key>RunAtLoad</key>` alone says nothing about the value. Read the element that
# FOLLOWS the key rather than grepping for `<false/>` anywhere in the file.
RAL="$(grep -A1 '<key>RunAtLoad</key>' "$PLIST" 2>/dev/null | tail -1 | tr -d '[:space:]')"
if [[ "$RAL" == "<false/>" ]]; then
	pass "RunAtLoad => <false/> (a load-time run would rotate on every reinstall)"
else
	fail "expected RunAtLoad => <false/>, got '${RAL}'"
fi

echo "Test: no double hyphen inside an XML comment"
# Tool-independent guard for a defect plutil -lint does NOT catch. XML forbids `--`
# anywhere inside a comment, and the natural thing to write in an instructions block —
# `install-account-rotation.sh` followed by its two-hyphen uninstall flag — trips it.
# plutil accepted such a file happily; expat rejected the whole plist. Since the typed
# assertions below only run where python3 exists, assert it directly here too.
COMMENT_HYPHENS="$(awk '
	/<!--/ { depth++; line=$0; sub(/.*<!--/, "", line) }
	depth && !/<!--/ { line=$0 }
	depth {
		probe=line
		sub(/-->.*/, "", probe)
		if (index(probe, "--") > 0) printf "%d: %s\n", NR, $0
	}
	/-->/ { depth-- }
' "$PLIST")"
if [[ -z "$COMMENT_HYPHENS" ]]; then
	pass "no double hyphen inside any XML comment"
else
	fail "double hyphen inside an XML comment (illegal XML; plutil will not catch it): ${COMMENT_HYPHENS}"
fi
# Positive control: the probe fires on a file that really has one.
PROBE2="$(mktemp)"
printf '<!--\n  run foo.sh --uninstall\n-->\n' >"$PROBE2"
if [[ -n "$(awk '
	/<!--/ { depth++; line=$0; sub(/.*<!--/, "", line) }
	depth && !/<!--/ { line=$0 }
	depth { probe=line; sub(/-->.*/, "", probe); if (index(probe, "--") > 0) print NR }
	/-->/ { depth-- }
' "$PROBE2")" ]]; then
	pass "positive control: the comment-hyphen probe fires on a known-bad file"
else
	fail "positive control FAILED — the comment-hyphen probe cannot fire"
fi
rm -f "$PROBE2"

echo "Test: well-formed XML"
# Substitute first: the TEMPLATE is deliberately not valid on its own
# (REPLACE_START_INTERVAL sits inside <integer>), so linting it raw would fail for a
# reason that has nothing to do with the template being well-formed.
TMPP="$(mktemp)"
sed -e 's|REPLACE_START_INTERVAL|300|g' \
	-e 's|REPLACE_ROTATION_MODE|shadow|g' \
	-e 's|REPLACE_WITH_ABSOLUTE|/opt/catalyst/scripts|g' \
	-e 's|REPLACE_HOME|/Users/example|g' \
	-e 's|REPLACE_PATH|/Users/example/.catalyst/bin:/usr/bin:/bin|g' \
	-e 's|REPLACE_CATALYST_DIR|/Users/example/catalyst|g' "$PLIST" >"$TMPP"

# BOTH validators run when both are available — they answer different questions and the
# earlier version of this suite ran only whichever it found first, so on macOS the typed
# assertions below never executed at all.
VALIDATED=0
if command -v plutil >/dev/null 2>&1; then
	VALIDATED=1
	if plutil -lint "$TMPP" >/dev/null 2>&1; then
		pass "plutil -lint accepts the substituted plist"
	else
		fail "plutil -lint rejected it: $(plutil -lint "$TMPP" 2>&1 | head -3)"
	fi
fi
if command -v python3 >/dev/null 2>&1; then
	VALIDATED=1
	# plistlib checks the TYPED values launchd actually reads — <integer> really parsing
	# as an int, RunAtLoad really being the boolean false rather than the string "false".
	if python3 - "$TMPP" <<-'PY'
		import plistlib, sys
		d = plistlib.load(open(sys.argv[1], "rb"))
		assert d["Label"] == "ai.coalesce.catalyst-account-rotation", d.get("Label")
		assert isinstance(d["StartInterval"], int), type(d["StartInterval"])
		assert 60 <= d["StartInterval"] <= 3600, d["StartInterval"]
		assert d["RunAtLoad"] is False, repr(d["RunAtLoad"])
		assert "KeepAlive" not in d, "KeepAlive present"
		assert "AbandonProcessGroup" not in d, "AbandonProcessGroup present"
		assert d["ProgramArguments"][0] == "/bin/bash", d["ProgramArguments"]
		assert d["ProgramArguments"][1].endswith("/coord/account-rotation-watch.sh"), d["ProgramArguments"]
		assert d["EnvironmentVariables"]["CATALYST_ACCOUNT_ROTATION"] == "shadow"
		assert d["EnvironmentVariables"]["PATH"] == "/Users/example/.catalyst/bin:/usr/bin:/bin"
		assert d["EnvironmentVariables"]["CATALYST_DIR"] == "/Users/example/catalyst"
		assert d["StandardOutPath"].endswith("/catalyst/account-rotation.log"), d["StandardOutPath"]
	PY
	then
		pass "plistlib parses it and every TYPED value is correct"
	else
		fail "plistlib rejected it or a typed value was wrong"
	fi
fi
if [[ "$VALIDATED" -eq 0 ]]; then
	fail "neither plutil nor python3 available — XML well-formedness UNVERIFIED (inconclusive, not a pass)"
fi
rm -f "$TMPP"

echo "Test: the PATH the INSTALLER bakes actually resolves catalyst-stack"
# A PATH key with the wrong dirs is the same bug as no PATH key at all, so assert the
# real substituted value, not just the token's presence. Read the installer's own
# _agent_path rather than restating the list here — a copy would drift and then agree
# with itself while disagreeing with what is installed.
INSTALLER="${REPO_ROOT}/plugins/dev/scripts/install-account-rotation.sh"
if [[ -f "$INSTALLER" ]]; then
	# Extract the function TEXT in this shell, then run it in a subshell with a fixed
	# HOME. Doing the sed inside a `bash -c` string instead put the `{`/`}` of the range
	# address through brace expansion, which silently split it into two malformed sed
	# programs — the extraction then returned empty and this assertion reported
	# "inconclusive" for a reason that had nothing to do with the installer.
	AGENT_PATH_FN="$(sed -n '/^_agent_path() {/,/^}/p' "$INSTALLER" 2>/dev/null)"
	BAKED_PATH="$(HOME=/Users/example bash -c "${AGENT_PATH_FN}
_agent_path" 2>/dev/null)"
	if [[ -z "$BAKED_PATH" ]]; then
		fail "could not extract _agent_path from ${INSTALLER} (inconclusive, not a pass)"
	else
		case ":${BAKED_PATH}:" in
			*":/Users/example/.catalyst/bin:"*)
				pass "the baked PATH contains the dir holding catalyst-stack (~/.catalyst/bin)"
				;;
			*)
				fail "the baked PATH does NOT contain ~/.catalyst/bin, so the switch verb still exit-127s: ${BAKED_PATH}"
				;;
		esac
		# Positive control: the same probe must be able to FAIL. A case-match that can
		# never miss is not evidence.
		case ":/usr/bin:/bin:" in
			*":/Users/example/.catalyst/bin:"*) fail "positive control FAILED — the PATH probe matches a PATH that lacks the dir" ;;
			*) pass "positive control: the PATH probe correctly rejects launchd's built-in PATH" ;;
		esac
	fi
else
	fail "installer missing at ${INSTALLER} — baked-PATH assertion UNVERIFIED (inconclusive, not a pass)"
fi

echo ""
echo "== ${PASSES} passed, ${FAILURES} failed =="
[[ $FAILURES -eq 0 ]]
